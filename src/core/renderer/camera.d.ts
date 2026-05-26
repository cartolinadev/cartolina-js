/**
 * Type surface for the legacy renderer `Camera` class (`camera.js`).
 *
 * Declares the fields and methods used by typed code in `renderer.ts`
 * and `freeze-camera-state.ts`. `position` and `orientation` are
 * declared as tuples to match their runtime shape, overriding the
 * `number[]` that allowJs would otherwise infer.
 */

type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];
type Mat4 = number[];

export default class Camera {

    constructor(
        parent: unknown,
        fov: number,
        near: number,
        far: number,
    );

    position: Vec3;
    orientation: Vec3;
    aspect: number;
    fov: number;
    fovTan: number;
    fovDist: number;
    fovFactor?: number;
    near: number;
    far: number;
    viewHeight?: number;
    ortho?: boolean;
    rotationByMatrix: boolean;

    modelview: Mat4;
    rotationview: Mat4;
    projection: Mat4;
    modelviewinverse: Mat4;
    mvpinverse: Mat4;
    mvp: Mat4;
    frustumPlanes: Vec4[];
    bboxPoints: Vec4[];
    mvp32: Float32Array;
    modelview32: Float32Array;
    rotationview32: Float32Array;
    projection32: Float32Array;

    dirty: boolean;

    setPosition(position: Vec3): void;
    setOrientation(orientation: Vec3): void;
    setRotationMatrix(matrix: Mat4): void;
    setAspect(aspect: number): void;
    setViewHeight(height: number): void;
    setParams(fov: number, near: number, far: number): void;

    getPosition(): Vec3;
    getFar(): number;
    getModelviewMatrix(): Mat4;
    getModelviewMatrixInverse(): Mat4;
    getModelviewFMatrix(): Float32Array;
    getProjectionMatrix(): Mat4;
    getProjectionFMatrix(): Float32Array;

    update(): void;
}
