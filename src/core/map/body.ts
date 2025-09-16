
import * as math from '../utils/math';

/**
 * The celestial body, as defined by map configuration
 */

class MapBody {

    class!: any;
    comment!: any;
    parent!: any;
    atmosphere?: MapBody.Atmosphere;


    constructor (map, json) {
    //this.map = map;
    //this.id = json["id"] || null;
        this.parse(json);
    };


    private parse(json: any) {

        this.class = json['class'] || '';
        this.comment = json['comment'] || '';
        this.parent = json['parent'] || '';

        if (json['atmosphere']) {

            this.atmosphere =
                {...MapBody.DefaultAtmosphere, ...json['atmosphere']};
        }
    };


    getInfo() {

        return {
            'class' : this.class,
            'comment' : this.comment,
            'parent' : this.parent,
            'atmosphere' : JSON.parse(JSON.stringify(this.atmosphere)),
        };
    };

}; // class MapBody

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
    }

    export type Atmosphere = typeof DefaultAtmosphere;

} // namespace MapBody

export default MapBody;
