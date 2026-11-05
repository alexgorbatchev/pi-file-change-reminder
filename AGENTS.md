---
created_on: 2026-11-05 11:35
last_modified: 2026-11-05 11:35
status: current
---

# pi-file-change-reminder

Pi extension that matches modified files to reminder rules and injects each reminder once per session branch.

## Commands

- `just setup`: install locked dependencies with Bun 1.4 or newer.
- `just run`: launch the installed Pi with the local extension and real user settings.
- `just check`: read-only formatting, lint, type, unused-code, and test coverage checks.
- `just test`: execute the suite under the shared Pi isolation supervisor.
- `just fmt`: format TypeScript, configuration, and the justfile.

## Runtime contracts

- Keep the default extension export at `src/fileChangeReminderExtension.ts`; the Pi manifest and package export identify this entrypoint.
- Use the maintained `@earendil-works/pi-coding-agent` SDK with an explicit compatible peer range.
- Project settings override global settings. Resolve relative rule paths from the nearest ancestor containing `.git` or `.pi`; match relative globs from that directory too.
- Use picomatch for glob matching, including dotfiles, rather than introducing custom glob parsing.
- Deduplicate by trimmed reminder text within the current session branch; rebuild that state from custom session entries after session changes.
- Idle reminders are normal user messages; busy reminders steer the active run. The edit command instead queues a follow-up when busy.
- Preserve actionable settings/rules errors and suppress repeated identical UI notifications until recovery.

## Tests and artifacts

- For executable behavior changes, add or update meaningful behavioral tests using the installed Pi loader and event runner.
- Require at least 90% line and function coverage over non-test first-party source, including unexecuted modules. `just test` enforces both metrics; the coverage preload imports every source module. Tests and fixtures are excluded; exclude `scripts/` if introduced.
- Keep environment-file loading disabled in Bun and retain the shared isolation preload. Direct `bun test` must fail outside an isolated run.
- Consume the shared `@alexgorbatchev/pi-test-isolation` runner and guard from a pinned GitHub tag; do not copy them into this repository.
- Tests remove owned files and processes on every outcome. The supervisor owns private home, caches, sessions, and scratch, and waits for its process group before removal. It is not a filesystem sandbox.
- Rule cache tests must control modification times explicitly instead of depending on sub-millisecond filesystem timing.
- Keep disposable artifacts in task-owned `.tmp/` children, retained records in `.state/`, and regenerable caches in `.cache/`. Never remove shared scratch by directory name.
- After test changes, compare checkout scratch, system temporary files, and child processes before and after the run.
- Keep tests, fixtures, and tooling out of the published package. Verify package contents before publishing.

## Publication

- Commit the lockfile and keep CI on the verified Bun version.
- Publish required tags, releases, and packages through the existing workflow after checks pass; align the tag and package version.
- Never publish private hostnames, credentials, or private tracker references.
