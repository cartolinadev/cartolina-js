# Non-interactive usage

See [index.md](index.md) for the wiki table of contents.

Applications that provide their own navigation UI — input handling,
camera control, autopilot — can suppress cartolina's built-in mouse,
keyboard, and touch event listeners with `interactive: false`. The map
renders normally; the application drives the camera.

This mirrors the MapLibre GL JS convention (`interactive: false` at the
top level of the factory options).


## Historical note

Until 2026-05, cartolina shipped a separate `vts-core.js` build from
the entry point `src/core/index.ts`. Its purpose was headless rendering:
it omitted the `Browser` UI layer, `Autopilot`, `Presenter`, and all
input handling. Consumers got a `Map` class with no built-in navigation.

The build was removed for two reasons:

1. **Negligible size difference.** `vts-core.js` was 3.0 MB and
   `cartolina.js` was 3.3 MB — a 9% difference that does not justify
   maintaining a separate entry point.

2. **No opt-out in the browser build.** The browser build registered
   mouse and keyboard event listeners unconditionally, so it could not
   serve the same use case. Adding `interactive: false` closes that gap.

The only known external consumer of the core build was mapy.com's 3D
map view (`vts-core.min.js?2.81.0`). Their API usage and migration gap
are documented in project memory (`project-mapy-core-api.md`).


## Factory call

```js
const viewer = cartolina.map({
    container: 'map',
    style: './style.json',
    position: ['obj', 15, 50, 'fix', 0, 0, -70, 0, 8000000, 45],
    interactive: false,
});
```

`container` is an element id or DOM element. `style` is a style
specification object or URL. `position` is the 10-component camera
position array (see below). `interactive: false` suppresses all event
registration in `ControlMode`.

The return value is a `Viewer` instance (exported as `Map`). If WebGL2
is not available, construction throws.


## Position format

A 10-element array:

```
[viewMode, lon, lat, heightMode, height, yaw, pitch, roll, viewExtent, fov]
    0        1    2       3        4       5     6      7       8         9
```

| Index | Name | Values | Unit |
|---|---|---|---|
| 0 | viewMode | `'obj'` (orbit) or `'subj'` (first-person) | — |
| 1 | longitude | geographic | degrees |
| 2 | latitude | geographic | degrees |
| 3 | heightMode | `'fix'` (absolute) or `'float'` (above terrain) | — |
| 4 | height | camera height | metres |
| 5 | yaw | azimuth clockwise from north | degrees |
| 6 | pitch | tilt; 0 = horizon, −90 = straight down | degrees |
| 7 | roll | — | degrees |
| 8 | viewExtent | approximate visible span at ground level | metres |
| 9 | fov | field of view | degrees |

`viewer.getPosition()` returns a `MapPosition` instance wrapping this
array. `viewer.setPosition()` accepts either a `MapPosition` or a raw
array.


## Events

```js
const off = viewer.on('map-loaded', () => { console.log('ready'); });
off(); // unsubscribe

viewer.once('map-loaded', () => { /* fires once */ });
```

| Event | Fires when |
|---|---|
| `map-loaded` | terrain ready, first frame rendered |
| `map-mapconfig-loaded` | mapConfig parsed (before terrain ready) |
| `map-unloaded` | viewer disposal releases the loaded map |
| `map-update` | scene changed, redraw scheduled |
| `map-position-changed` | camera position changes |
| `tick` | every animation frame |
| `gpu-context-lost` / `gpu-context-restored` | WebGL context lifecycle |


## Navigation

With `interactive: false`, implement navigation by reading and writing
the position on pointer and wheel events. Basic pattern:

```js
// Pan (left drag): shift lon/lat by a factor of viewExtent / height
// Orbit (right drag): change yaw and pitch
// Zoom (scroll): scale viewExtent

el.addEventListener('wheel', e => {
    e.preventDefault();
    const pos = viewer.getPosition();
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    pos.pos[8] = Math.max(500, Math.min(2e7, pos.pos[8] * factor));
    viewer.setPosition(pos);
}, { passive: false });
```

See `demos/core/index.html` for a complete pan/orbit/zoom implementation.


## Coordinate conversion and hit-testing

These methods are available directly on `Viewer`:

```js
// Canvas pixel → geographic [lon, lat, height]
viewer.getHitCoords(screenX, screenY, 'fix');

// Public (lon/lat/height) → navigation (Cartesian)
viewer.convertCoordsFromPublicToNav([lon, lat, h], 'fix');

// Navigation → canvas pixel [x, y, depth]
viewer.convertCoordsFromNavToCanvas(navPos, 'fix');
```


## Vector overlays

A vector overlay is a source (the data) plus a layer (the styling):
`addSource` registers the geodata, `addLayer` draws it. A `'float'`
line is heightcoded against the terrain before the source is built.

```js
viewer.ready.then(() => {
    const geo = viewer.createGeodata();

    // Closed triangle over central Europe (lon, lat, height)
    const route = [
        [14.4, 50.1, 0], [16.6, 48.2, 0], [18.9, 49.7, 0],
        [14.4, 50.1, 0],
    ];
    geo.addLineString(route, 'float', null, 'line');

    // Resolve the float heights against the terrain, then build the
    // source from the heightcoded geodata.
    geo.processHeights('heightmap-by-lod', 4, async () => {

        // addSource resolves once the source is part of the map state;
        // await it before the layer that references it.
        await viewer.addSource('route', {
            type: 'cartolina-freelayer',
            definition: geo.makeFreeLayer(),
        });

        viewer.addLayer({
            id: 'route-line', type: 'lines', source: 'route',
            line: true, 'line-color': [255, 80, 0, 255],
            'line-width': 4, 'zbuffer-offset': [-5, 0, 0],
        });
    });
});

// Remove later (layers before their source)
viewer.removeLayer('route-line');
viewer.removeSource('route');
```

`createGeodata`, `addSource`, `addLayer`, `removeSource`, and
`removeLayer` are on `Viewer`. The geodata builder type is `unknown`
pending a full TypeScript declaration for the geodata API.

`addLayer` accepts any layer type; a layer with a `source` references a
source registered through `addSource`. `addSource` is asynchronous: it
resolves once the source has loaded and is part of the usable map
state, and rejects if it fails to load — a terrain source, for example,
must first reconcile its reference frame. Await it before adding a
layer that references the source.


## Demo

A reference implementation is at `demos/core/index.html`. It
demonstrates non-interactive init, pan/orbit/zoom navigation,
click-to-coordinates, and the heightcoded route overlay above.
