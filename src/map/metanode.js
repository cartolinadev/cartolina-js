
import {vec3 as vec3_} from '../utils/matrix';
import * as utils from '../utils/utils';
import BBox_ from '../renderer/bbox';

//get rid of compiler mess
var vec3 = vec3_;
var BBox = BBox_;


var MapMetanode = function(metatile, id, stream, divisionNode) {
    this.metatile = metatile;
    this.map = metatile.map;
    this.id = id;
    this.credits = [];
    this.watertight = false;
    this.ready = false;
    this.divisionNode = divisionNode;

    this.diskPos = new Array(3);
    this.diskDistance = 1; 
    this.diskNormal = new Array(3); 
    this.diskAngle = 1;
    this.diskAngle2 = 1;
    this.diskAngle2A = 1;
    //this.bboxHeight = 1;
    this.bbox2 = new Array(24);

    // vertical-exaggeration scale factor last baked into minZ/maxZ and
    // bbox2; compared against the live factor to detect a stale bake as
    // the camera zooms (see MapSurfaceTile.isMetanodeReady)
    this.veBakedFactor = undefined;

    //this.flagsGeometryPresent =  1;
    //this.flagsNavtilePresent =  3;
    //this.flagsInternalTexturePresent =  7;
    //this.flagsCoarsenessControl =  15;
    //this.flagsChildShift =  3;

    if (stream) {
        this.parseMetanode(stream);
    }
};


MapMetanode.prototype.kill = function() {
};


MapMetanode.prototype.hasChild = function(index) {
    return ((this.flags & (1<<(index+4))) != 0);
};


MapMetanode.prototype.hasChildById = function(id) {
    var ix = id[1] - (this.id[1]<<1); 
    var iy = id[2] - (this.id[2]<<1);
    
    //ul,ur,ll,lr
    return this.hasChild((iy<<1) + ix); 
};


MapMetanode.prototype.hasChildren = function() {
    return ((this.flags & ((15)<<4)) != 0);
};


MapMetanode.prototype.parseExtentBits = function(extentBytes, extentBits, index) {
    var value = 0;

    for (var i = 0, li = extentBits; i < li; i++) {
        var byteIndex = index >> 3;
        var bitIndex = index & 0x7;

        if (extentBytes[byteIndex] & (1 << (7-bitIndex))) {
            value = value | (1 << (li - i - 1));
        }

        index ++;
    }

    value /= (1 << li) - 1;
//    value *= maxExtent;

    return value;
};


MapMetanode.prototype.hasGeometry = function() {
    return ((this.flags & 1) != 0);
};


MapMetanode.prototype.hasNavtile = function() {
    return ((this.flags & (1 << 1)) != 0);
};


MapMetanode.prototype.usedTexelSize = function() {
    return ((this.flags & (1 << 2)) != 0);
};


MapMetanode.prototype.usedDisplaySize = function() {
    return ((this.flags & (1 << 3)) != 0);
};

MapMetanode.prototype.parseMetanode = function(stream) {

/*
struct Metanode {
    char flags;                   // #0 - geometry present, #1 - navtile present #2 - applyTexelSize,
                                  // #3 - applyPixelSize, #4,5,6,7 - ul,ur,ll,lr child exists
    char geomExtents[];           // a packed array of 6 bit sequences, each lod+2 long, in the following order:
                                  // minx,maxx,miny,maxy,minz,maxz, undefined if no geometry present
    uchar internalTextureCount;   // number of internal textures in geometry
    hfloat texelSize;             // internal texel size in physical srs units, undef unless applyTexelSize is set
    ushort displaySize;           // desired display size, undef unless applyDisplay size is set
    short minHeight, maxHeight;   // navigation tile value range, undef if no navtile present
}
*/

    var streamData = stream.data;
    //var lastIndex = stream.index;
    var version = this.metatile.version;

    this.flags = streamData.getUint8(stream.index, true); stream.index += 1;

    if (version < 5) {
        var extentsSize = (((this.id[0] + 2) * 6 + 7) >> 3);
        var extentsBytes = this.map.metanodeBuffer;//new Uint8Array(extentsSize);
    
        for (var i = 0, li = extentsSize; i < li; i++) {
            extentsBytes[i] = streamData.getUint8(stream.index, true); stream.index += 1;
        }
    
        var extentBits = this.id[0] + 2;
    
        var minExtents = [0,0,0];
        var maxExtents = [0,0,0];
    
        var index = 0;
        var spaceExtentSize = this.map.spaceExtentSize;
        var spaceExtentOffset = this.map.spaceExtentOffset;
    
        for (i = 0; i < 3; i++) {
            minExtents[i] = this.parseExtentBits(extentsBytes, extentBits, index) * spaceExtentSize[i] + spaceExtentOffset[i];
            //minExtents[i] = this.parseExtentBits(extentsBytes, extentBits, index, 1.0);
            index += extentBits;
            maxExtents[i] = this.parseExtentBits(extentsBytes, extentBits, index) * spaceExtentSize[i] + spaceExtentOffset[i];
            //maxExtents[i] = this.parseExtentBits(extentsBytes, extentBits, index, 1.0);
            index += extentBits;
        }
    
        //check zero bbox
        var extentsBytesSum = 0;
        for (i = 0, li = extentsBytes.length; i < li; i++) {
            extentsBytesSum += extentsBytes[i];
        }
        
        //extent bytes are empty and therefore bbox is empty also
        if (extentsBytesSum == 0 ) {
            //console.log("empty-node: id: " + JSON.stringify(this.id));
            //console.log("empty-node: surafce: " + this.metatile.surface.id);
    
            minExtents[0] = Number.POSITIVE_INFINITY;
            minExtents[1] = Number.POSITIVE_INFINITY;
            minExtents[2] = Number.POSITIVE_INFINITY;
            maxExtents[0] = Number.NEGATIVE_INFINITY;
            maxExtents[1] = Number.NEGATIVE_INFINITY;
            maxExtents[2] = Number.NEGATIVE_INFINITY;
        }
    
        this.bbox = new BBox(minExtents[0], minExtents[1], minExtents[2], maxExtents[0], maxExtents[1], maxExtents[2]);
    }    

    //this.surrogatezHeight = 0;

    this.minZ = streamData.getFloat32(stream.index, true); stream.index += 4;
    this.maxZ = streamData.getFloat32(stream.index, true); stream.index += 4;
    this.surrogatez = streamData.getFloat32(stream.index, true); stream.index += 4;

    //if (!(this.minZ > this.maxZ || this.surrogatez == Number.NEGATIVE_INFINITY)) {
      //  this.surrogatezHeight = this.surrogatez; //have to converted to nav srs height
    //}

    if (version >= 5) {
        // values are probably not needed for frontend
        /*this.llx = */streamData.getFloat32(stream.index, true); stream.index += 4;
        /*this.lly = */streamData.getFloat32(stream.index, true); stream.index += 4;
        /*this.urx = */streamData.getFloat32(stream.index, true); stream.index += 4;
        /*this.ury = */streamData.getFloat32(stream.index, true); stream.index += 4;
    }

    this.internalTextureCount = streamData.getUint8(stream.index, true); stream.index += 1;

    this.pixelSize = utils.decodeFloat16( streamData.getUint16(stream.index, true) ); stream.index += 2;
    this.displaySize = streamData.getUint16(stream.index, true); stream.index += 2;
    if ((this.flags & (1 << 2)) == 0) {
        this.pixelSize = Number.POSITIVE_INFINITY;
    }

    if ((this.flags & (1 << 3)) == 0) {
        this.displaySize = 256;
    }

    this.minHeight = streamData.getInt16(stream.index, true); stream.index += 2;
    this.maxHeight = streamData.getInt16(stream.index, true); stream.index += 2;

    this.minZ2 = this.minZ;
    this.maxZ2 = this.maxZ;

    if (this.metatile.flags & (1<<7)) {
        this.sourceReference = streamData.getUint16(stream.index, true); stream.index += 2;
    } else if (this.metatile.flags & (1<<6)) {
        this.sourceReference = streamData.getUint8(stream.index, true); stream.index += 1;
    }

    this.watertight = false;

    //var nodeSize2 = stream.index - lastIndex;

    //if (!this.map.config.mapSmartNodeParsing) {
    this.generateCullingHelpers();
    //}    
};


MapMetanode.prototype.clone = function() {
    var node = new  MapMetanode(this.metatile, this.id);
    node.flags = this.flags;
    node.minHeight = this.minHeight;
    node.maxHeight = this.maxHeight;
    node.minZ = this.minZ;
    node.maxZ = this.maxZ;
    node.minZ2 = this.minZ2;
    node.maxZ2 = this.maxZ2;
    node.llx = this.llx;
    node.lly = this.lly;
    node.urx = this.urx;
    node.ury = this.ury;
    node.surrogatez = this.surrogatez;
    node.internalTextureCount = this.internalTextureCount;
    node.pixelSize = this.pixelSize;
    node.displaySize = this.displaySize;
    node.ready = this.ready;
    node.stream = this.stream;
    node.watertight = this.watertight;
    
    //copy credits
    node.credits = new Array(this.credits.length);
    
    for (var i = 0, li = this.credits.length; i < li; i++) {
        node.credits[i] = this.credits[i];
    }

    if (this.bbox) {
        node.bbox = this.bbox.clone();
    }


//    if (this.map.config.mapGeocentCulling) {
    node.diskPos = this.diskPos;
    node.diskNormal = this.diskNormal; 
    node.diskAngle = this.diskAngle;
    node.diskAngle2 = this.diskAngle2;
    node.diskAngle2A = this.diskAngle2A;
    node.diskDistance = this.diskDistance; 
    node.bbox2 = this.bbox2;  

    node.divisionNode = this.divisionNode;

 //   }

    if (this.plane) {
        node.plane = this.plane.slice();
    }

    return node;
};


MapMetanode.prototype.generateCullingHelpers = function(virtual) {
    this.ready = true;
    
    var map = this.map;
    var draw = map.draw;
    var geocent = map.isGeocent;
    var version = this.metatile.version;

    if (this.id[0] < map.measure.minDivisionNodeDepth) {
        return;
    }

    // version >= 4 no longer carries quantized physical extents, computed here
    //use division node srs

    if (virtual) {
        return; //result is same for each tile id
    }

    var divisionNode;
    var llx, lly, urx, ury;
    var pos = draw.tmpVec3;
    
    if (this.id[0] > map.measure.maxDivisionNodeDepth) {
        var pos2 = draw.tmpVec5;
        
        divisionNode = map.measure.getSpatialDivisionNodeFromId(this.id);

        if (!divisionNode) {
            return;
        }

        map.measure.getSpatialDivisionNodeAndExtents2(this.id, pos2, divisionNode);
        //var node = pos2[0]; 
        llx = pos2[1];
        lly = pos2[2];
        urx = pos2[3];
        ury = pos2[4];

        this.divisionNode = divisionNode;

        /*if (this.id[0] == 2 && this.id[1] == 0 && this.id[2] == 2) {
            var res = this.map.measure.getSpatialDivisionNodeAndExtents(this.id);
            res = res;
        }*/
        
    } else {
        var res = map.measure.getSpatialDivisionNodeAndExtents(this.id);
        divisionNode = res ? res[0] : null; 

        if (!divisionNode) {
            return;
        }
                    
        llx = res[1][0][0];
        lly = res[1][0][1];
        urx = res[1][1][0];
        ury = res[1][1][1];
        this.divisionNode = divisionNode;
    }

    this.llx = llx;
    this.lly = lly;
    this.urx = urx;
    this.ury = ury;
    
    var h = this.minZ;
    //var middle = [(ur[0] + ll[0])* 0.5, (ur[1] + ll[1])* 0.5, h];
    //var normal = [0,0,0];
    
    pos[0] = (urx + llx)* 0.5; 
    pos[1] = (ury + lly)* 0.5; 
    pos[2] = h; 
    
    divisionNode.getPhysicalCoordsFast(pos, true, this.diskPos, 0, 0);
    
    if (geocent) {
        this.diskDistance = vec3.length(this.diskPos); 
        vec3.normalize(this.diskPos, this.diskNormal);
    } else {
        this.diskNormal[0] = 0;
        this.diskNormal[1] = 0;
        this.diskNormal[2] = 1;
    }
    //this.diskNormal = normal;   
    var normal = this.diskNormal;
    
    
    //if (divisionNode.id[0] == 1 && divisionNode.id[1] ==  1 && divisionNode.id[2] == 0) {   //???? debug?????
      //  var res = this.map.getSpatialDivisionNodeAndExtents(this.id);
      //  node = node;
    //}
    
    pos[0] = urx; 
    pos[1] = ury; 
    pos[2] = h; 

    /*if (this.id[0] == 17 && this.id[1] == 53306 && this.id[2] == 30754) {
        normal = normal;
    }*/
    
    var bbox = this.bbox2;

    divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 0);

    pos[1] = lly; 
    divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 3);
    
    pos[0] = llx; 
    divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 6);
    
    pos[1] = ury; 
    divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 9);

    var height;

    if (!geocent) {
        height = this.maxZ - h;
        
        bbox[12] = bbox[0];
        bbox[13] = bbox[1];
        bbox[14] = bbox[2] + height;
        
        bbox[15] = bbox[3];
        bbox[16] = bbox[4];
        bbox[17] = bbox[5] + height;
    
        bbox[18] = bbox[6];
        bbox[19] = bbox[7];
        bbox[20] = bbox[8] + height;
    
        bbox[21] = bbox[9];
        bbox[22] = bbox[10];
        bbox[23] = bbox[11] + height;
        return;        
    }

    var normalize;
    var dot = vec3.dot;
    var d1, d2, d3, d4, maxDelta;

    height = this.maxZ - h;

    if (this.id[0] <= 3) { //get aabbox for low lods
        normalize = vec3.normalize2; 

        normalize(bbox, 0, pos);
        d1 = dot(normal, pos);
        
        normalize(bbox, 3, pos);
        d2 = dot(normal, pos);

        normalize(bbox, 6, pos);
        d3 = dot(normal, pos);

        normalize(bbox, 9, pos);
        d4 = dot(normal, pos);

        maxDelta = Math.min(d1, d2, d3, d4);

        pos[0] = (urx + llx)* 0.5; 
        pos[1] = ury; 
        pos[2] = h; 
        
        divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 12);

        pos[1] = lly; 
        divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 15);

        pos[0] = urx; 
        pos[1] = (ury + lly)* 0.5; 
        divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 18);

        pos[0] = llx; 
        divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 21);

        var mpos = this.diskPos;
        var maxX = Math.max(bbox[0], bbox[3], bbox[6], bbox[9], bbox[12], bbox[15], bbox[18], bbox[21], mpos[0]);
        var minX = Math.min(bbox[0], bbox[3], bbox[6], bbox[9], bbox[12], bbox[15], bbox[18], bbox[21], mpos[0]);
        
        var maxY = Math.max(bbox[1], bbox[4], bbox[7], bbox[10], bbox[13], bbox[16], bbox[19], bbox[22], mpos[1]);
        var minY = Math.min(bbox[1], bbox[4], bbox[7], bbox[10], bbox[13], bbox[16], bbox[19], bbox[22], mpos[1]);
        
        var maxZ = Math.max(bbox[2], bbox[5], bbox[8], bbox[11], bbox[14], bbox[17], bbox[20], bbox[23], mpos[2]);
        var minZ = Math.min(bbox[2], bbox[5], bbox[8], bbox[11], bbox[14], bbox[17], bbox[20], bbox[23], mpos[2]);
        
        if (this.id[0] <= 1) {
            pos[0] = urx + (llx-urx )* 0.25; 
            pos[1] = (ury + lly)* 0.5; 
            
            divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 12);
    
            pos[0] = urx + (llx-urx )* 0.75; 
            divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 15);
    
            pos[0] = (urx + llx)* 0.5; 
            pos[1] = ury + (lly-ury )* 0.25; 
            divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 18);
    
            pos[1] = ury + (lly-ury )* 0.75; 
            divisionNode.getPhysicalCoordsFast(pos, true, bbox, 0, 21);

            maxX =  Math.max(maxX, bbox[12], bbox[15], bbox[18], bbox[21]);
            minX =  Math.min(minX, bbox[12], bbox[15], bbox[18], bbox[21]);
            
            maxY =  Math.max(maxY, bbox[13], bbox[16], bbox[19], bbox[22]);
            minY =  Math.min(minY, bbox[13], bbox[16], bbox[19], bbox[22]);
            
            maxZ =  Math.max(maxZ, bbox[14], bbox[17], bbox[20], bbox[23]);
            minZ =  Math.min(minZ, bbox[14], bbox[17], bbox[20], bbox[23]);

            maxDelta = -1;//full circle;
        }

        bbox[0] = minX; bbox[1] = minY; bbox[2] = minZ;
        bbox[3] = maxX; bbox[4] = minY; bbox[5] = minZ;
        bbox[6] = maxX; bbox[7] = maxY; bbox[8] = minZ;
        bbox[9] = minX; bbox[10] = maxY; bbox[11] = minZ;

        bbox[12] = minX; bbox[13] = minY; bbox[14] = maxZ;
        bbox[15] = maxX; bbox[16] = minY; bbox[17] = maxZ;
        bbox[18] = maxX; bbox[19] = maxY; bbox[20] = maxZ;
        bbox[21] = minX; bbox[22] = maxY; bbox[23] = maxZ;
    } else {

        normalize = vec3.normalize3; 
        dot = vec3.dot2;

        normalize(bbox, 0, bbox, 12);
        d1 = dot(normal, bbox, 12);
        
        normalize(bbox, 3, bbox, 15);
        d2 = dot(normal, bbox, 15);

        normalize(bbox, 6, bbox, 18);
        d3 = dot(normal, bbox, 18);

        normalize(bbox, 9, bbox, 21);
        d4 = dot(normal, bbox, 21);
    
        maxDelta = Math.min(d1, d2, d3, d4);

        if (this.id[0] <= 8) { //extend bbox because of lon curvature
            pos = this.diskPos;

            var expand = 0.12 / (9-4) * (5-(this.id[0]-4));

            bbox[0] += (bbox[0] - pos[0]) * expand;
            bbox[1] += (bbox[1] - pos[1]) * expand;
            bbox[2] += (bbox[2] - pos[2]) * expand;

            bbox[3] += (bbox[3] - pos[0]) * expand;
            bbox[4] += (bbox[4] - pos[1]) * expand;
            bbox[5] += (bbox[5] - pos[2]) * expand;

            bbox[6] += (bbox[6] - pos[0]) * expand;
            bbox[7] += (bbox[7] - pos[1]) * expand;
            bbox[8] += (bbox[8] - pos[2]) * expand;

            bbox[9] += (bbox[9] - pos[0]) * expand;
            bbox[10] += (bbox[10] - pos[1]) * expand;
            bbox[11] += (bbox[11] - pos[2]) * expand;
        }

        //extend bbox height by tile curvature 
        height += draw.planetRadius - (draw.planetRadius * maxDelta);  
        
        bbox[12] = bbox[0] + bbox[12] * height;
        bbox[13] = bbox[1] + bbox[13] * height;
        bbox[14] = bbox[2] + bbox[14] * height;
        
        bbox[15] = bbox[3] + bbox[15] * height;
        bbox[16] = bbox[4] + bbox[16] * height;
        bbox[17] = bbox[5] + bbox[17] * height;
    
        bbox[18] = bbox[6] + bbox[18] * height;
        bbox[19] = bbox[7] + bbox[19] * height;
        bbox[20] = bbox[8] + bbox[20] * height;
    
        bbox[21] = bbox[9] + bbox[21] * height;
        bbox[22] = bbox[10] + bbox[22] * height;
        bbox[23] = bbox[11] + bbox[23] * height;
    }

    if (version >= 5 && this.usedDisplaySize()) {
        this.bboxMaxSize = Math.max(
            vec3.distance2(bbox, 0, bbox, 3),
            vec3.distance2(bbox, 3, bbox, 6),
            vec3.distance2(bbox, 0, bbox, 12)
        );
    }

    //get cos angle based at 90deg
    this.diskAngle = Math.cos(Math.max(0,(Math.PI * 0.5) - Math.acos(maxDelta)));
    this.diskAngle2 = maxDelta;
    this.diskAngle2A = Math.acos(maxDelta); //optimalization

    //shift center closer to earth
    //var factor = this.bbox.maxSize * 0.2; 
    //this.diskPos = [this.diskPos[0] - normal[0] * factor, this.diskPos[1]  - normal[1] * factor, this.diskPos[2] - normal[2] * factor];   

    //console.log(this.bbox2);
};


MapMetanode.prototype.drawBBox = function() {
    //var spoints = []; 
    //for (var i = 0, li = this.bbox2.length; i < li; i++) {
        //var pos = this.bbox2[i];
        //pos = ["obj", pos[0], pos[1], "fix", pos[2], 0, 0, 0, 10, 90 ];
        
    var bbox = this.bbox2;
    var buffer = this.map.draw.bboxBuffer;
    var camPos = this.map.camera.position;
    var renderer = this.map.renderer;
    var prog = renderer.progBBox2;

    for (var i = 0, li = 8*3; i < li; i+=3) {
        //var pos = ["obj", bbox[i], bbox[i+1], "fix", bbox[i+2], 0, 0, 0, 10, 90 ];
        //var coords = this.map.convert.getPositionCameraCoords((new MapPosition(pos)), null, true);

        buffer[i] = bbox[i] - camPos[0];
        buffer[i+1] = bbox[i+1] - camPos[1];
        buffer[i+2] = bbox[i+2] - camPos[2];
    }
    

    renderer.gpu.useProgram(prog, ['aPosition']);

    prog.setFloatArray('uPoints', buffer);

    //var mvp = mat4.create();
    //var mv = mat4.create();

    //mat4.multiply(renderer.camera.getModelviewMatrix(), this.getWorldMatrix(cameraPos), mv);

    //var proj = renderer.camera.getProjectionMatrix();
    //mat4.multiply(proj, mv, mvp);

    var mvp = renderer.camera.getMvpMatrix();

    prog.setMat4('uMVP', mvp);

    //draw bbox
    renderer.bboxMesh2.draw(prog, 'aPosition');
};


export default MapMetanode;
