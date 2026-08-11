
import type Map from './legacy-map';
import type VerticalExaggeration from './vertical-exaggeration';
import type * as StyleSchema from './style-schema';
import * as math from '../utils/math';

/**
 * The celestial body definition authored in map configuration.
 *
 * This is a small immutable data holder for body metadata, the surface
 * color, and optional atmosphere defaults. It mirrors the legacy
 * `mapConfig.json` body object closely and exposes a deep-copied
 * plain-data snapshot via `getInfo()`.
 */
class MapBody {

    /**
     * Create a body definition from its map-config payload.
     *
     * @param _map owning map; currently unused but preserved to match the
     *             legacy construction path
     * @param json body definition from `mapConfig.json`
     */
    constructor(_map: Map, json: MapBody.Configuration) {

        this.class = json.class ?? '';
        this.comment = json.comment ?? '';
        this.parent = json.parent ?? '';

        // authored colors are 0-255 components; the runtime value is
        // normalized, matching the constant-layer colors in a style
        this.surfaceColor = json.surfaceColor
            ? json.surfaceColor.map((c) => c / 255) as math.vec3
            : [...MapBody.DefaultSurfaceColor];

        if (json.verticalExaggeration) {

            this.verticalExaggeration =
                structuredClone(json.verticalExaggeration);
        }

        if (json.atmosphere) {

            this.atmosphere =
                { ...MapBody.DefaultAtmosphere, ...json.atmosphere };
        }
    }

    /**
     * Return a deep-copied plain-data snapshot of the body definition.
     *
     * @returns serializable body information matching the legacy JS contract
     */
    getInfo(): MapBody.Info {

        return {
            class: this.class,
            comment: this.comment,
            parent: this.parent,
            surfaceColor: [...this.surfaceColor],

            verticalExaggeration: this.verticalExaggeration
                ? structuredClone(this.verticalExaggeration)
                : undefined,

            // the deep copy contract, copied from old js file
            atmosphere: this.atmosphere
                ? structuredClone(this.atmosphere)
                : undefined,
        };
    }

    /** Kind of body, e.g. `planet`, `moon`, `star`. Empty when unset. */
    class: string;

    /** Free-form description of the body. Empty when unset. */
    comment: string;

    /** Id of the body this one orbits. Empty for the root of the tree. */
    parent: string;

    /**
     * Color of the body's surface, normalized to 0-1 components. It shows
     * wherever no diffuse map covers the terrain.
     */
    surfaceColor: math.vec3;

    /**
     * Vertical-exaggeration ramps a style gets when it asks for
     * exaggeration without naming its own. Undefined for a body that
     * declares none.
     */
    verticalExaggeration?: VerticalExaggeration.Spec;

    /**
     * Atmosphere parameters, merged over `DefaultAtmosphere`. Undefined for
     * a body that declares no atmosphere.
     */
    atmosphere?: MapBody.Atmosphere;

} // class MapBody

// export classes

namespace MapBody {

    /** Surface color of a body that does not declare one. */
    export const DefaultSurfaceColor: math.vec3 = [0.9, 0.9, 0.8];

    export const DefaultAtmosphere = {
        thickness: 100000,
        thicknessQuantile: 1e-6,
        visibility: 100000,
        visibilityQuantile: 1e-2,
        colorGradientExponent: 0.3,
        colorHorizon: [0, 0, 0, 0] as math.vec4,
        colorZenith: [0, 0, 0, 0] as math.vec4
    };

    export type Atmosphere = typeof DefaultAtmosphere;

    type BaseInfo = {
        class: string;
        comment: string;
        parent: string;
        surfaceColor: math.vec3;
        verticalExaggeration?: VerticalExaggeration.Spec;
        atmosphere?: Atmosphere;
    };

    export type Info = BaseInfo;

    // every field is optional: the constructor substitutes defaults, and
    // body documents carry additional fields the parser ignores
    export type Configuration =
        Partial<Omit<BaseInfo, 'atmosphere' | 'surfaceColor'>> & {
            surfaceColor?: StyleSchema.Color3Spec;
            atmosphere?: Partial<Atmosphere>;
        };

} // namespace MapBody

export default MapBody;
