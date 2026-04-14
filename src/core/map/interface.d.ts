import type Map from './map';
import type MapPosition from './position';
import type { HeightMode, Lod } from '../types';
import type { vec3 } from '../utils/math';

/**
 * Legacy ES5 public wrapper around the internal terrain engine.
 *
 * The runtime implementation is in `interface.js`. This declaration
 * describes only the subset currently consumed by TypeScript modules.
 */
export default class MapInterface {

    constructor(map: Map);

    map: Map;

    setPosition(position: MapPosition | number[]): this;
    getPosition(): MapPosition;

    getHitCoords(
        screenX: number,
        screenY: number,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null;

    convertCoordsFromNavToPublic(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null;

    convertCoordsFromNavToPhys(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
        includeSE?: boolean,
    ): vec3 | null;

    convertCoordsFromPhysToCameraSpace(pos: vec3): vec3;

    convertCoordsFromPublicToNav(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null;

    convertCoordsFromNavToCanvas(
        pos: vec3,
        mode: HeightMode,
        lod?: Lod,
    ): vec3 | null;
}
