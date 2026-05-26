/**
 * Type surface for the legacy `MapDraw` helper (`draw.js`).
 *
 * Declares the subset of `MapDraw` state and methods that typed code
 * (`Map.draw` and the recursive terrain traversal) reads or calls.
 * The runtime implementation lives in `draw.js`; this declaration
 * grows as more of the legacy surface is touched by typed code.
 * Fields tagged "phase-1" are reads from the recursive traversal and
 * disappear with the legacy `drawSurfaceTile` orchestrator in phase 8.
 */

import type GpuDevice from '../renderer/gpu/device';
import type MapDrawTiles from './draw-tiles';

export default class MapDraw {

    constructor(map: unknown);

    drawTileState: GpuDevice.State;
    tileBuffer: unknown[];
    zbufferOffset: number | null;

    /** phase-1 */
    drawCounter: number;
    /** phase-1 */
    texelSizeFit: number;
    /** phase-1 */
    drawTiles: MapDrawTiles;

    initFrame(): void;
    drawMonoliticGeodata(layer: unknown): void;
    drawHitmap(): void;
    drawGeodataHitmap(): void;
    setupDetailDegradation(degradeMore?: number): void;
}
