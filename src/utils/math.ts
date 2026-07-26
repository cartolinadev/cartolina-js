
import {mat4, vec3} from './matrix';

export type vec3 = [number, number, number]
export type vec4 = [number, number, number, number];

export type mat3 = ArrayLike<number> & { length: 9 };
export type mat4 = ArrayLike<number> & { length: 16 };

export function isEqual(value: number, value2: number, delta: number) {
    return (Math.abs(value - value2) < delta);
};


export function clamp(value: number, min: number, max: number) {
    if (value < min) value = min;
    else if (value > max) value = max;

    return value;
};


export function radians(degrees: number) {
    return degrees * Math.PI / 180;
};


export function degrees(radians: number) {
    return (radians / Math.PI) * 180;
};


export function mix(a: number, b: number, c: number) {
    return a + (b - a) * c;
};


export function frustumMatrix(
    left: number, right: number, bottom: number,
    top: number, near: number, far: number,
) {
    var w = (right - left);
    var h = (top - bottom);
    var d = (far - near);

    var m = mat4.create([2*near/w, 0, (right+left)/w, 0,
        0, 2*near/h, (top+bottom)/h, 0,
        0, 0, -(far+near)/d, -2*far*near/d,
        0, 0, -1, 0]);

    mat4.transpose(m);
    return m;
};


export function perspectiveMatrix(
    fovy: number, aspect: number, near: number, far: number,
) {
    var ymax = near * Math.tan(fovy * Math.PI / 180.0);
    var xmax = ymax * aspect;
    return frustumMatrix(-xmax, xmax, -ymax, ymax, near, far);
};


export function orthographicMatrix(
    vsize: number, aspect: number, near: number, far: number,
) {
    //vsize *= 0.020;
    var w = vsize* 0.5 * aspect;
    var h = vsize * 0.5;
    var d = (far - near);

    var m = mat4.create([1/w, 0, 0, 0,
        0, 1/h, 0, 0,
        0, 0, -2/d, -((far+near)/d),
        0, 0, 0, 1]);

    mat4.transpose(m);
    return m;
};


export function rotationMatrix(axis: number, angle: number) {
    var ca = Math.cos(angle), sa = Math.sin(angle);

    /*    var m;
    switch (axis) {
    case 0:
        m = [
            1,  0,  0, 0,
            0, ca,-sa, 0,
            0, sa, ca, 0,
            0,  0,  0, 1 ];
        break;
    case 1:
        m = [
            ca, 0,-sa, 0,
            0, 1,  0,  0,
            sa, 0, ca, 0,
            0, 0,  0, 1 ];
        break;
    default:
        m = [
            ca,-sa, 0, 0,
            sa, ca, 0, 0,
            0,  0,  1, 0,
            0,  0,  0, 1 ];
        break;
    }
    mat4.transpose(m);
    return m; */

    switch (axis) {
    case 0:
        // correct
        return [
            1,   0,   0,  0,
            0,  ca,  sa,  0,
            0, -sa,  ca,  0,
            0,   0,   0,  1 ];
    case 1:
        // WARNING: inverted !!
        return [
             ca,  0,  sa,  0,
              0,  1,   0,  0,
            -sa,  0,  ca,  0,
              0,  0,   0,  1 ];
    default:
        // correct
        return [
             ca, sa,  0,  0,
            -sa, ca,  0,  0,
              0,  0,  1,  0,
              0,  0,  0,  1 ];
    }

};


export function scaleMatrix(sx: number, sy: number, sz: number) {
    /*var m = [
        sx,  0,  0, 0,
        0, sy,  0, 0,
        0,  0, sz, 0,
        0,  0,  0, 1 ];

    mat4.transpose(m);
    return m;*/
    return [
        sx,   0,   0,   0,
        0,   sy,   0,   0,
        0,    0,  sz,   0,
        0,    0,   0,   1 ];
};


export function scaleMatrixf(s: number) {
    return scaleMatrix(s, s, s);
};


export function translationMatrix(tx: number, ty: number, tz: number) {
    /*
    var m = [
        1, 0, 0, tx,
        0, 1, 0, ty,
        0, 0, 1, tz,
        0, 0, 0, 1 ];

    mat4.transpose(m);
    */

    return [
        1,   0,  0,  0,
        0,   1,  0,  0,
        0,   0,  1,  0,
        tx, ty, tz,  1 ];
};


export function translationMatrix2f(t: ArrayLike<number>) {
    return translationMatrix(t[0], t[1], 0);
};


export function translationMatrix3f(t: ArrayLike<number>) {
    return translationMatrix(t[0], t[1], t[2]);
};


