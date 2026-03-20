# pi-file-change-reminder

[pi](https://pi.dev) extension that injects reminder messages when matching files are modified via `write`, `edit`, or `multi_tool_use.parallel` tool calls.

## Install

### Local path

```bash
pi install /absolute/path/to/pi-file-change-reminder
```

### npm (after publish)

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

## Rules file resolution

Default rules path is `.pi/reminders.json` resolved from the **nearest ancestor directory** containing either:

- `.git`, or
- `.pi`

If no ancestor contains either marker, resolution falls back to Pi's current working directory.

You can override with `PI_REMINDERS_FILE`:

```bash
export PI_REMINDERS_FILE=/absolute/path/to/reminders.json
```

If `PI_REMINDERS_FILE` is relative, it is resolved from the detected project directory (same logic as above).

## Glob behavior

- Matching engine: `picomatch`
- Relative rule globs match against paths relative to Pi's current working directory.
- Absolute rule globs match against normalized absolute file paths.

## Development

```bash
npm install
npm run typecheck
npm run verify:pi-load
```

## Current limitation

Reminder deduplication is currently keyed by reminder text. If two different rules use the same `reminder` string, only one will be injected per session branch.
