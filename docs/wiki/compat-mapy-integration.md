# mapy.com integration — API method inventory

This document lists the methods the mapy.com 3D integration calls on
the cartolina-js public API. The list was established by inspecting the
minified integration JavaScript loaded by the live mapy.com site.

Only calls on the three named objects below were recorded. Calls on
mapy.com's own objects are excluded. Last verified: **2026-05-23**,
integration version **2.81.7**.

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

## Core factory object

Calls on the object returned by the `cartolina.core()` factory.

| Method / event | Notes |
|---|---|
| `.on('map-loaded', fn)` | |
| `.on('map-position-changed', fn)` | |
| `.on('gpu-context-lost', fn)` | |
| `.on('renderer-shader-error', fn)` | Not in `CoreEventMap` |
| `.destroy()` | |
| `.destroyMap()` | |

---

## Map object

Calls on the `.map` property of the core factory result. In the
current code this is `MapInterface` / `LegacyMap`.

Methods already on the public `Map` surface:

| Method | |
|---|---|
| `.getHitCoords(x, y, mode)` | `Map.ts` ✓ |
| `.convertCoordsFromNavToCanvas(pos, mode)` | `Map.ts` ✓ |

Methods that exist on `MapInterface` but are not yet promoted:

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

`getView` / `setView` use the legacy mapConfig view system. A
style-based equivalent does not yet exist.

`getCurrentGeometry` was specifically checked: it is **not** called
by the mapy.com integration.

---

## Renderer object

Calls on the `.renderer` property of the core factory result.

| Method | Notes |
|---|---|
| `.getCanvasSize()` | Not yet on public `Renderer` surface |

---

## Relationship to the refactor backlog

The "continue absorbing legacy objects into `Map`" backlog entry
([backlog.md](backlog.md)) describes the promotion work. As each
method is promoted, move its row from the "not yet promoted" table to
the "public surface" table above.
