/**
 * Type surface for the legacy `MapCamera` helper (`camera.js`).
 *
 * Declares the runtime shape used by `FreezeCameraState` and the rest
 * of the typed codebase. The implementation lives in `camera.js`; this
 * declaration overrides the allowJs inference so that properties set
 * only inside `update()` are typed correctly rather than inferred as
 * `T | undefined`.
 */

import type Renderer from '../renderer/renderer';

type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];

export default class MapCamera {

    /** Back-pointer to the owning `Renderer` camera. */
    camera: Renderer['camera'];

    distance: number;
    distance2: number;
    position: Vec3;
    vector: Vec3;
    vector2: Vec4;
    center: Vec3;
    height: number;
    terrainHeight: number;
    lastTerrainHeight: number;
    near: number;

    /**
     * Tangent of half the vertical field-of-view angle.
     * Set by `update()` before any frame draw.
     */
    distanceFactor: number;

    /** Effective perceived distance used for texel-size selection. */
    perceivedDistance: number;

    mapIsProjected?: boolean;
    geocentDistance?: number;
    geocentNormal?: Vec3;

    /** Returns the physical-space center of the map view. */
    getCenter(): Vec3;

    update(): void;
}
