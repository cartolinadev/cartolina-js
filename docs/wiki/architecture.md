# Architecture

See `index.md` for the wiki table of contents.

This page is the first technical read after `README.md`. It describes the
main runtime objects, where authored map state comes from, and which older
VTS concepts still shape the code. Topic pages linked below carry the
format, renderer, and migration details.

## System Shape

cartolina-js is the browser-side component of cartolina. The backend is
`cartolina-tileserver`, a C++ daemon that serves tile resources and one
`mapConfig.json` endpoint per terrain resource. The client fetches those
resources, builds a terrain tile tree, and renders it with WebGL2.

The client consumes these resource kinds:

| Resource | Role |
|---|---|
| Terrain surfaces | TIN meshes with bundled normal maps |
| Raster overlays | Satellite, aerial, or thematic imagery |
| Bump maps | Surface detail folded into terrain normals |
| Specular maps | Surface reflectance for sun glint |
| Geodata free layers | 3D vector data used for lettering and overlays |

Terrain normal maps are discovered from tileserver metadata. Style files
do not configure them directly. See `normal-encoding.md` for the stored
normal format and the bump-map collapse path.

## From VTS To Cartolina

cartolina-js is a heavily diverged fork of `vts-browser-js`, the browser
client from VTS-geospatial. VTS-geospatial was a larger 3D geospatial
stack built around server-side composition:

- `mapproxy` streamed GIS sources as VTS tile resources.
- `vtsd` served static tilesets and translated storage views into
  `mapConfig.json`.
- the `vts` CLI managed filesystem storages and generated glue tilesets
  between overlapping surfaces.
- `vts-registry` supplied reference frame and SRS definitions to all
  components.

cartolina removed that model. It has no `vtsd`, storage views, storage
CLI, encoder toolchain, browser-C++ client, or system-installed
`vts-registry`. The tileserver serves independent resources; the browser
decides how to combine them.

There is no glue-tile system in cartolina. In VTS-geospatial,
overlapping surfaces in one storage needed precomputed glue tilesets to
render without gaps at the overlap. cartolina treats each surface as an
independent source and does not blend between surfaces at overlap
boundaries.

The main replacement is the client-side style specification. A
`style.json` lists sources, terrain sources, diffuse/bump/specular
layers, illumination, atmosphere, and vertical exaggeration. This is the
composition contract for new applications. The inherited mapConfig path
still loads legacy maps, but no new authored feature should be added to
it. See `api-and-lifecycle.md` for the compatibility rules.

Reference frames still come from the VTS model, but they are embedded in
each surface `mapConfig.json` served by the tileserver. The client takes
the reference frame from the first loaded surface. See
`reference-frames.md`.

## Build And Entry Point

The webpack build has one application entry point:

| Entry point | Output | Purpose |
|---|---|---|
| `src/browser/index.ts` | `cartolina.js` / `.esm.js` | Browser library |

The public factory is `map()`. It returns a `Viewer` instance, exported
as the public `Map` type alias. `browser()` is a deprecated compatibility
alias for the old vts-browser-js factory.

Worker bundles such as `map-loader-worker.js` and
`geodata-processor-worker.js` are produced separately. They are loaded by
the runtime and are not application entry points.

Until 2026-05, the repo also built `vts-core.js` from
`src/core/index.ts`. That headless build was removed; applications that
need their own input handling now use `interactive: false` on `map()`.
See `non-interactive.md`.

The browser entry imports CSS for runtime behaviour. The styles define
the full-size map layout and hide the fallback overlay until the engine
enables it. If those imports leave the webpack graph, construction can
look broken even when WebGL2 is available.

## Runtime Objects

The current ownership chain is:

```text
Viewer                         public API
  Browser                      legacy UI engine
    UI                         DOM controls
    Autopilot                  camera animation
    Presenter                  tour playback
    ControlMode                input handling
    Map                        internal engine boundary
      Core                     engine coordinator
        LegacyMap              terrain data and scene state
        MapInterface           legacy terrain API wrapper
        Renderer               WebGL2 renderer
          GpuDevice            GL context and render targets
```

`Viewer` is the public API. It exposes a flat MapLibre-like method
surface and owns the `Browser` instance. It also keeps a shortcut to the
internal `Map` object so public methods do not repeatedly walk through
`Browser`.

`Browser` is the legacy UI engine. It creates DOM controls, input
handling, camera animation, and presenter playback. It is private to
`Viewer` and is being absorbed into it as feature work touches that code.

`Map` in `src/core/map.ts` is not the public API class. It is the typed
boundary between the UI code and the older engine objects. It owns the
event methods, the `ready` Promise, and lifecycle disposal. Its `core`
getter is a temporary migration hook.

`Core` coordinates startup, map loading, configuration routing, the
animation frame callback, auth headers, `LegacyMap`, and `Renderer`.
It is a legacy coordinator scheduled to disappear into `Map`.

`LegacyMap` is the terrain engine in `src/core/map/map.js`. It owns the
tile tree, loader, geodata processing, camera state, coordinate
conversion, measurement, atmosphere object, and render slots. TypeScript
files import it as `LegacyMap` to avoid colliding with the newer `Map`
class. `LegacyMap` is also destined to dissolve into `Map` as feature
work moves terrain-engine behaviour into TypeScript.

`Renderer` owns the WebGL2 context, GPU resources, render targets,
shader programs, and draw calls. It remains separate from `Map`. Map
code should decide what to draw; renderer code should issue the GPU
work. See `rendering-architecture.md`, `render-targets.md`, and
`renderer-coordinate-spaces.md`.

## Terrain Data Flow

Terrain rendering starts with a style source. The source points at a
tileserver resource; the resource `mapConfig.json` supplies URL
templates, credits, reference frame data, and tile format metadata.

The client loads metatiles before mesh tiles. Metatiles carry compact
metanodes that describe tile existence, extents, height range, child
availability, and screen-space error data. The tile tree uses those
values for culling, LOD selection, and scheduling. See
`surface-metatile.md` and `lod-selection.md`.

`TileRenderRig` is the current terrain tile renderer. It resolves the
mesh and layer resources for one tile, tracks readiness, builds the
style layer stack, and renders terrain color and depth passes. The old
multi-command mesh draw path has been partly deleted; remaining draw
modules still serve mapConfig-era paths and geodata. See
`rendering-architecture.md` and `rfc-draw-traversal.md`.

## Public API Direction

New public API belongs on `Viewer`. Do not add public sub-objects or
restore VTS-style access through `.core`, `.map`, `.renderer`,
`loadMap()`, or `setParams()`. Promote a deliberate flat `Viewer`
method when a capability needs to be public.

The remaining migration direction is:

- route `Viewer` methods through `Map`, then remove the `Map.core`
  escape hatch
- move `Browser` behaviour into `Viewer`
- move `Core` and `LegacyMap` behaviour into `Map` when feature work
  already touches that area
- keep `Renderer` as the owner of GPU state

See `api-and-lifecycle.md` for construction, async readiness, events,
configuration routing, and teardown rules.

## Design References

MapLibre GL JS is the primary API reference. cartolina follows its
single-map-object shape, event vocabulary where the concepts match, and
style-oriented authoring model. Compatibility is not a goal.

Three.js is useful when comparing WebGL state management, shader source
organization, and renderer conventions. CesiumJS is useful when working
on globe, terrain, reference-frame, or camera math problems.
