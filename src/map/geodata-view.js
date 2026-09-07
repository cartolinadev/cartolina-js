import {mat4} from '../utils/matrix';
import * as math from '../utils/math';
import * as utils from '../utils/utils';
import GpuGroup from '../renderer/gpu/group';
import MapGeodataProcessor from './geodata-processor/processor';

import * as vts from '../constants';


var MapGeodataView = function(map, geodata, extraInfo) {
    this.map = map;
    this.stats = map.stats;
    this.geodata = geodata;
    this.gpu = this.map.renderer.gpu;
    this.renderer = this.map.renderer;
    this.gpuGroups = [];
    this.buildingGpuGroups = [];
    this.currentGpuGroup = null;
    this.tile = extraInfo.tile;
    this.surface = extraInfo.surface;

    if (!this.surface.geodataProcessor) {
        var processor = new MapGeodataProcessor(
            this, this.onGeodataProcessorMessage.bind(this));
        processor.setStylesheet(this.surface.stylesheet);
        this.surface.geodataProcessor = processor;
        this.map.geodataProcessors.push(processor);
    } else if (this.surface.styleChanged) {
        this.surface.geodataProcessor.setStylesheet(this.surface.stylesheet);
        this.surface.styleChanged = false;
    }

    this.geodataProcessor = this.surface.geodataProcessor;
    this.processing = false;
    this.pendingCommands = 0;
    this.statsCounter = 0;
    this.size = 0;
    this.buildingSize = 0;
    this.killed = false;
    this.ready = false;
    this.processorListener = this.onGeodataProcessorMessage.bind(this);
    this.heightcoding = null;
    this.heightcodingUpdate = null;
    this.heightcodingMode = this.map.config.mapHeightcoding;
    this.settledEpoch = 0;
    this.isReady();
};


MapGeodataView.prototype.kill = function() {
    this.killed = true;
    this.geodata = null;

    if (this.heightcoding) {
        this.heightcoding.detach(this.processorListener);
        this.heightcoding = null;
    }

    if (this.gpuCacheItem) {
        this.map.gpuCache.remove(this.gpuCacheItem);
    } else {
        this.killGpuGroups(this.gpuGroups, this.size);
    }

    for (var i = 0, li = this.buildingGpuGroups.length; i < li; i++) {
        this.buildingGpuGroups[i].kill();
    }

    this.buildingGpuGroups = [];
    this.buildingSize = 0;
};


MapGeodataView.prototype.killGpuGroups = function(groups, size) {
    for (var i = 0, li = groups.length; i < li; i++) {
        groups[i].kill();
    }

    if (size > 0) {
        this.stats.gpuGeodata -= size;
        this.stats.graphsFluxGeodata[1][0]++;
        this.stats.graphsFluxGeodata[1][1] += size;
    }

    if (groups === this.gpuGroups) {
        this.gpuGroups = [];
        this.size = 0;
        this.ready = false;
        this.gpuCacheItem = null;
    }
};


MapGeodataView.prototype.processPackedCommands = function(
        buffer, index, deadline) {
    var maxIndex = buffer.byteLength;
    var t = performance.now(), length, str, data;
    var view = new DataView(buffer.buffer);

    do {
        var command = buffer[index]; index += 1;

        switch(command) {
        case vts.WORKERCOMMAND_GROUP_BEGIN:
            index += 1;
            length = view.getUint32(index); index += 4;
            str = utils.unint8ArrayToString(
                new Uint8Array(buffer.buffer, index, length));
            index += length;
            data = JSON.parse(str);

            this.currentGpuGroup = new GpuGroup(
                data['id'], data['bbox'], data['origin'],
                this.gpu, this.renderer);
            this.buildingGpuGroups.push(this.currentGpuGroup);
            break;

        case vts.WORKERCOMMAND_GROUP_END:
            this.buildingSize += this.currentGpuGroup.size;
            index += 1 + 4;
            break;

        case vts.WORKERCOMMAND_ADD_RENDER_JOB:
            index = this.currentGpuGroup.addRenderJob2(
                buffer, index, this.tile);
            break;

        case vts.WORKERCOMMAND_ALL_PROCESSED:
            this.commitGpuGroups();
            index += 1 + 4;
            break;
        }

        if (performance.now() >= deadline && index < maxIndex) {
            this.stats.renderBuild += performance.now() - t;
            return index;
        }

    } while(index < maxIndex);

    this.stats.renderBuild += performance.now() - t;
    return -1;
};


MapGeodataView.prototype.commitGpuGroups = function() {
    if (this.gpuCacheItem) {
        this.map.gpuCache.remove(this.gpuCacheItem);
    } else if (this.gpuGroups.length > 0) {
        this.killGpuGroups(this.gpuGroups, this.size);
    }

    var groups = this.buildingGpuGroups;
    var size = this.buildingSize;

    this.gpuGroups = groups;
    this.size = size;
    this.buildingGpuGroups = [];
    this.buildingSize = 0;
    this.ready = true;
    this.processing = false;

    this.stats.gpuGeodata += size;
    this.stats.graphsFluxGeodata[0][0]++;
    this.stats.graphsFluxGeodata[0][1] += size;

    this.gpuCacheItem = this.map.gpuCache.insert(
        this.killGpuGroups.bind(this, groups, size), size);

    // A committed group set releases the job's next height update.
    if (this.heightcoding)
        this.heightcoding.notePublished(this.processorListener);

    this.map.markDirty();
};


MapGeodataView.prototype.onGeodataProcessorMessage = function(
        command, message, task, deadline) {
    if (this.killed) return;

    switch (command) {
    case 'addPackedCommands':
        if (task) {
            var index = this.processPackedCommands(
                message['buffer'], message.index, deadline);

            if (index < 0) {
                this.pendingCommands--;
                this.map.markDirty();
            } else {
                message.index = index;
                return -123;
            }
        } else {
            message.index = 0;
            this.pendingCommands++;
            this.map.markDirty();
            this.map.addProcessingTask2(
                this.onGeodataProcessorMessage.bind(
                    this, command, message, true));
        }
        break;

    case 'ready':
        if (this.geodataProcessor.processCounter > 0) {
            this.geodataProcessor.processCounter--;

            if (this.geodataProcessor.processCounter > 0) {
                this.map.markDirty();
                break;
            }
        }

        this.geodataProcessor.busy = false;
        this.map.markDirty();
        break;
    }
};


MapGeodataView.prototype.startProcessing = function(
        payload, heightcoding) {
    this.processing = true;
    this.buildingGpuGroups = [];
    this.buildingSize = 0;
    this.currentGpuGroup = null;
    this.geodataProcessor.setListener(this.processorListener);

    var heightcodingRequest = heightcoding
        ? heightcoding.beginInitial() : null;
    var raw = payload instanceof ArrayBuffer;

    if (raw) payload = payload.slice(0);

    if (raw) {
        this.geodataProcessor.sendCommand(
            'processGeodataRaw', payload, this.tile,
            (window.devicePixelRatio || 1), [payload],
            heightcodingRequest
                ? { heightcoding: heightcodingRequest } : null);
    } else {
        this.geodataProcessor.sendCommand(
            'processGeodata', payload, this.tile,
            (window.devicePixelRatio || 1), null,
            heightcodingRequest
                ? { heightcoding: heightcodingRequest } : null);
    }

    this.geodataProcessor.busy = true;
};


MapGeodataView.prototype.startHeightcodingRebuild = function() {

    // Request the rebuild before clearing the group set, so a refused
    // request leaves the current groups intact.
    if (!this.heightcoding.rebuild()) return false;

    this.processing = true;
    this.buildingGpuGroups = [];
    this.buildingSize = 0;
    this.currentGpuGroup = null;
    return true;
};


MapGeodataView.prototype.isReady = function(
        doNotLoad, priority, doNotCheckGpu) {
    if (this.killed) return false;

    var doNotUseGpu =
        (this.map.stats.gpuRenderUsed >= this.map.draw.maxGpuUsed);
    doNotLoad = doNotLoad || doNotUseGpu;

    if (!doNotLoad && this.surface.stylesheet.isReady()
        && this.geodata.isReady(
            doNotLoad, priority, doNotCheckGpu, false)) {

        var geodata = this.geodata.geodata;
        var mode = this.heightcodingMode;
        var payload = geodata;

        if (mode === 'store') {

            // Stale after the store dropped its terrain: re-parse below.
            if (this.ready && !this.heightcoding
                    && this.settledEpoch !== this.map.outerMap.terrainEpoch)
                this.map.gpuCache.remove(this.gpuCacheItem);

            // Hold a job while building or refining; a settled view keeps none.
            if (!this.ready || this.heightcoding) {

                this.heightcoding = this.geodata.getHeightcoding(
                    this.geodataProcessor);

                if (this.heightcoding)
                    this.heightcoding.attach(this.processorListener);
            }

            // Reached final resolution and committed here: release it.
            if (this.map.config.mapTiledGeodataDisposeOnSettled
                    && this.ready && !this.processing && !this.pendingCommands
                    && this.heightcoding && this.heightcoding.settled) {

                this.settledEpoch = this.map.outerMap.terrainEpoch;
                this.geodata.settleHeightcoding();
                this.heightcoding = null;
            }

            // Not yet settled: bring the retained samples up to date.
            if (this.heightcoding && !this.heightcodingUpdate) {

                var tileId = this.tile ? this.tile.id : null;
                var desiredGsd = this.map.outerMap.geodataHeightcodingGsd(
                    tileId, this.surface.displaySize);

                if (desiredGsd !== null) {

                    var update = this.heightcoding.update(desiredGsd);

                    if (update)
                        this.heightcodingUpdate = update.finally((function() {
                            this.heightcodingUpdate = null;
                        }).bind(this));
                }
            }
        }

        // A new parse clears currentGpuGroup. Wait for any queued
        // command buffers to drain first: one resumed mid-group would
        // otherwise find the group gone.

        if (!this.ready && !this.processing && !this.pendingCommands
            && this.geodataProcessor.isReady() && payload) {
            if (this.heightcoding && this.heightcoding.retained) {
                this.startHeightcodingRebuild();
            } else if (!this.heightcoding || !this.heightcoding.started) {
                this.startProcessing(payload, this.heightcoding);
            }
        }
    }

    if (!doNotLoad && this.gpuCacheItem) {
        this.map.gpuCache.updateItem(this.gpuCacheItem);
    }

    return this.ready;
};


MapGeodataView.prototype.getWorldMatrix = function(bbox, geoPos, matrix) {
    var m = matrix;

    if (m != null) {
        m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 0;
        m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
        m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
        m[12] = bbox.min[0] - geoPos[0];
        m[13] = bbox.min[1] - geoPos[1];
        m[14] = bbox.min[2] - geoPos[2];
        m[15] = 1;
    } else {
        m = mat4.create();

        mat4.multiply(
            math.translationMatrix(
                bbox.min[0] - geoPos[0],
                bbox.min[1] - geoPos[1],
                bbox.min[2] - geoPos[2]),
            math.scaleMatrix(1, 1, 1), m);
    }

    return m;
};


MapGeodataView.prototype.draw = function(cameraPos) {
    if (this.ready) {
        var renderer = this.renderer;
        var tiltAngle = this.tile
            ? Math.abs(this.tile.tiltAngle)
            : renderer.cameraTiltFator;

        for (var i = 0, li = this.gpuGroups.length; i < li; i++) {
            var group = this.gpuGroups[i];

            if (!group.jobs.length) continue;

            var mvp = group.mvp;
            var mv = group.mv;
            var mtmp = mvp;

            mat4.multiply(renderer.camera.getModelviewFMatrix(),
                this.getWorldMatrix(group.bbox, cameraPos, mtmp), mv);

            var proj = renderer.camera.getProjectionFMatrix();
            mat4.multiply(proj, mv, mvp);

            group.draw(mv, mvp, null, tiltAngle,
                (this.tile ? this.tile.texelSize : 1));

            this.stats.drawnFaces += group.polygons;
            this.stats.drawCalls += group.jobs.length;
        }

        if (this.statsCounter != this.stats.counter) {
            this.statsCounter = this.stats.counter;
            this.stats.gpuRenderUsed += this.size;
        }
    }

    return this.ready;
};


export default MapGeodataView;
