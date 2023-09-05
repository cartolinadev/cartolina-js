
/*
 * illumination.ts - illumination vector math
 *
 * This module is used for view-dependent alpha calculation in views. Functions
 * are provided to compute lNED and NED illumination vectors from azimuth
 * and elevation, and to transform vectors from lNED and NED.
 *
 * We use the lNED and NED coordinate systems in the map context as follows.
 *
 * NED is the local geographic north-east-down system for the current position.
 * It differs from the map's navigation SRS only in order and polarity of axes.
 * Hence NED is defined by where the center of orbit is in VTS terminology.
 *
 * lNED is the local NED as defined by the Euler angles of the current position.
 * It differs from the camera coordinate system only in order and polarity of
 * axes. Hence lNED is defined by where the observer is in VTS terminology.
 *
 * (Somewhat confusingly, in lNED N is the negative Z in camera space (it points
 * where the camera looks) and D points down our viewport (negative Y in camera
 * space). This follows the way the VTS positions are defined: looking down
 * means yaw of -90. This would normally mean nose down in aeronautics).
 */



export const enum CoordSystem { NED, LNED }

export type Position = [string, number, number, string, number, number, number,
    number, number, number];

export type vec3 = [number, number, number];

/*
 * Build illlumination vector from azimuth and elevation, for a given
 * coordinate system.
 *
 * @param azimuth illumination azimuth in degrees
 * @param elevation illumination elevation in degrees
 * @cs Coordinate system. For NED, the azimuth and elevation are defined with
 *      respect to the NE plane. For lNED, the are defined with respect to the
 *      (-D,E) plane, as explained in module header.
 * @returns illumination vector in the target coordinate system.
 */

export function illuminationVector(azimuth: number = 315,
    elevation: number = 45., cs: CoordSystem = CoordSystem.NED) : vec3 {

    // TODO
}


/*
 * lNED to NED conversion.
 * @param arg vector in lNED coordinates
 * @param pos current map position (only the Euler angles matter for this op)
 * @returns corresponding vector in NED coordinates
 */

export function lned2ned(arg: vec3, pos: Position) : vec3 {

    // TODO
}

