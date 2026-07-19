# Wiki index

This is the landing page for the shared cartolina-js wiki.

Use it as the starting point when orienting yourself in the codebase,
then branch into more specific documents as needed.

## Table of contents

### Overview

- [architecture.md](architecture.md) — broad system structure, object
  ownership, and links to focused topic notes
- [backlog.md](backlog.md) — deferred bugs, follow-up work, and
  documentation restructuring tasks
- [session-log.md](session-log.md) — chronological record of significant
  work sessions and non-obvious findings

### Tileserver documentation

- [cartolina-tileserver documentation][tileserver-docs] — tileserver
  operator guides, implementation notes, resource reference, and session log

### Integration guides

- [non-interactive.md](non-interactive.md) — non-interactive usage with
  `interactive: false`: factory call, position format, events,
  navigation, geodata overlays, and historical note on the
  removed `vts-core.js` build
- [request-transform.md](request-transform.md) — MapLibre-style
  `transformRequest` hook for URL rewrites, request headers,
  credentials, and authentication
- [compat-mapy-integration.md](compat-mapy-integration.md) — inventory
  of the API methods the mapy.com 3D integration consumes; reference
  for assessing migration impact when removing or changing those methods

### RFCs — active

RFCs are numbered in a plain integer sequence; see the RFC protocol
in [AGENTS.md](../../AGENTS.md).

- RFC 8 [rfc8-context-loss-recovery.md](rfc8-context-loss-recovery.md) —
  recover from WebGL context loss at the map level: flush GPU caches,
  re-create renderer statics from one entry point, let the lazy tile
  machinery repopulate

### Data model

- [reference-frames.md](reference-frames.md) — reference frame concepts,
  the melown2015 and QSC families, client loading path, and tileserver
  production
- [surface-metatile.md](surface-metatile.md) — surface metatile binary
  format (v1–v6, incl. the v6 watertight bitplane), metanode fields,
  version history, and how the client uses metatiles for LOD selection,
  culling, and resource loading
- [lod-selection.md](lod-selection.md) — how metatile texel length is
  generated, stored, and projected to screen-space error in
  `updateTexelSize`; distance functions, degrade-horizon logic, tree
  traversal, and comparisons with other renderers

### Geodata and labels

- [geodata-rendering.md](geodata-rendering.md) — current geodata
  render path: tile traversal, job collection, and queued job drawing
- [label-styling-engine.md](label-styling-engine.md) — reference notes
  about the shared lettering style engine, expression domains, and
  textured line patterns

### Rendering

- [rendering-architecture.md](rendering-architecture.md) — map/renderer
  ownership boundary, `TileRenderRig`, legacy draw code, and
  illumination notes
- [gpu-subsystem.md](gpu-subsystem.md) — WebGL/GPU subsystem ownership,
  `GpuDevice` fixed-function state, and pass-boundary responsibilities
- [render-targets.md](render-targets.md) — render-target ownership,
  auxiliary framebuffer policy, and camera/logical-size rules
- [rendering-sizes.md](rendering-sizes.md) — canvas, framebuffer,
  logical, physical, and visual-scale size relationships in the renderer
- [renderer-coordinate-spaces.md](renderer-coordinate-spaces.md) —
  renderer projection, target-local 2D coordinates, and legacy
  screen-space draw helper terminology
- [normal-encoding.md](normal-encoding.md) — octahedral RG normal
  encoding: why it is kept for full-sphere coverage and uniform precision,
  the nonlinearity problem when blending encoded values, and how
  `TextureBlend` oct-normal mode fixes it for bump-layer collapse
- [tile-render-rig-profiling.md](tile-render-rig-profiling.md) —
  settled-state GPU cost of the terrain color shader on `simple.json`:
  method and clock-drift caveat, the fill-bound finding, two confirmed
  wins (discard×MSAA, layer-VM split), and a normal-tap change that did
  not pay off on this hardware

### API, navigation, demos, and testing

- [api-and-lifecycle.md](api-and-lifecycle.md) — public API direction,
  construction, async readiness, configuration routing, events, teardown,
  and CSS runtime dependency
- [trajectory-behavior.md](trajectory-behavior.md) — flight duration and
  phase structure in `MapTrajectory`: base rules, nadir-departure patch,
  and extent-proximity short-flight patch
- [waypoint-spec.md](waypoint-spec.md) — design and behavior notes for
  the waypoint demo
- [relief-lab-spec.md](relief-lab-spec.md) — design and behavior notes
  for the relief-lab demo
- [label-regression-diagnostics.md](label-regression-diagnostics.md) —
  workflow for empirical label-pipeline regression tracing
- [testing-notes.md](testing-notes.md) — non-obvious regression-test
  behaviour, including transient upstream tile-source failures

### Legacy VTS concepts

- [nav-tiles.md](nav-tiles.md) — what navtile textures are, how the
  client uses them for terrain height queries (camera, coordinate
  conversion, geodata draping), the v1–v3 height-range propagation
  path, the legacy grid-fallback relationship, and dead code
- [virtual-surfaces.md](virtual-surfaces.md) — per-tile seam stitching
  and the legacy `virtualSurfaces` mapConfig concept (client
  implementation removed 2026-06-08; retained as a server-side concept)
- [vts-storage-and-virtual-surfaces.md](vts-storage-and-virtual-surfaces.md) —
  VTS storage layout, the aggregated tileset driver, how virtual surfaces
  are built and served, and the two-generation history of the alien flag
- [glue-alien-flag.md](glue-alien-flag.md) — the `isAlien` flag in
  `surfaceSequence` (client implementation removed 2026-06-08; retained
  as a record of the VTS concept)
- [vts-vtsd-archeology.md](vts-vtsd-archeology.md) — how vts-vtsd serves
  stored tilesets (delivery only, no transcoding), where the watertight
  information lives, and the `vts --reencode` process that upgrades a
  legacy v5 tileset to v6 with correct watertight flags and a
  cache-busting revision bump

### RFC archive

- [rfcs-implemented.md](rfcs-implemented.md) — completed RFCs,
  newest first

## Other documentation sources

Read `README.md` first for the project-level introduction.

For understanding the legacy codebase and its concepts, these are the
main on-demand references:

- `vts-registry`
  <https://github.com/melowntech/vts-registry>
  Authoritative definitions of all built-in reference frames and SRS
  entries (`registry/registry/referenceframes.json`,
  `registry/registry/srs.json`). The tileserver loads these at startup;
  the client receives the relevant subset embedded in `mapConfig.json`.
- `melowntech/workshop`
  <https://github.com/melowntech/workshop>
  Very dated, but `reference/concepts.rst` is the best prose explanation
  of reference frames, position format, surfaces, bound layers, and
  geodata. Start here for conceptual background.
- `vts-browser-js` wiki
  <https://github.com/melowntech/vts-browser-js/wiki>
  Documents the upstream fork. Useful when working with legacy code
  paths or inherited API concepts.

For the tileserver's internal workings and operation, consult the
backend repository:

- [cartolina-tileserver documentation][tileserver-docs]
  contains tileserver operator guides, implementation notes, the resource
  reference, and the backend session log.

[tileserver-docs]: https://github.com/cartolinadev/cartolina-tileserver/blob/main/docs/index.md

## Writing guidelines

The intended structure is three levels:

1. `index.md` and `architecture.md` — broad orientation and ownership.
2. Subsystem pages — ownership, invariants, and links for one area of
   the runtime, such as `gpu-subsystem.md` or `geodata-rendering.md`.
3. Topic pages — focused mechanics, formats, diagnostics, or gotchas,
   such as `render-targets.md`, `normal-encoding.md`, or
   `label-regression-diagnostics.md`.

Keep broad architecture notes out of topic pages, and keep low-level
mechanics out of [architecture.md](architecture.md) unless they
affect ownership across subsystems.

Always use link syntax for cross-references to other wiki pages:
`[filename.md](filename.md)`. Do not use backtick code format for
file names that are navigation references.

The current structure mixes levels 2 and 3. The split into separate subsystem 
and topic sections has not happened yet.
