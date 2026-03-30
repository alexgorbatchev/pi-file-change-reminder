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

This package uses npm.

```bash
npm install
npm run check
```

Or run the individual checks:

```bash
npm run typecheck
npm run verify:pi-load
```

## Current limitation

Reminder deduplication is currently keyed by reminder text. If two different rules use the same `reminder` string, only one will be injected per session branch.
