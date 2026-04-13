
import type Map from './map';
import * as math from '../utils/math';

/**
 * The celestial body definition authored in map configuration.
 *
 * This is a small immutable data holder for body metadata and optional
 * atmosphere defaults. It mirrors the legacy `mapConfig.json` body object
 * closely and exposes a deep-copied plain-data snapshot via `getInfo()`.
 */
class MapBody {

    class = '';
    comment = '';
    parent = '';
    atmosphere?: MapBody.Atmosphere;

    /**
     * Create a body definition from its map-config payload.
     *
     * @param _map owning map; currently unused but preserved to match the
     *             legacy construction path
     * @param json body definition from `mapConfig.json`
     */
    constructor(_map: Map, json: MapBody.Configuration) {

        this.parse(json);
    }

    private parse(json: MapBody.Configuration): void {

        this.class = json.class ?? '';
        this.comment = json.comment ?? '';
        this.parent = json.parent ?? '';

        if (json.atmosphere) {

            this.atmosphere =
                { ...MapBody.DefaultAtmosphere, ...json.atmosphere };
        }
    };

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

            // the deep copy contract, copied from old js file
            atmosphere: this.atmosphere
                ? structuredClone(this.atmosphere)
                : undefined,
        };
    }

} // class MapBody

// export classes

namespace MapBody {

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
        atmosphere?: Atmosphere;
    };

    export type Info = BaseInfo;

    export type Configuration = Omit<BaseInfo, 'atmosphere'> & {
        atmosphere?: Partial<Atmosphere>;
    };

} // namespace MapBody

export default MapBody;
