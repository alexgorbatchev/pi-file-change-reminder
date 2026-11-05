import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionActions, ExtensionError, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fileChangeReminderExtension from "../fileChangeReminderExtension.js";

const extensionPath = fileURLToPath(new URL("../fileChangeReminderExtension.ts", import.meta.url));
const globalSettingsPath = path.join(getAgentDir(), "settings.json");
let projectDir = "";
let runner: ExtensionRunner;
let session: SessionManager;
let messages: Parameters<ExtensionActions["sendUserMessage"]>[];
let notifications: Parameters<ExtensionUIContext["notify"]>[];
let errors: ExtensionError[];
let isIdle = true;

async function createRunner(cwd = projectDir): Promise<void> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [fileChangeReminderExtension],
  });
  await loader.reload();
  const result = loader.getExtensions();
  expect(result.errors).toEqual([]);
  result.runtime.sendUserMessage = (...args) => {
    messages.push(args);
  };
  result.runtime.appendEntry = (customType, data) => {
    session.appendCustomEntry(customType, data);
  };
  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
    modelsPath: null,
  });
  runner = new ExtensionRunner(result.extensions, result.runtime, cwd, session, new ModelRegistry(modelRuntime));
  runner.bindCore(result.runtime, {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => isIdle,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => assert.fail("Unexpected abort"),
    hasPendingMessages: () => false,
    shutdown: () => assert.fail("Unexpected shutdown"),
    getContextUsage: () => undefined,
    compact: () => assert.fail("Unexpected compaction"),
    getSystemPrompt: () => "",
  });
  runner.setUIContext({
    ...runner.getUIContext(),
    notify: (...args) => {
      notifications.push(args);
    },
  });
  runner.onError((error) => {
    errors.push(error);
  });
}

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "pi-reminder-behavior-"));
  await mkdir(path.join(projectDir, ".pi"));
  messages = [];
  notifications = [];
  errors = [];
  isIdle = true;
  session = SessionManager.inMemory(projectDir);
  await createRunner();
});

afterEach(async () => {
  await rm(globalSettingsPath, { force: true });
  await rm(projectDir, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

async function writeRules(value: unknown, file = path.join(projectDir, ".pi/reminders.json")): Promise<void> {
  await Bun.write(file, JSON.stringify(value));
}

async function emitToolResult(toolName: string, input: Record<string, unknown>, isError = false): Promise<void> {
  await runner.emitToolResult({
    type: "tool_result",
    toolCallId: "test-call",
    toolName,
    input,
    isError,
    content: [],
    details: undefined,
  });
}

async function startSession(): Promise<void> {
  await runner.emit({ type: "session_start", reason: "startup" });
}

async function runCommand(args: string): Promise<void> {
  const command = runner.getCommand("pi-file-change-reminder");
  assert(command);
  await command.handler(args, runner.createCommandContext());
}

test("loads through Pi's file loader and registers the command", async () => {
  const loader = new DefaultResourceLoader({
    cwd: projectDir,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [extensionPath],
  });
  await loader.reload();
  const result = loader.getExtensions();
  expect(result.errors).toEqual([]);
  expect(result.extensions.map((extension) => [extension.path, [...extension.commands.keys()]])).toEqual([
    [extensionPath, ["pi-file-change-reminder"]],
  ]);
});

describe("matching and delivery", () => {
  test("matches edits and writes, deduplicates reminder text, and records branch state", async () => {
    await writeRules([
      { glob: "src/**/*.ts", reminder: "Run tests" },
      { glob: "**/*.ts", reminder: " Run tests " },
    ]);
    await startSession();
    await emitToolResult("write", { path: "src/first.ts" });
    await emitToolResult("edit", { path: "src/second.ts" });
    expect(messages).toEqual([["Run tests", undefined]]);
    expect(notifications).toEqual([["Auto reminder injected for src/first.ts (rule: src/**/*.ts)", "info"]]);
    const entries = session.getBranch();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "custom",
      customType: "file-change-reminder.injected",
      data: {
        reminderKey: "Run tests",
        glob: "src/**/*.ts",
        reminder: "Run tests",
        matchedPath: "src/first.ts",
      },
    });
  });

  test("steers busy sessions and supports absolute globs and paths", async () => {
    isIdle = false;
    await writeRules([{ glob: path.join(projectDir, "src/*.ts"), reminder: "Check absolute file" }]);
    await emitToolResult("edit", { path: path.join(projectDir, "src/test.ts") });
    expect(messages).toEqual([["Check absolute file", { deliverAs: "steer" }]]);
  });

  test("injects headlessly without UI notifications", async () => {
    runner.setUIContext();
    await writeRules([{ glob: "./.config/*.json", reminder: "Review config" }]);
    await emitToolResult("write", { path: ".config/config.json" });
    expect(messages).toEqual([["Review config", undefined]]);
    expect(notifications).toEqual([]);
  });

  test("extracts valid nested writes and edits from parallel tool results", async () => {
    await writeRules([{ glob: "**/*.ts", reminder: "Typecheck" }]);
    await emitToolResult("multi_tool_use.parallel", {
      tool_uses: [
        null,
        {},
        { recipient_name: " " },
        { recipient_name: "functions.read", parameters: { path: "read.ts" } },
        { recipient_name: "functions.write", parameters: {} },
        { recipient_name: "functions.write", parameters: { path: "one.ts" } },
        { recipient_name: "functions.edit", parameters: { path: "two.ts" } },
      ],
    });
    expect(messages).toEqual([["Typecheck", undefined]]);
  });

  test.each(["read", "unknown", "write", "multi_tool_use.parallel"])(
    "ignores non-writing or malformed %s calls",
    async (toolName) => {
      await writeRules([{ glob: "**/*", reminder: "Must not inject" }]);
      await emitToolResult(toolName, {});
      expect(messages).toEqual([]);
    },
  );

  test("ignores failed writes and unmatched paths", async () => {
    await writeRules([{ glob: "src/**/*.ts", reminder: "Must not inject" }]);
    await emitToolResult("write", { path: "src/test.ts" }, true);
    await emitToolResult("write", { path: "README.md" });
    expect(messages).toEqual([]);
  });

  test("skips malformed rules but uses valid trimmed and normalized rules", async () => {
    await writeRules([
      null,
      {},
      { glob: "", reminder: "bad" },
      { glob: "*.ts", reminder: 3 },
      { glob: "src\\*.ts", reminder: "  Valid rule  " },
    ]);
    await emitToolResult("write", { path: "src/valid.ts" });
    expect(messages).toEqual([["Valid rule", undefined]]);
  });

  test.each([{}, null, [], "invalid"].map((rules) => [rules]))(
    "ignores a non-list or empty rules document: %j",
    async (rules) => {
      await writeRules(rules);
      await emitToolResult("write", { path: "one.ts" });
      expect(messages).toEqual([]);
    },
  );
});

describe("settings and rule reloads", () => {
  test("loads project settings before global settings", async () => {
    await Bun.write(globalSettingsPath, JSON.stringify({ "pi-file-change-reminder": { rulesFile: "global.json" } }));
    await Bun.write(
      path.join(projectDir, ".pi/settings.json"),
      JSON.stringify({ "pi-file-change-reminder": { rulesFile: "project.json" } }),
    );
    await writeRules([{ glob: "*.ts", reminder: "Project" }], path.join(projectDir, "project.json"));
    await writeRules([{ glob: "*.ts", reminder: "Global" }], path.join(projectDir, "global.json"));
    await emitToolResult("write", { path: "test.ts" });
    expect(messages).toEqual([["Project", undefined]]);
  });

  test("resolves absolute global rules paths", async () => {
    const rulesPath = path.join(projectDir, "custom.json");
    await Bun.write(globalSettingsPath, JSON.stringify({ "pi-file-change-reminder": { rulesFile: rulesPath } }));
    await writeRules([{ glob: "*.ts", reminder: "Global" }], rulesPath);
    await emitToolResult("write", { path: "test.ts" });
    expect(messages).toEqual([["Global", undefined]]);
  });

  test("finds the ancestor marker when invoked below the project root", async () => {
    const nested = path.join(projectDir, "src/nested");
    await mkdir(nested, { recursive: true });
    await createRunner(nested);
    await writeRules([{ glob: "src/**/*.ts", reminder: "From root" }]);
    await emitToolResult("write", { path: "test.ts" });
    expect(messages).toEqual([["From root", undefined]]);
  });

  test("reloads changed rules after mtime changes", async () => {
    const rulesPath = path.join(projectDir, ".pi/reminders.json");
    await writeRules([{ glob: "*.ts", reminder: "First" }]);
    await emitToolResult("write", { path: "test.ts" });
    await writeRules([{ glob: "*.ts", reminder: "Updated" }]);
    await utimes(rulesPath, new Date(2000), new Date(2000));
    await emitToolResult("write", { path: "test.ts" });
    expect(messages).toEqual([
      ["First", undefined],
      ["Updated", undefined],
    ]);
  });

  test("handles a missing rules file and later discovers it", async () => {
    await startSession();
    await emitToolResult("write", { path: "test.ts" });
    expect(messages).toEqual([]);
    await writeRules([{ glob: "*.ts", reminder: "New file" }]);
    await emitToolResult("write", { path: "test.ts" });
    expect(messages).toEqual([["New file", undefined]]);
  });

  test("restores deduplication from branch entries on session changes", async () => {
    session.appendMessage({ role: "user", content: "Existing prompt", timestamp: 1 });
    session.appendCustomEntry("other", {});
    session.appendCustomEntry("file-change-reminder.injected", null);
    session.appendCustomEntry("file-change-reminder.injected", { reminderKey: " " });
    session.appendCustomEntry("file-change-reminder.injected", { reminderKey: "Existing" });
    await writeRules([{ glob: "*.ts", reminder: "Existing" }]);
    await runner.emit({ type: "session_tree", newLeafId: session.getLeafId(), oldLeafId: null });
    await emitToolResult("write", { path: "test.ts" });
    expect(messages).toEqual([]);
  });

  test("reports malformed JSON once and recovers after repair", async () => {
    const rulesPath = path.join(projectDir, ".pi/reminders.json");
    await Bun.write(rulesPath, "{");
    await startSession();
    await startSession();
    expect(notifications).toHaveLength(1);
    const notification = notifications[0];
    assert(notification);
    expect(notification).toEqual(["Failed to parse reminder rules file: JSON Parse error: Expected '}'", "warning"]);
    await writeRules([{ glob: "*.ts", reminder: "Recovered" }]);
    await utimes(rulesPath, new Date(2000), new Date(2000));
    await emitToolResult("write", { path: "test.ts" });
    expect(messages).toEqual([["Recovered", undefined]]);
  });
});

describe("error recovery", () => {
  test("warns once for invalid settings and clears the warning after repair", async () => {
    const settingsPath = path.join(projectDir, ".pi/settings.json");
    await Bun.write(settingsPath, "{");
    await startSession();
    await startSession();
    expect(notifications).toEqual([
      ["Failed to load reminder settings: project: JSON Parse error: Expected '}'", "warning"],
    ]);
    await Bun.write(settingsPath, "{}");
    await startSession();
    await Bun.write(settingsPath, "{");
    await startSession();
    expect(notifications).toHaveLength(2);
  });

  test("reports non-ENOENT stat failures without repeatedly notifying", async () => {
    const file = path.join(projectDir, "not-a-directory");
    const rulesPath = path.join(file, "rules.json");
    await Bun.write(file, "file");
    await Bun.write(
      path.join(projectDir, ".pi/settings.json"),
      JSON.stringify({ "pi-file-change-reminder": { rulesFile: rulesPath } }),
    );
    const errorMessage = await stat(rulesPath).catch((error: unknown) => {
      assert(error instanceof Error);
      return error.message;
    });
    assert(typeof errorMessage === "string");
    await startSession();
    await startSession();
    expect(notifications).toEqual([[`Failed to stat reminder rules file: ${errorMessage}`, "warning"]]);
    expect(messages).toEqual([]);
  });
});

describe("edit command", () => {
  test("sends complete edit guidance while idle", async () => {
    await runCommand("");
    expect(messages).toHaveLength(1);
    const message = messages[0];
    assert(message && typeof message[0] === "string");
    expect(message[0].replaceAll(projectDir, "<project>")).toMatchInlineSnapshot(`
      "Help me update this project reminder configuration file:
      - <project>/.pi/reminders.json

      Purpose of this file:
      - It defines reminders that are auto-injected when matching files are changed.
      - Each rule maps a file pattern (glob) to a reminder message sent to the agent.

      Glob usage:
      - 'glob' uses picomatch syntax (for example *, **, ?, braces like {ts,tsx}, and extglobs).
      - Relative globs are matched from the project marker directory: <project>
      - Example relative glob: src/**/*.ts
      - The project marker directory is the nearest ancestor containing .git or .pi.
      - Absolute globs are matched against normalized absolute file paths.
      - Use specific patterns to avoid noisy reminders.

      Requirements:
      - Keep valid JSON with a top-level array.
      - Each rule must have non-empty string fields: glob, reminder.
      - Preserve existing rules unless my request says otherwise.
      - Use 2-space indentation.

      Explain what changes you recommend, then ask me what to add, edit, or remove."
    `);
    expect(message[1]).toBeUndefined();
  });

  test("queues requested edits as follow-up when busy", async () => {
    isIdle = false;
    await runCommand("  Add docs reminder  ");
    const message = messages[0];
    assert(message && typeof message[0] === "string");
    expect(message[0].replaceAll(projectDir, "<project>")).toMatchInlineSnapshot(`
      "Help me update this project reminder configuration file:
      - <project>/.pi/reminders.json

      Purpose of this file:
      - It defines reminders that are auto-injected when matching files are changed.
      - Each rule maps a file pattern (glob) to a reminder message sent to the agent.

      Glob usage:
      - 'glob' uses picomatch syntax (for example *, **, ?, braces like {ts,tsx}, and extglobs).
      - Relative globs are matched from the project marker directory: <project>
      - Example relative glob: src/**/*.ts
      - The project marker directory is the nearest ancestor containing .git or .pi.
      - Absolute globs are matched against normalized absolute file paths.
      - Use specific patterns to avoid noisy reminders.

      Requirements:
      - Keep valid JSON with a top-level array.
      - Each rule must have non-empty string fields: glob, reminder.
      - Preserve existing rules unless my request says otherwise.
      - Use 2-space indentation.

      Apply this requested change: Add docs reminder"
    `);
    expect(message[1]).toEqual({ deliverAs: "followUp" });
    expect(notifications).toEqual([["Queued /pi-file-change-reminder prompt as a follow-up message.", "info"]]);
  });
});
