# Wiki index

This is the landing page for the shared cartolina-js wiki.

Use it as the starting point when orienting yourself in the codebase,
then branch into more specific documents as needed.

## Table of contents

### Overview

- [architecture.md](architecture.md) — broad system structure, object
  ownership, and cross-cutting runtime notes
- [backlog.md](backlog.md) — deferred bugs, follow-up work, and
  documentation restructuring tasks
- [session-log.md](session-log.md) — chronological record of significant
  work sessions and non-obvious findings

### Integration guides

- [non-interactive.md](non-interactive.md) — non-interactive usage with
  `interactive: false`: factory call, position format, events,
  navigation, geodata overlays, and historical note on the
  removed `vts-core.js` build

### RFCs

- [rfc-draw-traversal.md](rfc-draw-traversal.md) — unified recursive
  tile-tree traversal replacing the four legacy draw modes; client-side
  mask compositing replacing server-side glues; mask-space design
  question discussed
- [rfc-config-store.md](rfc-config-store.md) — reactive ConfigStore
  to replace stringly-typed config routing; prerequisite for
  core.js suppression
- [rfc-event-bus.md](rfc-event-bus.md) — extract the event bus from
  `core.js` to a typed `EventBus<EventMap>` class as part of the
  `core.js` suppression track; `EventTarget` evaluated and rejected

### Subsystem and feature notes

- [reference-frames.md](reference-frames.md) — reference frame concepts,
  the melown2015 and QSC families, client loading path, and tileserver
  production
- [surface-metatile.md](surface-metatile.md) — surface metatile binary
  format (v1–v5), metanode fields, version history, and how the client
  uses metatiles for LOD selection, culling, and resource loading
- [lod-selection.md](lod-selection.md) — how `updateTexelSize` computes
  screen-space error from metanode fields, the two distance functions
  (`getPixelSize` vs `getPixelSize3`), degrade-horizon logic, tree
  traversal, and free-layer vs surface-layer differences
- [tileserver-metatile-production.md](tileserver-metatile-production.md) —
  how the tileserver generates metatiles on demand (VRTWO, tile index,
  serve-time GDAL warp), where the cost lies, and the structural problem
- [label-styling-engine.md](label-styling-engine.md) — reference notes
  about the shared lettering style engine, expression domains, and
  textured line patterns
- [label-regression-diagnostics.md](label-regression-diagnostics.md) —
  workflow for empirical label-pipeline regression tracing
- [render-targets.md](render-targets.md) — render-target ownership,
  auxiliary framebuffer policy, and camera/logical-size rules
- [rendering-sizes.md](rendering-sizes.md) — canvas, framebuffer,
  logical, physical, and visual-scale size relationships in the renderer
- [renderer-coordinate-spaces.md](renderer-coordinate-spaces.md) —
  renderer projection, target-local 2D coordinates, and legacy
  screen-space draw helper terminology
- [trajectory-behavior.md](trajectory-behavior.md) — flight duration and
  phase structure in `MapTrajectory`: base rules, nadir-departure patch,
  and extent-proximity short-flight patch
- [waypoint-spec.md](waypoint-spec.md) — design and behavior notes for
  the waypoint demo
- [relief-lab-spec.md](relief-lab-spec.md) — design and behavior notes
  for the relief-lab demo
- [virtual-surfaces.md](virtual-surfaces.md) — per-tile seam stitching
  and the legacy `virtualSurfaces` mapConfig concept
- [archaeology-replay-inspector.md](archaeology-replay-inspector.md) —
  the VTS-era replay inspector tool: purpose, architecture, five-file
  touchpoint map, the 2019 bug that silently broke it, and the freeze
  mode concept that supersedes it
- [vts-storage-and-virtual-surfaces.md](vts-storage-and-virtual-surfaces.md) —
  VTS storage layout, the aggregated tileset driver, how virtual surfaces
  are built and served, and the two-generation history of the alien flag
- [glue-alien-flag.md](glue-alien-flag.md) — the `isAlien` flag in
  `surfaceSequence` and why it is currently vestigial

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

For frontend/backend interface work, consult the backend repository:

- `cartolina-tileserver`
  <https://github.com/cartolinadev/cartolina-tileserver>
  Use this when working on features that involve the data or network
  interface between the two projects.
- `cartolina-tileserver/docs/resources.md`
  This is the authoritative resource-definition documentation for the
  tileserver-served resource types consumed by `cartolina-js`.

## Navigation note

The wiki is still evolving from a small set of long-form notes into a
more hierarchical reference manual.

For now:

- start here for navigation
- use [architecture.md](architecture.md) for system-level understanding
- use narrow pages for feature- or subsystem-specific findings
- use [session-log.md](session-log.md) when you need historical
  implementation context
