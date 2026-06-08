
import BBox_ from './bbox';

//get rid of compiler mess
var BBox = BBox_;


var RendererGeometry = {};


RendererGeometry.setFaceVertices = function(vertices, a, b, c, index) {
    vertices[index] = a[0];
    vertices[index+1] = a[1];
    vertices[index+2] = a[2];

    vertices[index+3] = b[0];
    vertices[index+4] = b[1];
    vertices[index+5] = b[2];

    vertices[index+6] = c[0];
    vertices[index+7] = c[1];
    vertices[index+8] = c[2];
};


RendererGeometry.setFaceUVs = function(uvs, a, b, c, index) {
    uvs[index] = a[0];
    uvs[index+1] = a[1];

    uvs[index+2] = b[0];
    uvs[index+3] = b[1];

    uvs[index+4] = c[0];
    uvs[index+5] = c[1];
};


// Procedural mesh representing a heightmap block
// Creates a grid of size x size vertices, all coords are [0..1].
RendererGeometry.buildHeightmap = function(size, use16bit) {
    size--;

    var g = RendererGeometry;
    var numFaces = (size* size) * 2;
    var vertices = new Float32Array(numFaces * 3 * 3);//[];
    var uvs = new Float32Array(numFaces * 3 * 2);//[];

    var factor = 1.0 * size;
    var index = 0;
    var index2 = 0;

    for (var i = 0; i < size; i++) {
        for (var j = 0; j < size; j++) {
            var x1 = (j) * factor;
            var x2 = (j+1) * factor;

            var y1 = (i) * factor;
            var y2 = (i+1) * factor;

            g.setFaceVertices(vertices, [x1, y1, 0], [x2, y1, 0], [x2, y2, 0], index);
            g.setFaceUVs(uvs, [x1, y1], [x2, y1], [x2, y2], index2);
            index += 9;
            index2 += 6;

            g.setFaceVertices(vertices, [x2, y2, 0], [x1, y2, 0], [x1, y1, 0], index);
            g.setFaceUVs(uvs, [x2, y2], [x1, y2], [x1, y1], index2);
            index += 9;
            index2 += 6;
        }
    }

    var bbox = new BBox(0,0,0,1,1,1);

    if (use16bit) {
        return { bbox:bbox, vertices:this.covnetTo16Bit(vertices), uvs: this.covnetTo16Bit(uvs)};
    } else {
        return { bbox:bbox, vertices:vertices, uvs: uvs};
    }
};


RendererGeometry.covnetTo16Bit = function(array) {
    var t, array2 = new Uint16Array(array.length);

    for (var i = 0, li = array.length; i < li; i++) {
        t = array[i] * 65535;
        if (t < 0) t = 0; if (t > 65535) t = 65535;
        array2[i] = t;
    }

    return array2;
}


export default RendererGeometry;

