/*
 * types.ts — transitional scaffolding, not a permanent home.
 *
 * This file has no legitimate long-term residents. Each type below
 * belongs to a feature module that is not yet typed and is parked here
 * only until that module can receive it. The file is expected to
 * disappear once both migrations below land.
 *
 * Do not add new residents. Domain-neutral type-level utilities also
 * get narrowly named modules rather than extending this catch-all.
 *
 * Parked groups and their destinations:
 *
 *   - Position group — PositionInput, HeightMode, Lod. Move into the
 *     position model when map/position.js is refactored (imminent; its
 *     public API is changing). A position is a fixed ten-slot tuple and
 *     HeightMode is slot 3, so these are members of that shape rather
 *     than standalone concepts.
 *
 *   - Measure group — NodeInformation and its private Vec2/Vec3. Move
 *     into map/measure when that module is typed.
 */

import type MapSrs from './srs';
import type MapPosition from './position';


// Position group (see file header).

/**
 * A camera position accepted by the public API: a `MapPosition`
 * instance or a legacy ten-component position array, which carries
 * mode strings at indices 0 and 3 and numbers elsewhere.
 */
export type PositionInput = MapPosition | (number | string)[];

/** Height mode for coordinate conversions and hit-testing. */
export type HeightMode = 'fix' | 'float';

/**
 * Level-of-detail hint for coordinate conversions and height sampling.
 * A higher value requests a finer terrain mesh.
 */
export type Lod = number;


// Measure group (see file header).

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/**
 * Result of `MapMeasure.getNodeInformation()` for one spatial division
 * node.
 */
export type NodeInformation = {
    id: Vec3;
    height: number;
    srs: MapSrs;
    extents: {
        ll: Vec2;
        ur: Vec2;
    };
    physicalCorners: {
        ul: Vec3;
        ur: Vec3;
        lr: Vec3;
        ll: Vec3;
    };
    divisionNode: unknown;
    upVector: Vec3;
};
