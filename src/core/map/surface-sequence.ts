
import MapStyle from '../map/style';
import MapSurface from '../map/surface';


var MapSurfaceSequence = function(this: any, map: any) {
    this.map = map;
};


MapSurfaceSequence.prototype.generateBoundLayerSequence = function() {

    if (this.map.style)
        throw Error('This legacy function should be called '
            + 'for map-config based maps only.');

    var view = this.map.getCurrentView();
    
    //zero bound layer filters
    /*var layers = this.map.boundLayers;
    for (var key in layers) {
        layers[key].shaderFilters = null;
    }*/

    let styleSources: Record<string, MapStyle.SourceSpecification> = {};

    // a stub to make the style spec compliant
    this.map.surfaces.forEach((surface: MapSurface) => {

        styleSources[surface.id] = { 'type': 'cartolina-surface', 'url': '' }
    });

    //surfaces
    for (let key in view.surfaces) {

        let styleTerrain: MapStyle.TerrainSpecification = { sources: [] }
        let styleLayers: MapStyle.LayerSpecification[] = [];

        let surfaceLayers = view.surfaces[key];
        let surface: MapSurface = this.map.getSurface(key);

        if (surface != null) {

            styleTerrain.sources.push(surface.id);

            for (let i = 0; i < surfaceLayers.length; i++) {
                let item = surfaceLayers[i];
                
                // implicit alpha
                let alpha: {
                    mode: string; value: number; illumination?: number[];
                } = { mode: 'constant', value: 1.0 };

                if (typeof item === 'string') {

                    let layer = this.map.getBoundLayerById(item);

                    if (layer) {

                        styleLayers.push({
                            type: 'diffuse-map',
                            source: layer.id,
                            blendMode: 'overlay',
                            alpha: alpha as MapStyle.Alpha
                        });
                    }

                } else {
                    let layer = this.map.getBoundLayerById(item['id']);
                    if (layer) {

                        // implicit type
                        let type = 'diffuse-map';

                        let type_ = item ['type' ];

                        if (type_ != null) {
                            console.assert([
                                'diffuse', 'diffuse-map',
                                'specular', 'specular-map',
                                'bump', 'bump-map'].includes(type_),
                                "unsupported BL type ('%s')", type_);

                            type = type_;
                        }

                        // diffuse maps
                        if (['diffuse', 'diffuse-map'].includes(type)) {

                            // implicit mode
                            let mode: MapStyle.BlendMode = 'overlay';
                       
                            // mode
                            let mode_ = item['mode'];
                            if (mode_ === 'normal') mode_ = 'overlay';

                            if (mode_ != null) {
                                console.assert(['overlay', 'normal','multiply'].includes(mode_),
                                    "unsupported BL param %s ('%s')", mode_);
                            
                                mode = mode_;
                            }

                            // alpha
                            let alpha_ = item['alpha'];
                        
                            if (typeof alpha_ === 'number' ) {

                                alpha.value = alpha_;
                            }
                                               
                            if (typeof alpha_ === 'object' ) {
                            
                                // alpha.value
                                if (alpha_['value'] != null) {
                                    console.assert(typeof alpha_['value'] === 'number');
                                    alpha.value = alpha_['value'];
                                }
                            
                                // alpha.mode
                                if (alpha_['mode'] != null) {
                                    console.assert(['constant', 'viewdep', 'view-dependent']
                                        .includes(alpha_['mode']));
                                    if (['viewdep', 'view-dependent'].includes
                                        (alpha_['mode'])) {
                                        alpha.mode = 'viewdep'; }
                                }
                            
                                // alpha.illumination
                                if (alpha_['illumination'] != null) {
                                    let illum_ = alpha_['illumination'];
                                
                                    console.assert(Array.isArray(illum_) && illum_.length === 2
                                        && typeof(illum_[0]) === 'number'
                                        && typeof(illum_[1]) === 'number');
                                
                                    alpha['illumination'] = [illum_[0], illum_[1]];
                                }
                            }

                            console.assert(! (alpha['mode'] === 'viewdep' &&
                                ! alpha['illumination']), "Illumination vector not " +
                                "defined for view dependent bound layer alpha (%o).",
                                alpha);
                        
                            let item2 = item['options'] || item;

                            let whitewash = item2['whitewash'] ?? 0.0;

                            // add to sequence
                            styleLayers.push({
                                type: 'diffuse-map',
                                source: layer.id,
                                blendMode: mode,
                                alpha: alpha as MapStyle.Alpha,
                                whitewash: whitewash
                            });

                        } // ["diffuse", "diffuse-map"].includes(type)

                        // specular maps
                        if (['specular', 'specular-map'].includes(type)) {

                            // alpha
                            let alpha: MapStyle.Alpha = 1.0;
                            let alpha_ = item['alpha'];

                            if (alpha_ != null) {
                                console.assert(typeof alpha_ === 'number');
                                alpha = alpha_;
                            }

                            styleLayers.push({
                                type: 'specular-map',
                                source: layer.id,
                                blendMode: 'overlay',
                                alpha: alpha
                            });

                        } // ["specular", "specular-map"].includes(type)

                        // bump maps
                        if (['bump', 'bump-map'].includes(type)) {

                            // alpha
                            let alpha: MapStyle.Alpha = 1.0;
                            let alpha_ = item['alpha'];

                            if (alpha_ != null) {
                                console.assert(typeof alpha_ === 'number');
                                alpha = alpha_;
                            }

                            styleLayers.push({
                                type: 'bump-map',
                                source: layer.id,
                                blendMode: 'overlay',
                                alpha: alpha
                            });


                        } // ["bump", "bump-map"].includes(type)
                    }
                }
            }
        }


        // the style stub for tile rendering, gneerated from view
        surface.style = {
            sources: styleSources, terrain: styleTerrain, layers: styleLayers
        }


    } // for (let key in view.surfaces


};


export default MapSurfaceSequence;
