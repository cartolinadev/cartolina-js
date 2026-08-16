# mapy.com integration — API method inventory

This document lists the methods the mapy.com 3D integration calls on
the legacy VTS-style object graph. The list was established by
inspecting the minified integration JavaScript loaded by the live
mapy.com site.

Only calls on the three named objects below were recorded. Calls on
mapy.com's own objects are excluded. Last verified: **2026-05-23**,
integration version **2.81.7**.

### Active metatile version

Metatile responses from the mapy.com production tileserver
(`mapserver-3d.mapy.cz`) use **version 4** of the binary metatile
format, confirmed by inspecting live responses in 2026-05. Version 4
stores `minZ`, `maxZ`, and `surrogatez` as explicit float32 values in
the spatial division node coordinate system (SDS), independent of the
int16 navSRS `minHeight`/`maxHeight` fields.

Version 4 is the oldest format the client parses, so this deployment
sits at the lower bound of client support. See
[surface-metatile.md](surface-metatile.md) for the supported range and
[nav-tiles.md](nav-tiles.md) for the full navtile analysis.

Current cartolina-js applications do not access a `cartolina.core()`
factory object. They call `cartolina.map(options)`, which is now the
only factory; a legacy mapConfig reaches it through
`mapConfigToStyle()` first. It
returns the `Viewer` class from `src/viewer/viewer.ts`. Package
consumers see that class through the exported `Map` type alias.
Promoted public methods should appear as flat methods on `Viewer`.
Many of those methods delegate through `src/map/map.ts`, which is the
typed internal boundary between `Viewer` and the legacy map engine. The
legacy `.map` and `.renderer` objects recorded below are observed
mapy.com usage, not current cartolina-js API design.

## How to use this list

When considering removing or substantially changing any method below,
consult this list as part of the decision. For each affected method,
consider:

- what mapy.com uses it for
- whether cartolina-js already offers a clear alternative
- how much migration effort the change would require on their side

The list is a soft reference, not a hard constraint. Removal is not
blocked if a reasonable migration path exists or the method is
genuinely unused for meaningful functionality. The goal is to avoid
silently losing functionality that would make a future migration
significantly harder, not to freeze the API.

---

## Legacy factory result

Calls on the object returned by the old `cartolina.core()` factory used
by mapy.com.

| Method / event | Notes |
|---|---|
| `.on('map-loaded', fn)` | |
| `.on('map-position-changed', fn)` | |
| `.on('gpu-context-lost', fn)` | |
| `.on('renderer-shader-error', fn)` | Not in `CoreEventMap` |
| `.destroy()` | |
| `.destroyMap()` | |

---

## Legacy map object

Calls on the `.map` property of the legacy factory result. In the
current code this is `LegacyMap`.

Methods already promoted to `Viewer`:

| Method | |
|---|---|
| `.getHitCoords(x, y, mode)` | `Viewer` ✓ |
| `.convertCoordsFromNavToCanvas(pos, mode)` | `Viewer` ✓ |
| `.getView()` / `.setView()` / named views | removed with the mapConfig runtime (rfc11); named views convert to visibility profiles applied through `Viewer.applyVisibilityProfile()` |

Methods that currently exist on the legacy map object only:

| Method | Notes |
|---|---|
| `.getPosition()` | Position camera / nav query |
| `.setPosition(pos)` | |
| `.redraw()` | |
| `.movePositionCoordsTo(pos, azimuth, dist)` | Pan helper |
| `.convertPositionHeightMode(pos, mode)` | Fix / float conversion |
| `.getPositionCameraCoords(posArray, mode)` | Camera world coords |
| `.getReferenceFrame()` | Reference frame metadata |
| `.getSrsInfo(srs)` | SRS metadata |
| `.getStats()` | Render performance stats |
| `.getCreditInfo()` | Data attribution |
| `.getCurrentCredits()` | Data attribution |
| `.renderToImage()` | Screenshot / pixel export |
| `.createGeodata()` | Returns a geodata builder |
| `.addFreeLayer(name, freeLayer)` | Add a vector overlay |
| `.removeFreeLayer(name)` | |
| `.generateTrajectory(from, to, opts)` | Fly-to animation |
`getCurrentGeometry` was specifically checked: it is **not** called
by the mapy.com integration.

---

## No longer existent

Use this section for methods from the observed mapy.com call surface
that are later deleted from cartolina-js. Each entry should say what
replaced it, or that no replacement is planned.

`.addRenderSlot(name, fn, enabled)`, `.moveRenderSlotAfter(...)`,
`.moveRenderSlotBefore(...)`, `.removeRenderSlot(...)`,
`.setRenderSlotEnabled(...)`, `.getRenderSlotEnabled(...)` — **removed
2026-05-25**. Replaced by typed `Viewer.addOverlay(name, spec)`,
`removeOverlay`, `setOverlayEnabled`. Migration:

```diff
- map.addRenderSlot('custom-render', fn, true);
- map.moveRenderSlotAfter('after-map-render', 'custom-render');
+ viewer.addOverlay('custom-render', { render: fn });
```

The `moveRenderSlotAfter` line was a silent no-op in the inherited
idiom (the gate in `MapRenderSlots` was inverted); removing it is a
behavioural no-op. The overlay runs once per frame, after the engine
draws to the canvas, and is skipped on the depth/hit pass — fixing a
latent bug where custom slots ran in the hitmap pass.

`browser.setConfigParam(key, value)`, `browser.setConfigParams(...)`,
`browser.getConfigParam(key)` — **removed 2026-07-13**. The observed
mapy.com call surface does not include them (they are absent from
the inventory above). Replacement for applications: the typed
`Viewer.setParam` / `Viewer.getParam` over the public runtime
subset; construction-time values go through the factory option
bag. Converted mapConfig `browserOptions` return as typed
`viewerOptions` from `mapConfigToStyle()` and merge below the
caller's own options.

---

## Legacy renderer object

Calls on the `.renderer` property of the legacy factory result.

| Method | Notes |
|---|---|
| `.getCanvasSize()` | Present on legacy renderer object |

---

## Relationship to the refactor backlog

The "continue absorbing legacy objects into `Map`" backlog entry
([backlog.md](backlog.md)) tracks work that may replace selected legacy
methods with deliberate public APIs. This document does not require
promotion. When a method is promoted, move its row to the public-surface
table above. When a method is removed, move its row to the "No longer
existent" section with a short note.
