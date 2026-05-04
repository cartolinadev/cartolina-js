# Wiki index

This is the landing page for the shared cartolina-js wiki.

Use it as the starting point when orienting yourself in the codebase,
then branch into more specific documents as needed.

## Table of contents

### Overview

- `architecture.md` — broad system structure, object ownership, and
  cross-cutting runtime notes
- `backlog.md` — deferred bugs, follow-up work, and documentation
  restructuring tasks
- `session-log.md` — chronological record of significant work sessions
  and non-obvious findings

### Subsystem and feature notes

- `reference-frames.md` — reference frame concepts, the melown2015 and
  QSC families, client loading path, and tileserver production
- `label-styling-engine.md` — reference notes about the shared
  lettering style engine, expression domains, and textured line
  patterns
- `label-regression-diagnostics.md` — workflow for empirical
  label-pipeline regression tracing
- `render-targets.md` — render-target ownership, auxiliary framebuffer
  policy, and camera/logical-size rules
- `rendering-sizes.md` — canvas, framebuffer, logical, physical, and
  visual-scale size relationships in the renderer
- `renderer-coordinate-spaces.md` — renderer projection, target-local 2D
  coordinates, and legacy screen-space draw helper terminology
- `trajectory-behavior.md` — flight duration and phase structure in
  `MapTrajectory`: base rules, nadir-departure patch, and
  extent-proximity short-flight patch
- `waypoint-spec.md` — design and behavior notes for the waypoint demo
- `relief-lab-spec.md` — design and behavior notes for the relief-lab
  demo

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
- use `architecture.md` for system-level understanding
- use narrow pages for feature- or subsystem-specific findings
- use `session-log.md` when you need historical implementation context
