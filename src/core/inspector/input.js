
/**
 * Keyboard input handler for the diagnostic inspector.
 *
 * All key handling flows through `onKeyUp`, which is also called by `onKeyDown`
 * and `onKeyPress` with `press = true` so that modifier state is kept current.
 * Actual actions only fire on keyup (press = false/undefined) to avoid
 * repeated triggering while a key is held.
 *
 * Within diagnostic mode, one of three mutually exclusive sub-modes may be
 * active at a time.  See `setSubMode` for details.
 */
export default class InspectorInput {

    constructor(inspector) {

        this.inspector = inspector;
        this.core = inspector.core;
    }

    init() {

        document.addEventListener('keyup',    this.onKeyUp.bind(this),    false);
        document.addEventListener('keypress', this.onKeyPress.bind(this), false);
        document.addEventListener('keydown',  this.onKeyDown.bind(this),  false);
    }

    onKeyDown(event) {

        this.altDown   = event.altKey;
        this.ctrlDown  = event.ctrlKey;
        this.shiftDown = event.shiftKey;
        this.onKeyUp(event, true);
    }

    onKeyPress(event) {

        this.onKeyUp(event, true);
    }

    /**
     * Switch to a named sub-mode, or pass null to return to plain diagnostic
     * mode. Activating a new sub-mode automatically deactivates the current
     * one and clears its owned rendering state.
     *
     * Sub-modes and owned rendering state:
     *   'renderFlags' — map.renderer.debug.flagX overrides
     *   'tileBBox'    — debug.drawBBoxes / debug.drawNBBoxes
     *   'radar'       — inspector.drawRadar
     *
     * For 'tileBBox', the specific rendering flag (drawBBoxes vs drawNBBoxes)
     * is set by the caller after this method returns, depending on which key
     * was used.
     */
    setSubMode(name) {

        const map = this.core.getMap();
        const inspector = this.inspector;
        if (!map) return;
        const debug = map.draw.debug;

        if (this.subMode === 'tileBBox') {

            debug.drawBBoxes = false;
            debug.drawNBBoxes = false;
        }
        if (this.subMode === 'radar') {

            inspector.drawRadar = false;
        }

        this.subMode = name;

        if (name === 'radar') inspector.drawRadar = true;

        const rfLabel = 'Diagnostics mode > Render flags'
            + ' — f:light n:normal d:diffuse s:specular'
            + ' b:bump a:atm h:shadows k:labels'
            + ' l:lambert p:slope x:aspect';
        const labels = {
            renderFlags: rfLabel,
            tileBBox:    'Diagnostics mode > Tile bounding boxes',
            radar:       'Diagnostics mode > Radar'
        };
        inspector.showNotification(labels[name] || 'Diagnostic mode');
    }

    /**
     * Main key handler, called for keyup, keydown, and keypress events.
     *
     * @param {KeyboardEvent} event  The keyboard event.
     * @param {boolean}       press  True when called from keydown or keypress;
     *     false/undefined for genuine keyup.  Most actions are gated on !press
     *     so they fire exactly once per keypress rather than repeatedly while
     *     the key is held.
     *
     * Sets `hit = true` for any key that was handled.  When hit:
     *   - `map.markDirty()` schedules a render frame (a debug option changed).
     *   - `inspector.preventDefault(event)` suppresses the browser's default
     *     action for that key, preventing interference with the page or browser
     *     UI.
     */
    onKeyUp(event, press) {

        const map = this.core.getMap();
        const inspector = this.inspector;

        if (!map || !event) return;

        const debug = map.draw.debug;

        this.altDown   = event.altKey;
        this.ctrlDown  = event.ctrlKey;
        this.shiftDown = event.shiftKey;

        let hit = false;

        const keyCode = event.keyCode;

        // Shift+D — toggle diagnostic mode (works regardless of current sub-mode)
        if (this.shiftDown && !press && !this.ctrlDown
                && (keyCode === 68 || keyCode === 100)) {

            this.diagnosticMode = !this.diagnosticMode;
            if (this.diagnosticMode) {

                inspector.enableInspector();
                inspector.showNotification('Diagnostic mode');
                // Enabling diagnostic mode does not change rendering state,
                // so hit is not set — markDirty is not needed.
            } else {

                if (this.subMode === 'tileBBox') {

                    debug.drawBBoxes = false;
                    debug.drawNBBoxes = false;
                }
                if (this.subMode === 'radar') {

                    inspector.drawRadar = false;
                }
                this.subMode = null;
                inspector.showNotification('Diagnostic mode off');
                hit = true;
            }
        }

        if (this.diagnosticMode) {

            // plain-key sub-mode handlers — keyup only, no modifier
            if (!this.shiftDown && !press) {

                if (keyCode === 27 && this.subMode !== null) { // Escape

                    this.setSubMode(null);
                    hit = true;
                }

                if (this.subMode === 'renderFlags') {

                    const rfRenderer = map.renderer;
                    switch (keyCode) {

                    case 70: case 102: {  // f — lighting

                        const rfF = !(rfRenderer.debug.flagLighting
                            ?? map.config.mapFlagLighting);
                        rfRenderer.debug.flagLighting = rfF;
                        inspector.showNotification(
                            'Lighting ' + (rfF ? 'on' : 'off'));
                        hit = true; break;
                    }
                    case 78: case 110: {  // n — normal maps

                        const rfN = !(rfRenderer.debug.flagNormalMaps
                            ?? map.config.mapFlagNormalMaps);
                        rfRenderer.debug.flagNormalMaps = rfN;
                        inspector.showNotification(
                            'Normal maps ' + (rfN ? 'on' : 'off'));
                        hit = true; break;
                    }
                    case 68: case 100: {  // d — diffuse maps

                        const rfD = !(rfRenderer.debug.flagDiffuseMaps
                            ?? map.config.mapFlagDiffuseMaps);
                        rfRenderer.debug.flagDiffuseMaps = rfD;
                        inspector.showNotification(
                            'Diffuse maps ' + (rfD ? 'on' : 'off'));
                        hit = true; break;
                    }
                    case 83: case 115: {  // s — specular maps

                        const rfS = !(rfRenderer.debug.flagSpecularMaps
                            ?? map.config.mapFlagSpecularMaps);
                        rfRenderer.debug.flagSpecularMaps = rfS;
                        inspector.showNotification(
                            'Specular maps ' + (rfS ? 'on' : 'off'));
                        hit = true; break;
                    }
                    case 66: case 98: {   // b — bump maps

                        const rfB = !(rfRenderer.debug.flagBumpMaps
                            ?? map.config.mapFlagBumpMaps);
                        rfRenderer.debug.flagBumpMaps = rfB;
                        inspector.showNotification(
                            'Bump maps ' + (rfB ? 'on' : 'off'));
                        hit = true; break;
                    }
                    case 65: case 97: {   // a — atmosphere

                        const rfA = !(rfRenderer.debug.flagAtmosphere
                            ?? map.config.mapFlagAtmosphere);
                        rfRenderer.debug.flagAtmosphere = rfA;
                        inspector.showNotification(
                            'Atmosphere ' + (rfA ? 'on' : 'off'));
                        hit = true; break;
                    }
                    case 72: case 104: {  // h — shadows

                        const rfH = !(rfRenderer.debug.flagShadows
                            ?? map.config.mapFlagShadows);
                        rfRenderer.debug.flagShadows = rfH;
                        inspector.showNotification(
                            'Shadows ' + (rfH ? 'on' : 'off'));
                        hit = true; break;
                    }
                    case 75: case 107: {  // k — labels

                        const rfK = !(rfRenderer.debug.flagLabels
                            ?? map.config.mapFlagLabels);
                        rfRenderer.debug.flagLabels = rfK;
                        inspector.showNotification(
                            'Labels ' + (rfK ? 'on' : 'off'));
                        hit = true; break;
                    }
                    case 76: case 108: {  // l — Lambertian shading

                        const rfL = !(rfRenderer.debug.flagShadingLambertian
                            ?? map.config.mapShadingLambertian);
                        rfRenderer.debug.flagShadingLambertian = rfL;
                        inspector.showNotification(
                            'Lambertian shading ' + (rfL ? 'on' : 'off'));
                        hit = true; break;
                    }
                    case 80: case 112: {  // p — slope shading

                        const rfP = !(rfRenderer.debug.flagShadingSlope
                            ?? map.config.mapShadingSlope);
                        rfRenderer.debug.flagShadingSlope = rfP;
                        inspector.showNotification(
                            'Slope shading ' + (rfP ? 'on' : 'off'));
                        hit = true; break;
                    }
                    case 88: case 120: {  // x — aspect shading

                        const rfX = !(rfRenderer.debug.flagShadingAspect
                            ?? map.config.mapShadingAspect);
                        rfRenderer.debug.flagShadingAspect = rfX;
                        inspector.showNotification(
                            'Aspect shading ' + (rfX ? 'on' : 'off'));
                        hit = true; break;
                    }
                    }
                }

                if (this.subMode === 'tileBBox') {

                    let bboxHit = true;
                    switch (keyCode) {

                    case 76: case 108:  debug.drawLods = !debug.drawLods; break;  // l
                    case 80: case 112:  debug.drawPositions = !debug.drawPositions; break;  // p
                    case 85: case 117:  debug.drawOctants = !debug.drawOctants; break;  // u
                    case 84: case 116:  debug.drawTextureSize = !debug.drawTextureSize; break;  // t
                    case 70: case 102:  debug.drawFaceCount = !debug.drawFaceCount; break;  // f
                    case 71: case 103:  debug.drawGeodataOnly = !debug.drawGeodataOnly; break;  // g
                    case 68: case 100:  debug.drawDistance = !debug.drawDistance; break;  // d
                    case 86: case 118:  debug.drawSpaceBBox = !debug.drawSpaceBBox; break;  // v
                    case 78: case 110:  debug.drawNodeInfo = !debug.drawNodeInfo; break;  // n
                    case 77: case 109:  debug.drawMeshBBox = !debug.drawMeshBBox; break;  // m
                    case 73: case 105:  debug.drawIndices = !debug.drawIndices; break;  // i
                    case 66: case 98:   debug.drawBoundLayers = !debug.drawBoundLayers; break;  // b
                    case 82: case 114:  debug.drawResources = !debug.drawResources; break;  // r
                    case 83: case 115:  debug.drawSurfaces = !debug.drawSurfaces; break;  // s
                    case 90: case 122:  debug.drawSurfaces2 = !debug.drawSurfaces2; break;  // z
                    case 67: case 99:   debug.drawCredits = !debug.drawCredits; break;  // c
                    case 79: case 111:  debug.drawOrder = !debug.drawOrder; break;  // o
                    case 69: case 101:  // e
                        debug.debugTextSize = (debug.debugTextSize == 2.0) ? 3.0 : 2.0;
                        break;
                    case 88: case 120:  // x
                        map.config.mapPreciseBBoxTest = !map.config.mapPreciseBBoxTest;
                        break;
                    case 87: case 119:  debug.drawPolyWires = !debug.drawPolyWires; break;  // w
                    case 75: case 107:  debug.drawGPixelSize = !debug.drawGPixelSize; break;  // k
                    default: bboxHit = false; break;
                    }
                    if (bboxHit) hit = true;
                }

                if (this.subMode === 'radar') {

                    let radarHit = true;
                    switch (keyCode) {

                    case 43: case 107:  // numpad +
                        if (inspector.radarLod == null) inspector.radarLod = 8;
                        inspector.radarLod++; break;
                    case 45: case 109:  // numpad -
                        if (inspector.radarLod == null) inspector.radarLod = 8;
                        inspector.radarLod = Math.max(0, inspector.radarLod - 1);
                        break;
                    case 42: case 106:  // numpad *
                        inspector.radarLod = null; break;
                    default:
                        radarHit = false; break;
                    }
                    if (radarHit) hit = true;
                }
            }

            // wireframe test-data: numpad 0–9, active whenever wireframe is visible
            if (debug.drawWireframe && !press) {

                if (keyCode >= 96 && keyCode <= 105) {

                    if (this.altDown) {

                        debug.drawTestData = keyCode - 96;
                        if (this.ctrlDown) debug.drawTestData += 10;
                    } else {

                        debug.drawTestMode = keyCode - 96;
                    }
                    hit = true;
                }
            }

            // Shift+key diagnostic shortcuts
            if (this.shiftDown && !press) {

                switch (keyCode) {

                case 70: case 102:  // Shift+F — render-flags sub-mode
                    this.setSubMode(
                        this.subMode === 'renderFlags' ? null : 'renderFlags');
                    hit = true; break;

                case 66: case 98:   // Shift+B — tile-bbox sub-mode (bbox view)
                    if (this.subMode === 'tileBBox') {

                        this.setSubMode(null);
                    } else {

                        this.setSubMode('tileBBox');
                        debug.drawBBoxes = true;
                    }
                    hit = true; break;

                case 78: case 110:  // Shift+N — tile-bbox sub-mode (node-bbox view)
                    if (this.subMode === 'tileBBox') {

                        this.setSubMode(null);
                    } else {

                        this.setSubMode('tileBBox');
                        debug.drawNBBoxes = true;
                    }
                    hit = true; break;

                case 76: case 108:  // Shift+L — radar sub-mode
                    this.setSubMode(this.subMode === 'radar' ? null : 'radar');
                    hit = true; break;

                case 67: case 99:   // Shift+C — shake camera
                    inspector.shakeCamera = !inspector.shakeCamera;
                    hit = true; break;

                case 49: {  // Shift+1 — copy position to clipboard

                    const map1 = this.core.getMap();
                    if (map1) {

                        let p1 = map1.getPosition();
                        p1 = map1.convert.convertPositionHeightMode(
                            p1, 'fix', true);
                        const c1 = p1.getCoords(), o1 = p1.getOrientation();
                        const posStr = p1.getViewMode() + ','
                            + c1[0].toFixed(6) + ',' + c1[1].toFixed(6) + ','
                            + p1.getHeightMode() + ',' + c1[2].toFixed(2) + ','
                            + o1[0].toFixed(2) + ',' + o1[1].toFixed(2)
                            + ',' + o1[2].toFixed(2) + ','
                            + p1.getViewExtent().toFixed(2)
                            + ',' + p1.getFov().toFixed(2);
                        navigator.clipboard.writeText('pos=' + posStr)
                            .then(function() {

                                inspector.showNotification(
                                    'Position copied to clipboard');
                            });
                    }
                    hit = true; break;
                }

                case 50: {  // Shift+2 — paste position from clipboard

                    const self = this;
                    navigator.clipboard.readText().then(function(text) {

                        const match = text.match(/pos=([^\s&]+)/);
                        if (match) {

                            const items = match[1].split(',');
                            for (let i = 1; i < items.length; i++) {

                                if (i !== 3) items[i] = parseFloat(items[i]);
                            }
                            const map2 = self.core.getMap();
                            if (map2) {

                                map2.setPosition(items);
                                inspector.showNotification(
                                    'Position applied from clipboard');
                            }
                        } else {

                            inspector.showNotification(
                                'No position found in clipboard');
                        }
                    });
                    hit = true; break;
                }

                case 72: case 104:  // Shift+H — heightmap only
                    debug.heightmapOnly = !debug.heightmapOnly; hit = true; break;

                case 81: case 113: {  // Shift+Q — toggle view mode (obj/subj)

                    const pos = map.getPosition();
                    map.convert.convertPositionViewMode(pos,
                        (pos.getViewMode() == 'obj') ? 'subj' : 'obj');
                    map.setPosition(pos);
                    map.camera.near = (this.altDown
                        && pos.getViewMode() != 'obj') ? 0.1 : 2;
                    hit = true; break;
                }

                case 80: case 112:  // Shift+P — save screenshot
                    map.renderer.saveScreenshot('file', 'vts-screenshot.png', 'png');
                    hit = true; break;

                case 83: case 115:  // Shift+S — stats panel
                    inspector.stats.switchPanel(); hit = true; break;

                case 86: case 118:  // Shift+V — layers panel
                    inspector.layers.switchPanel(); hit = true; break;

                case 69: case 101:  // Shift+E — stylesheets panel
                    inspector.stylesheets.switchPanel(); hit = true; break;

                case 84: case 116:  // Shift+T — replay panel
                    inspector.replay.switchPanel(); hit = true; break;

                case 65: case 97:   // Shift+A — label boxes
                    debug.drawLabelBoxes = !debug.drawLabelBoxes; hit = true; break;

                case 75: case 107:  // Shift+K — all labels
                    debug.drawAllLabels = !debug.drawAllLabels; hit = true; break;

                case 73: case 105:  // Shift+I — shader illumination (legacy CPU-level gate)
                    debug.shaderIllumination = !debug.shaderIllumination;
                    hit = true; break;

                case 87: case 119:  // Shift+W — wireframe cycle (0→1→2→0)
                    debug.drawWireframe = (debug.drawWireframe >= 2)
                        ? 0 : debug.drawWireframe + 1;
                    hit = true; break;

                case 85: case 117:  // Shift+U — super elevation toggle
                    map.renderer.setSuperElevationState(
                        !map.renderer.useSuperElevation);
                    hit = true; break;

                case 71: case 103:  // Shift+G — mesh stats
                    debug.meshStats = !debug.meshStats; hit = true; break;

                case 77: case 109:  // Shift+M — suspend tile loader
                    map.loaderSuspended = !map.loaderSuspended; hit = true; break;

                case 74: case 106:  // Shift+J — draw earth
                    debug.drawEarth = !debug.drawEarth; hit = true; break;

                case 88: case 120:  // Shift+X — fog
                    debug.drawFog = !debug.drawFog; hit = true; break;

                case 89: case 121:  // Shift+Y — split LODs
                    map.config.mapSplitLods = !map.config.mapSplitLods; hit = true; break;

                case 82: case 114:  // Shift+R — graphs panel
                    inspector.graphs.switchPanel(); hit = true; break;

                case 79: case 111:  // Shift+O — ortho camera
                    map.camera.camera.setOrtho(!map.camera.camera.getOrtho());
                    hit = true; break;

                case 90: case 122:  // Shift+Z — max zoom
                    debug.maxZoom = !debug.maxZoom; hit = true; break;

                }
            }
        }

        if (hit) {

            map.markDirty();
            inspector.preventDefault(event);
        }
    }

    /**
     * Apply a debug parameter that was specified as a URL query string entry.
     * Called during page initialisation by the map config loader when it
     * encounters a `debugX=…` parameter.  Mirrors the interactive shortcuts so
     * that a URL can reproduce any debug view without manual key presses.
     *
     * For `debugBBox` and `debugNBBox` the value is a string of capital letters
     * that enable individual bbox annotations (e.g. `"LPN"` → lods + positions
     * + node info).  For all other parameters the value is a boolean or number.
     *
     * Also sets `this.subMode` so the corresponding sub-mode key handler is
     * immediately active without requiring the user to press the entry shortcut.
     *
     * @param {string} key    Parameter name (e.g. 'debugBBox', 'debugRadar').
     * @param {string} value  Parameter value from the URL.
     */
    setParameter(key, value) {

        const map = this.core.getMap();
        const inspector = this.inspector;

        if (!map) return;

        const debug = map.draw.debug;
        const getBool = () => (value === true || value == 'true' || value == '1');

        switch (key) {

        case 'debugMode': this.diagnosticMode = true; break;
        case 'debugBBox':
            debug.drawBBoxes = true;
            // fall through — bbox and nbbox share the annotation-letter parsing below
        case 'debugNBBox': {

            if (key == 'debugNBBox') debug.drawNBBoxes = true;
            const has = (a) => value.indexOf(a) != -1;
            if (has('L')) debug.drawLods = true;
            if (has('P')) debug.drawPositions = true;
            if (has('T')) debug.drawTextureSize = true;
            if (has('F')) debug.drawFaceCount = true;
            if (has('G')) debug.drawGeodataOnly = true;
            if (has('D')) debug.drawDistance = true;
            if (has('N')) debug.drawNodeInfo = true;
            if (has('V')) debug.drawSpaceBBox = true;
            if (has('M')) debug.drawMeshBBox = true;
            if (has('I')) debug.drawIndices = true;
            if (has('U')) debug.drawOctants = true;
            if (has('B')) debug.drawBoundLayers = true;
            if (has('S')) debug.drawSurfaces = true;
            if (has('Z')) debug.drawSurfaces2 = true;
            if (has('C')) debug.drawCredits = true;
            if (has('O')) debug.drawOrder = true;
            if (has('E')) debug.debugTextSize = 3.0;
            if (has('K')) debug.drawGPixelSize = true;
            this.subMode = 'tileBBox';
            break;
        }
        case 'debugLBox':      debug.drawLabelBoxes = getBool(); break;
        case 'debugNoEarth':   debug.drawEarth = !getBool(); break;
        case 'debugShader':    debug.drawWireframe = parseInt(value); break;
        case 'debugHeightmap': debug.heightmapOnly = getBool(); break;
        case 'debugGridCells': debug.drawGridCells = getBool(); break;
        case 'debugRadar': {

            inspector.enableInspector();
            inspector.drawRadar = true;
            inspector.radarLod = parseInt(value);
            if (isNaN(inspector.radarLod)) inspector.radarLod = null;
            this.subMode = 'radar';
            break;
        }
        }

        map.markDirty();
    }
}
