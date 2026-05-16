# Claude Code Guidelines — cartolina-js

Read [AGENTS.md](AGENTS.md) for the full project guidelines. Everything there applies here.

The notes below are specific to working with Claude Code in this repository.


## Context to load at the start of a session

1. Read [README.md](README.md) for build instructions and the test workflow.


## Testing after changes

Before declaring a task complete, verify that all test URLs still render
correctly (see [Test applications](AGENTS.md#test-applications) in
AGENTS.md). Report any visual regressions and console errors found.

**Critical:** the dev server (`npm start`) serves its last successful
webpack compilation. If any compilation error appears in the screenshot
test output — even apparently unrelated ones — the server is serving
stale code. Stop. Do not report those tests as valid.

The correct pre-test sequence when source files have changed:

1. Run `npx tsc --noEmit` and fix all type errors first.
2. Restart the dev server so it picks up any `webpack.config.js`
   changes and compiles fresh: stop the running server, then
   `npm start` again (or ask the user to do so).
3. Confirm the first screenshot test output contains no webpack
   compilation errors before declaring results valid.

Note: `npx tsc` only checks TypeScript files. JavaScript files
(`browser.js`, `interface.js`, etc.) are not checked by tsc. Bugs in
those files will not be caught by type checking alone — they require
the screenshot tests to exercise the affected code paths.

## Shell commands

The following categories of commands may be run without requesting
permission:

- POSIX read-only analysis: `awk`, `wc`, `sed`, `grep`, `cut`, `sort`,
  `uniq`, `head`, `tail` and pipelines thereof.
- TypeScript compilation: `npx tsc` with any flags.
- Test screenshots: `node test/screenshot.js [id]`.
- Dev server queries: `curl http://localhost:8080/...`.

Never use shell commands to modify files — use the Edit or Write tools.


## Commits

Commit when there is a clear, meaningful reason: the workflow
prescribes it (e.g. RFC protocol requires committing before acting on
a review), a logical unit of work is complete, or the user asks.

Do not commit after every small change. Multiple edits that belong
to the same logical unit — a review response, a section rewrite, an
AGENTS.md update — are one commit, not several. If a mistake is
discovered in an unpushed commit, amend it; do not create a
correction commit.

## Code style reminders

- Follow the documentation rules in [AGENTS.md](AGENTS.md).
- Maximum line length is 80 characters. This applies to all code and prose
  written or modified. Wrap before hitting the limit — no exceptions.
- Surround multi-line statements with a blank line before and after.
  This applies to imports, function calls, declarations — any statement
  that spans more than one line.
