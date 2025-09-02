
import GpuDevice from 'gpu/device';
import GpuProgram from 'gpu/program';

type MeshData = {
    bbox: any,
    vertices: Uint16Array | Float32Array,
    uvs: Uint16Array | Float32Array,
    uvs2: Uint16Array | Float32Array,
    indices: Uint16Array
    vertexSize?: GLint,
    uvSize?: GLint,
    uv2Size?: GLint
}

type Layout = {
    itemSize: GLint, numItems: GLint
}

class GpuMesh {

    gpu: GpuDevice;
    gl: WebGL2RenderingContext;
    bbox: any;
    core: any;

    vertexBuffer: WebGLBuffer;
    vertexBufferLayout: Layout;

    uvBuffer: WebGLBuffer;
    uvBufferLayout: Layout;

    uv2Buffer: WebGLBuffer;
    uv2BufferLayout: Layout;

    indexBuffer: WebGLBuffer;
    indexBufferLayout: Layout;

    use16bit: boolean;    barycentricBuffer: WebGLBuffer = null;

    verticesUnnormalized: boolean;
    size: number;

    polygons: number;

    constructor(gpu: GpuDevice, meshData: MeshData, _: any, core: any,
                direct: boolean, use16bit: boolean,
                verticesUnnormalized: boolean) {

        this.gpu = gpu;
        this.gl = gpu.gl;
        this.bbox = meshData.bbox; //< bbox copy from Mesh
        this.core = core;
        this.vertexBuffer = null;
        this.uvBuffer = null;
        this.uv2Buffer = null;
        this.use16bit = !! use16bit;
        this.verticesUnnormalized = !! verticesUnnormalized;

        var vertices = meshData.vertices;
        var uvs = meshData.uvs;
        var uvs2 = meshData.uvs2;
        var indices = meshData.indices;
        var vertexSize = meshData.vertexSize || 3;
        var uvSize = meshData.uvSize || 2;
        var uv2Size = meshData.uv2Size || 2;

        var gl = this.gl;

        if (!vertices || !gl) {
            return;
        }

        //create vertex buffer
        this.vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);

        //when direct mode is used vertices can be also unit16
        gl.bufferData(gl.ARRAY_BUFFER, direct ? vertices : (new Float32Array(vertices)), gl.STATIC_DRAW);
        this.vertexBufferLayout = {
            itemSize: vertexSize, numItems: vertices.length / vertexSize };

        if (uvs != null) {
            //create texture coords buffer
            this.uvBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);

            gl.bufferData(gl.ARRAY_BUFFER, direct ? uvs : (new Float32Array(uvs)), gl.STATIC_DRAW);
            this.uvBufferLayout = {
                itemSize: uvSize, numItems: uvs.length / uvSize };
        }

        if (uvs2 != null) {
            //create texture coords buffer
            this.uv2Buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uv2Buffer);

            gl.bufferData(gl.ARRAY_BUFFER, direct ? uvs2 : (new Float32Array(uvs2)), gl.STATIC_DRAW);
            this.uv2BufferLayout = {
                itemSize: uv2Size, numItems: uvs2.length / uv2Size };
        }

        if (indices != null) {
            //create index buffer
            this.indexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, direct ? indices : (new Uint16Array(indices)), gl.STATIC_DRAW);
            this.indexBufferLayout = {
                itemSize: 1, numItems: indices.length }
        }

        var varSize = this.use16bit ? 2 : 4;
        this.size = this.vertexBufferLayout.numItems * vertexSize * varSize;
        this.size += (uvs) ? this.uvBufferLayout.numItems * uvSize * varSize : 0;
        this.size += (uvs2) ? this.uv2BufferLayout.numItems * uv2Size * varSize : 0;
        this.size += (indices) ? indices.length * 2 : 0;
        this.polygons = (indices) ? indices.length / 3 : this.vertexBufferLayout.numItems / 3;

    };

//destructor
kill() {
    if (!this.gl) {
        return;
    }

    if (this.vertexBuffer) {
        this.gl.deleteBuffer(this.vertexBuffer);
    }
    
    if (this.uvBuffer) {
        this.gl.deleteBuffer(this.uvBuffer);
    }

    if (this.uv2Buffer) {
        this.gl.deleteBuffer(this.uv2Buffer);
    }

    if (this.indexBuffer) {
        this.gl.deleteBuffer(this.indexBuffer);
    }
    
    this.vertexBuffer = null;
    this.uvBuffer = null;
    this.uv2Buffer = null;
    this.indexBuffer = null;
};

// Draws the mesh, given the two vertex shader attributes locations.
draw(program: GpuProgram, attrVertex: string, attrUV: string, attrUV2: string,
     attrBarycenteric: string, skipDraw: boolean) {

    var gl = this.gl;

    if (gl == null) {
        return;
    }

    // we should handle this through binding a VAO
    if (this.use16bit) {
        //bind vetex positions
        var vertexAttribute = program.getAttribLocation(attrVertex);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.vertexAttribPointer(vertexAttribute, this.vertexBufferLayout.itemSize, gl.UNSIGNED_SHORT, !this.verticesUnnormalized, 0, 0);

        //bind texture coords
        if (this.uvBuffer && attrUV) {
            var uvAttribute = program.getAttribLocation(attrUV);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
            gl.vertexAttribPointer(uvAttribute, this.uvBufferLayout.itemSize, gl.UNSIGNED_SHORT, true, 0, 0);
        }

        if (this.uv2Buffer && attrUV2) {
            var uv2Attribute = program.getAttribLocation(attrUV2);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uv2Buffer);
            gl.vertexAttribPointer(uv2Attribute, this.uv2BufferLayout.itemSize, gl.UNSIGNED_SHORT, true, 0, 0);
        }
    } else {
        //bind vetex positions
        var vertexAttribute = program.getAttribLocation(attrVertex);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.vertexAttribPointer(vertexAttribute, this.vertexBufferLayout.itemSize, gl.FLOAT, false, 0, 0);

        //bind texture coords
        if (this.uvBuffer && attrUV) {
            var uvAttribute = program.getAttribLocation(attrUV);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
            gl.vertexAttribPointer(uvAttribute, this.uvBufferLayout.itemSize, gl.FLOAT, false, 0, 0);
        }

        if (this.uv2Buffer && attrUV2) {
            var uv2Attribute = program.getAttribLocation(attrUV2);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uv2Buffer);
            gl.vertexAttribPointer(uv2Attribute, this.uv2BufferLayout.itemSize, gl.FLOAT, false, 0, 0);
        }
    }

    if (attrBarycenteric) {
        var barycentericAttribute = program.getAttribLocation(attrBarycenteric);
        
        if (barycentericAttribute != -1) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.gpu.barycentricBuffer);
            gl.vertexAttribPointer(barycentericAttribute, this.gpu.barycentricBufferLayout.itemSize, gl.FLOAT, false, 0, 0);
        }
    }

    //draw polygons
    if (this.indexBuffer) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

        if (!skipDraw) gl.drawElements(gl.TRIANGLES, this.indexBufferLayout.numItems, gl.UNSIGNED_SHORT, 0);
    }  else {
        if (!skipDraw) gl.drawArrays(gl.TRIANGLES, 0, this.vertexBufferLayout.numItems);
    }
}


// Returns GPU RAM used, in bytes.
getSize(): number { return this.size; }


getBBox(): any { return this.bbox; }


getPolygons(): number { return this.polygons; }

} // class GpuMesh

export default GpuMesh;

