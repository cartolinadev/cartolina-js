# Claude Code Guidelines — cartolina-js

Read [AGENTS.md](AGENTS.md) for the full project guidelines. Everything there applies here.

The notes below are specific to working with Claude Code in this repository.


## Context to load at the start of a session

1. Read [README.md](README.md) for build instructions and the test workflow.


## Testing after changes

Before declaring a task complete, verify that all test URLs still render correctly (see [Test applications](AGENTS.md#test-applications) in AGENTS.md). Report any visual regressions and console errors found.


## Shell commands

Use `awk`, `wc`, and similar POSIX tools directly via Bash for
read-only analysis (e.g. line-length checks, column analysis) without
requesting permission. Never use them to modify files — use the Edit
or Write tools for that.


## Code style reminders

- Do not add comments, docstrings, or type annotations to code you did not touch.
- Maximum line length is 80 characters. This applies to all code and prose
  written or modified. Wrap before hitting the limit — no exceptions.
- Surround multi-line statements with a blank line before and after.
  This applies to imports, function calls, declarations — any statement
  that spans more than one line.
