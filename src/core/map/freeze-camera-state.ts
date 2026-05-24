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
 * camera and position values from mutable fields spread across `Map`,
 * `MapCamera`, `Renderer.camera`, and `Renderer` itself. This class is the
 * narrow bridge used while that code still exists: draw code scopes legacy
 * reads with `withSelectionCamera` or `withNavigationCamera`, and this class
 * swaps the fields those reads use.
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
import type MapPosition from './position';


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

type FreezeMap = {
    position: MapPosition;
    camera: MutableMapCamera;
    renderer: Renderer & {
        cameraPosition: Vec3;
        cameraVector: Vec3;
    };
};

type MapCameraState = {
    mapPosition: MapPosition;
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

/**
 * Stores the frozen selection camera and swaps legacy map fields for scoped
 * draw callbacks. The primary motivation for this module was the diagnostic
 * freeze mode, which needs tile selection to use a frozen camera while
 * navigation and final rendering use the live camera.
 */
class FreezeCameraState {

    active = false;
    selectionCameraState: FreezeCameraState.CapturedCameraState | null = null;
    private navigationCameraState_:
        FreezeCameraState.CapturedCameraState | null = null;
    private context_: FreezeCameraState.Context = 'navigation';

    constructor(private readonly map_: FreezeMap) {}

    /**
     * Snapshot the current camera and make it the selection camera.
     */
    activateFromCurrentCamera(): void {

        this.active = true;
        this.selectionCameraState = this.capture();
        this.navigationCameraState_ = null;
        this.context_ = 'navigation';
    }

    /** Clear the frozen selection camera. */
    deactivate(): void {

        this.active = false;
        this.selectionCameraState = null;
        this.navigationCameraState_ = null;
        this.context_ = 'navigation';
    }

    /**
     * Run a callback with the frozen selection context installed.
     */
    withSelectionCamera<T>(callback: () => T): T {

        if (!this.selectionCameraState) return callback();

        const restoreState = this.capture();
        const restoreNavigationState = this.navigationCameraState_;
        const restoreContext = this.context_;

        if (this.context_ === 'navigation') {
            this.navigationCameraState_ = restoreState;
        }

        this.restore(this.selectionCameraState);
        this.context_ = 'selection';

        try {

            return callback();

        } finally {

            this.restore(restoreState);
            this.navigationCameraState_ = restoreNavigationState;
            this.context_ = restoreContext;
        }
    }

    /**
     * Run a callback with the live navigation context installed.
     */
    withNavigationCamera<T>(callback: () => T): T {

        if (!this.active || !this.navigationCameraState_) {
            return callback();
        }

        const restoreState = this.capture();
        const restoreContext = this.context_;

        this.restore(this.navigationCameraState_);
        this.context_ = 'navigation';

        try {

            return callback();

        } finally {

            this.restore(restoreState);
            this.context_ = restoreContext;
        }
    }

    /** Return the live navigation position. */
    getNavigationPosition(): MapPosition | null {

        return this.navigationCameraState_
            ? this.navigationCameraState_.map.mapPosition.clone()
            : null;
    }

    /** Return the map position used for tile selection. */
    getSelectionPosition(): MapPosition | null {

        return this.active && this.selectionCameraState
            ? this.selectionCameraState.map.mapPosition.clone()
            : null;
    }

    private capture(): FreezeCameraState.CapturedCameraState {

        const mapCamera = this.map_.camera;
        const renderCamera = mapCamera.camera;

        return {
            map: {
                mapPosition: this.map_.position.clone(),
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

    private restore(state: FreezeCameraState.CapturedCameraState): void {

        const mapCamera = this.map_.camera;
        const renderCamera = mapCamera.camera;
        const mapState = state.map;
        const renderState = state.renderer;

        this.map_.position = mapState.mapPosition.clone();
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

        this.map_.renderer.cameraPosition = mapCamera.position;
        this.map_.renderer.cameraVector = mapCamera.vector;
    }

    private vec3_(value: ArrayLike<number>): Vec3 {

        return [value[0], value[1], value[2]];
    }

    private vec4_(value: ArrayLike<number>): Vec4 {

        return [value[0], value[1], value[2], value[3]];
    }
}

namespace FreezeCameraState {
    export type Context = 'navigation' | 'selection';

    export type CapturedCameraState = {
        map: MapCameraState;
        renderer: RendererCameraState;
    };
}

export default FreezeCameraState;
