
import MapGeodataView from './geodata-view';
import * as utils from '../utils/utils';
import { TileRenderRig } from './tile-render-rig';
import * as vts from '../constants';


var MapDrawTiles = function(map, draw) {
    this.map = map;
    this.config = map.config;
    this.isProjected = this.map.getNavigationSrs().isProjected();
    this.stats = map.stats;
    this.draw = draw;
    this.core = map.core;
    this.camera = map.camera;

    this.renderer = map.renderer;

    this.getTextSize = this.renderer.draw.getTextSize.bind(this.renderer.draw);
    this.drawText = this.renderer.draw.drawText.bind(this.renderer.draw);
    this.defaultColorPair = this.renderer.draw.constructor.defaultColorPair;

    this.readinessFull = { minimum: 'fallback', desired: 'full' };
    this.readinessFallback = { minimum: 'fallback', desired: 'fallback' };
    this.readyPriority = { essential: 0, optional: 0 };
    this.readyOptions = { doNotLoad: false, doNotCheckGpu: false };
};


MapDrawTiles.prototype.drawSurfaceTile = function(
    tile, node, cameraPos, pixelSize, priority, preventRedener, preventLoad,
    doNotCheckGpu, readiness, maskTexture) {

    if (this.stats.gpuRenderUsed >= this.draw.maxGpuUsed) {
        return false;
    }

    if (tile.surface) {
        if (node.hasGeometry()) {

            // escape hatch for no-load probing
            // motivation: off-cadence residence-only draws in tree traversal
            let probingUnloadedTerrain =
                !tile.surface.geodata && preventLoad && !tile.surfaceMesh;
            if (probingUnloadedTerrain) return false;

            // update tile counts in inspector
            if (!preventRedener) {
                this.stats.renderedLods[tile.id[0]]++;
                this.stats.drawnTiles++;

                // mirror the per-LOD tile count, keyed by surface id, so
                // the inspector can break the same total down by surface
                var surfaceId = tile.surface.id || '(no id)';

                this.stats.renderedSurfaces[surfaceId] =
                    (this.stats.renderedSurfaces[surfaceId] || 0) + 1;

                if (tile.surface.geodata && this.renderer.drawnGeodataTilesUsed) {    //used in scr-count2 !!! legacy mode, do not remove

                    var pp = this.renderer.project2(
                        [(node.bbox2[12] + node.bbox2[15] + node.bbox2[18] + node.bbox2[21])*0.25 - cameraPos[0],
                         (node.bbox2[13] + node.bbox2[16] + node.bbox2[19] + node.bbox2[22])*0.25 - cameraPos[1],
                         (node.bbox2[14] + node.bbox2[17] + node.bbox2[20] + node.bbox2[23])*0.25 - cameraPos[2]],
                         this.camera.getMvpMatrix());

                    if (!(pp[0] < 0 || pp[1] < 0 || pp[0] > this.renderer.curSize[0] || pp[1] > this.renderer.curSize[1])) {
                        this.stats.drawnGeodataTilesPerLayer++;
                        this.stats.drawnGeodataTilesFactor += Math.pow(Math.abs(tile.tiltAngle * tile.texelSize), vts.TILE_COUNT_FACTOR);
                    }

                    this.stats.drawnGeodataTiles++;
                }
            }

            if (tile.resetDrawCommands) {
                tile.drawCommands = [[], [], []];
                tile.updateBounds = true;
                tile.resetDrawCommands = false;
            }

            let ret = false;

            // set once any submesh of this tile paints color content; the
            // terrain debug overlay below is keyed off this
            let tileDidDraw = false;

            if (!tile.surface.geodata) {

                // -- tile-render-rig integration - start

                if (!tile.surfaceMesh) {
                    let path = tile.resourceSurface.getMeshUrl(tile.id);
                    tile.surfaceMesh = tile.resources.getMesh(path, tile);
                }

                let surfaceMesh = tile.surfaceMesh;

                // Trigger the mesh load (side effect of isReady) and capture
                // whether the mesh is currently usable for drawing. The
                // return value reflects GPU residence — an existing rig can
                // still be drawn from gpuSubmeshes even after a CPU resource
                // cache eviction, as long as the GPU copy survives.
                let meshReady = surfaceMesh.isReady(
                    preventLoad, priority, doNotCheckGpu);

                // If the mesh has never finished its first parse, there are
                // no submeshes to iterate. Return early so callers see the
                // tile as not-ready and try children. (The submeshes array
                // is also non-empty after CPU eviction — see cpuReady below
                // for that case.)
                //
                // Workaround: a surface generator can deliver a parsed,
                // structurally valid mesh that carries zero submeshes (no
                // geometry over the tile). Once it has loaded (loadState 2)
                // such a tile is ready with nothing to draw, so report it
                // ready. Reporting not-ready forever stalls the legacy
                // topdown traversal, which descends the root only when every
                // division-node sibling is ready — one empty sibling then
                // blocks the whole surface. Remove with the legacy path.
                if (!surfaceMesh.submeshes.length) {
                    return surfaceMesh.loadState == 2;
                }

                // CPU residence is a stricter condition than meshReady.
                // killSubmeshes nulls per-submesh CPU fields (vertices,
                // internalUVs, externalUVs, indices) but leaves the
                // submeshes array length intact so existing rigs can keep
                // drawing from gpuSubmeshes. Rig CONSTRUCTION needs the CPU
                // fields, so we must check this explicitly before building
                // a new rig — otherwise rt.internalUVs/externalUVs would
                // latch to false and the rig would render only the constant
                // background layer (drab-tile bug).
                let cpuReady = meshReady && !surfaceMesh.submeshesKilled;

                let priority_ = this.readyPriority;
                priority_.essential = priority;
                priority_.optional = priority;

                let readyOptions = this.readyOptions;
                readyOptions.doNotLoad = preventLoad;
                readyOptions.doNotCheckGpu = doNotCheckGpu;

                // iterate through submeshes
                for (let i = 0; i < surfaceMesh.submeshes.length; i++) {

                    var submeshSurface = tile.resourceSurface;

                    // we are either drawing the tile for the first time, or
                    // there has been a raster fallback, or a view
                    // has been switched
                    if (!tile.tileRenderRig[i] || tile.updateBounds) {

                        // wait for CPU data before constructing a new rig
                        if (!cpuReady) continue;

                        if (tile.lastRenderRig[i]) tile.lastRenderRig[i].dispose();

                        if (tile.tileRenderRig[i])
                            tile.lastRenderRig[i] = tile.tileRenderRig[i];

                        // create new rig from submeshSurface layer sequence
                        tile.tileRenderRig[i] = new TileRenderRig(
                            i, submeshSurface.style, tile, this.renderer,
                            this.config);
                    }

                    let curRig = tile.tileRenderRig[i];
                    let lastRig = tile.lastRenderRig[i];
                    let curRigReady = false;

                    // is the tile rig ready? Draw it. If not, try the last rig
                    readiness = readiness || this.readinessFull;

                    if (this.map.outerMap.drawChannel === 'color')
                        curRigReady = curRig.isReady(
                            readiness,
                            priority_, readyOptions);

                    if (this.map.outerMap.drawChannel === 'depth')
                        curRigReady = curRig.isDepthReady(
                            priority_.essential, readyOptions);

                    let lastRigReady = false;

                    if (!curRigReady) {

                        if (this.map.outerMap.drawChannel === 'color')
                            lastRigReady = lastRig && lastRig.isReady(
                                this.readinessFallback,
                                priority_, readyOptions);

                        if (this.map.outerMap.drawChannel === 'depth')
                            lastRigReady = lastRig && lastRig.isDepthReady(
                                priority_.essential, readyOptions);
                    }

                    let rigToDraw = curRigReady
                        ? curRig
                        : lastRigReady
                            ? lastRig
                            : null;

                    // draw
                    if (rigToDraw && !preventRedener) {

                        if (this.map.outerMap.drawChannel === 'color') {

                            // draw something
                            rigToDraw.draw(cameraPos, maskTexture);
                            tileDidDraw = true;

                            // process layer credits (only active layers)
                            let activeRasterSourceIds =
                                rigToDraw.activeRasterSourceIds();

                            activeRasterSourceIds.forEach((id) => {

                                let source = tile.rasterSources[id];
                                if (!source) return;

                                let credits = source.credits;
                                for (let k = 0; k < credits.length; k++)
                                    tile.imageryCredits[credits[k]] =
                                        source.specificity;
                            });

                            tile.addSubmeshCredits(
                                i, activeRasterSourceIds);

                            // extract and flush credits
                            this.map.applyCredits(tile);
                        }

                        if (this.map.outerMap.drawChannel === 'depth')
                            rigToDraw.drawDepth(cameraPos, maskTexture);
                    }

                    ret = rigToDraw;
                } // end iterate through submeshes

                // submesh rigs were rebuilt -> clear update flag
                if (cpuReady) tile.updateBounds = false;

                // draw the overlay once per tile, on the color pass, when the
                // tile painted color content this frame
                if (tileDidDraw
                    && this.map.outerMap.overrides.drawBBoxes
                    && !this.map.outerMap.overrides.drawGeodataOnly
                    && this.map.outerMap.drawChannel === 'color') {

                    this.drawTileInfo(
                        tile, node, cameraPos, tile.surfaceMesh, pixelSize);
                }

                // -- tile-render-rig integration - end

            } else {

                // debug bbox/label overlay for geodata-surface tiles, drawn
                // on tile selection. This call has no drawChannel guard, so
                // on the depth pass it writes overlay geometry into the
                // depth/hitmap target and locally corrupts it.
                if (this.map.outerMap.overrides.drawBBoxes && !preventRedener) {
                    this.drawTileInfo(
                        tile, node, cameraPos, tile.surfaceMesh, pixelSize);
                }

                ret = this.drawGeodataTile(tile, node, cameraPos, pixelSize,
                    priority, preventRedener, preventLoad, doNotCheckGpu);
            }

            return ret;
        } else { // if (! node.hasGeometry())
            return true;
        }
    }
};


MapDrawTiles.prototype.drawGeodataTile = function(tile, node, cameraPos, pixelSize, priority, preventRedener, preventLoad, doNotCheckGpu) {
    if (tile.id[0] <= 1) {
        return true;
    }

    if (tile.surfaceGeodata == null) {
        var path = tile.resourceSurface.getGeodataUrl(tile.id, '');
        tile.surfaceGeodata = tile.resources.getGeodata(
            path, {tile:tile, surface:tile.surface});
    }

    // tile.drawCommands is a numeric-indexed array of per-channel
    // command lists; convert the typed channel at this boundary.
    var channel = this.map.outerMap.drawChannel === 'color' ? 0 : 1;

    if (tile.geodataCounter != tile.surface.geodataCounter) {
        tile.drawCommands = [[],[],[]];

        if (tile.surfaceGeodataView != null) {
            tile.surfaceGeodataView.kill();
        }

        tile.surfaceGeodataView = null;
        tile.geodataCounter = tile.surface.geodataCounter;
    }

    if (tile.drawCommands[channel].length > 0 && this.draw.areDrawCommandsReady(tile.drawCommands[channel], priority, preventLoad, doNotCheckGpu)) {
        if (!preventRedener) {
            this.draw.processDrawCommands(cameraPos, tile.drawCommands[channel], priority, null, tile);
            this.map.applyCredits(tile);
        }
        return true;
    }

    if (!tile.surfaceGeodataView) {
        if (tile.surfaceGeodata.isReady(preventLoad, priority, doNotCheckGpu) && !preventLoad) {
            tile.surfaceGeodataView = new MapGeodataView(this.map, tile.surfaceGeodata, {tile:tile, surface:tile.surface});
        }
    }

    if (tile.surfaceGeodataView) {
        tile.mapdataCredits = {};

        var specificity = (tile.surface) ? tile.surface.specificity : 0;

        //set credits
        for (var k = 0, lk = node.credits.length; k < lk; k++) {
            tile.mapdataCredits[node.credits[k]] = specificity;
        }

        tile.drawCommands[channel][0] = {
            type : vts.DRAWCOMMAND_GEODATA,
            geodataView : tile.surfaceGeodataView
        };

        return tile.surfaceGeodataView.isReady();
    }

    return false;
};


MapDrawTiles.prototype.getParentTile = function(tile, lod) {
    while(tile && tile.id[0] > lod) {
        tile = tile.parent;
    }

    return tile;
};


MapDrawTiles.prototype.getTileTextureTransform = function(sourceTile, targetTile) {
    var shift = targetTile.id[0] - sourceTile.id[0];
    var x = sourceTile.id[1] << shift;
    var y = sourceTile.id[2] << shift;
    var s = 1.0 / Math.pow(2.0, shift);
    return [ s, s, (targetTile.id[1] - x) * s, (targetTile.id[2] - y) * s ];
};


MapDrawTiles.prototype.drawTileInfo = function(tile, node, cameraPos, mesh) {
    var debug = this.map.outerMap.overrides;
    var pos;

    if (!debug.drawMeshBBox) {

        node.drawBBox(cameraPos);
    }

    //get screen pos of node
    if (node.metatile.useVersion < 4) {
        var min = node.bbox.min;
        var max = node.bbox.max;

        pos =  this.core.renderer.project2(
            [(min[0] + (max[0] - min[0])*0.5) - cameraPos[0],
                (min[1] + (max[1] - min[1])*0.5) - cameraPos[1],
                (max[2]) - cameraPos[2]],
             this.camera.getMvpMatrix());

        pos[2] = pos[2] * 0.9992;
    } else {
        var dx = node.bbox2[3] - node.bbox2[0];
        var dy = node.bbox2[4] - node.bbox2[1];
        var dz = node.bbox2[5] - node.bbox2[2];

        var d = Math.sqrt(dx*dx + dy*dy + dz*dz);

        pos =  this.core.renderer.project2(
            [(node.bbox2[12] + node.bbox2[15] + node.bbox2[18] + node.bbox2[21])*0.25 + node.diskNormal[0] * d*0.1 - cameraPos[0],
                (node.bbox2[13] + node.bbox2[16] + node.bbox2[19] + node.bbox2[22])*0.25 + node.diskNormal[1] * d*0.1 - cameraPos[1],
                (node.bbox2[14] + node.bbox2[17] + node.bbox2[20] + node.bbox2[23])*0.25 + node.diskNormal[2] * d*0.1 - cameraPos[2]],
             this.camera.getMvpMatrix());

        /*
            var pos =  this.core.renderer.project2(
                            [(node.diskPos[0] + node.diskNormal[0] * node.bboxHeight) - cameraPos[0],
                             (node.diskPos[1] + node.diskNormal[1] * node.bboxHeight) - cameraPos[1],
                             (node.diskPos[2] + node.diskNormal[2] * node.bboxHeight) - cameraPos[2]],
                             this.camera.getMvpMatrix());
        */
    }

    var factor = debug.debugTextSize, text, i, li,c;

    //draw lods
    if (debug.drawLods) {
        text = '' + tile.id[0]; // + ' ta:' + Math.abs(tile.tiltAngle).toFixed(3);
        //text = '' + tile.id[0] + ' c:' + (50*(Math.pow(Math.abs(tile.tiltAngle * tile.texelSize), vts.TILE_COUNT_FACTOR) / Math.max(0.00001, this.renderer.drawnGeodataTilesFactor))).toFixed(3) +
          //     ' l:' + Math.pow(Math.abs(tile.tiltAngle * tile.texelSize), vts.TILE_COUNT_FACTOR).toFixed(3) + ' g:' + this.renderer.drawnGeodataTilesFactor.toFixed(3);
        this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]-4*factor), 4*factor, text, this.defaultColorPair, pos[2]);
    }

    //draw indices
    if (debug.drawIndices) {
        text = '' + tile.id[1] + ' ' + tile.id[2];
        this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]-11*factor), 4*factor, text, [0,1,1,1], pos[2]);
    }

    //draw positions
    if (debug.drawPositions) {
        //text = "" + min[0].toFixed(1) + " " + min[1].toFixed(1) + " " + min[2].toFixed(1);
        //text = "" + Math.floor(node.corners[0]) + " " + Math.floor(node.corners[1]) + " " + Math.floor(node.corners[2]) + " " + Math.floor(node.corners[3]);

        var b = node.border;
        if (b) {
            text = Math.floor(b[0]) + ' ' + Math.floor(b[1]) + ' '
                + Math.floor(b[2]) + ' ' + Math.floor(b[3]) + ' '
                + Math.floor(b[4]) + ' ' + Math.floor(b[5]) + ' '
                + Math.floor(b[6]) + ' ' + Math.floor(b[7]) + ' '
                + Math.floor(b[8]);
            this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]+10*factor), 4*factor, text, [0,1,1,1], pos[2]);
        }

        //text = 'llx:' + Math.floor(node.llx) + ' lly:' + Math.floor(node.lly) + ' urx:' + Math.floor(node.urx) + ' ury:' + Math.floor(node.ury);
        //this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]+3*factor), 4*factor, text, [0,1,1,1], pos[2]);
    }

    //draw resources
    if (debug.drawResources && mesh) {
        text = '' + (mesh.gpuSize / (1024 * 1024)).toFixed(2) + 'MB';
        this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]+10*factor), 4*factor, text, [0,1,0,1], pos[2]);
    }

    //draw face count
    if (debug.drawFaceCount && mesh) {
        text = '' + mesh.faces + ' - ' + mesh.submeshes.length;
        this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]+10*factor), 4*factor, text, [0,1,0,1], pos[2]);
    }

    //draw geodata pixel size
    if (debug.drawGPixelSize) {
        text = '' + ((Math.tan(tile.metanode.diskAngle2A) * tile.metanode.diskDistance * 0.70710678118) / node.displaySize).toFixed(2);
        this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]+10*factor), 4*factor, text, [0,1,0,1], pos[2]);
    }

    if (debug.drawSurfaces || debug.drawSurfaces2) {
        text = '' + tile.surface.id;

        // non-watertight tiles get their surface id parenthesized so
        // gaps in coverage are visible at a glance in the overlay
        if (!node.watertight) {
            text = '(' + text + ')';
        }

        if (debug.drawSurfaces2) {
            //c = utils.getHashColor(text);
            c = utils.getHashColor2(tile.surface.surfaceCounter);
            //c = [c[0]/255,c[1]/255,c[2]/255,1];
            c = [c[0],c[1],c[2],1];
        } else {
            c = [1,1,1,1];
        }

        this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]+10*factor), 4*factor, text, c, pos[2]);
    }

    if (debug.drawCredits) {
        text = '{ ';

        for (var key in tile.imageryCredits) {
            if (tile.imageryCredits[key]) {
                text += key + ':' + tile.imageryCredits[key] + ', ';
            }
        }

        text += '}';

        this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]+10*factor), 4*factor, text, [1,1,1,1], pos[2]);
    }

    //draw distance
    if (debug.drawDistance) {
        text = '' + tile.distance.toFixed(2) + '  ' + tile.texelSize.toFixed(3) + '  ' + node.pixelSize.toFixed(3);
        text += '--' + tile.texelSize2.toFixed(3);
        this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]+17*factor), 4*factor, text, [1,0,1,1], pos[2]);
    }

    //draw node info
    if (debug.drawNodeInfo) {
        var children = ((node.flags & ((15)<<4))>>4);
        text = 'v' + node.metatile.version + '-' + node.flags.toString(2) + '-' + ((children & 1) ? '1' : '0') + ((children & 2) ? '1' : '0') + ((children & 4) ? '1' : '0') + ((children & 8) ? '1' : '0');
        text += '-' + node.minHeight + '/' + node.maxHeight+ '-' + Math.floor(node.minZ) + '/' + Math.floor(node.maxZ)+ '-' + Math.floor(node.surrogatez);
        this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]-18*factor), 4*factor, text, [1,0,1,1], pos[2]);
    }

    //draw texture size
    if (debug.drawTextureSize && mesh) {
        var submeshes = mesh.submeshes;
        for (i = 0, li = submeshes.length; i < li; i++) {

            if (submeshes[i].internalUVs) {
                var texture = tile.surfaceTextures[i];
                if (texture) {
                    var gpuTexture = texture.getGpuTexture();
                    if (gpuTexture) {
                        text = '[' + i + ']: ' + gpuTexture.width + ' x ' + gpuTexture.height;
                        this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]+(17+i*4*2)*factor), 4*factor, text, [1,1,1,1], pos[2]);
                    }
                }
            } else {
                text = '[' + i + ']: 256 x 256';
                this.drawText(Math.round(pos[0]-this.getTextSize(4*factor, text)*0.5), Math.round(pos[1]+(17+i*4*2)*factor), 4*factor, text, [1,1,1,1], pos[2]);
            }
        }
    }

};


export default MapDrawTiles;
