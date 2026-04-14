# Waypoint demo — specification

A geographic story / presentation demo. The user navigates a sequence
of map positions ("waypoints") with arrow keys; the camera flies
smoothly between them via `autopilot.flyTo()`. HTML image markers can
be anchored to geographic coordinates and track the camera in real
time. The module is embeddable in a reveal.js presentation.

---

## Name and location

**`waypoint`** — `demos/waypoint/`

---

## New files

### `demos/waypoint/config.example.json`

Config schema (JSON):

```
{
  "positions": [
    {
      "name": "my-place",          ← optional symbolic name
      "position": ["obj", lon, lat, "fix", h, yaw, pitch, roll, extent, fov],
      "flyTo": { "speed": 1.0, "maxHeight": 50000 }
    }
  ],
  "markers": [
    {
      "coords": [lon, lat],        ← height optional; omit → 'float'
      "url": "https://…/pin.png",
      "offset": [0, 0],            ← px shift from bottom-center anchor
      "height": 90,                ← CSS display height in px (default 90)
      "show": ["my-place"],        ← visible only at these waypoints
      "hide": ["other-place"]      ← hidden at these waypoints
    }
  ]
}
```

- `positions[].name` — optional symbolic name used by marker filters.
  Using names keeps filters stable when positions are reordered or
  new entries are inserted.
- `positions[].flyTo` — all fields optional; forwarded verbatim to
  `autopilot.flyTo(position, options)`.
- `markers[].coords` — 2-element `[lon, lat]` uses terrain-surface
  height (`'float'`); 3-element `[lon, lat, h]` uses fixed height
  (`'fix'`).
- `markers[].offset` — CSS-pixel `[x, y]` offset applied after the
  default anchor. Default anchor: middle of the image's lower edge
  sits on the geo position.
- `markers[].height` — CSS display height in pixels. Width scales
  proportionally unless `width` is also set. Default: 90 px.
- `markers[].show` — optional inclusive filter: marker is visible only
  when the current waypoint's `name` appears in this list.
- `markers[].hide` — optional exclusive filter: marker is hidden when
  the current waypoint's `name` appears in this list. If neither
  `show` nor `hide` is set the marker is always shown (subject to the
  depth check).

### `demos/waypoint/waypoint.js`

Self-contained vanilla ES module (no build step). Loaded alongside
`cartolina.js` in the browser.

Public API:
```
class WaypointMap {
    constructor(container, options)
    next()           // fly to next position (clamps at end)
    prev()           // fly to previous position (clamps at start)
    goTo(index)      // fly to position[index]
    destroy()        // tear down map + markers + listeners
    currentIndex     // (getter) current position index
    slideCount       // (getter) total positions
    on(event, cb)    // events: 'slide-change', 'fly-start', 'fly-end'
}
```

Options:
```
{
  style:  './styles/complex.json',  // URL or style object
  config: './config.json',          // URL or config object
  keys:   true                      // install arrow-key listeners
}
```

**Marker update loop:** subscribes to the viewer's `'tick'` event.
Each frame, for each marker:

1. Apply `show` / `hide` filter using the current waypoint `name`.
   Skip (hide) the marker if the filter excludes it.
2. Height mode: `coords.length === 2` → `'float'`, else `'fix'`.
3. `viewer.convertCoordsFromPublicToNav(coords, mode)` → nav `[x,y,z]`
4. `viewer.convertCoordsFromNavToCanvas(navCoords, mode)` → canvas
   `[px, py, depth]`
5. Set CSS size on the `<img>` from config (`height`, optional `width`).
6. `depth <= 1` (in front of camera): position element at
   `left = px - img.offsetWidth/2 + offset[0]`,
   `top  = py - img.offsetHeight  + offset[1]`.
   Otherwise hide.

Marker elements are absolutely-positioned `<img>` (or `<a><img>` when
a link is provided) in a pointer-events-none overlay `<div>`.

**Depth / occlusion limitation:** The depth check (`depth <= 1`) tests
only whether the geo point is in front of the camera's near plane. It
does **not** test occlusion by terrain geometry. A marker anchored to a
location on the far side of the globe can remain visible during
cross-planetary navigation. Use `show` / `hide` filters to suppress
markers that are not relevant to the current waypoint.

### `demos/waypoint/index.html`

- Loads `../../build/cartolina.js` + `../../build/cartolina.css`.
- Imports `./waypoint.js` as an ES module.
- URL params: `style=` (default complex.json), `config=` (default
  config.example.json).
- Arrow-key HUD: `←` / `→` navigate waypoints.
- Slide counter: "2 / 5", bottom-center.

---

## Modified files

### `src/browser/viewer.ts`

Two coordinate-conversion methods promoted from `MapInterface` to
`Viewer` (in the "Hit testing and coordinate conversion" section):

```typescript
convertCoordsFromPublicToNav(pos: vec3, mode: HeightMode,
    lod?: Lod): vec3 | null

convertCoordsFromNavToCanvas(pos: vec3, mode: HeightMode,
    lod?: Lod): vec3 | null
```

Also adds:

```typescript
checkVisibility(pos: vec3, mode: HeightMode): boolean | null
```

This method is currently documented as experimental and unreliable, and
the waypoint demo does not rely on it.

### `test/screenshot.js`

Two fixes made during implementation:

- Added `${config}` substitution so URL templates containing that
  variable expand correctly.
- Fixed template side resolution: when a template entry is an object
  (`{ "dev": "waypoint" }`) and the requested side is absent, the
  URL now returns `null` (skipped) instead of falling back to the
  `default` CDN template.

---

## Reveal.js integration

**One reveal.js slide = one waypoint** is the recommended pattern.
Reveal's own arrow keys drive the deck; `slidechanged` calls
`map.goTo(idx)`. Slides without `data-waypoint` are skipped — the
map stays at its last position. Mixed decks (map slides + title slides
+ image slides) are fully supported.

```html
<script type="module">
  import { WaypointMap } from './waypoint.js';
  const map = new WaypointMap('map', {
    style: './style.json',
    config: './journey.json',
    keys: false            // reveal.js owns the arrow keys
  });
  Reveal.on('slidechanged', (e) => {
    const idx = e.currentSlide.dataset.waypoint;
    if (idx !== undefined) map.goTo(Number(idx));
  });
</script>
```

For intra-slide navigation (map navigable within one reveal slide
independently of deck navigation), disable reveal's default key
handling for those keys and call `map.next()` / `map.prev()` from a
custom handler.
