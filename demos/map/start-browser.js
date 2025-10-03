
import { browser, utils } from "../../build/cartolina.esm.js";


function vtsParseUrlParams(initialParams_, url_) {
    var params_ = utils.getParamsFromUrl(url_ ? url_ : window.location.href);

    if (!initialParams_) {
        initialParams_ = params_;
    }
	
    //console.log(params_);
	
    if ('map' in params_) {
    
        document.title = document.title + " — " + initialParams_['map'];
        
        if (!params_['map'].endsWith('mapConfig.json')) {
            initialParams_['map'] = initialParams_['map'] + '/mapConfig.json';
        }
        
    } else {
    
        alert('Use query parameter "map" to specify the mapConfig location'); 
    }

    for (let key_ in params_) {
        switch(key_) {
            case 'rotate':
            case 'fixedHeight':
            case 'minViewExtent':
            case 'maxViewExtent':
            case 'mapTexelSizeFit':
            case 'mapSplitMargin':
            case 'mapLowresBackground':
            case 'mapMaxProcessingTime':
            case 'mapMaxGeodataProcessingTime':
            case 'mapMobileDeatailDegradation':
            case 'mapFeaturesPerSquareInch':
            case 'mapFeaturesReduceFactor':
            case 'mapNavSamplesPerViewExtent':  initialParams_[key_] = parseFloat(params_[key_]); break;
            case 'mapCache':
            case 'mapGPUCache':
            case 'mapMetatileCache':
            case 'mapMaxHiresLodLevels':
            case 'mapRefreshCycles':
            case 'mapDownloadThreads':
            case 'mapForceFrameTime':
            case 'mapForcePipeline':
            case 'mapFeatureGridCells':
            case 'mapGridUnderSurface':
            case 'mapGridTextureLevel':
            case 'mapHysteresisWait':
            case 'mapDMapSize':
            case 'mapDMapMode':
            case 'mapDMapCopyIntervalMs':
            case 'rendererAnisotropic':         initialParams_[key_] = parseInt(params_[key_], 10); break;
            case 'panAllowed':
            case 'rotationAllowed':
            case 'zoomAlowed':
            case 'noZoomWhilePan':
            case 'screenshot':
            case 'controlCompass':
            case 'controlZoom':
            case 'controlMeasure':
            case 'controlMeasureLite':
            case 'controlScale':
            case 'controlSpace':
            case 'controlSearch':
            case 'controlGithub':
            case 'controlLayers':
            case 'controlCredits':
            case 'controlFullscreen':
            case 'controlLoading':
            case 'controlSearchFilter':
            case 'constrainCamera':
            case 'bigScreenMargins':
            case 'timeNormalizedInertia':
            case 'legacyInertia':
            case 'mapMobileMode':
            case 'mapMobileModeAutodect':
            case 'mapIgnoreNavtiles':
            case 'mapFog':
            case 'mapFlatshade':
            case 'mapDisableCulling':
            case 'mapPreciseCulling':
            case 'mapAllowHires':
            case 'mapAllowLowres':
            case 'mapAllowSmartSwitching':
            case 'mapHeightLodBlend':
            case 'mapHeightNodeBlend':
            case 'mapBasicTileSequence':
            case 'mapXhrImageLoad':
            case 'mapStoreLoadStats':
            case 'mapPreciseBBoxTest':
            case 'mapPreciseDistanceTest':
            case 'mapHeightfiledWhenUnloaded':
            case 'mapForceMetatileV3':
            case 'mapVirtualSurfaces':
            case 'mapDegradeHorizon':
            case 'mapGridSurrogatez':
            case 'mapFeaturesSortByTop':
            case 'mapLogGeodataStyles':
            case 'mapSoftViewSwitch':
            case 'map16bitMeshes':
            case 'mapOnlyOneUVs':
            case 'mapIndexBuffers':
            case 'mapAsyncImageDecode':
            case 'mapSeparateLoader':
            case 'mapGeodataBinaryLoad':
            case 'mapPackLoaderEvents':
            case 'mapParseMeshInWorker':
            case 'mapPackGeodataEvents':
            case 'mapSortHysteresis':
            case 'mapBenevolentMargins':
            case 'mapSplitMeshes':
            case 'mapSplitLods':
            case 'mapTraverseToMeshNode':
            case 'mapCheckTextureSize':
            case 'separatePanAndZoom':
            case 'syncCursor':
            case 'walkMode':
            case 'rendererAntialiasing':
            case 'mapExposeFpsToWindow':
            case 'rendererAllowScreenshots':    initialParams_[key_] = (params_[key_] == 'true' || params_[key_] == '1'); break;
            case 'mapDegradeHorizonParams':
            case 'inertia':
            case 'sensitivity':
            case 'tiltConstrainThreshold':
            case 'mapFeaturesReduceParams':
            case 'mapLabelFreeMargins':
            case 'mapFeatureStickMode':
            case 'mapSplitSpace':
            case 'wheelInputLag':
            case 'pan':
                var value_ = decodeURIComponent(params_[key_]);
                value_ = value_.split(',');

                for (var i = 0, li = value_.length; i < li; i++) {
                    value_[i] = parseFloat(value_[i]);
                }

                initialParams_[key_] = value_;
                break;

            case 'pos':
                var value_ = decodeURIComponent(params_[key_]);
                value_ = value_.split(',');

                for (var i = 1, li = value_.length; i < li; i++) {
                    if (i != 3) {
                        value_[i] = parseFloat(value_[i]);
                    }
                }

                initialParams_[key_] = value_;
                break;

            case 'mapGridMode':
            case 'mapLoadMode':
            case 'mapGeodataLoadMode':
            case 'mapFeaturesReduceMode':
            case 'mapGridTextureLayer':
            case 'mapLanguage':
            case 'navigationMode':
            case 'controlSearchUrl':
            case 'controlSearchSrs':
            case 'controlSearchElement':
            case 'controlSearchValue':
            case 'geodata':
            case 'geojson':
            case 'geojsonStyle':
            case 'sync':
            case 'syncServer':
            case 'syncId':
            case 'debugBBox':
            case 'debugLBox':
            case 'debugNoEarth':
            case 'debugShader':
            case 'debugHeightmap':
            case 'debugRadar':
            case 'view':
                initialParams_[key_] = decodeURIComponent(params_[key_]);
                if (initialParams_[key_] === 'null') initialParams_[key_] = null;
                break;

            case 'useCredentials':
                vts['useCredentials'] = (params_[key_] == 'true' || params_[key_] == '1'); break;
        }
    }

    if (initialParams_['screenshot']) {   //tomas hack for backend
        initialParams_['controlLoading'] = false;
    }


    return initialParams_;
}

async function startBrowser() {

    var params_ = vtsParseUrlParams();
    
    // disfunctional search in Melowntech's vtsapi - workaround
    if (params_['controlSearchUrl'] == null) {
    
        params_['controlSearchUrl'] = 'https://nominatim.openstreetmap.org/search.php?q={value}&format=json&limit=20';
        params_['controlSearchFilter'] = false;
    }

    params_['jumpAllowed'] = true;
    params_['positionInUrl'] = true;
    
    let browser_ = browser('map-canvas', params_);
    //await browser_.ready;
}

export default startBrowser;