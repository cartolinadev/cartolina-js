/**
 * Freeze sub-mode for the diagnostic inspector.
 *
 * Entering freeze mode snapshots the camera state used by tile culling
 * and texel-size selection. Navigation then moves the rendered view while
 * tile descent continues to evaluate the frozen viewpoint.
 */

import type Renderer from '../renderer/renderer';
import type MapPosition from '../map/position';
import type FreezeCameraState from '../map/freeze-camera-state';
import type {
    FrozenCameraState,
} from '../map/freeze-camera-state';


type DepthSample = [boolean, number];

type FreezeMap = {
    camera: { update(): void };
    draw: {
        freeze: FreezeCameraState;
    };
    hitMapDirty: boolean;
    position: MapPosition;
    referenceFrame: {
        division: {
            extents: {
                ll: [number, number, number];
                ur: [number, number, number];
            };
        };
    };
    getScreenDepth(
        x: number,
        y: number,
        dilate: number,
        useGeometricIntersection: boolean,
        coordinateSpace: Renderer.CoordinateSpace,
    ): DepthSample;
    getScreenRay(x: number, y: number): number[];
    setPosition(position: MapPosition): void;
    markDirty(): void;
};

type FreezeCore = {
    renderer: Renderer;
    getMap(): FreezeMap | null;
};


/**
 * Owns freeze-mode DOM, draw-state wiring, and frustum capture.
 */
export class FreezeMode {

    active = false;
    drawFrustum = false;
    frustumApex: number[] | null = null;
    frustumBase: number[][] | null = null;

    private navPosition_: MapPosition | null = null;
    private resetBtn_: HTMLElement | null = null;
    private statusEl_: HTMLElement | null = null;

    constructor(private readonly core: FreezeCore) {}

    /**
     * Snapshot the current culling camera and create freeze controls.
     */
    enter(): void {

        const map = this.core.getMap();
        if (!map) return;

        map.camera.update();
        this.navPosition_ = map.position.clone();
        map.draw.freeze.activateFromCurrentCamera();

        this.active = true;
        this.resetBtn_ = this.createResetButton_(map);
        this.statusEl_ = this.createStatusBar_();
        this.updateStatus();
        map.markDirty();
    }

    /**
     * Disable freeze mode and remove its DOM controls.
     */
    exit(): void {

        const map = this.core.getMap();

        if (map) {

            map.draw.freeze.deactivate();
            map.markDirty();
        }

        this.resetBtn_?.remove();
        this.statusEl_?.remove();

        this.active = false;
        this.drawFrustum = false;
        this.frustumApex = null;
        this.frustumBase = null;
        this.navPosition_ = null;
        this.resetBtn_ = null;
        this.statusEl_ = null;
    }

    /**
     * Toggle the frozen-camera frustum pyramid.
     */
    toggleFrustum(): void {

        this.drawFrustum = !this.drawFrustum;
        if (this.drawFrustum) {

            this.captureFrustum();
        } else {

            this.frustumApex = null;
            this.frustumBase = null;
        }

        this.updateStatus();
    }

    /**
     * Compute the frozen-camera pyramid from five depth samples.
     */
    captureFrustum(): void {

        const map = this.core.getMap();
        const selectionState = map?.draw.freeze.selectionCameraState ?? null;
        if (!map || !selectionState) return;

        const renderer: Renderer = this.core.renderer;
        const [w, h] = renderer.getCanvasSize();
        const samples: [number, number][] = [
            [1, 1],
            [w - 1, 1],
            [w - 1, h - 1],
            [1, h - 1],
            [w * 0.5, h * 0.5],
        ];

        const hits = map.draw.freeze.withSelectionCamera(() => {

            map.hitMapDirty = true;
            return samples.map(([x, y]) =>
                map.getScreenDepth(x, y, 0, false, 'layout') as DepthSample);
        });

        const finiteDepths = hits
            .filter((hit: DepthSample) =>
                hit && hit[0] && Number.isFinite(hit[1]))
            .map((hit: DepthSample) => hit[1]);

        const depth = finiteDepths.length === samples.length
            ? Math.max(...finiteDepths) * 1.25
            : this.referenceFrameExtent_(map);

        const apex = this.cameraPosition_(selectionState);
        const corners: [number, number][] = [
            [0, 0],
            [w, 0],
            [w, h],
            [0, h],
        ];

        const base = map.draw.freeze.withSelectionCamera(() =>
            corners.map(([x, y]) => {

                const ray = map.getScreenRay(x, y);
                return [
                    apex[0] + ray[0] * depth,
                    apex[1] + ray[1] * depth,
                    apex[2] + ray[2] * depth,
                ];
            }));

        this.frustumApex = apex;
        this.frustumBase = base;
    }

    /**
     * Update the persistent status bar.
     */
    updateStatus(): void {

        if (!this.statusEl_) return;

        this.statusEl_.textContent =
            'Freeze mode | C: frustum '
            + (this.drawFrustum ? 'on' : 'off')
            + ' | Shift+Z or Esc: exit';
    }

    private referenceFrameExtent_(map: FreezeMap): number {

        const ext = map.referenceFrame.division.extents;
        const dx = ext.ur[0] - ext.ll[0];
        const dy = ext.ur[1] - ext.ll[1];
        const dz = ext.ur[2] - ext.ll[2];

        return Math.hypot(dx, dy, dz);
    }

    private cameraPosition_(state: FrozenCameraState): number[] {

        return state.map.position.slice();
    }

    private createResetButton_(map: FreezeMap): HTMLElement {

        const btn = document.createElement('button');
        btn.className = 'vts-freeze-reset';
        btn.textContent = 'Reset position';
        btn.addEventListener('click', () => {

            if (this.navPosition_) {

                map.setPosition(this.navPosition_);
                map.markDirty();
            }
        });

        document.body.appendChild(btn);
        return btn;
    }

    private createStatusBar_(): HTMLElement {

        const el = document.createElement('div');
        el.className = 'vts-freeze-status';
        document.body.appendChild(el);
        return el;
    }
}
