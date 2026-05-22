/**
 * Camera-state swapper for diagnostic freeze mode.
 *
 * Freeze mode separates the navigation context from the selection context.
 * The navigation context follows user input and defines the view to render.
 * The selection context is the camera snapshot used for culling, texel-size
 * tile selection, and depth sampling. Diagnostic freeze mode keeps the
 * selection context fixed while navigation continues to move.
 *
 * The legacy map draw code does not pass these contexts explicitly. It reads
 * camera values from mutable fields spread across `MapCamera`,
 * `Renderer.camera`, and `Renderer` itself. This class is the narrow bridge
 * used while that code still exists: `draw.js` and `surface-tree.js` call
 * small phase hooks, and the hook implementation swaps the fields that those
 * phases read.
 *
 * This is not the target design. As legacy `map.js`, `draw.js`, and related
 * files are dissolved into `map.ts` and supporting TypeScript modules, map
 * code should own map data and selection decisions, while `Renderer` should
 * own rendering commands and GPU state. The eventual replacement is explicit
 * per-pass context data passed through draw traversal, with separate values
 * for navigation, selection, hitmap, and final rendering. When that exists,
 * freeze mode can provide a frozen selection context without mutating shared
 * camera objects.
 *
 * The long field list below records the current unorganized state that must
 * move together for freeze mode to be correct. Shrink it when a field gains
 * one owner or is passed through an explicit context object.
 */

import type Renderer from '../renderer/renderer';
import type MapCamera from './camera';


type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];
type Mat4 = number[];

type MutableRendererCamera = Renderer['camera'] & {
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
};

type MutableMapCamera = MapCamera & {
    camera: MutableRendererCamera;
    distance: number;
    distance2: number;
    distanceFactor: number;
    perceivedDistance: number;
    position: Vec3;
    vector: Vec3;
    vector2: Vec4;
    center: Vec3;
    height: number;
    terrainHeight: number;
    lastTerrainHeight: number;
    mapIsProjected?: boolean;
    geocentDistance?: number;
    geocentNormal?: Vec3;
};

type FreezeDraw = {
    camera: MutableMapCamera;
    renderer: Renderer & {
        cameraPosition: Vec3;
        cameraVector: Vec3;
        updateBuffers(): void;
    };
    drawChannel: number;
};

type MapCameraState = {
    distance: number;
    distance2: number;
    distanceFactor: number;
    perceivedDistance: number;
    position: Vec3;
    vector: Vec3;
    vector2: Vec4;
    center: Vec3;
    height: number;
    terrainHeight: number;
    lastTerrainHeight: number;
    mapIsProjected?: boolean;
    geocentDistance?: number;
    geocentNormal?: Vec3;
};

type RendererCameraState = {
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
    dirty: boolean;
};

export type FrozenCameraState = {
    map: MapCameraState;
    renderer: RendererCameraState;
};


/**
 * Stores the frozen selection camera and swaps legacy camera fields at draw
 * phases. The primary motivation for this module was the diagnostic freeze
 * mode, which needs tile selection to use a frozen camera while navigation
 * and final rendering use the live camera.
 */
export default class FreezeCameraState {

    active = false;
    selectionCameraState: FrozenCameraState | null = null;
    private liveCameraState_: FrozenCameraState | null = null;

    constructor(private readonly draw_: FreezeDraw) {}

    /**
     * Snapshot the current camera and make it the selection camera.
     */
    activateFromCurrentCamera(): void {

        this.active = true;
        this.selectionCameraState = this.capture();
        this.liveCameraState_ = null;
    }

    /** Clear the frozen selection camera. */
    deactivate(): void {

        this.active = false;
        this.selectionCameraState = null;
        this.liveCameraState_ = null;
    }

    /**
     * Switch to the frozen camera before tile descent begins.
     */
    beforeTileDescent(): void {

        if (!this.active || !this.selectionCameraState) return;

        this.liveCameraState_ = this.capture();
        this.restore(this.selectionCameraState);
    }

    /**
     * Switch to the live camera before drawing selected tiles.
     *
     * @param cameraPos selection camera position passed by legacy traversal
     * @returns live camera position for base-pass tile rendering
     */
    beforeDrawBuffer(cameraPos: Vec3): Vec3 {

        if (!this.active || !this.liveCameraState_) return cameraPos;
        if (this.draw_.drawChannel !== 0) return cameraPos;

        this.restore(this.liveCameraState_);
        return this.liveCameraState_.map.position;
    }

    /**
     * Restore the frozen camera after drawing selected tiles.
     */
    afterDrawBuffer(): void {

        if (!this.active || !this.selectionCameraState) return;
        if (this.draw_.drawChannel !== 0) return;

        this.restore(this.selectionCameraState);
    }

    /**
     * Restore the live camera at the end of a draw pass.
     */
    afterDrawMap(): void {

        if (this.liveCameraState_) {

            this.restore(this.liveCameraState_);
            this.liveCameraState_ = null;
            this.draw_.renderer.updateBuffers();
        }
    }

    /**
     * Run a callback with the frozen selection camera installed.
     */
    withSelectionCamera<T>(callback: () => T): T {

        if (!this.selectionCameraState) return callback();

        const restoreState = this.capture();
        this.restore(this.selectionCameraState);

        try {

            return callback();

        } finally {

            this.restore(restoreState);
        }
    }

    /**
     * Run a callback with the live render camera installed.
     */
    withLiveCamera<T>(callback: () => T): T {

        if (!this.active || !this.liveCameraState_) return callback();

        this.restore(this.liveCameraState_);

        try {

            return callback();

        } finally {

            if (this.selectionCameraState) {
                this.restore(this.selectionCameraState);
            }
        }
    }

    private capture(): FrozenCameraState {

        const mapCamera = this.draw_.camera;
        const renderCamera = mapCamera.camera;

        return {
            map: {
                distance: mapCamera.distance,
                distance2: mapCamera.distance2,
                distanceFactor: mapCamera.distanceFactor,
                perceivedDistance: mapCamera.perceivedDistance,
                position: this.vec3_(mapCamera.position),
                vector: this.vec3_(mapCamera.vector),
                vector2: this.vec4_(mapCamera.vector2),
                center: this.vec3_(mapCamera.center),
                height: mapCamera.height,
                terrainHeight: mapCamera.terrainHeight,
                lastTerrainHeight: mapCamera.lastTerrainHeight,
                mapIsProjected: mapCamera.mapIsProjected,
                geocentDistance: mapCamera.geocentDistance,
                geocentNormal: mapCamera.geocentNormal
                    ? this.vec3_(mapCamera.geocentNormal)
                    : undefined,
            },
            renderer: {
                position: this.vec3_(renderCamera.position),
                orientation: this.vec3_(renderCamera.orientation),
                aspect: renderCamera.aspect,
                fov: renderCamera.fov,
                fovTan: renderCamera.fovTan,
                fovDist: renderCamera.fovDist,
                fovFactor: renderCamera.fovFactor,
                near: renderCamera.near,
                far: renderCamera.far,
                viewHeight: renderCamera.viewHeight,
                ortho: renderCamera.ortho,
                rotationByMatrix: renderCamera.rotationByMatrix,
                modelview: renderCamera.modelview.slice(),
                rotationview: renderCamera.rotationview.slice(),
                projection: renderCamera.projection.slice(),
                modelviewinverse: renderCamera.modelviewinverse.slice(),
                mvpinverse: renderCamera.mvpinverse.slice(),
                mvp: renderCamera.mvp.slice(),
                frustumPlanes: renderCamera.frustumPlanes.map(
                    (plane: Vec4) => this.vec4_(plane)),
                bboxPoints: renderCamera.bboxPoints.map(
                    (point: Vec4) => this.vec4_(point)),
                dirty: renderCamera.dirty,
            },
        };
    }

    private restore(state: FrozenCameraState): void {

        const mapCamera = this.draw_.camera;
        const renderCamera = mapCamera.camera;
        const mapState = state.map;
        const renderState = state.renderer;

        mapCamera.distance = mapState.distance;
        mapCamera.distance2 = mapState.distance2;
        mapCamera.distanceFactor = mapState.distanceFactor;
        mapCamera.perceivedDistance = mapState.perceivedDistance;
        mapCamera.position = this.vec3_(mapState.position);
        mapCamera.vector = this.vec3_(mapState.vector);
        mapCamera.vector2 = this.vec4_(mapState.vector2);
        mapCamera.center = this.vec3_(mapState.center);
        mapCamera.height = mapState.height;
        mapCamera.terrainHeight = mapState.terrainHeight;
        mapCamera.lastTerrainHeight = mapState.lastTerrainHeight;
        mapCamera.mapIsProjected = mapState.mapIsProjected;
        mapCamera.geocentDistance = mapState.geocentDistance;
        mapCamera.geocentNormal = mapState.geocentNormal
            ? this.vec3_(mapState.geocentNormal)
            : undefined;

        renderCamera.position = this.vec3_(renderState.position);
        renderCamera.orientation = this.vec3_(renderState.orientation);
        renderCamera.aspect = renderState.aspect;
        renderCamera.fov = renderState.fov;
        renderCamera.fovTan = renderState.fovTan;
        renderCamera.fovDist = renderState.fovDist;
        renderCamera.fovFactor = renderState.fovFactor;
        renderCamera.near = renderState.near;
        renderCamera.far = renderState.far;
        renderCamera.viewHeight = renderState.viewHeight;
        renderCamera.ortho = renderState.ortho;
        renderCamera.rotationByMatrix = renderState.rotationByMatrix;
        renderCamera.modelview = renderState.modelview.slice();
        renderCamera.rotationview = renderState.rotationview.slice();
        renderCamera.projection = renderState.projection.slice();
        renderCamera.modelviewinverse = renderState.modelviewinverse.slice();
        renderCamera.mvpinverse = renderState.mvpinverse.slice();
        renderCamera.mvp = renderState.mvp.slice();
        renderCamera.frustumPlanes = renderState.frustumPlanes.map(
            (plane) => this.vec4_(plane));
        renderCamera.bboxPoints = renderState.bboxPoints.map(
            (point) => this.vec4_(point));
        renderCamera.mvp32.set(renderCamera.mvp);
        renderCamera.modelview32.set(renderCamera.modelview);
        renderCamera.rotationview32.set(renderCamera.rotationview);
        renderCamera.projection32.set(renderCamera.projection);
        renderCamera.dirty = renderState.dirty;

        this.draw_.renderer.cameraPosition = mapCamera.position;
        this.draw_.renderer.cameraVector = mapCamera.vector;
    }

    private vec3_(value: ArrayLike<number>): Vec3 {

        return [value[0], value[1], value[2]];
    }

    private vec4_(value: ArrayLike<number>): Vec4 {

        return [value[0], value[1], value[2], value[3]];
    }
}
