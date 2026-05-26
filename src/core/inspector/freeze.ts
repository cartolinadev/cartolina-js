/**
 * Freeze diagnostic state and controls.
 *
 * Freezing snapshots the camera state used by tile culling and texel-size
 * selection. Navigation then moves the rendered view while tile descent
 * continues to evaluate the frozen viewpoint. The keyboard sub-mode only
 * controls this state; leaving that sub-mode does not unfreeze the map.
 */

import type Renderer from '../renderer/renderer';
import type MapPosition from '../map/position';
import type FreezeCameraState from '../map/freeze-camera-state';
import type LegacyMap from '../map/map';


/**
 * Owns freeze-state DOM, draw-state wiring, and frustum capture.
 */
export class FreezeMode {

    active = false;
    drawFrustum = false;
    frustumApex: number[] | null = null;
    frustumBase: number[][] | null = null;

    private controlsActive_ = false;
    private navPosition_: MapPosition | null = null;
    private controlsEl_: HTMLElement | null = null;
    private freezeBtn_: HTMLButtonElement | null = null;
    private frustumBtn_: HTMLButtonElement | null = null;
    private resetBtn_: HTMLButtonElement | null = null;

    /**
     * Snapshot the current selection camera at the live navigation position.
     *
     * @param map legacy terrain engine for the current loaded map
     */
    freeze(map: LegacyMap): void {

        map.camera.update();
        this.navPosition_ = map.position.clone();
        map.freeze.activateFromCurrentCamera();

        this.active = true;
        this.ensureControls_(map);
        this.updateControls_();
        map.markDirty();
    }

    /**
     * Disable frozen selection and remove its persistent controls.
     *
     * @param map legacy terrain engine for the current loaded map
     */
    unfreeze(map: LegacyMap | null): void {

        if (map) {
            map.freeze.deactivate();
            map.markDirty();
        }

        this.active = false;
        this.drawFrustum = false;
        this.frustumApex = null;
        this.frustumBase = null;
        this.navPosition_ = null;
        this.updateControls_();
        this.removeControlsIfIdle_();
    }

    /**
     * Toggle frozen selection at the current live navigation position.
     *
     * @param map legacy terrain engine for the current loaded map
     */
    toggleFrozen(map: LegacyMap | null): void {

        if (!map) return;

        if (this.active) {

            this.unfreeze(map);

        } else {

            this.freeze(map);
        }
    }

    /**
     * Restore the live navigation camera to the frozen position.
     *
     * @param map legacy terrain engine for the current loaded map
     */
    resetView(map: LegacyMap | null): void {

        if (!map || !this.navPosition_) return;

        map.setPosition(this.navPosition_.clone());
        map.markDirty();
    }

    /**
     * Toggle the frozen-camera frustum pyramid.
     *
     * @param map legacy terrain engine for the current loaded map
     * @param renderer renderer used to sample the current viewport size
     */
    toggleFrustum(map: LegacyMap | null, renderer: Renderer): void {

        if (!this.active || !map) return;

        this.drawFrustum = !this.drawFrustum;
        if (this.drawFrustum) {

            this.captureFrustum(map, renderer);
        } else {

            this.frustumApex = null;
            this.frustumBase = null;
        }

        this.updateControls_();
        map.markDirty();
    }

    /**
     * Show or hide the freeze command strip.
     *
     * @param map legacy terrain engine for the current loaded map
     */
    setControlsActive(map: LegacyMap | null, active: boolean): void {

        this.controlsActive_ = active;

        if (active && map) {

            this.ensureControls_(map);
            this.updateControls_();

        } else {

            this.removeControlsIfIdle_();
        }
    }

    /**
     * Compute the frozen-camera pyramid from the hitmap's farthest depth.
     *
     * @param map legacy terrain engine for the current loaded map
     * @param renderer renderer used to sample the current viewport size
     */
    captureFrustum(map: LegacyMap, renderer: Renderer): void {

        const selectionState = map?.freeze.selectionCameraState ?? null;
        if (!map || !selectionState) return;

        const [w, h] = renderer.getCanvasSize();
        const maxDepth = map.withSelectionCamera(() => {

            map.markDirty();
            map.getScreenDepth(w * 0.5, h * 0.5, 0, false, 'layout');
            return renderer.getMaxFiniteDepth();
        });
        const depth = maxDepth !== null
            ? maxDepth * 1.1
            : this.referenceFrameExtent_(map);

        const apex = this.cameraPosition_(selectionState);
        const corners: [number, number][] = [
            [0, 0],
            [w, 0],
            [w, h],
            [0, h],
        ];

        const base = map.withSelectionCamera(() =>
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

    private ensureControls_(map: LegacyMap): void {

        if (this.controlsEl_) return;

        const controls = document.createElement('div');
        controls.className = 'vts-freeze-controls';
        controls.addEventListener('pointerdown', (event) => {

            event.stopPropagation();
        });
        controls.addEventListener('click', (event) => {

            event.stopPropagation();
        });

        this.freezeBtn_ = this.createButton_('Freeze', () => {

            this.toggleFrozen(map);
        });
        controls.appendChild(this.freezeBtn_);

        this.frustumBtn_ = this.createButton_('Show frustum', () => {

            this.toggleFrustum(map, map.renderer);
        });
        controls.appendChild(this.frustumBtn_);

        this.resetBtn_ = this.createButton_('Reset view', () => {

            this.resetView(map);
        });
        controls.appendChild(this.resetBtn_);

        document.body.appendChild(controls);
        this.controlsEl_ = controls;
        this.updateControls_();
    }

    private createButton_(
        label: string,
        onClick: () => void,
    ): HTMLButtonElement {

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', (event) => {

            event.preventDefault();
            event.stopPropagation();
            onClick();
            btn.blur();
        });
        return btn;
    }

    private updateControls_(): void {

        if (!this.freezeBtn_ || !this.frustumBtn_ || !this.resetBtn_) return;

        this.freezeBtn_.textContent = this.active ? 'Unfreeze' : 'Freeze';
        this.frustumBtn_.textContent = this.drawFrustum
            ? 'Hide frustum'
            : 'Show frustum';
        this.frustumBtn_.disabled = !this.active;
        this.resetBtn_.disabled = !this.active;
    }

    private removeControlsIfIdle_(): void {

        if (this.active || this.controlsActive_) return;

        this.controlsEl_?.remove();
        this.controlsEl_ = null;
        this.freezeBtn_ = null;
        this.frustumBtn_ = null;
        this.resetBtn_ = null;
    }
}
