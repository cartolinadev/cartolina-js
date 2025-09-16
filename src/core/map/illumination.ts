
/*
 * illumination.ts - illumination vector math
 *
 * This module is used for view-dependent alpha calculation in views. Functions
 * are provided to compute lNED and NED illumination vectors from azimuth
 * and elevation, and to transform vectors from lNED and NED.
 */

import * as Matrix from '../utils/matrix';
import * as math from '../utils/math';

import MapPosition from './position';

/**
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
 *
 * VC is the openGL camera space, it differs from LNED only in order and
 * and orientation of the axis.
 */

export enum CoordSystem { NED, LNED, VC };

/* Some borrowed types. */

enum Axis { X = 0, Y = 1, Z = 2  };

/**
 * Build illlumination vector from azimuth and elevation, for a given
 * coordinate system.
 *
 * @param azimuth illumination azimuth in degrees
 * @param elevation illumination elevation in degrees
 * @cs Coordinate system. For NED, the azimuth and elevation are defined with
 *      respect to the NE plane. For lNED, the are defined with respect to the
 *      (-D,E) plane, as explained in the enum definition.
 * @returns illumination vector in the target coordinate system.
 */

export function illuminationVector(azimuth: number = 315,
    elevation: number = 45., cs: CoordSystem = CoordSystem.NED) : math.vec3 {

    const { sin, cos } = Math;

    let az = math.radians(azimuth);
    let el = math.radians(elevation);

    if (cs === CoordSystem.NED) {

        // shorthand for Rz(a)*Ry(e)*[1,0,0]
        return [cos(az) * cos(el), sin(az) * cos(el), - sin(el)];
    }

    if (cs === CoordSystem.LNED) {

        // shorthand for Rx(a)*Ry(e)*[0,0,-1]
        return [-sin(el), sin(az) * cos(el), - cos(az) * cos(el)];
    }

    if (cs == CoordSystem.VC) {

        // (X,Y,Z) = (lE, -lD, -lN)
        // should be shorthand for Rx(e) * Rz(-a) * [0, 1, 0]
        return [sin(az) * cos(el), cos(az) * cos(el), sin(el)]
    }

    // never reached
    return [0,0,0];
}


/*
 * lNED to NED conversion.
 * @param arg vector in lNED coordinates
 * @param pos current map position (only the Euler angles matter for this op)
 * @returns corresponding vector in NED coordinates
 */

export function lned2ned(arg: math.vec3, pos: MapPosition) : math.vec3 {

    const rad = math.radians;
    const R = math.rotationMatrix;
    const mat4 = Matrix.mat4;

    let yaw = rad(pos.pos[5]), pitch = rad(pos.pos[6]), roll = rad(pos.pos[7]);

    let retval_: math.vec3 = [...arg];

    mat4.multiplyVec3(R(Axis.X, roll), retval_);

    // WARNING: math module's Y-rotation is inverted, ouch
    mat4.multiplyVec3(R(Axis.Y, - pitch),retval_);

    mat4.multiplyVec3(R(Axis.Z, yaw), retval_);

    return retval_;
}

