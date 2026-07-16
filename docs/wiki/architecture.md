# Architecture

See [index.md](index.md) for the wiki table of contents.

This page is the first technical read after `README.md`. It describes the
main runtime objects, where authored map state comes from, and which older
VTS concepts still shape the code. Topic pages linked below carry the
format, renderer, and migration details.

## System Shape

cartolina-js is the browser-side component of Cartolina. The backend is
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
do not configure them directly. See [normal-encoding.md](normal-encoding.md) for the stored normal
format and the bump-map collapse path.

## Principal Classes

cartolina-js has three principal classes. Every other object in the
codebase is either owned by one of them, scoped to UI / inspector /
worker concerns, or scheduled to absorb into one of them.

| Class | File | Role |
|---|---|---|
| `Viewer` | [src/browser/viewer.ts](../../src/browser/viewer.ts) | The public API. Flat, typed, MapLibre-style method surface. The object `cartolina.map()` returns. |
| `Map` | [src/core/map.ts](../../src/core/map.ts) | The typed map data model and logic. Owns the frame loop (per [rfc6-map-frame.md](rfc6-map-frame.md)), map loading, lifecycle, the event bus, and the constructed `Renderer` and `Inspector`. Not the public API class. |
| `Renderer` | [src/core/renderer/renderer.ts](../../src/core/renderer/renderer.ts) | The WebGL2 graphics class. Owns the GL context, render targets, shader programs, and draw calls. Also serves as the public surface for custom drawing from inside overlay callbacks (`drawImage`, `drawLineString`, `createTexture`, `getCanvasSize`). |

The split is by concern: `Viewer` is the consumer-facing API and the
home of UI conveniences; `Map` is the map model and frame
orchestration; `Renderer` is graphics. New code lands on the class
whose concern it matches. New public API belongs on `Viewer`. New map
data model state and per-frame state belongs on `Map`. New graphics
work belongs on `Renderer`.

Two other classes exist as residual or transitional structures:
`Browser` holds legacy UI helpers being absorbed into `Viewer`;
`LegacyMap` is the JS half of `Map` being absorbed. Neither is a
separate subsystem of the architecture; they are work-in-progress on
the way to the three-class shape.

The "Runtime Objects" section below shows the full ownership chain.

## From VTS To Cartolina

cartolina-js is a heavily divergent fork of `vts-browser-js`, the browser
client from vts-geospatial. `vts-browser-js` was a general-purpose viewer.
The wider VTS stack assembled the data and described the map; the browser
rendered terrain, photogrammetric city models, geodata, and other 3D
content.

Cartolina keeps the tiled terrain model, progressive loading, navigation,
and other parts that provide a strong base for large terrain maps. It
gives them a narrower purpose. Terrain cartography is the main subject
rather than one kind of content among many.

In Cartolina, the application authors the map through a style, which is a
complete map manifest. Styles have replaced the server-side map
configurations used in vts-geospatial. The style chooses the terrain
sources and their cartographic treatment, including imagery, lighting,
atmosphere, and labels.

The unwieldy server-side glue system has been abandoned and replaced by
a real-time client mechanism with much more flexibility. Terrain
resources can come from different tileservers, and the browser combines
them while rendering the map. Surface order and presentation can
therefore change without rebuilding the source data.

The new cartographic focus also drove a new WebGL2 terrain renderer.
Lighting, relief shading, physical atmosphere, and scale-dependent
vertical exaggeration are some of the new features absent from
vts-geospatial.

The codebase has evolved in place rather than through a clean rewrite.
It retains much of the original loading, navigation, and data machinery,
with the WebGL2 renderer, style model, and typed public API introduced
incrementally around that foundation.

Legacy map configurations remain a compatibility path, not the design
direction for new features. See
[api-and-lifecycle.md](api-and-lifecycle.md) for the
compatibility rules.

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
See [non-interactive.md](non-interactive.md).

The browser entry imports CSS for runtime behaviour. The styles define
the full-size map layout and hide the fallback overlay until the engine
enables it. If those imports leave the webpack graph, construction can
look broken even when WebGL2 is available.

## Runtime Objects

The current ownership chain is:

```text
Viewer                         public API
    Browser                      legacy UI helpers
      UI                         DOM controls
      Autopilot                  camera animation
      Presenter                  tour playback
      ControlMode                input handling
      Map                        typed map data model and engine owner
        LegacyMap                JS half of Map (being absorbed)
        Renderer                 WebGL2 renderer
          GpuDevice              GL context and render targets
```

`Viewer` is the public API. It exposes a flat MapLibre-like method
surface and owns the `Browser` instance. It also keeps a shortcut to the
internal `Map` object so public methods do not repeatedly walk through
`Browser`.

`Browser` holds the legacy UI helper objects: DOM controls, input
handling, camera animation, and presenter playback. It is private to
`Viewer` and is being absorbed into it as feature work touches that code.

`Map` in `src/core/map.ts` is the typed map data model and logic.
It is not the public API class — that is `Viewer`. `Map` owns the
event bus, the `ready` Promise, lifecycle disposal, the
`requestAnimationFrame` loop and per-frame entry point
(post-[rfc6-map-frame.md](rfc6-map-frame.md)), map loading, and the
constructed `Renderer` and `Inspector` (absorbed from the retired
`core.js` shell per [rfc1-config-store.md](rfc1-config-store.md)).
Legacy JS modules reach this instance through their `core`
back-references.

`LegacyMap` is the JS half of `Map` in `src/core/map/map.js`. It holds
the parts of the map data model that have not been rewritten in
TypeScript yet: the tile tree, loader, geodata processing, surface and
free-layer registries, camera state, coordinate conversion, and
measurement. TypeScript files import it as `LegacyMap` to avoid
colliding with the newer `Map` class. It is not a separate subsystem;
the name describes implementation status, not a logical boundary.

`Renderer` owns the WebGL2 context, GPU resources, render targets,
shader programs, and draw calls. It is also the public surface for
custom drawing from inside overlay callbacks (`drawImage`,
`drawLineString`, `createTexture`, `getCanvasSize`). Map code decides
what to draw; renderer code issues the GPU work. See [rendering-architecture.md](rendering-architecture.md),
[render-targets.md](render-targets.md), and
[renderer-coordinate-spaces.md](renderer-coordinate-spaces.md).
Low-level fixed-function GL state is covered in
[gpu-subsystem.md](gpu-subsystem.md).

## Terrain Data Flow

Terrain rendering starts with a style source. The source points at a
tileserver resource; the resource `mapConfig.json` supplies URL
templates, credits, reference frame data, and tile format metadata.

The client loads metatiles before mesh tiles. Metatiles carry compact
metanodes that describe tile existence, extents, height range, child
availability, and screen-space error data. The tile tree uses those
values for culling, LOD selection, and scheduling. See
[surface-metatile.md](surface-metatile.md) and
[lod-selection.md](lod-selection.md).

`TileRenderRig` is the current terrain tile renderer. It resolves the
mesh and layer resources for one tile, tracks readiness, builds the
style layer stack, and renders terrain color and depth passes. The old
multi-command mesh draw path has been partly deleted; remaining draw
modules still serve mapConfig-era paths and geodata. See
[rendering-architecture.md](rendering-architecture.md) and
[rfc3-draw-traversal.md](rfc3-draw-traversal.md).

## Public API Direction

New public API belongs on `Viewer`. Do not add public sub-objects or
restore VTS-style access through `.core`, `.map`, `.renderer`,
`loadMap()`, or `setParams()`. Promote a deliberate flat `Viewer`
method when a capability needs to be public.

The remaining migration direction is:

- route `Viewer` methods through `Map`
- move `Browser` behaviour into `Viewer`
- move `LegacyMap` behaviour into `Map` when feature work already
  touches that area
- keep `Renderer` as the owner of GPU state

See [api-and-lifecycle.md](api-and-lifecycle.md) for construction,
async readiness, events, configuration routing, and teardown rules.

## Design References

MapLibre GL JS is the primary API reference. Cartolina follows its
single-map-object shape, event vocabulary where the concepts match, and
style-oriented authoring model. Compatibility is not a goal.

Three.js is useful when comparing WebGL state management, shader source
organization, and renderer conventions. CesiumJS is useful when working
on globe, terrain, reference-frame, or camera math problems.
