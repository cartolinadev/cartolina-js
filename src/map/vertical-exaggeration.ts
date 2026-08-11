/*
 * vertical-exaggeration.ts - scale terrain by elevation and map scale
 */

import type MapPosition from './position';
import type Renderer from '../renderer/renderer';
import type * as viewerConfig from '../viewer-config';
import * as math from '../utils/math';


/**
 * Vertical exaggeration of the terrain: authored map state that scales
 * model heights before anything is drawn.
 *
 * Two ramps compose, each defined by two pivots and clamped outside
 * them, and either may be absent. The elevation ramp's factor is linear
 * in height, so low ground and high ground can be exaggerated
 * differently. The scale ramp's factor is a power law in the map scale
 * denominator, so exaggeration grows as the camera pulls back. `apply`
 * runs the elevation ramp first and the scale ramp second; `unapply`
 * undoes them in the opposite order.
 *
 * The reference frame's body supplies the ramps a style gets when it
 * asks for exaggeration without naming its own; see `MapBody`.
 *
 * It sits on the map rather than the renderer because coordinate
 * conversion, camera height, tile bounding volumes, and the
 * atmosphere's solid radius all read it. `Renderer` forwards to it for
 * the legacy JavaScript call sites that still name it in the retired
 * `superelevation` vocabulary.
 */
class VerticalExaggeration {

    /**
     * @param renderer supplies the canvas size the scale denominator
     *                 needs
     * @param config   runtime configuration, read for `rendererCssDpi`
     */
    constructor(
        renderer: Renderer,
        config: Readonly<viewerConfig.ViewerConfig>,
    ) {

        this.renderer_ = renderer;
        this.config_ = config;
    }

    /**
     * Installs both ramps. A ramp omitted from `spec` is cleared.
     *
     * @param spec elevation and/or scale-denominator ramp pivots
     */
    set(spec: VerticalExaggeration.Spec): void {

        if (spec.elevationRamp) {

            const { min, max } = spec.elevationRamp;
            this.setElevationRamp([[min[0], max[0]], [min[1], max[1]]]);

        } else {

            delete this.elevationRamp_;
        }

        if (spec.scaleRamp) {

            const { min, max } = spec.scaleRamp;
            this.scaleRamp_ = VerticalExaggeration.makeScaleRamp(
                min[0], min[1], max[0], max[1]);

        } else {

            delete this.scaleRamp_;
        }

        this.enabled_ = true;
        this.counter_++;
    }

    /** Returns the ramps currently installed. */
    get(): VerticalExaggeration.Spec {

        const spec: VerticalExaggeration.Spec = {};

        if (this.elevationRamp_) {

            spec.elevationRamp = {
                min: [this.elevationRamp_[0], this.elevationRamp_[1]],
                max: [this.elevationRamp_[2], this.elevationRamp_[3]]
            };
        }

        if (this.scaleRamp_) {

            spec.scaleRamp = {
                min: [this.scaleRamp_.sd0, this.scaleRamp_.va0],
                max: [this.scaleRamp_.sd1, this.scaleRamp_.va1]
            };
        }

        return spec;
    }

    /**
     * Installs both ramps from the deprecated authored form.
     *
     * @deprecated Use `set` instead. Kept for the deprecated style
     *   vertical-exaggeration form.
     * @param definition the authored `heightRamp` / `viewExtentProgression`
     *   pair; a member omitted from it clears its ramp
     */
    setDeprecated(definition: VerticalExaggeration.DeprecatedSpec): void {

        // heightRamp
        if (definition.heightRamp && Array.isArray(definition.heightRamp)) {

            this.setElevationRamp(definition.heightRamp);

        } else {

            delete this.elevationRamp_;
        }

        // viewExtentProgression
        if (definition.viewExtentProgression
            && Array.isArray(definition.viewExtentProgression)) {

            this.setScaleRampFromProgression(
                definition.viewExtentProgression);

        } else {

            delete this.scaleRamp_;
        }

        this.enabled_ = true;
        this.counter_++;
    }

    /** Whether exaggeration applies at all. */
    get enabled(): boolean {

        return this.enabled_;
    }

    set enabled(state: boolean) {

        if (this.enabled_ != state) {
            this.enabled_ = state;
            this.counter_++;
        }
    }

    /**
     * Version stamp of the exaggeration configuration. Consumers cache
     * the value they last baked against (`tile.seCounter`,
     * `job.seCounter`) and re-derive their exaggeration-dependent data
     * when this has moved past their copy. It advances when the
     * settings change (enable/disable, ramp setup), not on camera
     * movement. The zoom-dependent scale factor is tracked separately,
     * per node, by `MapSurfaceTile.isMetanodeReady`.
     */
    get counter(): number {

        return this.counter_;
    }

    /** The installed scale ramp, or undefined when there is none. */
    get scaleRamp(): Readonly<ScaleRamp> | undefined {

        return this.scaleRamp_;
    }

    /**
     * @param position current map position, or a vertical extent value
     *   directly (the value normally sourced from `position.pos[8]`)
     * @returns a tuple of 7 numbers describing the vertical exaggeration.
     *   If the original ramp spec was [h1, h2, f1, f2], the returned
     *   value is something like:
     *   [h1, f1, h2, f2, h2-h1, f2-f1, 1.0 / (h2-h1)]
     */
    vaParams(position: MapPosition | number): ElevationRamp {

        // elevation ramp
        const retval: number[] = this.elevationRamp_
            ? this.elevationRamp_.slice()
            : [0, 1, 1000, 1, 1000, 0, 1.0 / 1000];

        // scale ramp
        if (this.scaleRamp_) {
            retval[1] *= this.scaleFactor(position);
            retval[3] *= this.scaleFactor(position);

            retval[5] = retval[3] - retval[1];
        }

        return retval as ElevationRamp;
    }

    /**
     * Exaggerates a height.
     *
     * @param height model height in metres
     * @param position current map position, or a vertical extent value
     */
    apply(height: number, position: MapPosition | number): number {

        // elevation ramp
        let retval = this.elevationRamp_
            ? this.applyElevationRamp(height) : height;

        // scale ramp
        if (this.scaleRamp_) retval *= this.scaleFactor(position);

        return retval;
    }

    /**
     * Reverses `apply`.
     *
     * @param height exaggerated height in metres
     * @param position current map position, or a vertical extent value
     */
    unapply(height: number, position: MapPosition | number): number {

        let retval = height;

        // `apply` applies the elevation ramp first and the scale ramp
        // second. The elevation ramp scales a height by a factor that
        // is itself linear in that height, so the transform is not
        // linear and the inverse composes back to the identity only
        // when it undoes the two in reverse.

        // scale ramp
        if (this.scaleRamp_) retval /= this.scaleFactor(position);

        // elevation ramp
        if (this.elevationRamp_)
            retval = this.unapplyElevationRamp(retval);

        return retval;
    }

    /**
     * The scale ramp's factor at the given position.
     *
     * @param position current map position, or a vertical extent value
     */
    scaleFactor(position: MapPosition | number): number {

        if (!this.scaleRamp_) return 1.0;

        const extent = typeof position === 'number'
            ? position : position.pos[8];
        const r = this.scaleRamp_;
        const sd = this.scaleDenominator(extent);
        const clamped = math.clamp(sd, r.sd0, r.sd1);
        return r.va0 * Math.pow(clamped / r.sd0, r.exponent);
    }

    /**
     * Return the current map scale denominator computed from the given
     * view extent and the current canvas dimensions.
     *
     * @param extent - view extent in map units (metres)
     */
    scaleDenominator(extent: number): number {

        const cssDpi = (this.config_.rendererCssDpi as number | undefined)
            ?? 96;
        const height = this.renderer_.gpu.canvasRenderTarget.apparentSize[1];
        return extent / (height / cssDpi * 0.0254);
    }

    /**
     * @deprecated Use `set` instead.
     *   Converts a legacy `viewExtentProgression` spec to a `ScaleRamp`
     *   using a canonical canvas height of 1113 CSS px for a 1:1
     *   behavioural match.
     */
    private setScaleRampFromProgression(progression: ProgressionDef): void {

        if (!(progression && progression[0] && progression[1] && progression[2]
                && progression[3] && progression[4]))
            throw new Error("Unsupported vertical exaggeration option.");

        const cssDpi = (this.config_.rendererCssDpi as number | undefined)
            ?? 96;
        const canonicalH = 1113; // CSS px — matches legacy tuning baseline
        const toSd = (ext: number) => ext / (canonicalH / cssDpi * 0.0254);

        const baseValue  = progression[0];
        const baseExtent = progression[1];
        const exponent   = Math.log2(progression[2]);
        const min        = progression[3];
        const max        = progression[4];

        // Invert the old formula: extent at which old VA equals `va`
        const extfromva = (va: number) =>
            Math.pow(va / baseValue, 1 / exponent) * baseExtent;

        this.scaleRamp_ = VerticalExaggeration.makeScaleRamp(
            toSd(extfromva(min)), min,
            toSd(extfromva(max)), max
        );
    }

    private setElevationRamp(ramp: ElevationRampDef): void {

        if (!(ramp && ramp[0] && ramp[1]
                && ramp[0].length >= 2 && ramp[1].length >= 2))
            throw new Error("Unsupported vertical exaggeration option.");

        let h1 = ramp[0][0]; let f1 = ramp[1][0];
        let h2 = ramp[0][1]; let f2 = ramp[1][1];

        if (h1 == h2) h2 = h1 + 1;
        this.elevationRamp_ = [h1, f1, h2, f2, h2-h1, f2-f1, 1.0 / (h2-h1)];
    }

    private applyElevationRamp(height: number): number {

        let se = this.elevationRamp_, h = height;
        if (!se) throw new Error('No elevation ramp defined.');

        // 0 - h1, 1 - f1, 2 - h2, 3 - f2, 4 - dh, 5 - df, 6 - invdh
        if (h < se[0]) h = se[0];
        if (h > se[2]) h = se[2];

        return height * (se[1] + ((h - se[0]) * se[6]) * se[5]);
    }

    private unapplyElevationRamp(height: number): number {

        let se = this.elevationRamp_, s = height;
        if (!se) throw new Error('No elevation ramp defined.');

        // 0 - h1, 1 - f1, 2 - h2, 3 - f2, 4 - dh, 5 - df, 6 - invdh
        if (se[1] == se[3]) return s / se[1];
        if (s <= se[0] * se[1]) return s / se[1];
        if (s >= se[2] * se[3]) return s / se[3];


        var h1 = se[0], f1 = se[1], h2 = se[2], f2 = se[3];

        // and f1!=f2 and h1!=h2

        const discriminant =
            -2*f2*(f1*h1*h2 + 2*h1*s - 2*h2*s)
            + f1*(f1*h2*h2 + 4*h1*s - 4*h2*s)
            + f2*f2*h1*h1;

        return -(Math.sqrt(discriminant) - f1*h2 + f2*h1)
            / (2*(f1 - f2));
    }

    /** Build a ScaleRamp from two pivot pairs, precomputing the exponent. */
    private static makeScaleRamp(
        sd0: number, va0: number,
        sd1: number, va1: number
    ): ScaleRamp {

        return {
            sd0, va0, sd1, va1,
            exponent: Math.log(va1 / va0) / Math.log(sd1 / sd0)
        };
    }

    private enabled_ = false;
    private counter_ = 0;
    private elevationRamp_?: ElevationRamp; // 7 elements
    private scaleRamp_?: ScaleRamp;

    private readonly renderer_: Renderer;
    private readonly config_: Readonly<viewerConfig.ViewerConfig>;

} // class VerticalExaggeration


type ScaleRamp = {

    // scale denominator at lower pivot
    sd0: number;

    // VA factor at lower pivot
    va0: number;

    // scale denominator at upper pivot
    sd1: number;

    // VA factor at upper pivot
    va1: number;

    // log(va1/va0)/log(sd1/sd0), precomputed
    exponent: number;
}

type ElevationRamp =
    [number, number, number, number, number, number, number];

/** @deprecated Part of the deprecated authored form. */
type ProgressionDef = [number, number, number, number, number];

/** @deprecated Part of the deprecated authored form. */
type ElevationRampDef = [[number, number], [number, number]];


namespace VerticalExaggeration {

    export type Spec = {
        elevationRamp?: {
            min: [number, number];
            max: [number, number];
        };
        scaleRamp?: {
            min: [number, number];
            max: [number, number];
        };
    }

    /**
     * @deprecated Use {@link Spec} instead.
     *   Kept for the deprecated style vertical-exaggeration form.
     */
    export type DeprecatedSpec = {
        heightRamp?: ElevationRampDef;
        viewExtentProgression?: ProgressionDef;
    }

} // namespace VerticalExaggeration

export default VerticalExaggeration;
