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
import type LegacyMap from '../map/map';


type DepthSample = [boolean, number];


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

    /**
     * Snapshot the current culling camera and create freeze controls.
     *
     * @param map legacy terrain engine for the current loaded map
     */
    enter(map: LegacyMap): void {

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
     *
     * @param map legacy terrain engine for the current loaded map
     */
    exit(map: LegacyMap | null): void {

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
     *
     * @param map legacy terrain engine for the current loaded map
     * @param renderer renderer used to sample the current viewport size
     */
    toggleFrustum(map: LegacyMap | null, renderer: Renderer): void {

        this.drawFrustum = !this.drawFrustum;
        if (this.drawFrustum && map) {

            this.captureFrustum(map, renderer);
        } else {

            this.frustumApex = null;
            this.frustumBase = null;
        }

        this.updateStatus();
    }

    /**
     * Compute the frozen-camera pyramid from five depth samples.
     *
     * @param map legacy terrain engine for the current loaded map
     * @param renderer renderer used to sample the current viewport size
     */
    captureFrustum(map: LegacyMap, renderer: Renderer): void {

        const selectionState = map?.draw.freeze.selectionCameraState ?? null;
        if (!map || !selectionState) return;

        const [w, h] = renderer.getCanvasSize();
        const samples: [number, number][] = [
            [0, 0],
            [w, 0],
            [w, h],
            [0, h],
            [w * 0.5, h * 0.5],
        ];

        const hits = map.draw.freeze.withSelectionCamera(() => {

            map.markDirty();
            return samples.map(([x, y]) =>
                map.getScreenDepth(x, y, 0, false, 'layout') as DepthSample);
        });

        const finiteDepths = hits
            .filter((hit: DepthSample) =>
                hit && hit[0] && Number.isFinite(hit[1]))
            .map((hit: DepthSample) => hit[1]);

        const farthestDepth = finiteDepths.length
            ? Math.max(...finiteDepths)
            : 0;
        const depth = finiteDepths.length === samples.length
            ? farthestDepth * 1.25
            : farthestDepth + this.referenceFrameExtent_(map);

        const apex = this.cameraPosition_(selectionState);
        const corners: [number, number][] = [
            [0, 0],
            [w, 0],
            [w, h],
            [0, h],
        ];

        const base = map.draw.freeze.withSelectionCamera(() =>
            corners.map(([x, y]) => {

                const ray = renderer.getScreenRay(x, y, 'layout');
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

    private referenceFrameExtent_(map: LegacyMap): number {

        const ext = map.referenceFrame?.division?.extents;
        if (!ext) return 0;

        const dx = ext.ur[0] - ext.ll[0];
        const dy = ext.ur[1] - ext.ll[1];
        const dz = ext.ur[2] - ext.ll[2];

        return Math.max(dx, dy, dz);
    }

    private cameraPosition_(
        state: FreezeCameraState.CapturedCameraState,
    ): number[] {

        return state.map.position.slice();
    }

    private createResetButton_(map: LegacyMap): HTMLElement {

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
