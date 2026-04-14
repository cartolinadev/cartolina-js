/**
 * WaypointMap — geographic story / presentation module.
 *
 * A self-contained ES module that wraps cartolina.js and provides
 * keyboard-navigable flythrough between a JSON-configured list of map
 * positions, with image markers anchored to geographic coordinates.
 *
 * USAGE — standalone:
 *
 *   import { WaypointMap } from './waypoint.js';
 *   const map = new WaypointMap('container-id', {
 *     style:  './style.json',
 *     config: './journey.json',
 *     keys:   true           // default
 *   });
 *
 * USAGE — reveal.js (one slide per waypoint):
 *
 *   const map = new WaypointMap('map', {
 *     style: './style.json', config: './journey.json', keys: false
 *   });
 *   Reveal.on('slidechanged', (e) => {
 *     const idx = e.currentSlide.dataset.waypoint;
 *     if (idx !== undefined) map.goTo(Number(idx));
 *   });
 *
 *   Slides without data-waypoint are skipped; the map stays at its
 *   last position. Mixed decks (map + title + image slides) work fine.
 *   For intra-slide navigation independent of the deck, call
 *   map.next() / map.prev() from your own event handler.
 *
 * CONFIG SCHEMA (journey.json):
 *
 *   {
 *     "positions": [
 *       {
 *         "name":     "my-place",     <- optional symbolic name
 *         "position": ["obj", lon, lat, "fix", h, yaw, pitch, roll,
 *                      extent, fov],
 *         "flyTo":    { "speed": 1.0, "maxHeight": 50000 }
 *       }
 *     ],
 *     "markers": [
 *       {
 *         "coords": [lon, lat],       <- 2-elem: float on terrain
 *         "url":    "https://…",      <- image URL
 *         "offset": [0, 0],           <- CSS-px offset from anchor
 *         "height": 90,               <- CSS display height (default 90)
 *         "width":  null,             <- CSS display width (auto if omitted)
 *         "link":   "https://…",      <- optional href
 *         "show":   ["my-place"],     <- only visible at these waypoints
 *         "hide":   ["other-place"]   <- hidden at these waypoints
 *       }
 *     ]
 *   }
 *
 * MARKER VISIBILITY FILTERING
 *
 *   Each marker can carry a "show" list (inclusive) or a "hide" list
 *   (exclusive) of waypoint names. Names refer to "name" fields on
 *   position entries. If neither list is set the marker is always shown
 *   (subject to the depth check below).
 *
 *   Using symbolic names keeps filters stable when positions are
 *   reordered or new entries are inserted.
 *
 * DEPTH / OCCLUSION LIMITATION
 *
 *   Markers are HTML elements overlaid on top of the WebGL canvas.
 *   The depth check (canvas[2] <= 1) only tests whether the geographic
 *   point is in front of the camera's near plane — it does NOT test
 *   occlusion by terrain geometry. A marker for a location on the far
 *   side of the globe can remain visible during cross-planetary
 *   navigation. Use show/hide filters to suppress markers that are not
 *   relevant to the current waypoint.
 */

const DEFAULT_MARKER_HEIGHT = 90;

/**
 * Fetch JSON from a URL string, or return an object passed directly.
 * @param {string|object} src
 * @returns {Promise<object>}
 */
async function resolveJson(src) {
    if (typeof src === 'string') {
        const r = await fetch(src);
        if (!r.ok) {
            throw new Error(
                `WaypointMap: fetch "${src}" failed: ${r.status}`
            );
        }
        return r.json();
    }
    return src;
}

/**
 * Geographic story / presentation map.
 *
 * Wraps a cartolina `Viewer` and adds waypoint navigation and
 * geo-anchored image markers.
 */
export class WaypointMap {

    /**
     * @param {string|HTMLElement} container
     *   CSS selector, element id, or DOM element for the map container.
     * @param {object} options
     * @param {string|object} options.style   Style URL or object.
     * @param {string|object} options.config  Config URL or object.
     * @param {boolean}       [options.keys=true]
     *   Install ArrowLeft / ArrowRight keyboard navigation.
     */
    constructor(container, options = {}) {
        this._container =
            typeof container === 'string'
                ? document.getElementById(container) ?? container
                : container;
        this._options  = options;
        this._viewer   = null;
        this._config   = null;
        this._index    = 0;
        this._flying   = false;
        this._listeners = { 'slide-change': [], 'fly-start': [], 'fly-end': [] };
        this._markerOverlay = null;
        this._markerEls = [];
        this._tickUnsub = null;
        this._keyHandler = null;
        this._destroyed = false;
        this._ready = this._init();
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /** Fly to the next position (clamps at end). */
    next() {
        this.goTo(Math.min(this._index + 1, this._slideCount - 1));
    }

    /** Fly to the previous position (clamps at start). */
    prev() {
        this.goTo(Math.max(this._index - 1, 0));
    }

    /**
     * Fly to the position at the given index.
     * @param {number} index
     */
    goTo(index) {
        if (!this._viewer || !this._config) return;
        const positions = this._config.positions ?? [];
        if (index < 0 || index >= positions.length) return;

        this._index = index;
        const entry = positions[index];
        const flyToOpts = entry.flyTo ?? {};

        this._flying = true;
        this._emit('slide-change', { index, position: entry.position });
        this._emit('fly-start',    { index, position: entry.position });

        this._viewer.autopilot.flyTo(entry.position, flyToOpts);
    }

    /** Destroy the map, markers, and event listeners. */
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        if (this._tickUnsub) { this._tickUnsub(); this._tickUnsub = null; }
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
        if (this._markerOverlay) {
            this._markerOverlay.remove();
            this._markerOverlay = null;
        }
        if (this._viewer) {
            this._viewer.destroy();
            this._viewer = null;
        }
    }

    /** Current slide index. */
    get currentIndex() { return this._index; }

    /** Total number of waypoint positions. */
    get slideCount() { return this._slideCount; }

    /**
     * Subscribe to a WaypointMap event.
     *
     * @param {'slide-change'|'fly-start'|'fly-end'} event
     * @param {Function} cb
     * @returns {Function} unsubscribe function
     */
    on(event, cb) {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(cb);
        return () => {
            this._listeners[event] =
                this._listeners[event].filter(f => f !== cb);
        };
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    get _slideCount() {
        return this._config?.positions?.length ?? 0;
    }

    _emit(event, data) {
        for (const cb of (this._listeners[event] ?? [])) cb(data);
    }

    async _init() {
        const opts = this._options;

        const [style, config] = await Promise.all([
            resolveJson(opts.style),
            resolveJson(opts.config)
        ]);

        if (this._destroyed) return;

        this._config = config;

        const firstPos =
            (config.positions ?? [])[0]?.position ?? null;

        this._viewer = cartolina.map({
            container: this._container,
            style:     style,
            position:  firstPos,
            options:   {}
        });

        this._buildMarkers(config.markers ?? []);

        this._tickUnsub = this._viewer.on('tick', () => {
            this._updateMarkers();
        });

        this._viewer.on('fly-end', () => {
            this._flying = false;
            this._emit('fly-end', { index: this._index });
        });

        if (opts.keys !== false) {
            this._keyHandler = (e) => {
                if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    this.next();
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    this.prev();
                }
            };
            document.addEventListener('keydown', this._keyHandler);
        }
    }

    _buildMarkers(markers) {
        const containerEl =
            typeof this._container === 'string'
                ? document.querySelector(this._container)
                : this._container;

        const overlay = document.createElement('div');

        overlay.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;' +
            'pointer-events:none;overflow:hidden;';

        if (getComputedStyle(containerEl).position === 'static') {
            containerEl.style.position = 'relative';
        }
        containerEl.appendChild(overlay);
        this._markerOverlay = overlay;

        for (const marker of markers) {
            let el;

            if (marker.link) {
                el = document.createElement('a');
                el.href = marker.link;
                el.target = '_blank';
                el.rel = 'noopener noreferrer';
                el.style.cssText = 'position:absolute;pointer-events:auto;';

                const img = document.createElement('img');
                img.src = marker.url ?? '';
                img.alt = '';
                img.style.display = 'block';
                el.appendChild(img);
            } else {
                el = document.createElement('img');
                el.src = marker.url ?? '';
                el.alt = '';
                el.style.cssText = 'position:absolute;';
            }

            el.style.visibility = 'hidden';
            overlay.appendChild(el);
            this._markerEls.push(el);
        }
    }

    _updateMarkers() {
        if (!this._viewer || !this._config) return;
        const markers     = this._config.markers ?? [];
        const currentName =
            this._config.positions?.[this._index]?.name ?? null;

        for (let i = 0; i < markers.length; i++) {
            const marker = markers[i];
            const el     = this._markerEls[i];
            if (!el) continue;

            // show/hide filter by waypoint name
            if (marker.show) {
                if (!marker.show.includes(currentName)) {
                    el.style.visibility = 'hidden';
                    continue;
                }
            } else if (marker.hide) {
                if (marker.hide.includes(currentName)) {
                    el.style.visibility = 'hidden';
                    continue;
                }
            }

            const coords = marker.coords;
            if (!coords || coords.length < 2) {
                el.style.visibility = 'hidden';
                continue;
            }

            const heightMode = coords.length >= 3 ? 'fix' : 'float';
            const pubCoords  = coords.length >= 3
                ? [coords[0], coords[1], coords[2]]
                : [coords[0], coords[1], 0];

            const navCoords = this._viewer.convertCoordsFromPublicToNav(
                pubCoords, heightMode
            );

            if (!navCoords) {
                el.style.visibility = 'hidden';
                continue;
            }

            const navMode = (heightMode === 'float') ? 'fix' : heightMode;
            const canvas = this._viewer.convertCoordsFromNavToCanvas(
                navCoords, navMode
            );

            if (!canvas || canvas[2] > 1) {
                el.style.visibility = 'hidden';
                continue;
            }

            // Apply CSS display size once (img must be loaded)
            const imgEl = el.tagName === 'IMG' ? el : el.querySelector('img');

            if (imgEl) {
                const h = marker.height ?? DEFAULT_MARKER_HEIGHT;
                imgEl.style.height = h + 'px';

                if (marker.width != null) {
                    imgEl.style.width = marker.width + 'px';
                } else {
                    imgEl.style.width = 'auto';
                }
            }

            // Position: anchor is bottom-center of the element
            const elW = el.offsetWidth;
            const elH = el.offsetHeight;
            const ox  = (marker.offset ?? [0, 0])[0];
            const oy  = (marker.offset ?? [0, 0])[1];

            el.style.left        = (canvas[0] - elW / 2 + ox) + 'px';
            el.style.top         = (canvas[1] - elH      + oy) + 'px';
            el.style.visibility  = 'visible';
        }
    }
}
