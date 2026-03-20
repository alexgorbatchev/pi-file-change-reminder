import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface IReminderRule {
	glob: string;
	reminder: string;
}

interface IToolInputWithPath {
	path: string;
}

const EXTENSION_ID = "file-change-reminder";
const DEFAULT_RULES_FILE = ".pi/reminders.json";
const INJECTED_ENTRY_TYPE = `${EXTENSION_ID}.injected`;

export default function fileChangeReminderExtension(pi: ExtensionAPI): void {
	let rulesCache: IReminderRule[] = [];
	let rulesMtimeMs = -1;
	let hasLoadedRules = false;
	let lastLoadError = "";
	let injectedReminderKeys = new Set<string>();
	const globMatcherCache = new Map<string, (candidatePath: string) => boolean>();
	const projectDirectoryCache = new Map<string, string>();

	const rebuildInjectedReminderKeys = (ctx: ExtensionContext): void => {
		injectedReminderKeys = new Set<string>();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== INJECTED_ENTRY_TYPE) {
				continue;
			}

			if (!isRecord(entry.data)) {
				continue;
			}

			const reminderKey = readNonEmptyString(entry.data.reminderKey);
			if (reminderKey !== null) {
				injectedReminderKeys.add(reminderKey);
			}
		}
	};

	const resolveProjectDirectory = async (cwd: string): Promise<string> => {
		const resolvedCwd = path.resolve(cwd);
		const cachedDirectory = projectDirectoryCache.get(resolvedCwd);
		if (cachedDirectory !== undefined) {
			return cachedDirectory;
		}

		let currentDirectory = resolvedCwd;
		for (;;) {
			const hasGitMarker = await pathExists(path.join(currentDirectory, ".git"));
			const hasPiMarker = await pathExists(path.join(currentDirectory, ".pi"));
			if (hasGitMarker || hasPiMarker) {
				projectDirectoryCache.set(resolvedCwd, currentDirectory);
				return currentDirectory;
			}

			const parentDirectory = path.dirname(currentDirectory);
			if (parentDirectory === currentDirectory) {
				projectDirectoryCache.set(resolvedCwd, resolvedCwd);
				return resolvedCwd;
			}

			currentDirectory = parentDirectory;
		}
	};

	const resolveRulesFilePath = async (cwd: string): Promise<string> => {
		const envValue = process.env.PI_REMINDERS_FILE;
		const configuredPath = readNonEmptyString(envValue) ?? DEFAULT_RULES_FILE;
		if (path.isAbsolute(configuredPath)) {
			return configuredPath;
		}

		const projectDirectory = await resolveProjectDirectory(cwd);
		return path.resolve(projectDirectory, configuredPath);
	};

	const loadRules = async (ctx: ExtensionContext, force: boolean): Promise<IReminderRule[]> => {
		const rulesFilePath = await resolveRulesFilePath(ctx.cwd);

		let mtimeMs = -1;
		try {
			const stats = await stat(rulesFilePath);
			mtimeMs = stats.mtimeMs;
		} catch (error) {
			rulesCache = [];
			rulesMtimeMs = -1;
			hasLoadedRules = true;

			if (isRecord(error) && error.code === "ENOENT") {
				lastLoadError = "";
				return rulesCache;
			}

			const errorMessage = getErrorMessage(error);
			if (errorMessage !== lastLoadError && ctx.hasUI) {
				ctx.ui.notify(`Failed to stat reminder rules file: ${errorMessage}`, "warning");
			}
			lastLoadError = errorMessage;
			return rulesCache;
		}

		if (!force && hasLoadedRules && mtimeMs === rulesMtimeMs) {
			return rulesCache;
		}

		try {
			const raw = await readFile(rulesFilePath, "utf8");
			const parsed: unknown = JSON.parse(raw);
			rulesCache = parseRules(parsed);
			rulesMtimeMs = mtimeMs;
			hasLoadedRules = true;
			lastLoadError = "";
			globMatcherCache.clear();
			return rulesCache;
		} catch (error) {
			rulesCache = [];
			rulesMtimeMs = mtimeMs;
			hasLoadedRules = true;
			const errorMessage = getErrorMessage(error);
			if (errorMessage !== lastLoadError && ctx.hasUI) {
				ctx.ui.notify(`Failed to parse reminder rules file: ${errorMessage}`, "warning");
			}
			lastLoadError = errorMessage;
			return rulesCache;
		}
	};

	const maybeInjectReminder = (
		ctx: ExtensionContext,
		rule: IReminderRule,
		matchedPath: string,
	): void => {
		const reminderKey = buildReminderKey(rule.reminder);
		if (injectedReminderKeys.has(reminderKey)) {
			return;
		}

		injectedReminderKeys.add(reminderKey);
		pi.appendEntry(INJECTED_ENTRY_TYPE, {
			reminderKey,
			glob: rule.glob,
			reminder: rule.reminder,
			matchedPath,
			injectedAt: new Date().toISOString(),
		});

		if (ctx.isIdle()) {
			pi.sendUserMessage(rule.reminder);
		} else {
			pi.sendUserMessage(rule.reminder, { deliverAs: "steer" });
		}
	};

	const onSessionChanged = async (_ctxEvent: unknown, ctx: ExtensionContext): Promise<void> => {
		rebuildInjectedReminderKeys(ctx);
		await loadRules(ctx, true);
	};

	pi.on("session_start", onSessionChanged);
	pi.on("session_switch", onSessionChanged);
	pi.on("session_fork", onSessionChanged);
	pi.on("session_tree", onSessionChanged);

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) {
			return;
		}

		const changedPaths = getChangedPaths(event.toolName, event.input);
		if (changedPaths.length === 0) {
			return;
		}

		const rules = await loadRules(ctx, false);
		if (rules.length === 0) {
			return;
		}

		for (const changedPath of changedPaths) {
			const absolutePath = path.isAbsolute(changedPath)
				? path.normalize(changedPath)
				: path.resolve(ctx.cwd, changedPath);
			const normalizedAbsolutePath = normalizePath(absolutePath);
			const normalizedRelativePath = normalizePath(path.relative(ctx.cwd, absolutePath));

			for (const rule of rules) {
				if (
					matchesRule(
						rule.glob,
						normalizedRelativePath,
						normalizedAbsolutePath,
						globMatcherCache,
					)
				) {
					maybeInjectReminder(ctx, rule, normalizedRelativePath);
				}
			}
		}
	});
}

function parseRules(parsed: unknown): IReminderRule[] {
	if (!Array.isArray(parsed)) {
		return [];
	}

	const rules: IReminderRule[] = [];
	for (const item of parsed) {
		if (!isRecord(item)) {
			continue;
		}

		const glob = readNonEmptyString(item.glob);
		const reminder = readNonEmptyString(item.reminder);
		if (glob === null || reminder === null) {
			continue;
		}

		rules.push({
			glob: normalizePath(glob),
			reminder,
		});
	}

	return rules;
}

function getChangedPaths(toolName: string, input: unknown): string[] {
	if ((toolName === "write" || toolName === "edit") && isToolInputWithPath(input)) {
		return [input.path];
	}

	if (toolName !== "multi_tool_use.parallel") {
		return [];
	}

	if (!isRecord(input) || !Array.isArray(input.tool_uses)) {
		return [];
	}

	const changedPaths: string[] = [];
	for (const toolUse of input.tool_uses) {
		if (!isRecord(toolUse)) {
			continue;
		}

		const recipientName = readNonEmptyString(toolUse.recipient_name);
		if (recipientName === null) {
			continue;
		}

		const isWriteCall = recipientName.endsWith(".write");
		const isEditCall = recipientName.endsWith(".edit");
		if (!isWriteCall && !isEditCall) {
			continue;
		}

		if (isToolInputWithPath(toolUse.parameters)) {
			changedPaths.push(toolUse.parameters.path);
		}
	}

	return changedPaths;
}

function isToolInputWithPath(input: unknown): input is IToolInputWithPath {
	return isRecord(input) && typeof input.path === "string" && input.path.length > 0;
}

function matchesRule(
	ruleGlob: string,
	relativePath: string,
	absolutePath: string,
	globMatcherCache: Map<string, (candidatePath: string) => boolean>,
): boolean {
	const normalizedGlob = normalizePath(ruleGlob);
	if (path.isAbsolute(normalizedGlob)) {
		return matchesGlob(normalizedGlob, absolutePath, globMatcherCache);
	}

	return matchesGlob(normalizedGlob, relativePath, globMatcherCache);
}

function matchesGlob(
	globPattern: string,
	candidatePath: string,
	globMatcherCache: Map<string, (candidatePath: string) => boolean>,
): boolean {
	let matcher = globMatcherCache.get(globPattern);
	if (matcher === undefined) {
		const picomatchMatcher = picomatch(globPattern, { dot: true });
		matcher = (value: string): boolean => picomatchMatcher(value);
		globMatcherCache.set(globPattern, matcher);
	}

	return matcher(candidatePath);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function normalizePath(filePath: string): string {
	const forwardSlashPath = filePath.replaceAll("\\", "/");
	if (forwardSlashPath.startsWith("./")) {
		return forwardSlashPath.slice(2);
	}
	return forwardSlashPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return null;
	}

	return trimmed;
}

function buildReminderKey(reminder: string): string {
	return reminder.trim();
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) {
		return error.message;
	}
	return String(error);
}
