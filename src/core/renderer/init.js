
import RendererGeometry_ from './geometry';
import GpuBBox_ from './gpu/bbox';
import GpuMesh_ from './gpu/mesh';
import GpuPixelLine3_ from './gpu/pixel-line3';
import GpuProgram_ from './gpu/program';
import GpuShaders_ from './gpu/shaders';
import GpuTexture_ from './gpu/texture';

//get rid of compiler mess
var RendererGeometry = RendererGeometry_;
var GpuBBox = GpuBBox_;
var GpuMesh = GpuMesh_;
var GpuPixelLine3 = GpuPixelLine3_;
var GpuProgram = GpuProgram_;
var GpuShaders = GpuShaders_;
var GpuTexture = GpuTexture_;


var RendererInit = function(renderer) {
    this.renderer = renderer;
    this.core = renderer.core;
    this.gpu = renderer.gpu;

    //renderer.font = new GpuFont(this.gpu, this.core);
    //renderer.fonts['#default'] = renderer.font;
    //renderer.font = new GpuFont(this.gpu, this.core, null, null, './allinone.fnt');

    this.initShaders();
    this.initHeightmap();
    this.initSkydome();
    this.initHitmap();
    this.initTextMap();
    this.initImage();
    this.initTestMap();
    this.initBBox();
    this.initLines();
};


RendererInit.prototype.initShaders = function() {
    var shaders = GpuShaders;
    var renderer = this.renderer;
    var gpu = this.gpu;

    renderer.progTile = [new GpuProgram(gpu, '#define variants\n' +shaders.tileVertexShader, '#define variants\n' + shaders.tileFragmentShader)];
    renderer.progTile2 = [new GpuProgram(gpu, '#define variants\n#define externalTex\n' + shaders.tileVertexShader, '#define variants\n#define externalTex\n' + shaders.tileFragmentShader.replace('__FILTER__', ''))];
    renderer.progTile3 = [new GpuProgram(gpu, '#define variants\n#define externalTex\n' + shaders.tileVertexShader, '#define variants\n#define externalTex\n#define mask\n' + shaders.tileFragmentShader.replace('__FILTER__', ''))];

    renderer.progFogTile = [new GpuProgram(gpu, '#define variants\n#define onlyFog\n' + shaders.tileVertexShader, '#define variants\n#define onlyFog\n' + shaders.tileFragmentShader)];

    var sdExt = '#extension GL_OES_standard_derivatives : enable\n';

    renderer.progFlatShadeTile = [new GpuProgram(gpu, '#define variants\n#define flatShadeVar\n' + shaders.tileVertexShader, sdExt+'#define variants\n#define flatShadeVar\n#define flatShade\n' + shaders.tileFragmentShader)];
    renderer.progFlatShadeTileSE = [new GpuProgram(gpu, '#define variants\n#define applySE\n#define flatShadeVar\n' + shaders.tileVertexShader, sdExt+'#define variants\n#define flatShadeVar\n#define flatShade\n' + shaders.tileFragmentShader)];
    renderer.progCFlatShadeTile = new GpuProgram(gpu, '#define flatShadeVar\n' + shaders.tileVertexShader, (sdExt+'#define flatShadeVar\n#define flatShade\n#define fogAndColor\n' + shaders.tileFragmentShader).replace('mediump', 'highp'));
    renderer.progCFlatShadeTileSE = new GpuProgram(gpu, '#define applySE\n#define flatShadeVar\n' + shaders.tileVertexShader, (sdExt+'#define flatShadeVar\n#define flatShade\n#define fogAndColor\n' + shaders.tileFragmentShader).replace('mediump', 'highp'));

    renderer.progDepthTile = [new GpuProgram(gpu, '#define variants\n#define depth\n' + shaders.tileVertexShader, ('#define variants\n#define depth\n' + shaders.tileFragmentShader).replace('mediump', 'highp'))];
    renderer.progDepthHeightmap = new GpuProgram(gpu, shaders.heightmapDepthVertexShader, (shaders.heightmapDepthFragmentShader).replace('mediump', 'highp'));

    renderer.progWireFrameBasic = [new GpuProgram(gpu, '#define variants\n' + shaders.tileVertexShader, '#define variants\n' + shaders.tileWireFrameBasicShader)];

    renderer.progShadedTile = new GpuProgram(gpu, shaders.shadedMeshVertexShader, shaders.shadedMeshFragmentShader);
    renderer.progTShadedTile = new GpuProgram(gpu, shaders.shadedMeshVertexShader, '#define textured\n' + shaders.shadedMeshFragmentShader);

    renderer.progHeightmap = new GpuProgram(gpu, shaders.heightmapVertexShader, shaders.heightmapFragmentShader);
    renderer.progPlane = new GpuProgram(gpu, '#define flat\n' + shaders.planeVertexShader, shaders.planeFragmentShader); //flat
    renderer.progPlane2 = new GpuProgram(gpu, '#define poles\n' + shaders.planeVertexShader, '#define poles\n' + shaders.planeFragmentShader); //poles
    renderer.progPlane3 = new GpuProgram(gpu, shaders.planeVertexShader, shaders.planeFragmentShader); // grid
    renderer.progPlaneD = new GpuProgram(gpu, '#define depth\n#define flat\n' + shaders.planeVertexShader, '#define depth\n' + shaders.planeFragmentShader); //flat
    renderer.progPlane2D = new GpuProgram(gpu, '#define depth\n#define poles\n' + shaders.planeVertexShader, '#define depth\n#define poles\n' + shaders.planeFragmentShader); //poles
    renderer.progPlane3D = new GpuProgram(gpu, '#define depth\n' + shaders.planeVertexShader, '#define depth\n' + shaders.planeFragmentShader); // grid

    renderer.progSkydome = new GpuProgram(gpu, shaders.skydomeVertexShader, shaders.skydomeFragmentShader);
    renderer.progStardome = new GpuProgram(gpu, shaders.skydomeVertexShader, shaders.stardomeFragmentShader);
    
    renderer.progAtmo2 = new GpuProgram(gpu, shaders.atmoVertexShader, shaders.atmoFragmentShader);
    renderer.progAtmo = new GpuProgram(gpu, shaders.atmoVertexShader3, shaders.atmoFragmentShader3);

    renderer.progPCloud = new GpuProgram(gpu, shaders.pointsVertexShader, shaders.pointsFragmentShader);

    renderer.progBBox = new GpuProgram(gpu, shaders.bboxVertexShader, shaders.bboxFragmentShader);
    renderer.progBBox2 = new GpuProgram(gpu, shaders.bbox2VertexShader, shaders.bboxFragmentShader);

    renderer.progLine = new GpuProgram(gpu, shaders.lineVertexShader, shaders.lineFragmentShader); //line
    renderer.progLineSE = new GpuProgram(gpu, '#define applySE\n' + shaders.lineVertexShader, shaders.lineFragmentShader); //line SE
    renderer.progELine = new GpuProgram(gpu, '#define withElements\n' + shaders.lineVertexShader, '#define withElements\n' + shaders.lineFragmentShader); //line elements 
    renderer.progELineSE = new GpuProgram(gpu, '#define applySE\n#define withElements\n' + shaders.lineVertexShader, '#define withElements\n' + shaders.lineFragmentShader); //line SE elements 
    renderer.progLine3 = new GpuProgram(gpu, '#define pixelLine\n' + shaders.lineVertexShader, shaders.lineFragmentShader); //pixel line
    renderer.progELine3 = new GpuProgram(gpu, '#define pixelLine\n#define withElements\n' + shaders.lineVertexShader, '#define withElements\n' + shaders.lineFragmentShader); //pixel line elements
    renderer.progLine3SE = new GpuProgram(gpu, '#define applySE\n#define pixelLine\n' + shaders.lineVertexShader, shaders.lineFragmentShader); //pixel line SE
    renderer.progELine3SE = new GpuProgram(gpu, '#define applySE\n#define pixelLine\n#define withElements\n' + shaders.lineVertexShader, '#define withElements\n' + shaders.lineFragmentShader); //pixel line SE elements
    renderer.progLine4 = new GpuProgram(gpu, '#define pixelLine\n#define dataPoints\n' + shaders.lineVertexShader, shaders.lineFragmentShader); //direct linestring pixel line
    renderer.progLine5 = new GpuProgram(gpu, '#define pixelLine\n#define dataPoints\n#define dataPoints2\n' + shaders.lineVertexShader, shaders.lineFragmentShader); //clipped direct linestring pixel line, physical coords
    renderer.progRLine = new GpuProgram(gpu, '#define dynamicWidth\n' + shaders.lineVertexShader, shaders.lineFragmentShader); //dynamic width line
    renderer.progRLineSE = new GpuProgram(gpu, '#define applySE\n#define dynamicWidth\n' + shaders.lineVertexShader, shaders.lineFragmentShader); //dynamic width line
    renderer.progERLine = new GpuProgram(gpu, '#define dynamicWidth\n#define withElements\n' + shaders.lineVertexShader, '#define withElements\n' + shaders.lineFragmentShader); //dynamic width line elements
    renderer.progERLineSE = new GpuProgram(gpu, '#define applySE\n#define dynamicWidth\n#define withElements\n' + shaders.lineVertexShader, '#define withElements\n' + shaders.lineFragmentShader); //dynamic width line elements

    renderer.progTLine = new GpuProgram(gpu, shaders.tlineVertexShader, shaders.tlineFragmentShader); //textured line
    renderer.progTPLine = new GpuProgram(gpu, shaders.tplineVertexShader, shaders.tlineFragmentShader); //textured pixed line
    renderer.progTBLine = new GpuProgram(gpu, shaders.tlineVertexShader, shaders.tblineFragmentShader); //textured line with background color
    renderer.progTPBLine = new GpuProgram(gpu, shaders.tplineVertexShader, shaders.tblineFragmentShader); //textured pixel line with background color
    renderer.progETLine = new GpuProgram(gpu, shaders.etlineVertexShader, shaders.elineFragmentShader); //textured line elements
    renderer.progETPLine = new GpuProgram(gpu, shaders.etplineVertexShader, shaders.elineFragmentShader); //textured pixed line elements
    //renderer.progLineWireframe = new GpuProgram(gpu, shaders.lineWireframeVertexShader, shaders.lineWireframeFragmentShader); //line with wireframe for debugging

    renderer.progText2 = new GpuProgram(gpu, '#define lineLabel\n' + shaders.lineVertexShader, shaders.text2FragmentShader); //line label 
    renderer.progText2SE = new GpuProgram(gpu, '#define applySE\n#define lineLabel\n' + shaders.lineVertexShader, shaders.text2FragmentShader); //line label 

    renderer.progLineLabel16 = new GpuProgram(gpu, '#define DSIZE 16\n#define lineLabel2\n' + shaders.lineVertexShader, shaders.text2FragmentShader); 
    renderer.progLineLabel32 = new GpuProgram(gpu, '#define DSIZE 32\n#define lineLabel2\n' + shaders.lineVertexShader, shaders.text2FragmentShader); 
    renderer.progLineLabel48 = new GpuProgram(gpu, '#define DSIZE 48\n#define lineLabel2\n' + shaders.lineVertexShader, shaders.text2FragmentShader); 
    renderer.progLineLabel64 = new GpuProgram(gpu, '#define DSIZE 64\n#define lineLabel2\n' + shaders.lineVertexShader, shaders.text2FragmentShader); 
    renderer.progLineLabel96 = new GpuProgram(gpu, '#define DSIZE 96\n#define lineLabel2\n' + shaders.lineVertexShader, shaders.text2FragmentShader); 
    renderer.progLineLabel128 = new GpuProgram(gpu, '#define DSIZE 128\n#define lineLabel2\n' + shaders.lineVertexShader, shaders.text2FragmentShader); 

    renderer.progPolygon = new GpuProgram(gpu, shaders.polygonVertexShader, shaders.polygonFragmentShader);
    renderer.progImage = new GpuProgram(gpu, shaders.imageVertexShader, shaders.imageFragmentShader);
    renderer.progIcon = new GpuProgram(gpu, shaders.iconVertexShader, shaders.textFragmentShader); //label or icon
    renderer.progIcon2 = new GpuProgram(gpu, shaders.icon2VertexShader, shaders.text2FragmentShader); //label

    renderer.progLabel16 = new GpuProgram(gpu, '#define DSIZE 16\n' + shaders.icon3VertexShader, shaders.text2FragmentShader); //label with singleBuffer
    renderer.progLabel32 = new GpuProgram(gpu, '#define DSIZE 32\n' + shaders.icon3VertexShader, shaders.text2FragmentShader);
    renderer.progLabel48 = new GpuProgram(gpu, '#define DSIZE 48\n' + shaders.icon3VertexShader, shaders.text2FragmentShader);
    renderer.progLabel64 = new GpuProgram(gpu, '#define DSIZE 64\n' + shaders.icon3VertexShader, shaders.text2FragmentShader);
    renderer.progLabel96 = new GpuProgram(gpu, '#define DSIZE 96\n' + shaders.icon3VertexShader, shaders.text2FragmentShader); 
    renderer.progLabel128 = new GpuProgram(gpu, '#define DSIZE 128\n' + shaders.icon3VertexShader, shaders.text2FragmentShader); 
};

RendererInit.prototype.initProceduralShaders = function() {
    var shaders = GpuShaders;
    var renderer = this.renderer;
    var gpu = this.gpu;
    renderer.progHmapPlane = new GpuProgram(gpu, shaders.planeVertex4Shader, shaders.planeFragmentShader2);
    renderer.progHmapPlane2 = new GpuProgram(gpu, shaders.planeVertex4Shader, '#define grid\n' + shaders.planeFragmentShader2);
    renderer.progHmapPlane3 = new GpuProgram(gpu, shaders.planeVertex4Shader, '#define exmap\n' + shaders.planeFragmentShader2);
    renderer.progHmapPlane4 = new GpuProgram(gpu, shaders.planeVertex4Shader, '#define flat\n' + shaders.planeFragmentShader2);
    renderer.progHmapPlane5 = new GpuProgram(gpu, shaders.planeVertex4Shader, '#define normals\n' + shaders.planeFragmentShader2);
    renderer.progHmapPlane6 = new GpuProgram(gpu, shaders.planeVertex4Shader, '#define nmix\n#define normals\n' + shaders.planeFragmentShader2);
    renderer.progHmapPlane7 = new GpuProgram(gpu, shaders.planeVertex4Shader, '#define nmix\n' + shaders.planeFragmentShader2);
    renderer.progHmapPlane8 = new GpuProgram(gpu, shaders.planeVertex4Shader, '#define exmap\n#define classmap\n' + shaders.planeFragmentShader2);
}

RendererInit.prototype.initHeightmap = function() {
    var renderer = this.renderer;
    var use16Bit = renderer.core.config.map16bitMeshes;
    var gpu = this.gpu;

    // initialize heightmap geometry
    var meshData = RendererGeometry.buildHeightmap(5, true);
    //renderer.heightmapMesh = new GpuMesh(gpu, meshData, this.core, use16Bit);

    meshData = RendererGeometry.buildPlane(16, true);
    renderer.planeMesh = new GpuMesh(gpu, meshData, this.core, use16Bit, false);

    meshData = RendererGeometry.buildPlane(128, true);
    renderer.planeMesh2 = new GpuMesh(gpu, meshData, this.core, use16Bit, false);

    // create heightmap texture
    var size = 64;
    var halfLineWidth = 1;
    var data = new Uint8Array( size * size * 4 );

    for (var i = 0; i < size; i++) {
        for (var j = 0; j < size; j++) {

            var index = (i*size+j)*4;

            if (i < halfLineWidth || i >= size-halfLineWidth || j < halfLineWidth || j >= size-halfLineWidth) {
                data[index] = 255;
                data[index + 1] = 255;
                data[index + 2] = 255;
            } else {
                data[index] = 32;
                data[index + 1] = 32;
                data[index + 2] = 32;
            }

            data[index + 3] = 255;
        }
    }


    renderer.heightmapTexture = new GpuTexture(gpu);
    renderer.heightmapTexture.createFromData(size, size, data, 'trilinear', true);
};


RendererInit.prototype.initHitmap = function() {
    var renderer = this.renderer;
    var size = renderer.hitmapSize;
    var data = new Uint8Array( size * size * 4 );

    if (renderer.hitmapMode > 2) {
        renderer.hitmapData = data;
    }

    renderer.hitmapTexture = new GpuTexture(this.gpu);
    renderer.hitmapTexture.createFromData(size, size, data);
    renderer.hitmapTexture.createFramebuffer(size, size);

    renderer.geoHitmapTexture = new GpuTexture(this.gpu);
    renderer.geoHitmapTexture.createFromData(size, size, data);
    renderer.geoHitmapTexture.createFramebuffer(size, size);

    renderer.geoHitmapTexture2 = new GpuTexture(this.gpu);
    renderer.geoHitmapTexture2.createFromData(size, size, data);
    renderer.geoHitmapTexture2.createFramebuffer(size, size);
};


RendererInit.prototype.initTestMap = function() {
    var renderer = this.renderer;
    var gpu = this.gpu;

   // create red texture
    var size = 16, i, j, index;
    var data = new Uint8Array( size * size * 4 );

    for (i = 0; i < size; i++) {
        for (j = 0; j < size; j++) {
            index = (i*size+j)*4;
            data[index] = 255;
            data[index + 1] = 0;
            data[index + 2] = 0;
            data[index + 3] = 255;
        }
    }

    renderer.redTexture = new GpuTexture(gpu);
    renderer.redTexture.createFromData(size, size, data);

    data = new Uint8Array( size * size * 4 );

    for (i = 0; i < size; i++) {
        for (j = 0; j < size; j++) {
            index = (i*size+j)*4;
            data[index] = 255;
            data[index + 1] = 255;
            data[index + 2] = 255;
            data[index + 3] = 255;
        }
    }

    renderer.whiteTexture = new GpuTexture(gpu);
    renderer.whiteTexture.createFromData(size, size, data);

    data = new Uint8Array( size * size * 4 );

    for (i = 0; i < size; i++) {
        for (j = 0; j < size; j++) {
            index = (i*size+j)*4;
            data[index] = 0;
            data[index + 1] = 0;
            data[index + 2] = 0;
            data[index + 3] = 255;
        }
    }

    renderer.blackTexture = new GpuTexture(gpu);
    renderer.blackTexture.createFromData(size, size, data);
};


RendererInit.prototype.initTextMap = function() {
    var renderer = this.renderer;

    //font texture
    var texture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAACAAgMAAACZ21+ZAAAADFBMVEUAAAAAAAAAAAD///81VxGEAAAAAXRSTlMAQObYZgAAA25JREFUaN7tmFtu7CAMQC1lAd5KFxCJrUfqAu5WLPUXiRseBhuchMxM1Z8QTUl4nAS/MAXYC+0/xPxLD/sf5/fn2B4AQmqzCrVKAkgAXAT4G4Cwv46WDdY1A9IQ1ONr2ceZgDhhCiDb69tLBy+Bn2m9AMRSAWsEUOvbB3pvANYOUJdApRYAJ9q4rhNtwKYAuE0Acgcl4RLC8AX9ElgJAyAJrwNYMsDeLHgJFoC14GcAa7RF1DLgBwZ4oQQlRDZlFlRvyhJAx4A4Kbf2zkQW4E55adIpQFpeundU7+WvFz3x3AEQLgBrq8pcAq7jtVB2qPyTVw1W9UMIDABu5wA232TuCYAk0Hsok29T09ubedlZ504D/AWgrn1lAAn/D1StkB2rFyKpT9mffrY3AaHYLn8yTyTQdR/FgGOkvwlA+SnUdKmURQcAVmN8iYhG9wAsL5S+oE3Wvq8YYcrVIW4BZKijP48FWQahfCZ0NX86lZDWlhGEwQnA1tWTgKiQ9LgrtnddViQqx8r+4/npFmBpgGAD4ByAWwNsDAg3AA4q4IcYsGAVHk9ImviXo1UzW0o7FAPIiy/Q1saqNABBABwDvvHQfWqg7WWQ7svIrxDmAYsYs1Qt9OHbBpDp8J8ANLPUpqxMlrT58hV0h3amacDfl+a6oFy4v1Ifpz/U5YZ9HJgBLF6E9V6vFgCKEXE0RjQBMAA8W1wxYyxj1nbYOAc4zIEGiiujGDMFwFAGe5Gh7DcbfMlDRhOiAuxuG4WV9kKdh2g1zgBwOwDUAME9HSAuoYig7Y0DwI+AJH3KQuQsnVp+1wHcaAdJ+pRBze2PADgCkvRJtpV5yzYCuq0qS9239poKFymGGYAMNqeAdz35fQANyUM76mi7ISAryfg9gJHW/B4gmMccUJsuiBRgOApNA/AAYEVBHI4bOsHoDiKTAH8AaKG8nZstANvN5wHW9o4GuC4BXgW4A4ClxiE7LWoMovXUDkzAcgCY8feXfP8lAJ71hba9B49/AQB5aA8fAgwqPMhQmnkbu/MZgDOU/B8uffg0EwyEgwylBJNhnVeAmqE4uALA6MYlweAU52IJGsD5AQMWgnMhctBgAOcHGFqKcwvA+UEExX4HBwC5bfESZH6QMhS2A2HKlwCVH8wAXs4D3gY85SlPecpTnvKUp3TlPzpx58f+rik4AAAAAElFTkSuQmCC';

    renderer.textTexture2 = new GpuTexture(this.gpu, texture, this.core, null, true);
};


RendererInit.prototype.initImage = function() {
    var renderer = this.renderer;
    var gl = this.gpu.gl;

    //create vertices buffer for rect
    renderer.rectVerticesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.rectVerticesBuffer);

    var vertices = [ 0, 0, 0, 1,   1, 0, 0, 1,   2, 0, 0, 1,   3, 0, 0, 1 ];

    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    renderer.rectVerticesBuffer.itemSize = 4;
    renderer.rectVerticesBuffer.numItems = 4;

    //create indices buffer for rect
    renderer.rectIndicesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.rectIndicesBuffer);

    var indices = [ 0, 2, 1,    0, 3, 2 ];

    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    renderer.rectIndicesBuffer.itemSize = 1;
    renderer.rectIndicesBuffer.numItems = 6;

    renderer.textBuff16 = new Float32Array(16 * 4);
    renderer.textBuff32 = new Float32Array(32 * 4);
    renderer.textBuff48 = new Float32Array(48 * 4);
    renderer.textBuff64 = new Float32Array(64 * 4);

    renderer.textQuads16 = this.generateTextQuads(16);
    renderer.textQuads32 = this.generateTextQuads(32);
    renderer.textQuads48 = this.generateTextQuads(48);
    renderer.textQuads64 = this.generateTextQuads(64);
    renderer.textQuads96 = this.generateTextQuads(96);
    renderer.textQuads128 = this.generateTextQuads(128);
};


RendererInit.prototype.generateTextQuads = function(num) {

    var gl = this.gpu.gl;

    var buffer = new Float32Array(num * 2 * 6);
    var index, j;

    for (var i = 0; i < num; i++) {
        index = i * 6 * 2;

        j = 0;
        buffer[index] = i;
        buffer[index+1] = j;

        j = 1;
        buffer[index+2] = i;
        buffer[index+3] = j;

        j = 2;
        buffer[index+4] = i;
        buffer[index+5] = j;

        j = 2;
        buffer[index+6] = i;
        buffer[index+7] = j;

        j = 3;
        buffer[index+8] = i;
        buffer[index+9] = j;

        j = 0;
        buffer[index+10] = i;
        buffer[index+11] = j;
    }

    //create vertices buffer for rect
    var vbuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuffer);

    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);
    vbuffer.itemSize = 2;
    vbuffer.numItems = num * 6;

    return vbuffer;
};

RendererInit.prototype.initSkydome = function() {
    var renderer = this.renderer;
    var use16Bit = renderer.core.config.map16bitMeshes;
    var meshData = RendererGeometry.buildSkydome(32, 64, use16Bit);
    renderer.skydomeMesh = new GpuMesh(this.gpu, meshData, this.core, use16Bit);
    //this.skydomeTexture = new GpuTexture(this.gpu, "./skydome.jpg", this.core);

    meshData = RendererGeometry.buildSkydome(128, 256, use16Bit, true);
//    var meshData = RendererGeometry.buildSkydome(256, 512);
    renderer.atmoMesh = new GpuMesh(this.gpu, meshData, this.core, use16Bit);
};


RendererInit.prototype.initBBox = function() {
    var renderer = this.renderer;
    var gpu = this.gpu;
    renderer.bboxMesh = new GpuBBox(gpu);
    renderer.bboxMesh2 = new GpuBBox(gpu, true);
};


RendererInit.prototype.initLines = function() {
    var gpu = this.gpu;
    var renderer = this.renderer;
    renderer.plineBuffer = new Float32Array(32*3);
    renderer.plines = new GpuPixelLine3(gpu, this.core, true, 64, true, 8);
    renderer.plineJoints = new GpuPixelLine3(gpu, this.core, false, 64, true, 8);

    renderer.stencilLineState = gpu.createState({blend:true, stencil:true, culling: false});
    renderer.lineLabelState = gpu.createState({blend:true, culling: false, zequal: true, zwrite:false});
    renderer.labelState = gpu.createState({blend:true, culling: false, zequal: true});
    renderer.stencilLineHitState = gpu.createState({blend:false, stencil:true, culling: false});
    renderer.lineLabelHitState = gpu.createState({blend:false, culling: false});

    renderer.polygonB1S1C1tate = gpu.createState({blend:true, stencil:true, culling: true, zequal: true});
    renderer.polygonB1S0C1tate = gpu.createState({blend:true, stencil:false, culling: true, zequal: true});
    renderer.polygonB1S1C0tate = gpu.createState({blend:true, stencil:true, culling: false, zequal: true});
    renderer.polygonB1S0C0tate = gpu.createState({blend:true, stencil:false, culling: false, zequal: true});

    renderer.polygonB0S1C1tate = gpu.createState({blend:false, stencil:true, culling: true, zequal: true});
    renderer.polygonB0S0C1tate = gpu.createState({blend:false, stencil:false, culling: true, zequal: true});
    renderer.polygonB0S1C0tate = gpu.createState({blend:false, stencil:true, culling: false, zequal: true});
    renderer.polygonB0S0C0tate = gpu.createState({blend:false, stencil:false, culling: false, zequal: true});

};

export default RendererInit;
