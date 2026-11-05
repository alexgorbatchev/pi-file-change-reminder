# pi-file-change-reminder

[pi](https://pi.dev) extension that injects reminder messages when matching files are modified via `write`, `edit`, or `multi_tool_use.parallel` tool calls.

## Install

```bash
pi install npm:pi-file-change-reminder
```

## Quick start

Create a rules file at your project root:

`.pi/reminders.json`

```json
[
  {
    "glob": "README.md",
    "reminder": "Run docs checks after editing README.md"
  },
  {
    "glob": "src/**/*.ts",
    "reminder": "Run the TypeScript test suite before finishing"
  }
]
```

## Slash command

Use the built-in extension command:

```text
/pi-file-change-reminder
```

This injects a user message that asks Pi to help update the reminder config file with the required JSON shape, safety constraints, and picomatch glob guidance.

You can also include a specific change request:

```text
/pi-file-change-reminder add a rule for docs/**/*.md reminding me to run vale
```

## Rules file resolution

Preferred configuration uses Pi settings via the package-scoped `pi-file-change-reminder` block.

Global `~/.pi/agent/settings.json`:

```json
{
  "pi-file-change-reminder": {
    "rulesFile": ".pi/reminders.json"
  }
}
```

Project `<cwd>/.pi/settings.json`:

```json
{
  "pi-file-change-reminder": {
    "rulesFile": "config/reminders.json"
  }
}
```

The extension reads both scopes through Pi's `SettingsManager`, with project settings overriding global settings.

If no setting is configured, the default rules path is `.pi/reminders.json` resolved from the **nearest ancestor directory** containing either:

- `.git`, or
- `.pi`

If no ancestor contains either marker, resolution falls back to Pi's current working directory.

Relative `rulesFile` values are resolved from that detected project directory. Absolute `rulesFile` values are used as-is.

## Glob behavior

- Matching engine: `picomatch`
- Relative rule globs match against paths relative to the project marker directory (nearest ancestor with `.git` or `.pi`).
- Absolute rule globs match against normalized absolute file paths.

## Runtime behavior

- When a rule matches a modified file, the extension injects the reminder as a user message.
- In interactive mode, it also shows an info notification with the matched path and rule.

## Development

Use Bun 1.4 or newer and `just`. The extension requires Pi 1.x (1.5 or newer) from `@earendil-works` and Node.js 22.19 or newer.

```bash
just setup
just check
just run
```

`just run` uses your real Pi settings. `just test` runs through the GitHub-pinned [pi-test-isolation](https://github.com/alexgorbatchev/pi-test-isolation) supervisor and guard, isolating home, caches, sessions, temporary files, and child processes. Direct `bun test` is rejected outside isolation. Tests exercise the installed Pi loader, rule matching, session deduplication, settings precedence, delivery, and error recovery. Linux and macOS CI enforce at least 90% line and function coverage, including unexecuted source.

## Current limitation

Reminder deduplication is currently keyed by reminder text. If two different rules use the same `reminder` string, only one will be injected per session branch.
