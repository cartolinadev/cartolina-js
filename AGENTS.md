# Agent Guidelines — cartolina-js

## Wiki

The [docs/wiki/](docs/wiki/) directory is a shared knowledge base for
agents and human contributors alike. Read it at the start of a session
to orient yourself before touching unfamiliar code.

While agents and humans do their best to keep the wiki up to date, it
may drift from the code over time.

At an appropriate moment during a session, or whenever an explicit wiki
update is requested, check whether the changes made in the current
session have caused the wiki to drift. If they have, update the wiki:
remove obsolete or no longer factual parts, and add or revise the
relevant information.

**What belongs in the wiki:**

- Architecture notes and non-obvious design decisions.
- Findings that are not obvious from reading the code — e.g. subtle
  runtime interactions, historical reasons for a design choice,
  gotchas discovered during debugging.
- A session log entry for each significant body of work: goal, key
  decisions, and anything surprising found along the way.

**What does not belong:**

- Transcripts of conversation or iterative back-and-forth.
- Things that are obvious from reading the code or git history.
- Temporary notes or in-progress state.

Keep entries concise. A future engineer (or agent) should be able to
read a page and immediately understand the decision, not reconstruct it
from noise.

Write wiki entries with a maximum line length of 80 characters. Tables
and code blocks are exempt.

Documentation must use repository-relative paths only. Do not write
references to files or directories outside this working copy, including
user-local absolute paths, temporary directories, editor paths, or agent
scratch-plan locations. If an external local artifact informed the work,
summarize the relevant conclusion without recording its path.

**Files:**

- [index.md](docs/wiki/index.md) — wiki landing page and table of
  contents.
- [architecture.md](docs/wiki/architecture.md) — system structure,
  key subsystems, and non-obvious implementation details.
- [label-styling-engine.md](docs/wiki/label-styling-engine.md) —
  reference notes for the shared lettering/style engine.
- [session-log.md](docs/wiki/session-log.md) — chronological record
  of significant work sessions.


## Commits

Before every commit, review and update
[docs/wiki/session-log.md](docs/wiki/session-log.md) so it reflects the
current state of things. Commit the session log together with the other
changes, or in a follow-up commit immediately after.

On a feature branch, commit freely — at milestones during implementation
or after completing a step — without asking first. On the main branch,
always ask before committing.

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

1. Ensure the dev server is running: check whether
   `http://localhost:8080` is reachable; if not, start it with
   `npm start` in the background. If it is already running, connect to
   it directly; do not start a second instance.

2. Use [test/screenshot.js](test/screenshot.js) to capture and compare
   renders. This script may be run without asking for permission:

```bash
# all test URLs
node test/screenshot.js

# one entry by id
node test/screenshot.js complex-terrain
```

Screenshots are saved to `sandbox/tmp/screenshots/<id>-dev.png` and
`sandbox/tmp/screenshots/<id>-prod.png`. The script waits for network
idle before capturing (same quiet-window strategy as the perf runner)
and prints any console or network errors it finds.

Run `test/screenshot.js` entries sequentially. Do not launch multiple
canonical screenshot captures in parallel; concurrent runs currently
cause intermittent remote tile/resource fetch failures that obscure the
rendering signal.

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

### Regression bug diagnostics and fixing

When diagnosing a regression, first create a diagnostics branch from the
state where the behavior still worked. This is usually `main`; when the
regression is reported against production, use the commit recorded in
the production build. The two comparison branches are then:

- the diagnostics branch created from the known-good state, with
  diagnostic instrumentation added;

- the development branch that produced the regression, with equivalent
  diagnostic instrumentation added.

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

**`update session log` command.** When the user types this, write a
new entry in `docs/wiki/session-log.md` covering: goal, work done,
current state, open questions, and a link to the plan file. Keep it
brief but self-contained — a future agent picking up mid-session must
be able to orient from it alone.

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

**Use a `types.ts` for simple, reusable type shapes.**
JavaScript files cannot define types. Simple types that are reused
across multiple modules — string literal unions, numeric aliases, tuple
types, event maps — belong in a `types.ts` file for their layer:
`src/core/types.ts` for the core layer, `src/browser/types.ts` for the
browser layer. Create the file when the first such type is needed in
that layer.

**No `: any` or `: unknown` for known shapes.**
If a shape is trivial (a fixed-shape tuple, a small string union),
define it in `types.ts`. If a shape is complex and belongs to a
specific `.js` class, write a `.d.ts`. Reserve `unknown` only for
payloads that genuinely cannot be typed yet (e.g. legacy event payloads
from untyped JS).

Do not use `: any` or `: unknown` as a convenience workaround when the
shape is already available elsewhere in the codebase, whether via an
existing type in `types.ts`, a sibling `.d.ts`, or direct import of a
legacy `.js` module under `allowJs`.

**Verify from code before inferring local history or intent.**
When the answer can be checked directly in the current file, the branch
diff, or git history available in the workspace, do that first. Do not
speculate with phrases like "probably", "if", or similar hedging about
code-local facts that are directly verifiable.

**Derive normalized data shapes from canonical defaults when possible.**
When a module defines a default plain-data object whose fields already
describe the complete normalized runtime shape, prefer deriving the type
with `typeof` instead of restating the same property list manually.
This keeps the default values as the single source of truth and avoids
parallel type drift. If authored input is looser than the normalized
runtime shape, define the input type as a variation of that derived type
(for example `Partial<T>` on selected fields) rather than duplicating
the full structure.


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

### Declaration merging for exported types

Modules that export a class as their default export use a
**same-name namespace** to expose associated types. This is an
intentional application of TypeScript declaration merging, chosen so
that consumers always reference types with their origin explicit:

```ts
// atmosphere.ts
class Atmosphere { ... }

namespace Atmosphere {
    export type Specification = ...;
}

export default Atmosphere;
```

Consumers then write `Atmosphere.Specification` rather than importing a
bare `Specification`. **Do not convert these to named exports.** Apply
the same pattern when adding exported types to any new module that
follows this structure.

Modules that export only free functions and types (no primary class) use
regular named exports, as in
[illumination.ts](src/core/map/illumination.ts).

### Documentation

Every new class and every new module shall have a JSDoc block:

- **Module-level:** a leading block comment describing purpose,
  responsibilities, and any significant design decisions.

- **Class-level:** a JSDoc comment immediately before the `class`
  keyword.

- **Public methods and constructors:** JSDoc with `@param` and
  `@returns` for non-obvious signatures.

Use [tile-render-rig.ts](src/core/map/tile-render-rig.ts) and
[atmosphere.ts](src/core/map/atmosphere.ts) as reference examples for
documentation style.

Private methods usually do not need JSDoc unless their functionality is
non-obvious. But if they do, it must be kept up to date; stale
documentation is worse than none.

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

Do not use `@link` or any other JSDoc tags that produce hyperlinks.
TypeScript IDEs do not render them. Reference other symbols by name
in backtick code spans instead: `` `MyClass.myMethod` ``.


## WebGL2 shaders

Shaders live in [src/core/renderer/shaders/](src/core/renderer/shaders/):

- Fragment shaders: `<name>.frag.glsl`

- Vertex shaders: `<name>.vert.glsl`

- Shared include files:
  `src/core/renderer/shaders/includes/<name>.inc.glsl`

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

`cartolina-js` inherits a two-level API structure from `vts-browser-js`:

- **Core API** (`src/core/`) — map rendering only. Consumers wire their
  own UI and navigation. Use this level when you need full control over
  interaction.

- **Browser API** ([src/browser/index.ts](src/browser/index.ts)) —
  higher-level, out-of-the-box solution with built-in UI controls and
  navigation. The term "browser" is dated but the structural split is
  preserved. Public API design should follow the
  [MapLibre GL JS](#maplibre-gl-js-primary) conventions where
  applicable.


## Source layout (new modules)

Place new TypeScript modules according to their architectural owner.
Do not put modules under `src/core/` merely because they are new.

Use `src/core/` for core map-rendering functionality. Its existing
sub-structure is:

```text
src/core/
  map/          — map-level objects (Atmosphere, TileRenderRig, Style, ...)
  renderer/     — rendering pipeline (Renderer, GpuDevice, GpuProgram, ...)
  renderer/gpu/ — low-level GPU abstractions
  utils/        — math, utilities
```

Place new modules in the most specific matching directory. Do not create
new top-level directories without a clear reason.
