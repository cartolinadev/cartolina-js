/**
 * Type surface for the legacy `MapDraw` helper (`draw.js`).
 *
 * Declares the subset of `MapDraw` state and methods that typed code
 * (`Map.draw`) reads or calls. The runtime implementation lives in
 * `draw.js`; this declaration grows as more of the legacy surface is
 * touched by typed code.
 */

import type GpuDevice from '../renderer/gpu/device';

export default class MapDraw {

    drawTileState: GpuDevice.State;
    tileBuffer: unknown[];
    zbufferOffset: number | null;

    initFrame(): void;
    drawMonoliticGeodata(layer: unknown): void;
    drawHitmap(): void;
    drawGeodataHitmap(): void;
    setupDetailDegradation(degradeMore?: number): void;
}
