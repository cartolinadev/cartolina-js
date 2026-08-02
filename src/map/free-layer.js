import MapCredit from './credit';
import MapStylesheet from './stylesheet';
import MapSurfaceTree from './surface-tree';
import BBox from '../renderer/bbox';
import * as utils from '../utils/utils';
import {utilsUrl} from '../utils/url';


/**
 * A geodata free layer: a monolithic (`type: 'geodata'`) or tiled
 * (`type: 'geodata-tiles'`) vector overlay drawn above the terrain.
 *
 * @param map the owning legacy map
 * @param json free layer definition object, or a URL string to fetch it
 *   from
 * @param [baseUrl] base URL that resolves relative URLs inside an
 *   inline definition object; ignored for URL input, which derives
 *   its own base
 */
var MapFreeLayer = function(map, json, baseUrl) {
    this.map = map;
    this.id = null;
    this.type = 'basic';
    this.metaUrl = '';
    this.baseUrl = this.map.url.baseUrl;
    this.baseUrlSchema = this.map.url.baseUrlSchema;
    this.baseUrlOrigin = this.map.url.baseUrlOrigin;
    this.lodRange = [0,0];
    this.tileRange = [[0,0],[0,0]];
    this.ready = false;
    this.geodataProcessor = null;
    this.geodataCounter = 0;
    this.monoGeodata = null;
    this.monoGeodataView = null;
    this.monoGeodataCounter = -1;

    this.style = null;
    this.stylesheet = null;
    this.originalStyle = null;
    this.styleChanged = true;

    //each free layer has its own data tree
    this.tree = new MapSurfaceTree(this.map, true, this);

    if (typeof json === 'string') {
        this.jsonUrl = this.map.url.processUrl(json);
        this.baseUrl = utilsUrl.getBase(this.jsonUrl);
        this.baseUrlSchema = utilsUrl.getSchema(this.jsonUrl);
        this.baseUrlOrigin = utilsUrl.getOrigin(this.jsonUrl);

        var onLoaded = (function(data){
            this.parseJson(data);
            this.ready = true;

            // a fetched free layer is validated here, once its type
            // is known; an unsupported resolved type is removed
            // rather than reaching the style path as a phantom entry
            if (!this.geodata) {

                console.warn(`Free layer at "${this.jsonUrl}" resolved `
                    + `to unsupported type "${this.type}"; removing.`);

                for (var key in this.map.freeLayers) {
                    if (this.map.freeLayers[key] === this)
                        this.map.freeLayers[key] = null;
                }
            }

            this.map.refreshView();
        }).bind(this);

        var onError = (function(){ }).bind(this);

        utils.loadJSON(
            this.jsonUrl, onLoaded, onError, null,
            (utils.useCredentials
                ? (this.jsonUrl.indexOf(this.map.url.baseUrl) != -1)
                : false),
            this.map.core.xhrParams,
            this.map.core.transformRequest,
            'Source');
    } else {
        if (baseUrl) {
            this.baseUrl = utilsUrl.getBase(baseUrl);
            this.baseUrlSchema = utilsUrl.getSchema(baseUrl);
            this.baseUrlOrigin = utilsUrl.getOrigin(baseUrl);
        }

        this.parseJson(json);
        this.ready = true;
    }
};


MapFreeLayer.prototype.parseJson = function(json) {
    this.id = json['id'] || null;
    this.type = json['type'] || 'basic';
    this.metaUrl = this.processUrl(json['metaUrl'], '');
    this.geodataUrl = this.processUrl(json['geodataUrl'] || json['geodata'], '');
    this.lodRange = json['lodRange'] || [0,0];
    this.tileRange = json['tileRange'] || [[0,0],[0,0]];
    this.geodata = (this.type == 'geodata' || this.type == 'geodata-tiles');
    this.credits = json['credits'] || [];
    this.displaySize = json['displaySize'] || 1024;

    if (json['extents']) {
        var ll = json['extents']['ll'];
        var ur = json['extents']['ur'];
        this.extents = new BBox(ll[0], ll[1], ll[2], ur[0], ur[1], ur[2]);
    } else {
        this.extents = new BBox(0,0,0,1,1,1);
    }

    this.specificity = Math.pow(2, this.lodRange[1]) + this.lodRange[0];

    // a URL names an external credit document, which is not loaded here
    if (typeof this.credits === 'string') {
        this.credits = [];
    }

    // a credit table carries inline definitions to register; a plain
    // list only names credits the map already knows
    if (typeof this.credits === 'object'
        && !Array.isArray(this.credits)) {

        var credits = this.credits;
        this.credits = [];

        for (var key in credits){
            this.map.addCredit(key, new MapCredit(this.map, credits[key]));
            this.credits.push(key);
        }
    }

    //load stylesheet
    if (this.geodata) {
        var style = json['style'];

        this.originalStyle = style;

        if (style) {
            this.setStyle(style);
        }
    }

};


MapFreeLayer.prototype.kill = function() {
    if (this.geodataProcessor) {
        this.geodataProcessor.kill();
        this.geodataProcessor = null;
    }

    this.geodataUrl = null;
    this.style = null;
    this.stylesheet = null;
    this.originalStyle = null;
};


MapFreeLayer.prototype.processUrl = function(url, fallback) {
    if (!url) {
        return fallback;
    }

    if (typeof url !== 'string') {
        return url;
    }

    url = url.trim();

    if (url.indexOf('://') != -1) { //absolute
        return url;
    } else if (url.indexOf('//') == 0) {  //absolute without schema
        return this.baseUrlSchema + url;
    } else if (url.indexOf('/') == 0) {  //absolute without host
        return this.baseUrlOrigin + url;
    } else {  //relative
        return this.baseUrl + url;
    }
};


MapFreeLayer.prototype.setStyle = function(style) {
    if (this.style == style) {
        return;
    }

    var id = style;

    if (typeof id !== 'object') {
        id = this.processUrl(id, '');
    } else {
        id = JSON.stringify(id);
        id = utils.getHash(id);
        id = "#obj#" + id.toString(16);
    }

    this.stylesheet = this.map.getStylesheet(id);

    if (!this.stylesheet) {
        this.stylesheet = new MapStylesheet(this.map, id, style, this);
        this.map.addStylesheet(id, this.stylesheet);
    }

    this.style = style;
    this.styleChanged = true;
    this.geodataCounter++;

    this.map.markDirty();
};


MapFreeLayer.prototype.getMetaUrl = function(id, skipBaseUrl) {
    return this.map.url.makeUrl(this.metaUrl, {lod:id[0], ix:id[1], iy:id[2] }, null, skipBaseUrl);
};


MapFreeLayer.prototype.getGeodataUrl = function(id, navtileStr, skipBaseUrl) {
    return this.map.url.makeUrl(this.geodataUrl, {lod:id[0], ix:id[1], iy:id[2] }, navtileStr, skipBaseUrl);
};


MapFreeLayer.prototype.getMonoGeodataUrl = function(id, skipBaseUrl) {
    return this.map.url.makeUrl(this.geodataUrl, {}, null, skipBaseUrl);
};


export default MapFreeLayer;
