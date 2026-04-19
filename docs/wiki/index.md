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

- `label-styling-engine.md` — reference notes about the shared
  lettering style engine, expression domains, and textured line
  patterns
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

- `vts-browser-js` wiki
  <https://github.com/melowntech/vts-browser-js/wiki>
  Documents the upstream fork and is often useful when working with
  legacy code paths or inherited API concepts.
- `melowntech/workshop`
  <https://github.com/melowntech/workshop>
  Very dated, but the Architecture Overview section still explains
  recurring concepts such as `mapConfig.json`, surfaces, bound layers,
  and geodata.

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
