# Agent Guidelines — cartolina-js

## Documentation ownership

Cartolina consists of the `cartolina-js` frontend in this repository and the
`cartolina-tileserver` backend in its sister repository. Documentation is
split by scope.

The [docs/wiki/](docs/wiki/) directory contains documentation for the project
as a whole. It also contains frontend documentation, frontend/backend
interface documentation, all RFCs, the shared backlog, and work that spans
both repositories. Read it at the start of a session to orient yourself
before touching unfamiliar code.

Documentation specific to the tileserver implementation belongs in the
[cartolina-tileserver documentation][tileserver-documentation]. This includes
operator guides, implementation notes, tool documentation, and the tileserver
session log.

Read the tileserver documentation index when work involves tileserver
behavior. Record significant work confined to the tileserver in its session
log. Record project-wide or cross-repository work in this wiki's session log.
For work that materially changes both repositories, add concise entries to
both logs and link them instead of duplicating the full account.

While agents and humans do their best to keep the wiki up to date, it
may drift from the code over time.

At an appropriate moment during a session, or whenever an explicit wiki
update is requested, check whether the changes made in the current
session have caused the wiki to drift. If they have, update the wiki:
remove obsolete or no longer factual parts, and add or revise the
relevant information.

**What belongs in the wiki:**

- Project-wide architecture and non-obvious design decisions.
- All RFCs, including RFCs for changes confined to the tileserver.
- Frontend documentation and frontend/backend interface documentation.
- Findings that are not obvious from reading the code — e.g. subtle
  runtime interactions, historical reasons for a design choice,
  gotchas discovered during debugging.
- A session log entry for each significant body of work: goal, key
  decisions, and anything surprising found along the way.

**What does not belong:**

- Mature documentation specific to `cartolina-tileserver`, including
  operator guides, tool inventories, and implementation guides.
- Transcripts of conversation or iterative back-and-forth.
- Things that are obvious from reading the code or git history.
- Temporary notes or in-progress state.
- Trivial edits that do not change architecture, behavior, workflow, or
  non-obvious project knowledge.
- Removed APIs, deleted branches, or no-longer-existing behavior. Do
  not keep comparison baggage in current docs. Mention legacy code only
  when that code still exists and must be maintained for compatibility;
  once it is removed, describe the current behavior instead.
- Private application names, private hostnames, customer or
  partner names, proprietary dataset names, or third-party service names
  learned from local/private integration work. Public documentation in
  this repository must describe the software behavior in generic terms,
  such as "legacy pre-v6 backend" or "private integration dataset,"
  unless the name is already part of this public repository's committed
  source or public project identity.
- Any reference to private validation or private data, in any form.
  This includes generic allusions ("validated against a private
  integration", "a private trace confirmed", "an internal dataset
  shows"), not just names, URLs, coordinates, screenshots, performance
  numbers, and hostnames. Public documentation must be self-contained:
  a reader with only this repository, its sister tileserver repository,
  and public test data must be able to check every claim. State
  mechanisms in terms of the code, and cite only reproducible public
  cases as evidence. Records of private validation belong in the
  private counterpart repository; when a finding rests solely on
  private data, this repository records only what the code shows.
- Never name, link to, or describe the existence or layout of a private
  companion repository. Public commits must stand alone; private material
  is organized entirely from the private repository.
- Do not copy production service URLs, proxy routes, request-rewrite recipes,
  access workarounds, or data-source configuration from an integration into
  this repository. This applies to demos, tests, documentation, comments,
  commit messages, and configuration. A generic API example must use neutral
  placeholders such as `https://tiles.example.com`, not a real third-party
  endpoint.
- Public demos may use only project-controlled public resources or resources
  already approved in the public test configuration. Never make a legacy demo
  work by replacing its source with an endpoint observed in another product.
- Before publishing a branch informed by non-public work, inspect the complete
  branch diff from its public merge base and search every added line for
  private names, URLs, proxy logic, data descriptions, validation claims, and
  companion-repository references. A clean tip is insufficient: if prohibited
  material entered an unpublished commit, rewrite that commit and audit every
  rewritten tree before pushing.

Keep entries concise. A future engineer (or agent) should be able to
read a page and immediately understand the decision, not reconstruct it
from noise.

**Writing style:** plain engineering prose. Every sentence must carry
information. No filler phrases ("the trade-offs are real", "it is worth
noting", "importantly", "indeed"), no charged adjectives or adverbs
("enormously", "powerful", "seamless", "fundamentally", "critically").
If something matters, state what it does; do not editorialize about how
much it matters.

Write wiki entries with a maximum line length of 80 characters. Tables
and code blocks are exempt.

Documentation must use repository-relative paths for files in this working
copy and web links for files in other repositories. Do not write user-local
absolute paths, temporary directories, editor paths, agent scratch-plan
locations, or relative paths into a sibling checkout. If an external local
artifact informed the work, summarize the relevant conclusion without
recording its path.

**Files:**

- [index.md](docs/wiki/index.md) — wiki landing page and table of
  contents.
- [architecture.md](docs/wiki/architecture.md) — system structure,
  key subsystems, and non-obvious implementation details.
- [label-styling-engine.md](docs/wiki/label-styling-engine.md) —
  reference notes for the shared lettering/style engine.
- [session-log.md](docs/wiki/session-log.md) — record of significant
  work sessions, top-posted: the newest entry goes at the top of the
  file, directly under the `# Session log` heading.
- [cartolina-tileserver documentation][tileserver-documentation] — entry
  point for tileserver-specific documentation and its session log.

[tileserver-documentation]: https://github.com/cartolinadev/cartolina-tileserver/blob/main/docs/index.md

### RFCs

An RFC is a design document for a feature or change that is too
broad or consequential to capture in a backlog entry. RFCs record
the motivation, alternatives considered, proposed design, and
migration plan. They are functional documentation: they remain
authoritative until the feature is fully implemented, then become
historical record.

RFC files live in `docs/wiki/` and are named `rfc<N>-<slug>.md`,
where `<N>` is the RFC number, zero-padded to two digits (`rfc01`
through `rfc99`) so filenames align in a directory listing. They are
listed in the **RFCs** section of `index.md`.

RFCs are numbered in a single plain-integer sequence in order of
creation. A new RFC takes the next unused integer, counting RFCs
that exist only on unmerged design branches. The number appears
zero-padded in the filename, but as a plain integer in the document
title (`# RFC 7: ...`) and in the index listings.

**Lifecycle:**

- A backlog entry may be promoted to an RFC when the scope grows
  beyond what a single paragraph can describe accurately.
- An RFC may be demoted to a backlog entry when scoping reveals
  the change is smaller than it appeared, or the design collapses
  into a straightforward implementation decision.
- An RFC is closed (marked **Implemented** in the Status line) when
  all implementation steps are done and the document no longer
  describes future work. Do not delete closed RFCs.

**Review process:**

Author and reviewer are peers. Neither role carries authority over the
other. A reviewer note is not an instruction; an author response is not
a concession. What prevails is facts, sound reasoning, and the rules
established in this document and the broader project documentation.

A reviewer appends a numbered review section (`## Review round N`) to
the RFC with their notes. The author then:

1. Commits the RFC as-is before making any changes, to preserve the
   reviewed state.
2. Addresses each note in the document — fixing, partially fixing, or
   rejecting with explanation.
3. Below each reviewer note, appends an italicised author comment
   using one of: *Adopted.*, *Partially adopted.*, or *Rejected.*,
   followed by a brief explanation. (Earlier RFCs used *Implemented.*
   for the same verdict; that wording was retired because it reads as
   a claim about code, not about the design text.)
4. Does not alter the reviewer's original note text.
5. Waits for the reviewer to either sign off or open the next round.

A rejected note that the reviewer considers unresolved is re-raised
in the next round. Rounds continue until all notes are either
accepted by the reviewer or dropped. Author and reviewer are
expected to converge.

To sign off, the reviewer appends a final section
(`## Review round N — sign-off`) stating that the design is
accepted, with any remaining editorial notes that are not blockers.
The reviewer then changes the status line to `Accepted`. The author
does not respond to a sign-off section; it closes the review.

**Post-acceptance addenda:**

The signed-off design body and review rounds are immutable. Implementation
history is appended after the sign-off as dated, atomic addenda in
chronological order.

Use `## Addendum — YYYY-MM-DD — title` headings. Append the implementing
commit in parentheses when available.

Atomic means that an addendum is closed when its commit lands. A later
addendum may reference or supersede it, but must not change its text. If an
addendum is materially wrong, append a dated correction addendum.

- The first addendum is the implementation note. It records the implemented
  result, validation, deviations from the accepted design, and the commit
  when available.
- Each later substantial implementation change gets its own dated addendum.
  One addendum describes one logical change or one tightly coupled body of
  work; include the implementing commit when available.
- Do not reorganize, combine, or rewrite earlier addenda to incorporate later
  events.
- Addenda document implementation history. They must not introduce future
  design changes or bypass review. A change to the signed-off design body
  still reopens the RFC for review.
- Append-only addenda do not invalidate sign-off. When implementation is
  complete, change the status from `Accepted` to `Implemented`.

The status line tracks the current state:

| Status | Meaning |
|---|---|
| `Draft` | Author is writing; no review requested yet |
| `In review` | Review round is open; author is responding |
| `Accepted` | Reviewer has signed off; ready to implement |
| `Implemented` | All implementation steps done |

**Agent responsibilities:**

- Before starting work that touches an area covered by an open RFC,
  read the RFC. It may override or constrain the approach that would
  otherwise seem natural from the code alone.
- Before sign-off, update the design body when work resolves an open
  question or changes an implementation step.
- After sign-off, record resolved questions, completed steps, deviations,
  and validation in the current atomic addendum. Do not edit the accepted
  design body to reflect later implementation history.
- Do not create an RFC for routine feature work, bug fixes, or
  incremental refactoring. Use a backlog entry or session-log entry
  instead.
- Do not leave an RFC in `Accepted` status after editing its signed-off
  design body. An accepted RFC is a signed-off design record; any change
  to that body invalidates the sign-off. Append-only implementation addenda
  are the exception described above. When a design change is needed, edit
  the body, change the status back to `In review`, and add a new
  `## Review round N — requested` section describing what changed and
  why. This marks the section as an author request for renewed review,
  not as reviewer feedback.
  The RFC stays in `In review` until the reviewer signs off again.


### Backlog hygiene

Add new entries to [docs/wiki/backlog.md](docs/wiki/backlog.md) directly below
its introduction, newest first. Work confined to `cartolina-tileserver`
belongs in the tileserver backlog:
<https://github.com/cartolinadev/cartolina-tileserver/blob/main/docs/backlog.md>.

Backlog entries are numbered in the heading (`## N. ...`) in the order
they were opened. The number is assigned once and never reused or
renumbered; a new entry takes the next unused number, regardless of
where in the file it is inserted (entries stay newest-first by
position, so number order and file order diverge over time — that is
expected).

[docs/wiki/backlog-archive.md](docs/wiki/backlog-archive.md) holds
entries that are resolved, implemented, or closed for another reason
(superseded, subsumed by another change). When closing a backlog
entry, move it there, keeping its number, instead of deleting it or
leaving it in the active file.

**Promotion to an RFC does not by itself close a backlog entry.**
Promoting or elevating an entry to an RFC (or noting it is "subsumed
by" one) hands off *tracking*, not completion — the underlying work
is not done until that RFC is implemented. An entry promoted to an
RFC stays in the active backlog, status noting the RFC, until the RFC
reaches `Implemented` status (see [rfcs-implemented.md](rfcs-implemented.md)
in `index.md`'s **RFC archive**); only then does the backlog entry
move to backlog-archive.md. Archiving on promotion alone would let a
high-importance bug quietly vanish from the active backlog the moment
someone opens a draft RFC for it, long before the fix ships.

A backlog entry may be rewritten freely while it is still open — including
trimming working hypotheses that turned out wrong, once that happens as
part of ordinary editing of an open entry. When closing an entry and moving
it to backlog-archive.md, never rewrite it — a rewritten resolution loses
the original argument and becomes noise duplicating the commit message and
session log. This applies to partial resolutions too: append a
`Resolution:` (or partial-resolution) paragraph below the original text
describing what was actually done and, if relevant, which recorded
hypotheses turned out wrong; do not erase or paraphrase the original report
to make room for it. Keep the entry's text exactly as it was, changing only
the status line.

## Commits

Do not commit trivial changes automatically. Leave typo fixes, link
updates, formatting changes, and straightforward documentation polish
uncommitted unless the user asks for a commit.

Before every commit, review affected wiki pages for completeness and
correctness when the change touches documented behavior. Stale field
names, removed APIs, or outdated descriptions must be corrected before
the commit lands.

For commits that represent a significant body of work or a non-trivial
finding, update [docs/wiki/session-log.md](docs/wiki/session-log.md) so
it reflects the current state of things. Do not add session-log entries
for trivial changes merely because they are being committed at the
user's request.

**A session-log entry states the goal first, then the outcome** — what
the change set out to do, and where the code ended up.

**Size the write-up to the change.** A four-line fix gets a few
sentences, not a report: what was wrong, what the change does, stop.
No investigation narrative, no diff in prose, no mechanism the code
already shows, no verification that passed. This governs commit
messages, session-log entries, and review notes alike.

Do not recite the code — removed members, renamed fields, touched files
are what `git show` is for, and such lists go stale. Name what a reader
can now rely on or must no longer assume. One or two sentences is
normal; one line is a fine entry.

Commit only when the user asks, or automatically before starting a new
unrelated body of work when uncommitted, unrelated changes already exist.
Do not create a commit after every small change — this produces an
unwieldy chain of micro-commits and reversals. On a feature branch,
commit at logical milestones, not after every step. On the main branch,
always ask before committing.

Commit hooks may add version bumps to `package.json` or
`src/version.ts`. Leave those hook-generated version changes in the
commit even when asked to commit only a specific logical change.

## Orientation

The goal is to become a modern web-based cartography library with a
truly three-dimensional underlying data model. It is a heavily diverged
fork of the now-discontinued `vts-browser-js`. The codebase is a
ten-year-old project in gradual, **feature-driven** refactoring. Most
legacy JavaScript code still exists alongside newer TypeScript modules.

Read [README.md](README.md) first, then use
[docs/wiki/index.md](docs/wiki/index.md) as the documentation starting
point. The wiki index lists the main internal pages together with other
relevant documentation sources for the legacy codebase and the backend
interface.

`cartolina-js` is a WebGL2 3D terrain cartography library for the web.
It is the frontend half of a two-component stack; the backend is
[`cartolina-tileserver`](https://github.com/cartolinadev/cartolina-tileserver),
a C++ Unix daemon that processes geospatial data and streams formatted
tiles to the client. Consult that repository when working on features
that involve the data or network interface between the two projects.

Key capabilities the library implements:
- Digital elevation model rendering at varying resolutions

- Hillshading with native lighting models and scale-dependent vertical
  exaggeration

- Bump-mapping using satellite or aerial imagery

- Atmospheric effects (background haze, foreground shadows, sun glint
  based on land-cover data)

- Support for high-latitude and polar regions without dateline issues

- Multiple frames of reference, including planetary bodies

- Point labels with visual hierarchy


## Environment

- `nvm`-managed Node is the expected runtime for repo commands. Before
  running `npm` or `node` commands in a fresh shell, load `nvm` and
  select the version specified in `.nvmrc`:

```bash
source ~/.nvm/nvm.sh && nvm use
```

- Do not assume the default `node` on `PATH` is correct; verify with
  `node -v` if a command fails unexpectedly.

- Text-analysis commands (`grep`, `awk`, `sed`, `wc`) may be run
  against files in this repository without asking for permission.

- Files ending in `~` (e.g. `shaders.js~`) are editor backup copies.
  They are `.gitignored` and untracked. Ignore them entirely during
  analysis, code reading, and search. Never cite them as evidence of
  current behaviour or use their contents to draw conclusions about
  the live codebase.

- `npx tsc` (any flags) may be run without asking for permission.

- `curl` to local dev services such as `http://localhost:8080` may be
  run without asking for permission.

- Local Playwright diagnostic scripts may be run via the repo Node
  runtime without asking for permission. Use:

```bash
source ~/.nvm/nvm.sh && nvm use >/dev/null && node ...
```

  Prefer `node -e '...'` when possible. Do not stop to ask for
  permission before running local browser checks against the dev server.


## Code and refactoring philosophy

Code is liability. Less code means fewer bugs and easier maintenance. We
like to delete code.

Complexity that exists for its own sake is a bug. Elegance is not a
cosmetic goal; a simpler design usually has fewer failure modes. When
two approaches solve the problem equally well, choose the one with
fewer moving parts, fewer special cases, and less code. A design that
eliminates a concept is better than one that models it more precisely.

- **Knuth's rule: premature optimization is the root of all evil.**
  Do not buy speculative performance with code complexity. Optimize
  when a measurement shows the need, against that measurement; until
  then, prefer the simpler design and record the deferred idea in the
  backlog instead of the codebase.
- **Write as little code as possible.** Before writing new code, search
  for existing functionality to reuse. When duplication is unavoidable,
  abstract, but only once the duplication is real and the right
  abstraction is clear.

- **Dead code removal is encouraged**, not just code that was explicitly
  replaced during refactoring, but also code that has no role in the
  current test applications (see
  [Test applications](#test-applications) below). When in doubt, remove
  and verify tests still pass.

- **Backward compatibility with vts-browser-js APIs is not a goal.**
  Old APIs may be removed without deprecation periods.

- **Do not restore legacy browser-level compatibility surfaces on
  `Viewer`.** Do not add back `BrowserInterface`-style sub-objects or
  wrapper methods such as `.core`, `.map`, `.renderer`, `loadMap()`,
  `setParams()`, or similar "temporary" bridges. If old demos or tests
  still rely on those surfaces, update the callers or promote the
  needed capability as a deliberate flat `Viewer` method instead.

- **Keep new code out of legacy JavaScript modules.** Treat `.js`
  modules as legacy. Put new behavior in TypeScript modules or modern
  public API surfaces. Integrate with legacy JavaScript through the
  smallest hooks needed at existing call sites.

- **Functionality of applications under src/demos needs to be
  ensured.** When changes are made to the API, it shall either preserve
  backward compatibility or the demo applications need to be modified to
  reflect the changes.

- **Do not add abstraction layers, helpers, or utilities for
  hypothetical future use.** Only the minimum complexity needed for the
  current task.

- **Test URLs under test/urls.json shall render correctly after any code
  change.** Backward compatiblity needs to be preserved to make these
  URLs work.

- **Anything that makes the render loop faster is a win.** To
  paraphrase Knuth: premature optimization is a root of all evil,
  but anything that makes the render loop faster is a win. Don't
  repeat per-frame work that could be done once, when the stable
  lifetime of the result is already defined by an existing cache
  boundary. Nonetheless, follow simple function first, optimize
  later.

Refactoring is feature-driven, not an end in itself:

- Refactoring small modules as part of a feature implementation is
  encouraged when it genuinely improves quality; just keep the scope
  proportionate.

- When a feature is complex, it is acceptable to first build it on top
  of duplicated code to make it testable, and then refactor in a second
  step once you have confidence from regression tests.

- Do not refactor speculatively or as a stand-alone exercise.


## Test applications

The canonical set of test cases is defined in
[test/urls.json](test/urls.json). Each entry describes a map
configuration (style + camera position) accessible from the webpack dev
server.

For regression testing, use only these three entries unless instructed
otherwise: `simple-terrain`, `complex-terrain`, `full-terrain`.

1. Always start a new dev server for every browser-test run. Kill any
   running Cartolina dev server first, confirm port 8080 is free, then
   run `npm start` and wait for compilation to finish. Never reuse an
   existing server, even when it is reachable or appears current: it
   may serve stale code or a bundle written by another process. Start
   exactly one server on the canonical port; if webpack selects another
   port, stop it and resolve the listener on 8080 instead of testing
   across two servers. Before capture, verify that the version served
   from `build/cartolina.js` matches `src/version.ts` in the
   current checkout.

2. Use [test/screenshot.js](test/screenshot.js) to capture and compare
   renders. This script may be run without asking for permission:

```bash
# all test URLs
node test/screenshot.js

# one entry by id
node test/screenshot.js complex-terrain
```

Screenshots are saved to `tmp/screenshots/<id>-dev.png` and
`tmp/screenshots/<id>-prod.png`. The script waits for network idle
before capturing (same quiet-window strategy as the perf runner) and
prints any console or network errors it finds.

All diagnostic output must go under gitignored paths, usually `tmp/` or
`tmp/screenshots/`. Use the gitignored `tmp/` directory in the
repository root, not the system `/tmp`. Do not leave diagnostic
screenshots, logs, probes, or other generated investigation artifacts
as untracked files in the repository root or source directories.
Temporary diagnostic scripts belong under `tmp/`; diagnostic scripts
worth preserving belong under `scripts/`.

Do not write screenshot output under `sandbox/`; the dev server watches
that directory and may rebuild or reload while the screenshot script is
capturing.

Run `test/screenshot.js` entries sequentially.

Custom Playwright-based diagnostic or test scripts may be created and
run against the dev server without asking for permission. Always listen
to **both** `page.on('console', ...)` and `page.on('pageerror', ...)`.

**Prefer testing over reasoning when investigating a problem.** Read
enough code to understand the landscape and form a hypothesis, then
test it against the dev server before going deeper. Use whatever
diagnostic tools are available: browser console output, runtime
overlays, temporary `console.log` statements added to the code. If a
hypothesis is testable, test it first — only return to source analysis
once the test result gives you more context.
Uncaught exceptions thrown inside event handlers (e.g. from simulated
keyboard or mouse interaction) surface as `pageerror` events, not as
`console` errors. A test that only monitors the `console` channel will
silently miss these failures.

### Test policy

Permanent tests follow the same rule as production code: each line must
justify its maintenance cost. The primary regression evidence comes from
real maps: direct visual comparison, comparative consistency checks over
derived or diagnostic data, and comparative performance measurements under
matched conditions. Use the canonical public cases above.

Unit tests are exceptional. Add one only when it protects a named observable
invariant, a plausible accidental edit can break it, the real-map checks would
not expose the failure clearly, and the proposed test is shown to detect that
edit. Do not add tests for counts, validation lines, routine implementation
details, hypothetical cases without a caller, deliberate design changes, or
failures already exposed by the real applications. Remove a test when its
reason for existing disappears.

Passing is normal, not news. This holds everywhere, not only in a reply:
a session log entry, a commit message, or a wiki page must not recite
which checks were run, what they measured, or that they came out as
expected. A change is assumed to have been verified — that is the price
of committing it, not a result to publish. Write about a check only when
it failed, when it revealed something the code does not already say,
when its coverage changed, or when it was skipped and something is
therefore unverified.

### No cargo-cult fixes

Do not make speculative fixes and leave them in the tree. Every change
must be grounded in diagnostic data or in source analysis that identifies
the mechanism being changed. If a trial change does not fix the measured
problem, remove or stash it before continuing. Freshly added,
speculative, and unproductive code is technical debt; do not let it
accumulate while debugging.

When a trial is useful, keep it clearly temporary: record what it tests,
run the relevant check, then either turn it into the minimal confirmed
fix or discard it. Do not stack new hypotheses on top of failed trial
code.

### No loose ends

Finish what the change starts. Code that a change makes redundant is
removed by that same change, not listed as a follow-up. A step the
change leaves half-done is completed before the work is reported as
done. This is not tidiness: code kept past its purpose is liability, and
an unproductive line left behind is the same debt as an unproductive
line added.

This binds hardest to loose ends the current session created. Reporting
one as a known leftover does not discharge it — it records a defect the
same session chose not to fix. When a leftover genuinely belongs to
separate work, say why it is separate and open a backlog entry; do not
leave it as a remark.

**Adopting an API obsoletes code elsewhere; go and delete it.** A new
abstraction takes over work its callers used to do by hand. Sweep them
for no-ops, stale workarounds, dead branches, and state the new owner
now holds — a copy left behind drifts from the original silently. The
adopting change removes them, not a later cleanup.

### No hand-waving

Hand-waving is prohibited, in code comments and in the wiki
(session log, backlog, RFCs) alike. A causal claim — "this happens
because…", "X fails because…", "this is caused by…" — may be written
down only when it has been verified, either by a measurement or by
source analysis that names the exact mechanism. Do not present a
plausible-sounding guess as established fact, and do not explain away a
result you have not actually traced.

A claim that is the basis for further work must be verified before that
work proceeds; an unverified premise is not an acceptable foundation.
For reasons of problem-solving economy a hypothesis may occasionally
remain unverified — when it does, say so plainly. Mark it as
unverified, or state what was observed and that the reason was not
established. "The reason was not pinned down" is acceptable; a confident
fabricated mechanism is not.

This applies to commit messages and review notes as well. When you
discover that a previously written explanation was wrong, correct it at
the source rather than layering a new guess on top.

### Regression bug diagnostics and fixing

When the user says "this is a regression bug", "use the regression
rules", or otherwise gives a known-good and bad behavior pair, enter
this protocol before proposing fixes:

1. State the known-good URL/branch and regression URL/branch.
2. State the viewport size used for browser diagnostics. If the user
   reports a visual regression, ask for or infer their viewport before
   treating screenshots as comparable. Default local diagnostic viewport
   is `1200x800`; override it to match the reported environment.
3. State the specific entity or symptom being traced.
4. Add or enable comparable diagnostics on both sides.
5. Run both sides and compare the first hard output.
6. Only then form a hypothesis or make a fix.

When diagnosing a regression, first identify the known-good commit. This
is usually `main`; when the regression is reported against production,
use the commit recorded in the production build. Create one reusable
ground-truth diagnostics branch from that commit, or reuse an existing
one if it still points at the same known-good commit. Do not create a new
known-good diagnostics branch for every symptom when the base commit has
not changed.

The regression side is the current feature branch that produced the
regression. Add temporary instrumentation there if it can be safely
stashed or removed before committing the fix. If a separate branch is
needed to keep diagnostics isolated, create one from the current feature
branch and name it clearly with the case being traced.

The two comparison worktrees or branches are then:

- the diagnostics branch created from the known-good state, with
  diagnostic instrumentation added;

- the development branch that produced the regression, or a clearly
  named diagnostics branch created from it, with equivalent diagnostic
  instrumentation added.

Keep diagnostic branch names explicit, e.g. `diag/nacis-main-labels` for
the reusable ground truth and `diag/nacis-fix-brennkogel` only when a
feature-side branch is needed for a specific trace.

**Trace divergence empirically, step by step.** When the diagnostics
branch and the regression branch produce different output, find the
earliest point where they first differ — not the last. Confirm the
divergence with a log, then move one step earlier. Repeat until you
reach the code change that causes it. Do NOT reason backward from a
user-reported symptom without first confirming it yourself via
diagnostics.

**When tracing a specific data entity, instrument every step it
touches.** Log every function it passes through, every check applied
to it, every value computed from it. Run both branches. Read the full
output side by side. Only after reading the data should you form any
hypothesis. "It might be X" before reading the logs is speculation —
stop and instrument instead.

**Always see the visual output yourself before drawing conclusions.**
Take a screenshot and look at it. Do not rely on user description alone.

**Diagnose by instrument, not by speculation.** One targeted log line
beats a page of analysis. Add `console.log` to the live code (webpack
reloads automatically), capture output via a Playwright script, and
reason from numbers.

For label-pipeline regressions, see the wiki page
`docs/wiki/label-regression-diagnostics.md`. The reusable Playwright
capture script is `test/diagnostics/label-pipeline.js`.

**`update session log` command.** When the user types this, write a
new entry in `docs/wiki/session-log.md` covering: goal, work done,
current state, open questions, and a link to the plan file. Keep it
brief but self-contained — a future agent picking up mid-session must
be able to orient from it alone. The log is top-posted: place the new
entry at the top of the file, directly under the `# Session log`
heading, never at the end.

3. A URL **renders correctly** when all of the following hold:
   - No network errors (failed tile or resource fetches).

   - No console errors.

   - The dev screenshot is visually indistinguishable from the prod
     screenshot: same shading, labels, and imagery.

The test index page is at `http://localhost:8080/test/`.

Automated performance regression tests can be run with:

```bash
npm run test:perf:headed
```

Results are viewable at `http://localhost:8080/test/perf`. A result is a
regression if FPS drops by more than 10% or load time increases by more
than 30%.

Performeance regressiopn tests are normally not needed after every
change. Perform them when they are part of the plan.


## JavaScript → TypeScript migration rules

This codebase is in gradual, feature-driven migration from ES5 JavaScript
to TypeScript. These rules govern how type shapes are expressed when new
TypeScript code touches legacy JavaScript.

**Reference legacy ES5 types directly where possible.**
`allowJs: true` means TypeScript infers the shape of imported `.js`
modules. Prefer `import Foo from './foo'` over creating a parallel
interface. IDE "go to definition" navigates to the original file.

**Use a sibling `.d.ts` for complex legacy shapes that need precise
typing.**
JavaScript files cannot define types. When a legacy `.js` class has a
complex shape that must be typed precisely, place a `.d.ts` declaration
next to it (e.g. `interface.d.ts` alongside `interface.js`). TypeScript
prefers the `.d.ts` over inferred JS types even with `allowJs`. The
shape declaration stays co-located with the implementation.

Do not create parallel boundary interfaces (`IFoo`-style types in a
separate file) that duplicate a JS class shape. That pattern requires
maintaining the same shape in two places.

Where types physically live is covered under **Where types live** in
Source code conventions.

**No `: any` or `: unknown` for known shapes.**
If a shape is trivial (a fixed-shape tuple, a small string union),
define it with the module that owns its meaning. If a shape is complex
and belongs to a specific `.js` class, write a `.d.ts`. Reserve
`unknown` only for payloads that genuinely cannot be typed yet (e.g.
legacy event payloads from untyped JS).

Do not use `: any` or `: unknown` as a convenience workaround when the
shape is already available elsewhere in the codebase, whether via its
owner module, a sibling `.d.ts`, or direct import of a legacy `.js`
module under `allowJs`.

**Verify from code before inferring local history or intent.**
When the answer can be checked directly in the current file, the branch
diff, or git history available in the workspace, do that first. Do not
speculate with phrases like "probably", "if", or similar hedging about
code-local facts that are directly verifiable.

If a fact is inspectable, inspect it. Do not say "most likely" or use
similar evasive phrasing for repository, configuration, or environment
facts that can be read directly.

**Derive normalized data shapes from canonical defaults when possible.**
When a module defines a default plain-data object whose fields already
describe the complete normalized runtime shape, prefer deriving the type
with `typeof` instead of restating the same property list manually.
This keeps the default values as the single source of truth and avoids
parallel type drift. If authored input is looser than the normalized
runtime shape, define the input type as a variation of that derived type
(for example `Partial<T>` on selected fields) rather than duplicating
the full structure.

**Resolving the `Map` name collision.**
The old ES5 `Map` class (`src/map/legacy-map.js`, the JS half being
absorbed) has the same default-export name as the new TypeScript `Map`
class (`src/map/map.ts`). In any TypeScript module that imports the
old class, use the alias `LegacyMap`:

```ts
import type LegacyMap from './legacy-map'; // JS half being absorbed
import Map from './map';                   // typed map data model
```

Apply the alias in all TypeScript modules — not only where both names
appear in the same file. Consistency across the TS codebase is the
goal. JavaScript modules that import the old class are unchanged.


## Language and module rules

- **No new JavaScript modules.** All new source files shall be
  TypeScript (`.ts`).

- **No pre-WebGL2 GLSL.** New shaders shall target GLSL ES 3.00
  (`#version 300 es`). Do not write GLSL ES 1.00 shaders. The runtime
  context is `WebGL2RenderingContext`.

- **Strict TypeScript.** New code shall pass strict TypeScript checks.
  Legacy code may not conform; do not relax strict settings to
  accommodate it. Fix or isolate the legacy code instead.


## Source code conventions

These rules apply to all source files, both TypeScript and JavaScript.

### Coding style

Spaces shall be used for indentation, no tabs. Indentation size is four
spaces.

Line length should be 80 characters maximum for new or edited code. Same
applies for documentation and READMEs.

**Empty lines inside blocks** — the rule is symmetric:

- When `{` appears at the end of a line with preceding content (an `if`,
  `else`, `for`, `while`, `switch`, function signature, callback, etc.),
  place an empty line immediately inside the opening brace.
- Symmetrically, when `}` appears at the start of a line followed by more
  content on the same line (e.g. `} else {`), place an empty line
  immediately before the closing brace.
- Apply this to every new or edited multi-line block, including nested
  loops, nested `if` statements, callbacks, and helper methods. Check
  the edited hunk for this before finishing; do not wait for review to
  catch it.
- **Exception:** if the entire block body is a single line, omit both
  empty lines.

```ts
function process(items: Item[]) {

    for (const item of items) {

        if (!item.valid) {
            continue;           // single-line block — no empty lines
        }

        if (item.type === 'a') {

            prepare(item);
            execute(item);

        } else {

            skip(item);
        }
    }
}
```

**Single-statement `if` bodies** go on one line without braces:
`if (condition) return false;` — do not wrap in `{ }`.

**Avoid `else if` chains.** Prefer a more hierarchical structure with
nested blocks when one condition refines another, or use explicitly
conditioned independent blocks when the cases are separate. Reach for
`else if` only when there is a strong reason not to express the control
flow in one of those clearer forms.

**Handle alternatives symmetrically.** When one block handles several
alternative values or source types, give every alternative its own explicitly
conditioned `if` block. Do not implement one alternative as an early exit and
leave another as implicit fallthrough. Start each alternative block with a
concise in-block comment stating what that block does.

**Label non-obvious closing braces.** Add a concise trailing `//` comment to
the closing brace of a long or deeply nested loop, conditional, or other block
when the opening line is no longer obvious at the closing line. Name the
condition, iteration, or block being closed.

**In-block comments** use `//` lines, even when they span multiple
lines. Reserve block comments (`/* ... */`) for module headers,
JSDoc, and other file- or declaration-level comments outside executable
blocks.

## <span style="color:red">NEVER TOUCH USER-AUTHORED COMMENTS DURING REVIEW</span>

User-authored comments and JSDoc are protected work. A request to review,
investigate, or fix code does not authorize changing them. Never rewrite,
shorten, expand, capitalize, reformat, move, or delete a comment merely to
match these guidelines or an agent's preferred wording.

When an explicitly requested structural change requires moving commented
code, preserve every comment verbatim, including spelling, capitalization,
line breaks, and whitespace. Change a comment only when the user explicitly
asks for that specific comment to change.

If an agent changes a protected comment accidentally, stop editing that file.
Restore the comment byte-for-byte from an exact pre-edit snapshot and verify
the restoration by direct comparison. Never reconstruct the wording from
memory, infer it from an older revision, substitute a similar comment, or
claim faithful restoration without an exact comparison. If no exact snapshot
exists, state that restoration cannot be guaranteed and ask the user how to
proceed.

**Make sequencing constraints visible.** When a call must occur before or
after surrounding initialization, put a concise in-block comment at the call
that names the dependency. Do not separate a step from the operation it
completes unless intervening work is required. A reviewer should not have to
reverse-engineer whether intervening statements justify delayed execution.

**Do not use underscore import shims.** Import symbols under the name
used in the file. Do not write `import Foo_ ...; var Foo = Foo_;` or
`//get rid of compiler mess`. When editing a file that still has this
shim, remove the shim for the imports you touch.

**Private TypeScript backing members** should use a trailing underscore.
The convention applies to **fields only**, not to private methods.
Private methods do not get a trailing underscore. The trailing
underscore on a field marks it as the backing slot whose public
identity is the same-name getter:

```ts
private renderTarget_!: GpuDevice.RenderTarget;

get renderTarget(): Readonly<GpuDevice.RenderTarget> {

    return this.renderTarget_;
}

private rebuildRenderTarget(): void {

    // ...
}
```

Do not rename existing private members only to satisfy this convention.
Apply it to new members and to members already being changed for other
reasons.

**Getters expose receiver-owned state.** Use a getter only for a value
derived from state the object owns or fully encapsulates. A query that
reads mutable state owned by another object is a method, so its call
sites show evaluation. A getter may lazily synchronize its own cached
state when that read contract is documented.

**Declaration order exposes the public surface before its
implementation.** Organize a module so a reader encounters its exported
API before module-private helpers and state. Keep related declarations
in functional groups; do not alphabetize declarations that are clearer
in their usage order. Order public groups hierarchically, with common
high-level operations before specialized or low-level operations. Use
current application call sites to judge prominence when they provide
evidence.

Within a class, use this order:

1. Public constructor, when the class has one.
2. Public methods and accessors, grouped by purpose.
3. Public fields. These are rare; when they exist they follow the
   public methods.
4. Protected members, when present.
5. Private constructor, accessors, and methods.
6. Private fields.

The consumer's information comes first. A class built through a static
factory therefore opens with that factory, and its private constructor
sits with the other private members — a private constructor is not part
of the public surface and does not belong at the top.

This order applies to internal classes as well as exported classes. A
private method belongs after the complete public surface even when the
constructor or a public method calls it. Private field declarations
belong at the end of the class. Field initializers execute in declaration
order, so preserve any ordering dependency when reorganizing existing
fields; runtime correctness overrides presentation order.

Do not reorder an existing class only to satisfy this rule. Apply it to
new classes and to classes already being restructured for another
reason; older classes that predate it are left alone.

**Initialize a field where its value comes from.** A constant initial
value — a literal, an empty container, a fresh object that reads nothing
else — belongs at the declaration. A value that reads a constructor
argument or another field belongs in the constructor, with the
declaration left bare.

At module scope, place exported declarations before non-exported helper
functions, types, constants, and other implementation state. The more
specific class-module layout below still governs default-export class
modules. Runtime initialization order is the exception: keep a
dependency before an eagerly evaluated declaration when moving it would
create a temporal-dead-zone access or otherwise change behavior.

### Type aliases over interfaces

Declare object and union types with `type`, not `interface`. The two are
interchangeable for a plain shape, and the codebase standardises on
`type` so there is one form to read. Reach for `interface` only for an
open declaration that other code deliberately extends through declaration
merging, such as augmentation of a third-party or global type.

An `implements` clause accepts either form and remains structural; it is not
an exception. A payload record, options bag, or event map is a `type`. A
`type` is also closed — no stray declaration elsewhere can silently widen
it — which is the safer default for an authoritative shape such as an event
map.

### Where types live

Put a type where its semantic owner is. A type belongs to the module
that defines what the value means or owns the operation that produces
or consumes it. Usage by several layers does not remove that ownership:
an event map belongs to its event hub, a tuple or string union belongs
to the domain model it describes, and a math alias belongs to the math
module.

A TypeScript owner exports the type and, for a class module, surfaces
associated public types through its same-name namespace (below). A
legacy `.js` owner takes a sibling `.d.ts`. The owner being legacy
JavaScript is not a reason to move the type elsewhere — that status is
temporary.

Do not create or add to a layer-level catch-all `types.ts`.
`src/map/types.ts` is temporary migration staging for types whose
legacy owners have not migrated yet; move each resident when its owner
migrates, then delete the file. A genuinely domain-neutral type-level
utility gets a narrowly named module only when a concrete use requires
one.

### Declaration merging for exported types

A module that exports a class as its default export uses a **same-name
namespace** to expose its associated types, so consumers reference them
with their origin explicit:

```ts
// atmosphere.ts
class Atmosphere { ... }

namespace Atmosphere {
    export type Specification = ...;
}

export default Atmosphere;
```

Consumers write `Atmosphere.Specification`, never a bare import.
Associated types owned by the class belong in this namespace. Types
owned by another module keep one canonical definition there and are
referenced with their owner's qualifier inside the codebase. **Do not
convert these to named exports.**

At the public `Viewer` surface, forward a type through its canonical owner:

```ts
import Map from '../map/map';

namespace Viewer {
    export type OverlaySpec = Map.OverlaySpec;
}
```

This holds at the package boundary too. The public entry point
([index.ts](src/viewer/index.ts)) exports no bare type names; every
public type is reached through the `Map` namespace — `Map.Config`,
`Map.OverlaySpec`, `Map.PositionInput`, `Map.PublicRuntimeConfig`, and
so on. Surface a type by adding it to `Viewer`'s namespace (`Viewer` is
exported as `Map`), forwarding to the module that owns the type. Only
types that appear directly on `Viewer`'s public surface — a method
parameter, return, or construction option — earn a place there. A type
that is merely a component of another (the `resourceType` inside a
request hook, the `ctx` inside an overlay spec) is reached by derivation,
not given a name.

Modules that export only free functions and types (no primary class) use
regular named exports, as in
[illumination.ts](src/map/illumination.ts). Import them as a
namespace — `import * as utils from './utils/utils'` — never through
named imports, so every call site names its origin. Fix named imports
whenever the importing file is already being changed.

### Order of declarations in a class module

For modules that export a class as their default export, lay the file
out in this order:

1. A one-line block comment naming the file and its job (see the
   **Documentation** section below for the required format).
2. Imports.
3. The class (with its JSDoc).
4. Local, non-exported types used by the class — keep them out of
   the way so the class is what the reader sees first.
5. The same-name namespace re-exporting public types (see
   **Declaration merging for exported types** above).
6. `export default`.

[atmosphere.ts](src/map/atmosphere.ts) and
[tile-render-rig.ts](src/map/tile-render-rig.ts) follow this
pattern. Do **not** put local types between the imports and the class
— that pushes the class down and reads as if those types were part of
the public surface. Within the class itself, follow the public-first
declaration order in **Coding style**.

### Documentation

Every new class and every new module shall have a JSDoc block:

- **Module-level:** a leading one-line block comment naming the file
  and stating its job in a single sentence, matching the pattern in
  [tile-render-rig.ts](src/map/tile-render-rig.ts):

  ```ts
  /*
   * tilerenderrig.ts - prepare and draw mesh tiles
   */
  ```

  Do **not** restate the class description in the module header — the
  class JSDoc carries the substantive documentation. A multi-line
  module header that duplicates the class description is wrong; remove
  it and keep only the one-liner.

- **Class-level:** a JSDoc comment immediately before the `class`
  keyword. This is where the substantive description lives:
  responsibilities, ownership, lifecycle, any non-obvious design
  decisions.

- **Public methods and constructors:** JSDoc with `@param` and
  `@returns` for non-obvious signatures.

Use [tile-render-rig.ts](src/map/tile-render-rig.ts) and
[atmosphere.ts](src/map/atmosphere.ts) as reference examples for
documentation style.

Private methods usually do not need JSDoc unless their functionality is
non-obvious. But if they do, it must be kept up to date; stale
documentation is worse than none.

**In-block and beginning-of-block inline comments** (single-line `//`)
are good practice and actively encouraged. Use them to describe
non-obvious logic: a subtle invariant, a hidden constraint, a
workaround for a specific behaviour, or a step whose purpose is not
plain from the identifiers alone. Write in plain engineering prose
with no jargon (see [No jargon](#no-jargon)). One line is almost
always enough; if more is needed, use a `/* ... */` block comment.

Keep inline comments concise and to the point:

- **One line is the default.** Wrap to a second line only when the
  concept is genuinely non-obvious and needs more than one sentence.
  Don't expand a simple idea into a multi-line block.
- **Say what the code does, not what it does not.** Comment on the
  behaviour present in the code. Do not contrast it with rejected
  alternatives ("iterating X instead would..."), with how it used to
  work, or with how a sibling path differs. A reader who lacks the
  history and the planned direction cannot tell such asides from live
  behaviour, so they read as noise. State the rule this code follows;
  leave history and future plans to commit messages, the wiki, and
  the backlog.

  **This means: never explain a fix by describing the bug it fixes.**
  A comment that argues against code that no longer exists — "this
  must match the other gate, or X stays broken", "unlike before, this
  now also checks Y" — documents the patch, not the code. The reader
  of the final file never saw the bug and has no use for its
  rebuttal. Write the positive rule only: what this reads, and why
  (if the why is a real hidden constraint). The bug narrative belongs
  in the commit message and the session log, never in the comment
  itself. This has been raised more than once — treat it as settled,
  not a judgment call to make fresh each time.

**Adding JSDoc to existing code is encouraged** when you encounter a
function or method whose behaviour is non-trivial or not obvious from
its name and signature, and where a JSDoc comment is absent. This
applies even when the function is not otherwise being changed. Do not
add routine boilerplate to self-evident code; use judgement.

Before committing TypeScript changes, check the diff for newly added
public classes, methods, and exported types. They must have JSDoc in the
same commit. This applies even to small helper APIs added during a
cleanup.

**Do not silently drop or rewrite documentation as a side effect of
a structural change.** When restructuring or moving code (rename,
move, extract), carry the existing JSDoc over unchanged — unless the
change itself makes the original wording incorrect, in which case
update it to match the new reality. The test: does the documentation
still accurately describe the code after the change? If yes, preserve
it. If no, fix it. Never silently discard accurate documentation.
The same rule applies to comments and context markers. Do not remove
them unless they are obsolete, inaccurate, or attached to code being
deleted.

**When modifying a class, review its class-level JSDoc block.** Field
additions, removals, and behavioural changes frequently make the class
description stale. Update it before committing.

Do not use `@link` or any other JSDoc tags that produce hyperlinks.
TypeScript IDEs do not render them. Reference other symbols by name
in backtick code spans instead: `` `MyClass.myMethod` ``.

### No jargon

**Jargon is banned.** Jargon is any word or phrase that sounds
technical but does not have a precise, agreed definition in this
codebase. Examples of banned patterns:

- Vague collective nouns that name nothing specific: "layer",
  "subsystem", "framework", "infrastructure", "platform",
  "scripting layer", "pipeline" (unless referring to a specific
  named object).
- Words that describe magnitude without content: "robust",
  "powerful", "flexible", "seamless", "scalable", "elegant".
- Speculation and vague passive constructions: "might be",
  "typically is", "is responsible for".

Instead, name the actual object and state what it does.
Wrong: "Used by the inspector scripting layer."
Right: "Called from `inspector.js` to draw the frustum overlay."

Every sentence in documentation must be checkable against the code.
If a sentence cannot be verified by reading the source, rewrite it
until it can.

**Never coin a term when the codebase already has one.** This carries
the same weight as the jargon ban. Before naming a thing in prose, a
comment, a commit message, or an identifier, find what the project
calls it and use exactly that. A coined synonym forces every reader to
work out whether it names the same thing or a second one.

Search first: the type name, the field name, the existing function
name. If no name exists and one is genuinely needed, say so plainly
rather than slipping a new word in as though it were established. If
the established name reads badly, ask — do not resolve it by inventing
a third form.


## WebGL2 shaders

Shaders live in [src/renderer/shaders/](src/renderer/shaders/):

- Fragment shaders: `<name>.frag.glsl`

- Vertex shaders: `<name>.vert.glsl`

- Shared include files:
  `src/renderer/shaders/includes/<name>.inc.glsl`

All shaders target GLSL ES 3.00 (`#version 300 es`).


## API design references

### MapLibre GL JS (primary)

Look to [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) as
the primary reference for API design. This is not about achieving
compatibility, but about making the library feel familiar to developers
coming from MapLibre or Mapbox. Borrow types, naming, and design
patterns where they map naturally: camera position specification, style
object shape, event API shape, option bags, etc.

### CesiumJS (secondary, technical)

[CesiumJS](https://cesium.com/learn/cesiumjs/ref-doc/) has a different
purpose and API philosophy but is a useful reference for the technical
design and implementation of specific features, particularly around
globe rendering, coordinate systems, and terrain. Draw on it for
implementation ideas, not API surface.


## API structure

`cartolina-js` exposes one public surface: the `Viewer` class returned
by `cartolina.map()`. Applications that need to drive their own input
handling, navigation, or autopilot pass `interactive: false` at
construction. See [non-interactive.md](docs/wiki/non-interactive.md).

The old vts-browser-js two-level split (separate "core" build for
headless rendering vs "browser" build with UI) was removed in 2026-05
along with the `vts-core.js` entry point. `interactive: false` covers
the headless use case from the same build.

Internal class structure:

- **`Viewer`** ([src/viewer/viewer.ts](src/viewer/viewer.ts)) — the
  public API. Flat, typed, MapLibre-style method surface. Public API
  design should follow the
  [MapLibre GL JS](#maplibre-gl-js-primary) conventions where
  applicable.
- **`Map`** ([src/map/map.ts](src/map/map.ts)) — the typed map data
  model and logic, graphics-library-independent. Owns the frame loop,
  lifecycle, and state that is map-model in nature. Not the public API
  class. `LegacyMap` ([src/map/legacy-map.js](src/map/legacy-map.js)) is
  the unfinished JS version of the same object and is absorbed into
  `Map` as feature work touches it.
- **`Renderer`** ([src/renderer/renderer.ts](src/renderer/renderer.ts))
  — the WebGL2 graphics class. Also serves as the public surface for
  custom drawing from inside overlay callbacks (`Renderer.drawImage`,
  `Renderer.drawLineString`, `Renderer.createTexture`,
  `Renderer.getCanvasSize`).


## Source layout (new modules)

Place new TypeScript modules according to their architectural owner.

The source tree follows the architectural owner:

```text
src/
  viewer/       — public Viewer, UI, input, autopilot, presenter
  map/          — map model, loading, styles, event bus, legacy JS map
  renderer/     — rendering pipeline and low-level GPU abstractions
  inspector/    — runtime diagnostics
  utils/        — domain-neutral runtime utilities
  compat/       — explicit compatibility entry point
  types/        — ambient declarations

  config-store.ts
  viewer-config.ts
  constants.ts
  version.ts
```

Place new modules in the most specific matching directory. Do not create
forwarding modules, aliases, or catch-all shared directories to blur
ownership.
