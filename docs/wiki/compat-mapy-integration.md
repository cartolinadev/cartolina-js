# mapy.com integration — API method inventory

This document lists the methods the mapy.com 3D integration calls on
the legacy VTS-style object graph. The list was established by
inspecting the minified integration JavaScript loaded by the live
mapy.com site.

Only calls on the three named objects below were recorded. Calls on
mapy.com's own objects are excluded. Last verified: **2026-05-23**,
integration version **2.81.7**.

Current cartolina-js applications do not access a `cartolina.core()`
factory object. They call `cartolina.map(options)` for style-based maps
or `cartolina.browser(element, config)` for legacy mapConfig maps. Both
return the `Viewer` class from `src/browser/viewer.ts`. Package
consumers see that class through the exported `Map` type alias.
Promoted public methods should appear as flat methods on `Viewer`.
Many of those methods delegate through `src/core/map.ts`, which is the
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
current code this is `MapInterface` / `LegacyMap`.

Methods already promoted to `Viewer`:

| Method | |
|---|---|
| `.getHitCoords(x, y, mode)` | `Viewer` ✓ |
| `.convertCoordsFromNavToCanvas(pos, mode)` | `Viewer` ✓ |

Methods that currently exist on `MapInterface` only:

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
| `.addRenderSlot(name, fn, bool)` | Custom render callback |
| `.moveRenderSlotAfter(slot, afterSlot)` | Order render passes |
| `.generateTrajectory(from, to, opts)` | Fly-to animation |
| `.getView()` | Returns named mapConfig view |
| `.setView(viewName)` | Switches named mapConfig view |

`getView` / `setView` use the legacy mapConfig view system. That
system is not a committed public API direction.

`addRenderSlot` / `moveRenderSlotAfter` expose legacy render-loop
insertion points. They are recorded here because mapy.com calls them,
not because they should be promoted unchanged.

`getCurrentGeometry` was specifically checked: it is **not** called
by the mapy.com integration.

---

## No longer existent

Use this section for methods from the observed mapy.com call surface
that are later deleted from cartolina-js. Each entry should say what
replaced it, or that no replacement is planned.

No observed mapy.com methods have been deleted as of 2026-05-23.

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
