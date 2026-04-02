# Agent Guidelines — cartolina-js

## Orientation

Read [README.md](README.md) first. Two legacy documentation sources are available as on-demand references for understanding the codebase:

- [vts-browser-js wiki](https://github.com/melowntech/vts-browser-js/wiki) — documents the upstream fork; useful when working with legacy code.
- [melowntech/workshop](https://github.com/melowntech/workshop) (very dated) — the Architecture Overview section defines general concepts that recur throughout the codebase: `mapConfig.json` is the primary interface contract between the backend and the frontend; **surfaces** are streamed 3D terrain meshes; **bound layers** are raster overlays; **geodata** are vector features.

`cartolina-js` is a WebGL2 3D terrain cartography library for the web. It is the frontend half of a two-component stack; the backend is [`cartolina-tileserver`](https://github.com/cartolinadev/cartolina-tileserver), a C++ Unix daemon that processes geospatial data and streams formatted tiles to the client. Consult that repository when working on features that involve the data or network interface between the two projects.

The tileserver serves terrain surfaces (TIN meshes) and raster tile layers over an nginx reverse proxy (default: `localhost:8070/mapproxy`). Tile types consumed by `cartolina-js` include terrain surfaces, normal maps, specular reflection maps, bump maps, and shaded-relief rasters. Normal maps are bundled with terrain surfaces and discovered automatically via tileserver-provided metadata — no special client configuration is needed. Authoritative resource-definition documentation is in [`docs/resources.md`](https://github.com/cartolinadev/cartolina-tileserver/blob/main/docs/resources.md) in the tileserver repository; the [legacy vts-mapproxy docs](https://web.archive.org/web/20230206094802/https://vts-geospatial.org/reference/server/mapproxy/index.html) cover most resource types and are still accurate.

Key capabilities the library implements:
- Digital elevation model rendering at varying resolutions
- Hillshading with native lighting models and scale-dependent vertical exaggeration
- Bump-mapping using satellite or aerial imagery
- Atmospheric effects (background haze, foreground shadows, sun glint based on land-cover data)
- Support for high-latitude and polar regions without dateline issues
- Multiple frames of reference, including planetary bodies
- Point labels with visual hierarchy

The goal is to become a modern web-based cartography library with a truly three-dimensional underlying data model. It is a heavily diverged fork of the now-discontinued `vts-browser-js`. The codebase is a ten-year-old project in gradual, **feature-driven** refactoring. Most legacy JavaScript code still exists alongside newer TypeScript modules.

## Environment

- `nvm`-managed Node 18 is the expected runtime for repo commands. Before running `npm` or `node` commands in a fresh shell, explicitly load `nvm` and select Node 18, for example:

```bash
source ~/.nvm/nvm.sh && nvm use 18
```

- Do not assume the default `node` on `PATH` is correct; verify with `node -v` if a command fails unexpectedly.


## Code and refactoring philosophy

Code is liability. Less code means fewer bugs and easier maintenance. We like to delete code.

- **Write as little code as possible.** Before writing new code, search for existing functionality to reuse. When duplication is unavoidable, abstract — but only once the duplication is real and the right abstraction is clear.

- **Dead code removal is encouraged**, not just code that was explicitly replaced during refactoring, but also code that has no role in the current test applications (see [Test applications](#test-applications) below). When in doubt, remove and verify tests still pass.

- **Backward compatibility with vts-browser-js APIs is not a goal.** Old APIs may be removed without deprecation periods.

- **Do not add abstraction layers, helpers, or utilities for hypothetical future use.** Only the minimum complexity needed for the current task.

Refactoring is feature-driven, not an end in itself:

- Refactoring small modules as part of a feature implementation is encouraged when it genuinely improves quality — just keep the scope proportionate.

- When a feature is complex, it is acceptable to first build it on top of duplicated code to make it testable, and then refactor in a second step once you have confidence from regression tests.

- Do not refactor speculatively or as a stand-alone exercise.


## Test applications

The canonical set of test cases is defined in [test/urls.json](test/urls.json). Each entry describes a map configuration (style + camera position) accessible from the webpack dev server.

**After any code change, verify that all test URLs still render correctly:**

1. Start the dev server: `npm start`
2. Open each URL listed under `"urls"` in `test/urls.json`, substituting the `"dev"` template.
3. Check for visual regressions and console errors.

The test index page is at `http://localhost:8080/test/`.

Automated performance regression tests can be run with:

```bash
npm run test:perf:headed
```

Results are viewable at `http://localhost:8080/test/perf`. A result is a regression if FPS drops by more than 10% or load time increases by more than 30%.


## Language and module rules

- **No new JavaScript modules.** All new source files shall be TypeScript (`.ts`).

- **No pre-WebGL2 GLSL.** New shaders shall target GLSL ES 3.00 (`#version 300 es`). Do not write GLSL ES 1.00 shaders. The runtime context is `WebGL2RenderingContext`.

- **Strict TypeScript.** New code shall pass strict TypeScript checks. Legacy code may not conform — do not relax strict settings to accommodate it; fix or isolate the legacy code instead.


## TypeScript conventions

### Declaration merging for exported types

Modules that export a class as their default export use a **same-name namespace** to expose associated types. This is an intentional application of TypeScript declaration merging, chosen so that consumers always reference types with their origin explicit:

```ts
// atmosphere.ts
class Atmosphere { ... }

namespace Atmosphere {
    export type Specification = ...;
}

export default Atmosphere;
```

Consumers then write `Atmosphere.Specification` rather than importing a bare `Specification`. **Do not convert these to named exports.** Apply the same pattern when adding exported types to any new module that follows this structure.

Modules that export only free functions and types (no primary class) use regular named exports, as in [illumination.ts](src/core/map/illumination.ts).

### Documentation

Every new class and every new module shall have a JSDoc block:

- **Module-level:** a leading block comment describing purpose, responsibilities, and any significant design decisions.
- **Class-level:** a JSDoc comment immediately before the `class` keyword.
- **Public methods and constructors:** JSDoc with `@param` and `@returns` for non-obvious signatures.

Use [tile-render-rig.ts](src/core/map/tile-render-rig.ts) and [atmosphere.ts](src/core/map/atmosphere.ts) as reference examples for documentation style.

Internal/private methods do not require JSDoc unless the logic is non-obvious.


## WebGL2 shaders

Shaders live in [src/core/renderer/shaders/](src/core/renderer/shaders/):

- Fragment shaders: `<name>.frag.glsl`
- Vertex shaders: `<name>.vert.glsl`
- Shared include files: `src/core/renderer/shaders/includes/<name>.inc.glsl`

All shaders target GLSL ES 3.00 (`#version 300 es`).


## API design references

### MapLibre GL JS (primary)

Look to [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) as the primary reference for API design. This is not about achieving compatibility, but about making the library feel familiar to developers coming from MapLibre or Mapbox. Borrow types, naming, and design patterns where they map naturally — camera position specification, style object shape, event API shape, option bags, etc.

### CesiumJS (secondary, technical)

[CesiumJS](https://cesium.com/learn/cesiumjs/ref-doc/) has a different purpose and API philosophy but is a useful reference for the technical design and implementation of specific features — particularly around globe rendering, coordinate systems, and terrain. Draw on it for implementation ideas, not API surface.


## API structure

`cartolina-js` inherits a two-level API structure from `vts-browser-js`:

- **Core API** (`src/core/`) — map rendering only. Consumers wire their own UI and navigation. Use this level when you need full control over interaction.

- **Browser API** ([src/browser/index.ts](src/browser/index.ts)) — higher-level, out-of-the-box solution with built-in UI controls and navigation. The term "browser" is dated but the structural split is preserved. Public API design should follow the [MapLibre GL JS](#maplibre-gl-js-primary) conventions where applicable.


## Source layout (new modules)

New TypeScript modules belong under `src/core/`. The existing sub-structure is:

```
src/core/
  map/          — map-level objects (Atmosphere, TileRenderRig, Style, ...)
  renderer/     — rendering pipeline (Renderer, GpuDevice, GpuProgram, ...)
  renderer/gpu/ — low-level GPU abstractions
  utils/        — math, utilities
```

Place new modules in the most specific matching directory. Do not create new top-level directories without a clear reason.
