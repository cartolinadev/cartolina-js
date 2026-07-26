
import {vec3, mat4} from '../utils/matrix';
import * as math from '../utils/math';
import GeographicLib from 'geographiclib';


var MapMeasure = function(map) {
    this.map = map;
    this.config = map.config;
    this.convert = map.convert;
    this.getPhysicalSrs = this.map.getPhysicalSrs();
    this.navigationSrs = this.map.getNavigationSrs();
    this.publicSrs = this.map.getPublicSrs();
    this.navigationSrsInfo = this.navigationSrs.getSrsInfo();
    this.isProjected = this.navigationSrs.isProjected();

    var res = this.getSpatialDivisionNodeDepths();

    this.minDivisionNodeDepth = res[0];
    this.maxDivisionNodeDepth = res[1];
};


/**
 * Returns the surface trees terrain queries should walk for this
 * frame, ordered back-to-front (front tree at the last index).
 *
 * The answer is the typed Map's per-surface helper trees, which are
 * populated by the same descent that renders the frame. The query
 * iterates this list front-to-back and stops on the first tree whose
 * trace yields data.
 *
 * Returns an empty array when no surface is in view; callers use that
 * to return their not-found result.
 */
MapMeasure.prototype.queryTrees_ = function() {

    return this.map.outerMap.surfaceTreesForQuery();
};

/**
 * Tests whether a height answer lies inside the claiming metanode's
 * geometry bbox, inflated by a quarter of its size. A navtile pane
 * spans the whole tile even when the surface covers only part of it,
 * and holds filler outside the covered part. The bbox is the only
 * per-node coverage information in pre-v6 data. Metanodes without a
 * bbox (v5+) pass.
 *
 * @param {Array<number>} coords navigation-space [lon, lat]
 * @param {number} height the candidate height answer
 * @param {Object} metanode the claiming metanode
 * @returns {boolean}
 */
MapMeasure.prototype.isHeightWithinNodeBounds_ = function(
    coords, height, metanode) {
    var bbox = metanode.bbox;

    if (!bbox) {
        return true;
    }

    var point = this.convert.convertCoords(
        [coords[0], coords[1], height], 'navigation', 'physical');

    var margin = bbox.maxSize * 0.25;

    return point[0] >= bbox.min[0] - margin &&
           point[0] <= bbox.max[0] + margin &&
           point[1] >= bbox.min[1] - margin &&
           point[1] <= bbox.max[1] + margin &&
           point[2] >= bbox.min[2] - margin &&
           point[2] <= bbox.max[2] + margin;
};


/**
 * Returns the navigation-space centre a node-only height answer is
 * derived from: the metanode disk position (v5+), the geometry bbox
 * centre (older versions, when the bbox is reasonably small), or the
 * query coordinate's own height as a last resort.
 *
 * @param {Object} metanode
 * @param {Array<number>} nodeCoords division-node inner coordinates
 * @returns {Array<number>} navigation-space [lon, lat, height]
 */
MapMeasure.prototype.getNodeOnlyCenter_ = function(metanode, nodeCoords) {
    if (metanode.metatile.version >= 5) {
        return this.convert.convertCoords(
            metanode.diskPos, 'physical', 'navigation');
    }

    // use the bbox only when it is reasonably small
    if (metanode.bbox.maxSize < 8000) {
        return this.convert.convertCoords(
            metanode.bbox.center(), 'physical', 'navigation');
    }

    return [0, 0, nodeCoords[2]];
};


MapMeasure.prototype.getSurfaceHeight = function(coords, lod, storeStats, node, nodeCoords, coordsArray, useNodeOnly) {
    // The candidates are the per-surface helper trees from the
    // recursive traversal; the ranked loop below picks the answer.
    // Only when every tree comes up empty do we return the not-found
    // result.
    var trees = this.queryTrees_();

    if (trees.length === 0) {
        return [0, true, true, null, null, null];
    }

    if (!node) {
        var result = this.getSpatialDivisionNode(coords);
        node = result[0];
        nodeCoords = result[1];
    }

    if (!this.config.mapHeightLodBlend) {
        lod = Math.floor(lod);
    }

    if (useNodeOnly || this.config.mapIgnoreNavtiles) {
        return this.getSurfaceHeightNodeOnly(null, lod + 8, storeStats, lod, null, node, nodeCoords, coordsArray);
    }

    if (node != null && lod !== null) {

        var params, metanode = null, i, li, height;

        // Set when a consulted tree could not answer conclusively (a
        // metanode or navtile texture is still loading). The result is
        // then marked provisional so callers query again.
        var anyWaiting = false;

        // Navigation-space query coordinate for the bbox test.
        var navCoords = coords || node.getOuterCoords(nodeCoords);

        // Every tree is consulted and the best navtile answer wins.
        // All surfaces model the same terrain, so navtiles at equal
        // lods agree — but a much finer navtile carries detail the
        // requested lod is meant to smooth away, and camera-height
        // navigation then jitters. Ranking:
        //
        // 1. sample lod closest to the requested lod,
        // 2. answer inside the claiming node's geometry bbox (the
        //    only coverage signal in pre-v6 data; failing answers
        //    are a last resort),
        // 3. stack order, front-most first.
        //
        // Trees with geometry but no navtile feed the node-only
        // fallback below, used when no navtile answers.
        var best = null;
        var bestLodDistance = 0;
        var outOfBounds = null;
        var geometryOnly = null;

        // Iterate trees front-to-back (last index = front surface).
        for (var t = trees.length - 1; t >= 0; t--) {

            var tree = trees[t];
            var root = tree.findSurfaceTile(node.id);

            var extents = {
                ll : node.extents.ll.slice(),
                ur : node.extents.ur.slice()
            };
            params = {
                coords : nodeCoords,
                desiredLod : Math.ceil(lod),
                extents : extents,
                metanode : null,
                heightMap : null,
                heightMapExtents : null,
                traceHeight : true,
                waitingForNode : false,
                finalNode : false,
                sawGeometry : false
            };

            tree.traceHeight(root, params, false);

            anyWaiting = anyWaiting || params.waitingForNode;
            metanode = params.metanode;

            if (!params.heightMap) {
                if (metanode && params.sawGeometry && !geometryOnly) {
                    geometryOnly = params;
                }
                continue;
            }

            height = this.getHeightmapValue(
                nodeCoords, metanode, params);

            if (!this.isHeightWithinNodeBounds_(
                    navCoords, height, metanode)) {
                if (!outOfBounds) {
                    outOfBounds = params;
                }
                continue;
            }

            var lodDistance = Math.abs(
                metanode.id[0] - params.desiredLod);

            // On equal distance prefer the coarser sample: coarser
            // is smoother, finer jitters.
            if (!best || lodDistance < bestLodDistance
                    || (lodDistance === bestLodDistance
                        && metanode.id[0] < best.metanode.id[0])) {
                best = params;
                bestLodDistance = lodDistance;
            }
        }

        if (best) {
            params = best;
            metanode = params.metanode;
        } else if (geometryOnly) {
            params = geometryOnly;
            metanode = params.metanode;
        } else if (outOfBounds) {
            params = outOfBounds;
            metanode = params.metanode;
        } else {
            metanode = null;
        }

        if (params.heightMap) {
            if (storeStats) {
                var stats = this.map.stats;
                stats.heightClass = 2;
                stats.heightLod = lod;
                stats.heightNode = metanode.id[0];                        
            }
            
            var res = metanode.id[0] >= Math.ceil(lod);
            var arrayRes, height1, height2;
           
            if (this.config.mapHeightLodBlend && metanode.id[0] > 0 &&
                params.parent && params.parent.heightMap && lod <= metanode.id[0]) {
                height1 = this.getHeightmapValue(nodeCoords, params.parent.metanode, params.parent);  
                height2 = this.getHeightmapValue(nodeCoords, metanode, params);  
                var factor = lod - Math.floor(lod);
                height = height1 + (height2 - height1) * factor;

                if (coordsArray) {
                    arrayRes = new Array(coordsArray.length);
                    
                    for (i = 0, li = coordsArray.length; i < li; i++) {
                        var nodeCoords2 = coordsArray[i];//node.getInnerCoords(coordsArray[i]);
                        height1 = this.getHeightmapValue(nodeCoords2, params.parent.metanode, params.parent);  
                        height2 = this.getHeightmapValue(nodeCoords2, metanode, params);  

                        arrayRes[i] = [height1 + (height2 - height1) * factor, res, true];
                    }
                }
                
                //console.log("lod: " + lod + " h1: " + height1 + " h2: " + height2 + " h: " + height);  
            } else {
                height = this.getHeightmapValue(nodeCoords, metanode, params);  

                if (coordsArray) {
                    arrayRes = new Array(coordsArray.length);
                    
                    for (i = 0, li = coordsArray.length; i < li; i++) {
                        height2 = this.getHeightmapValue(coordsArray[i], metanode, params);  

                        arrayRes[i] = [height2, res, true];
                    }
                }
            }

            return [height, res, !anyWaiting, null, null, arrayRes];

        } else if (metanode /*&& metanode.id[0] == lod && !metanode.hasNavtile()*/){
            res = this.getSurfaceHeightNodeOnly(coords, lod + 8, storeStats, lod, null, node, nodeCoords, coordsArray);

            //console.log("lod2: " + lod + " h: " + height[0]);
            //return [res[0], res[1], true, null, null, res[5]];

            return [res[0], res[1], res[2] && !anyWaiting, null, null, res[5]];
        }

        /*
        if (metanode != null) {
            var height = metanode.minHeight + (metanode.maxHeight - metanode.minHeight) * 0.5;
            return [height, metanode.id[0] >= lod, true];
        }*/
    }

    return [0, false, false, null, null, null];
};


MapMeasure.prototype.getSurfaceHeightNodeOnly = function(coords, lod, storeStats, statsLod, deltaSample, node, nodeCoords, coordsArray) {
    var arrayRes, height, stats = this.map.stats;

    var trees = this.queryTrees_();

    if (trees.length === 0) {
        return [0, true, true, null, null, null];
    }
    
    if (!deltaSample) {
        if (!node) {
            var result = this.getSpatialDivisionNode(coords);
            node = result[0];
            nodeCoords = result[1];
        }
        
        if (coordsArray) {
            arrayRes = new Array(coordsArray.length);
            
            for (var i = 0, li = coordsArray.length; i < li; i++) {
                arrayRes[i] = this.getSurfaceHeightNodeOnly(null, lod, storeStats, statsLod, deltaSample, node, coordsArray[i]);
            }
        }
        
    } else {
        node = deltaSample[0];
        nodeCoords = deltaSample[1];
    }

    if (!this.config.mapHeightLodBlend) {
        lod = Math.floor(lod);
    }

    if (!deltaSample && this.config.mapHeightNodeBlend) {
        var res1 = this.getSurfaceHeightNodeOnly(null, lod, storeStats, statsLod, [node, [nodeCoords[0], nodeCoords[1], nodeCoords[2]]]);
        
        if (res1[2]) {
            var sx = res1[3].ur[0] - res1[3].ll[0];
            var sy = res1[3].ur[1] - res1[3].ll[1];
            
            var fx = (nodeCoords[0] - res1[3].ll[0]) / sx;
            var fy = (nodeCoords[1] - res1[3].ll[1]) / sy;
            
            /*
            var c2 = node.getOuterCoords([nodeCoords[0] + sx, nodeCoords[1], nodeCoords[2]]);
            var c3 = node.getOuterCoords([nodeCoords[0], nodeCoords[1] + sy, nodeCoords[2]]);
            var c4 = node.getOuterCoords([nodeCoords[0] + sx, nodeCoords[1] + sy, nodeCoords[2]]);
    
            var res2 = this.getSurfaceHeightNodeOnly(c2, lod, storeStats, statsLod, true);
            var res3 = this.getSurfaceHeightNodeOnly(c3, lod, storeStats, statsLod, true);
            var res4 = this.getSurfaceHeightNodeOnly(c4, lod, storeStats, statsLod, true);
            */
            
            var res2 = this.getSurfaceHeightNodeOnly(null, lod, storeStats, statsLod, [node, [nodeCoords[0] + sx, nodeCoords[1], nodeCoords[2]]]);
            var res3 = this.getSurfaceHeightNodeOnly(null, lod, storeStats, statsLod, [node, [nodeCoords[0], nodeCoords[1] + sy, nodeCoords[2]]]);
            var res4 = this.getSurfaceHeightNodeOnly(null, lod, storeStats, statsLod, [node, [nodeCoords[0] + sx, nodeCoords[1] + sy, nodeCoords[2]]]);

            var w0 = (res1[0] + (res2[0] - res1[0])*fx);
            var w1 = (res3[0] + (res4[0] - res3[0])*fx);
            height = (w0 + (w1 - w0)*fy);
            
            //console.log("h: " + height + "fx: " + fx + "fy: " + fy + "s1234: " + res1[0] + " "  + res2[0] + " "  + res3[0] + " "  + res4[0]);            
            /*
            if (res1[4] && res2[4] && res3[4] && res4[4]){
                console.log("h: " + height + "fx: " + fx + "fy: " + fy + "s1234: " + JSON.stringify(res1[4].id) + " "  + JSON.stringify(res2[4].id) + " "  + JSON.stringify(res3[4].id) + " "  + JSON.stringify(res4[4].id));            
            }*/

            return [height, res1[1], res1[2], res1[3], null, arrayRes];                
        } else {
            return [res1[0], res1[1], res1[2], res1[3], null, arrayRes];                
        }
        //convert new coords to nav coords
        //blend values
    }

    if (node != null && lod !== null) {

        var params, metanode = null, center, center2;

        // Set when a consulted tree could not answer conclusively; the
        // result is then marked provisional so callers query again.
        var anyWaiting = false;

        // Front-most claim that failed the bbox test, used when no
        // tree passes it.
        var fallbackParams = null;
        var fallbackCenter = null;

        // Navigation-space query coordinate for the bbox test. Delta
        // samples pass division-node inner coordinates only.
        var navCoords = coords || node.getOuterCoords(nodeCoords);

        // Iterate trees front-to-back; the first tree whose traced
        // path carries geometry wins. For single-surface maps this is
        // a single iteration.
        for (var t = trees.length - 1; t >= 0; t--) {

            var tree = trees[t];
            var root = tree.findSurfaceTile(node.id);

            var extents = {
                ll : node.extents.ll.slice(),
                ur : node.extents.ur.slice()
            };
            params = {
                coords : nodeCoords,
                desiredLod : Math.ceil(lod),
                extents : extents,
                metanode : null,
                heightMap : null,
                heightMapExtents : null,
                traceHeight : true,
                waitingForNode : false,
                finalNode : false,
                sawGeometry : false
            };

            tree.traceHeight(root, params, true);

            metanode = params.metanode;

            // A tree claims only when its traced path carries
            // geometry and the answer lies inside the claiming
            // node's bbox; a structural path has no terrain here, and
            // a node whose geometry sits elsewhere in the tile is no
            // evidence for this coordinate either.
            if (metanode != null && params.sawGeometry) {
                center = this.getNodeOnlyCenter_(metanode, nodeCoords);

                if (this.isHeightWithinNodeBounds_(
                        navCoords, center[2], metanode)) {
                    break;
                }

                if (!fallbackParams) {
                    fallbackParams = params;
                    fallbackCenter = center;
                }
            }

            anyWaiting = anyWaiting || params.waitingForNode;
            metanode = null;
        }

        // No claim passed the bbox test; answer from the front-most
        // claim anyway so sparse data still resolves.
        if (metanode == null && fallbackParams) {
            params = fallbackParams;
            metanode = params.metanode;
            center = fallbackCenter;
        }

        if (metanode != null) { // && metanode.id[0] == lod){

            //console.log("lod2: " + lod + " nodelod: " + metanode.id[0] + " h: " + center[2]/1.55);

            if (storeStats) {
                stats.heightClass = 1;
                stats.heightLod = statsLod;
                stats.heightNode = metanode.id[0];
            }

            // reached: the traced node is fine enough for the request
            // (or the tree has nothing finer). settled: the answer can
            // no longer improve — nothing along the claiming path and
            // no consulted tree is still loading.
            var reached = metanode.id[0] >= Math.floor(lod)
                || params.finalNode;
            var settled = (!params.waitingForNode || reached)
                && !anyWaiting;

            if (this.config.mapHeightLodBlend && metanode.id[0] > 0 &&
                params.parent && params.parent.metanode) {

                center2 = this.getNodeOnlyCenter_(
                    params.parent.metanode, nodeCoords);

                var factor = lod - Math.floor(lod);
                height = center[2] + (center2[2] - center[2]) * factor;
               
                //extetnts = params.extents;
                //return [height, true, true, params.extents, metanode, arrayRes];

                return [height, reached, settled,
                        params.extents, metanode, arrayRes];

                //console.log("lod: " + lod + " h1: " + center[2] +
                //    " h2: " + center2[2] + " h: " + height);
            } else {
                return [center[2], reached, settled,
                        params.extents, metanode, arrayRes];

                //return [center[2], true, true, params.extents, metanode, arrayRes];
            }
        }

        /*
        if (metanode != null) {
            var height = metanode.minHeight + (metanode.maxHeight - metanode.minHeight) * 0.5;
            return [height, metanode.id[0] >= lod, true];
        }*/
    }

    //coords
    //console.log("lod3: " + lod + " h: 0");  

    if (storeStats) {
        stats.heightClass = 0;
        stats.heightLod = statsLod;
        stats.heightNode = 0;                        
    }


    return [0, false, false, null, null, arrayRes];
};


MapMeasure.prototype.getHeightmapValue = function(coords, node, params) {
    var heightMap = params.heightMap;
    var data = heightMap.getImageData();
    var dataExtents = heightMap.getImageExtents();
    var mapExtents = params.heightMapExtents;

    //relative tile coords
    var x = coords[0] - mapExtents.ll[0];
    //var y = nodeCoords[1] - mapExtents.ll[1];
    var y = mapExtents.ur[1] - coords[1];

    var maxX = (dataExtents[0]-1);
    var maxY = (dataExtents[1]-1);
    
    //data coords
    x = (maxX) * (x / (mapExtents.ur[0] - mapExtents.ll[0]));
    y = (maxY) * (y / (mapExtents.ur[1] - mapExtents.ll[1]));

    if (x < 0) { x = 0; }
    if (y < 0) { y = 0; }
    if (x > maxX) { x = maxX; }
    if (y > maxY) { y = maxY; }

    var ix = Math.floor(x);
    var iy = Math.floor(y);
    var fx = x - ix;
    var fy = y - iy;

    var index = iy * dataExtents[0];
    var index2 = (iy == maxY) ? index : index + dataExtents[0];
    var ix2 = (ix == maxX) ? ix : ix + 1; 
    var h00 = data[(index + ix)*4];
    var h01 = data[(index + ix2)*4];
    var h10 = data[(index2 + ix)*4];
    var h11 = data[(index2 + ix2)*4];
    var w0 = (h00 + (h01 - h00)*fx);
    var w1 = (h10 + (h11 - h10)*fx);
    var height = (w0 + (w1 - w0)*fy);

    height = node.minHeight + (node.maxHeight - node.minHeight) * (height/255);
    
    return height;
};


MapMeasure.prototype.getSpatialDivisionNode = function(coords) {
    var nodes = this.map.referenceFrame.getSpatialDivisionNodes();

    var bestNode = null;
    var bestLod = -1;
    var bestCoords = [0,0];

    for (var i = 0, li = nodes.length; i < li; i++) {
        var node = nodes[i];
        var nodeCoords = node.getInnerCoords(coords);
        var extents = node.extents;

        if (nodeCoords[0] >= extents.ll[0] && nodeCoords[0] <= extents.ur[0] &&
            nodeCoords[1] >= extents.ll[1] && nodeCoords[1] <= extents.ur[1]) {

            if (node.id[0] > bestLod) {
                bestNode = node;
                bestLod = node.id[0];
                bestCoords = nodeCoords;
            }
        }
    }

    return [bestNode, bestCoords];
};


MapMeasure.prototype.getSpatialDivisionNodeAndExtents = function(id) {
    var nodes = this.map.referenceFrame.getSpatialDivisionNodes();

    var bestNode = null;
    //var bestLod = -1;
    var bestNodeCoords = [0,0], shift;
    //var bestExtents = {ll:[0,0], ur:[1,1]};

    for (var i = 0, li = nodes.length; i < li; i++) {
        var node = nodes[i];
        
        //has division node this tile node 
        //var shift = node.id[0] - this.lodRange[0];
        shift = id[0] - node.id[0];

        if (shift >= 0) {
            var x = id[1] >> shift;
            var y = id[2] >> shift;
            
            if (node.id[1] == x && node.id[2] == y) {
                bestNode = node;
                //bestLod = node.id[0];
                //bestExtents = node.extents;
                bestNodeCoords = [node.id[1] << shift, node.id[2] << shift];                
            }
        }
    }
    
    if (!bestNode) {
        return null;
    }
    
    shift = id[0] - bestNode.id[0];
    
    var factor = 1.0 / Math.pow(2, shift);
    var ur = bestNode.extents.ur;
    var ll = bestNode.extents.ll;
    
    // extents use ll/ur corners, but tile ids use a top-left grid (y grows downward)
    
    var dx = (ur[0] - ll[0]) * factor; 
    var dy = (ll[1] - ur[1]) * factor;
    
    var nx = id[1] - bestNodeCoords[0];
    var ny = id[2] - bestNodeCoords[1];

    return [bestNode, [[ll[0] + dx * nx, ur[1] + dy * ny], [ll[0] + dx * (nx+1), ur[1] + dy * (ny+1)] ]];
};


MapMeasure.prototype.getSpatialDivisionNodeFromId = function(id) {
    var shift = id[0] - this.maxDivisionNodeDepth;
    var nx = id[1] >> shift;
    var ny = id[2] >> shift;
    
    return this.map.referenceFrame.nodesMap['' + this.maxDivisionNodeDepth + '.'  + nx + '.' + ny];
};


MapMeasure.prototype.getSpatialDivisionNodeAndExtents2 = function(id, res, divisionNode) {
    if (!divisionNode) {
        return [null, 0,0,0,0];
    }
    
    var shift = id[0] - divisionNode.id[0];
    var factor = 1.0 / Math.pow(2, shift);
    var ur = divisionNode.extents.ur;
    var ll = divisionNode.extents.ll;
    
    // extents use ll/ur corners, but tile ids use a top-left grid (y grows downward)
    
    var dx = (ur[0] - ll[0]) * factor; 
    var dy = (ll[1] - ur[1]) * factor;
    
    var nx = id[1] - (divisionNode.id[1] << shift);
    var ny = id[2] - (divisionNode.id[2] << shift);
    
    res[0] = divisionNode;
    res[1] = ll[0] + dx * nx;
    res[2] = ur[1] + dy * ny;
    res[3] = ll[0] + dx * (nx+1);
    res[4] = ur[1] + dy * (ny+1);
};


/**
 * @param {[number, number, number]} id tile id as [lod, x, y]
 * @param {number=} height physical-corner sampling height
 * @returns {import('../types').NodeInformation | null}
 */
MapMeasure.prototype.getNodeInformation = function(id, height) {
    if (!id || id.length < 3) {
        return null;
    }

    height = (height == null) ? 0 : height;
    const res = this.getSpatialDivisionNodeAndExtents(id);

    if (!res || !res[0]) {
        return null;
    }

    const divisionNode = res[0];
    const ll = [res[1][0][0], res[1][1][1]];
    const ur = [res[1][1][0], res[1][0][1]];

    const physicalCorners = {
        ul : divisionNode.getPhysicalCoords([ll[0], ur[1], height], true),
        ur : divisionNode.getPhysicalCoords([ur[0], ur[1], height], true),
        lr : divisionNode.getPhysicalCoords([ur[0], ll[1], height], true),
        ll : divisionNode.getPhysicalCoords([ll[0], ll[1], height], true)
    };

    const upLeft = vec3.subtract(physicalCorners.ul, physicalCorners.ll, []);
    const upRight = vec3.subtract(physicalCorners.ur, physicalCorners.lr, []);
    const upVector = vec3.scale(vec3.add(upLeft, upRight, []), 0.5);
    vec3.normalize(upVector);

    return {
        id : [id[0], id[1], id[2]],
        height : height,
        srs : divisionNode.srs,
        extents : {
            ll : ll,
            ur : ur
        },
        divisionNode : divisionNode,
        physicalCorners : physicalCorners,
        upVector : upVector
    };
};


MapMeasure.prototype.getSpatialDivisionNodeDepths = function() {
    var nodes = this.map.referenceFrame.getSpatialDivisionNodes();
    var maxLod = -1;
    var minLod = Number.MAX_VALUE;

    for (var i = 0, li = nodes.length; i < li; i++) {
        var node = nodes[i];

        if (node.id[0] < minLod) {
            minLod = node.id[0];
        } 
        
        if (node.id[0] > maxLod) {
            maxLod = node.id[0];
        } 
    }

    return [minLod, maxLod];
};


MapMeasure.prototype.getOptimalHeightLodBySampleSize = function(coords, desiredSamplesSize) {
    var result = this.getSpatialDivisionNode(coords);
    var node = result[0];

    if (node != null) {
        var nodeLod = node.id[0];
        var nodeExtent = node.extents.ur[1] - node.extents.ll[1];

        var lod = Math.log(nodeExtent / desiredSamplesSize) / Math.log(2);
        //lod = Math.round(lod) - 8 + nodeLod;
        lod = lod - 8 + nodeLod;

        return Math.max(0, lod);
    }

    return null;
};


MapMeasure.prototype.getOptimalHeightLod = function(coords, viewExtent, desiredSamplesPerViewExtent) {
    var result = this.getSpatialDivisionNode(coords);
    var node = result[0];

    if (node != null) {
        var nodeLod = node.id[0];
        var nodeExtent = node.extents.ur[1] - node.extents.ll[1];

        var lod = Math.log((desiredSamplesPerViewExtent * nodeExtent) / viewExtent) / Math.log(2);
        //lod = Math.round(lod) - 8 + nodeLod;
        lod = lod - 8 + nodeLod;

        return Math.max(0, lod);
    }

    return null;
};


MapMeasure.prototype.getDistance = function(coords, coords2, includingHeight, usePublic) {
    var sourceSrs = usePublic ? this.publicSrs : this.navigationSrs;
    var p1 = this.getPhysicalSrs.convertCoordsFrom(coords,  sourceSrs);
    var p2 = this.getPhysicalSrs.convertCoordsFrom(coords2, sourceSrs);
    var d = 0;

    var dx = p2[0] - p1[0];
    var dy = p2[1] - p1[1];
    var dz = p2[2] - p1[2];

    var dd = Math.sqrt(dx*dx + dy*dy + dz*dz);
    var navigationSrsInfo = this.navigationSrsInfo;

    if (!this.isProjected) {
        var geod = this.getGeodesic(); //new GeographicLib["Geodesic"]["Geodesic"](navigationSrsInfo["a"],
                                       //                   (navigationSrsInfo["a"] / navigationSrsInfo["b"]) - 1.0);

        var r = geod.Inverse(coords[1], coords[0], coords2[1], coords2[0]);

        if (r.s12 > (navigationSrsInfo['a'] * 2 * Math.PI) / 4007.5) { //aprox 10km for earth
            if (includingHeight) {
                return [Math.sqrt(r.s12*r.s12 + dz*dz), -r.azi1, dd];
            } else {
                return [r.s12, -r.azi1, dd];
            }
        } else {
            if (includingHeight) {
                return [Math.sqrt(dx*dx + dy*dy + dz*dz), -r.azi1, dd];
            } else {
                return [r.s12, -r.azi1, dd];
            }
        }

    } else {
        return [Math.sqrt(dx*dx + dy*dy), math.degrees(Math.atan2(dx, dy)), dd];
    }
};


MapMeasure.prototype.getGeodesic = function() {
    var navigationSrsInfo = this.navigationSrsInfo;

    var geodesic = new GeographicLib.Geodesic.Geodesic(navigationSrsInfo['a'],
                                                      (navigationSrsInfo['a'] / navigationSrsInfo['b']) - 1.0);

    return geodesic;
};


MapMeasure.prototype.getAzimuthCorrection = function(coords, coords2) {
    if (!this.getNavigationSrs().isProjected()) {
        var geodesic = this.getGeodesic();
        var r = geodesic.Inverse(coords[0], coords[1], coords2[0], coords2[1]);
        var ret = (r.azi1 - r.azi2);
        if (isNaN(ret)) {
            ret = 0;
        } 
        return ret; 
    }
    return 0;
};


MapMeasure.prototype.getNED = function(coords) {
    var centerCoords = this.convert.convertCoords([coords[0], coords[1], 0], 'navigation', 'physical');
    var upCoords, rightCoords;

    if (this.isProjected) {
        upCoords = this.convert.convertCoords([coords[0], coords[1] + 100, 0], 'navigation', 'physical');
        rightCoords = this.convert.convertCoords([coords[0] + 100, coords[1], 0], 'navigation', 'physical');
    } else {
        var cy = (coords[1] + 90) - 0.0001;
        var cx = (coords[0] + 180) + 0.0001;

        if (cy < 0 || cx > 180) { //if we are out of bounds things start to be complicated
            var geodesic = this.getGeodesic();
        
            //up coords
            var r = geodesic.Direct(coords[1], coords[0], 0, -100);
            upCoords = this.convert.convertCoords([r.lon2, r.lat2, 0], 'navigation', 'physical');
    
            //right coords
            r = geodesic.Direct(coords[1], coords[0], 90, 100);
            rightCoords = this.convert.convertCoords([r.lon2, r.lat2, 0], 'navigation', 'physical');
        } else {
            // substraction instead of addition is probably case of complicated view matrix calculation
            upCoords = this.convert.convertCoords([coords[0], coords[1] - 0.0001, 0], 'navigation', 'physical');
            rightCoords = this.convert.convertCoords([coords[0] + 0.0001, coords[1], 0], 'navigation', 'physical');
        }
    }

    var up = [upCoords[0] - centerCoords[0],
        upCoords[1] - centerCoords[1],
        upCoords[2] - centerCoords[2]]; 

    var right = [rightCoords[0] - centerCoords[0],
        rightCoords[1] - centerCoords[1],
        rightCoords[2] - centerCoords[2]]; 

    var dir = [0,0,0];
    vec3.normalize(up);
    vec3.normalize(right);
    vec3.cross(up, right, dir);
    vec3.normalize(dir);

    return {
        east  : right, 
        direction : up,
        north : dir        
    };
};

MapMeasure.prototype.getNewNED = function(coords, returnMatrix) {
    var centerCoords = this.convert.convertCoords([coords[0], coords[1], 0], 'navigation', 'physical');
    var upCoords, rightCoords;

    if (this.isProjected) {
        upCoords = this.convert.convertCoords([coords[0], coords[1] + 100, 0], 'navigation', 'physical');
        rightCoords = this.convert.convertCoords([coords[0] + 100, coords[1], 0], 'navigation', 'physical');
    } else {
        //get NED for latlon coordinates
        //http://www.mathworks.com/help/aeroblks/directioncosinematrixeceftoned.html
        /*        
        var coords = this.position.getCoords();
        var lon = math.radians(coords[0]);
        var lat = math.radians(coords[1]);

        //NED vectors for sphere
        var east = [-Math.sin(lat)*Math.cos(lon), -Math.sin(lat)*Math.sin(lon), Math.cos(lat)];
        var direction = [-Math.sin(lon), Math.cos(lon), 0];
        var north = [-Math.cos(lat)*Math.cos(lon), -Math.cos(lat)*Math.sin(lon), -Math.sin(lat)];

        north = vec3.negate(north);
        east  = vec3.negate(east);
        
        //get elipsoid factor
        var navigationSrsInfo = this.getNavigationSrs().getSrsInfo();
        var factor = navigationSrsInfo["b"] / navigationSrsInfo["a"];

        //flaten vectors
        north[2] *= factor;
        east[2] *= factor;
        direction[2] *= factor;

        //normalize vectors
        north = vec3.normalize(north);
        east  = vec3.normalize(east);
        direction = vec3.normalize(direction);
        */

        var cy = (coords[1] + 90) + 0.0001;
        var cx = (coords[0] + 180) + 0.0001;

        if (cy < 0 || cx > 180) { //if we are out of bounds things start to be complicated
            var geodesic = this.getGeodesic();
        
            //up coords
            var r = geodesic.Direct(coords[1], coords[0], 0, -100);
            upCoords = this.convert.convertCoords([r.lon2, r.lat2, 0], 'navigation', 'physical');
    
            //right coords
            r = geodesic.Direct(coords[1], coords[0], 90, -100);
            rightCoords = this.convert.convertCoords([r.lon2, r.lat2, 0], 'navigation', 'physical');
        } else {
            // substraction instead of addition is probably case of complicated view matrix calculation
            upCoords = this.convert.convertCoords([coords[0], coords[1] + 0.0001, 0], 'navigation', 'physical');
            rightCoords = this.convert.convertCoords([coords[0] + 0.0001, coords[1], 0], 'navigation', 'physical');
        }
    }

    var up = [upCoords[0] - centerCoords[0],
        upCoords[1] - centerCoords[1],
        upCoords[2] - centerCoords[2]]; 

    var right = [rightCoords[0] - centerCoords[0],
        rightCoords[1] - centerCoords[1],
        rightCoords[2] - centerCoords[2]]; 

    var dir = [0,0,0];
    vec3.normalize(up);
    vec3.normalize(right);
    vec3.cross(up, right, dir);
    vec3.normalize(dir);

    if (returnMatrix) {
        var east = right;
        var direction = up;
        var north = dir;

        return [
            east[0], east[1], east[2], 0,
            north[0], north[1], north[2], 0,
            direction[0], direction[1], direction[2], 0,
            0, 0, 0, 1
        ];        
    }

    return {
        east  : right, 
        direction : up,
        north : dir        
    };
};

//TODO: use getNewNED 
MapMeasure.prototype.getPositionCameraInfo = function(position, projected, clampTilt) {
    //var position = [0,0,0];
    var orientation = position.getOrientation();
    var distance = position.getViewDistance();
    
    if (clampTilt) { //used for street labels
        orientation[1] = math.clamp(orientation[1], -89.0, 90.0);
    }

    var roty = math.clamp(orientation[1], -89.5, 89.5);

    var tmpMatrix = mat4.create();
    mat4.multiply(math.rotationMatrix(2, math.radians(-orientation[0])), math.rotationMatrix(0, math.radians(roty)), tmpMatrix);
    var orbitPos, ned, north, east, direction, spaceMatrix, rotationMatrix;
    var east2, north2, direction2, dir, up, right;

    if (position.getViewMode() == 'obj') {
        orbitPos = [0, -distance, 0];
        mat4.multiplyVec3(tmpMatrix, orbitPos);
    } else {
        orbitPos = [0, 0, 0];
    }

    //this.cameraVector = [0, 0, 1];
    //mat4.multiplyVec3(this.updateCameraMatrix, this.cameraVector);

    var ret = {
        orbitCoords : null,
        distance : distance,
        rotMatrix : null,
        vector : null,
        orbitHeight : orbitPos[2]  
    };

    var coords = position.getCoords();

    if (projected) {
        
        tmpMatrix = mat4.create();
        mat4.multiply(math.rotationMatrix(0, math.radians(-roty - 90.0)), math.rotationMatrix(2, math.radians(orientation[0])), tmpMatrix);

        ned = this.getNED(coords);
        north = ned.north;
        east  = ned.east;
        direction = ned.direction;

        spaceMatrix = [
            east[0], east[1], east[2], 0,
            direction[0], direction[1], direction[2], 0,
            north[0], north[1], north[2], 0,
            0, 0, 0, 1
        ];
        
        east2  = [1,0,0];
        direction2 = [0,1,0];
        north2 = [0,0,1];

        dir = [1,0,0];
        up = [0,0,-1];
        right = [0,0,0];
        vec3.cross(dir, up, right);

        //rotate vectors according to eulers
        mat4.multiplyVec3(tmpMatrix, north2);
        mat4.multiplyVec3(tmpMatrix, east2);
        mat4.multiplyVec3(tmpMatrix, direction2);

        mat4.multiplyVec3(tmpMatrix, dir);
        mat4.multiplyVec3(tmpMatrix, up);
        mat4.multiplyVec3(tmpMatrix, right);

        var t = 0;
        t = dir[0]; dir[0] = dir[1]; dir[1] = t;
        t = up[0]; up[0] = up[1]; up[1] = t;
        t = right[0]; right[0] = right[1]; right[1] = t;
        
        dir[2] = -dir[2];
        up[2] = -up[2];
        right[2] = -right[2];

        /*
        mat4.multiplyVec3(spaceMatrix, north2);
        mat4.multiplyVec3(spaceMatrix, east2);
        mat4.multiplyVec3(spaceMatrix, direction2);
        */

        //get rotation matrix
        rotationMatrix = [
            east2[0], east2[1], east2[2], 0,
            direction2[0], direction2[1], direction2[2], 0,
            north2[0], north2[1], north2[2], 0,
            0, 0, 0, 1
        ];

       // mat4.multiplyVec3(spaceMatrix, orbitPos);
/*
        //get rotation matrix
        var rotationMatrix = [
            east[0], east[1], east[2], 0,
            direction[0], direction[1], direction[2], 0,
            north[0], north[1], north[2], 0,
            0, 0, 0, 1
        ];
*/
        ret.vector = vec3.normalize([-orbitPos[0], -orbitPos[1], -orbitPos[2]]); 
        ret.vector2 = ret.vector; //vector2 is probably hack for tree.js bboxVisible 
        
        ret.orbitCoords = orbitPos;
        ret.rotMatrix = rotationMatrix; 

    } else { //geographics

      
        ned = this.getNED(coords);
        north = ned.north;
        east  = ned.east;
        direction = ned.direction;
        

        spaceMatrix = [
            east[0], east[1], east[2], 0,
            direction[0], direction[1], direction[2], 0,
            north[0], north[1], north[2], 0,
            0, 0, 0, 1
        ];
        
        //spaceMatrix = mat4.inverse(spaceMatrix);
        
        var localRotMatrix = mat4.create();
        mat4.multiply(math.rotationMatrix(0, math.radians(-roty - 90.0)), math.rotationMatrix(2, math.radians(orientation[0])), localRotMatrix);

        east2  = [1,0,0];
        direction2 = [0,1,0];
        north2 = [0,0,1];

        coords = position.getCoords();
        var latlonMatrix = mat4.create();
        mat4.multiply(math.rotationMatrix(0, math.radians((coords[1] - 90.0))), math.rotationMatrix(2, math.radians((-coords[0]-90))), latlonMatrix);
//      mat4.multiply(math.rotationMatrix(2, math.radians((coords[0]-90))), math.rotationMatrix(0, math.radians((coords[1] - 90.0))), latlonMatrix);


        //mat4.multiply(math.rotationMatrix(0, math.radians(0)), math.rotationMatrix(2, math.radians(-(coords[0]+90))), latlonMatrix);
        //mat4.multiply(math.rotationMatrix(0, math.radians(0)), math.rotationMatrix(2, math.radians(0)), latlonMatrix);

        //rotate vectors according to latlon
        mat4.multiplyVec3(latlonMatrix, north2);
        mat4.multiplyVec3(latlonMatrix, east2);
        mat4.multiplyVec3(latlonMatrix, direction2);


        spaceMatrix = [
            east2[0], east2[1], east2[2], 0,
            direction2[0], direction2[1], direction2[2], 0,
            north2[0], north2[1], north2[2], 0,
            0, 0, 0, 1
        ];

        right = [1,0,0];
        dir = [0,1,0];
        up = [0,0,1];
        //vec3.cross(dir, up, right);

        //rotate vectors according to eulers
        //mat4.multiplyVec3(this.updateCameraMatrix, north2);
        //mat4.multiplyVec3(this.updateCameraMatrix, east2);
        //mat4.multiplyVec3(this.updateCameraMatrix, direction2);

        mat4.multiplyVec3(spaceMatrix, dir);
        mat4.multiplyVec3(spaceMatrix, up);
        mat4.multiplyVec3(spaceMatrix, right);

        mat4.multiplyVec3(localRotMatrix, right);
        mat4.multiplyVec3(localRotMatrix, dir);
        mat4.multiplyVec3(localRotMatrix, up);
        
        //mat4.multiplyVec3(spaceMatrix, north2);
        //mat4.multiplyVec3(spaceMatrix, east2);
        //mat4.multiplyVec3(spaceMatrix, direction2);


        //get rotation matrix
/*        
        var rotationMatrix = [
            east2[0], east2[1], east2[2], 0,
            direction2[0], direction2[1], direction2[2], 0,
            north2[0], north2[1], north2[2], 0,
            0, 0, 0, 1
        ];
*/        

        rotationMatrix = [
            right[0], right[1], right[2], 0,
            dir[0], dir[1], dir[2], 0,
            up[0], up[1], up[2], 0,
            0, 0, 0, 1
        ];

        //get orbit pos
        spaceMatrix = mat4.inverse(spaceMatrix);
        mat4.multiplyVec3(spaceMatrix, orbitPos);

        //ret.vector2 = [-spaceMatrix[8], -spaceMatrix[9], -spaceMatrix[10]]; //vector2 is probably hack for tree.js bboxVisible 
        ret.vector = [-rotationMatrix[2], -rotationMatrix[6], -rotationMatrix[10]];

        //var ray = this.map.renderer.getScreenRay(800,400);

        //get camera direction
        //mat4.inverse(rotationMatrix, spaceMatrix);
        //ret.vector = [-spaceMatrix[8], -spaceMatrix[9], -spaceMatrix[10]]; 
        
        //console.log("cam vec: " + JSON.stringify(this.cameraVector));
         
        //this.position.setHeight(0); !!!!!!!!!!!!!!!
    }

    ret.orbitCoords = orbitPos;
    ret.rotMatrix = rotationMatrix;
    return ret; 
};


export default MapMeasure;
