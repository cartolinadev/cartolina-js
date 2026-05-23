
import GpuDevice from './device';
import GpuProgram from './program';

// class GpuMesh

export class GpuMesh {

    gl!: WebGL2RenderingContext;
    private bbox!: any;

    private vertexBuffer: WebGLBuffer | null = null;
    vertexBufferLayout!: Layout;

    private uvBuffer: WebGLBuffer | null = null;
    private uvBufferLayout!: Layout;

    private uv2Buffer: WebGLBuffer | null = null;
    private uv2BufferLayout!: Layout;

    indexBuffer: WebGLBuffer | null = null;
    indexBufferLayout!: Layout;

    private use16bit!: boolean;
    private vertexDataType!: VertexDataType;
    private normalize!: boolean;

    private size!: number;
    polygons!: number;

    /**
     * VAO cache keyed by program. Attribute locations can differ per program.
     */
    private vaos = new Map<GpuProgram, WebGLVertexArrayObject>();

    private disposed_ = false;

    /**
     * Create a GPUMesh object from mesh data. Buffer data to the GPU.
     *
     * @param meshData the actual mesh data to work with. Both indexed and
     *      plain array payloads seem to be supported.
     * @param use16bit In the new API (draw2), this parameter is ignored, we
     *       work with the data passed in MeshData. In the old API (draw), it
     *      governs type passed to gl.vertexAttribPointer (gl.UNSIGNED_SHORT if
     *      true, gl.FLOAT otherwise).
     * @param normalize Relevant only when use16bit = true. If true,
     *      'normalized' is set in the call to gl.vertexAttribPointer and the
     *      provided vertex coordinates, if uint, are normalized by gl to the
     *      [0, 1] range before being passed to the vertex shader.
     *      Note that regardless of this parameter, uv coordinates, if uint,
     *      are always normalized before being passed to the shader.
     */
    constructor(gpu: GpuDevice, meshData: GpuMesh.MeshData, _core: unknown,
                use16bit: boolean = false,
                normalize: boolean = true) {

        this.gl = gpu.gl;
        this.bbox = meshData.bbox; //< bbox copy from Mesh
        this.vertexBuffer = null;
        this.uvBuffer = null;
        this.uv2Buffer = null;
        this.use16bit = !! use16bit;
        this.normalize = !! normalize;

        var vertices = meshData.vertices;
        var uvs = meshData.uvs;

        var uvs2 = meshData.uvs2;
        var indices = meshData.indices;
        var vertexSize = meshData.vertexSize || 3;
        var uvSize = meshData.uvSize || 2;
        var uv2Size = meshData.uv2Size || 2;

        var gl = this.gl;

        if (!vertices || !gl)
            throw new Error('No input to GPUMesh, or no context.');

        if (!(meshData.vertices instanceof Uint16Array ||
            meshData.vertices instanceof Float32Array))
            throw new Error('Unsupported vertices type');

        if (meshData.vertices instanceof Uint16Array)
            this.vertexDataType = VertexDataType.UNSIGNED_SHORT;

        if (meshData.vertices instanceof Float32Array)
            this.vertexDataType = VertexDataType.FLOAT;

        //create vertex buffer
        this.vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);

        //when direct mode is used vertices can be also unit16
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        this.vertexBufferLayout = {
            itemSize: vertexSize, numItems: vertices.length / vertexSize };

        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        if (uvs != null) {
            //create texture coords buffer
            this.uvBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);

            gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
            this.uvBufferLayout = {
                itemSize: uvSize, numItems: uvs.length / uvSize };

            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }

        if (uvs2 != null) {
            //create texture coords buffer
            this.uv2Buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uv2Buffer);

            gl.bufferData(gl.ARRAY_BUFFER, uvs2, gl.STATIC_DRAW);
            this.uv2BufferLayout = {
                itemSize: uv2Size, numItems: uvs2.length / uv2Size };

            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }

        if (indices != null) {
            //create index buffer
            this.indexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
            this.indexBufferLayout = { itemSize: 1, numItems: indices.length };

            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        }

        this.size = vertices.byteLength;
        this.size += uvs ? uvs.byteLength : 0;
        this.size += uvs2 ? uvs2.byteLength : 0;
        this.size += indices ? indices.byteLength : 0;
        this.polygons = (indices) ? indices.length / 3 : this.vertexBufferLayout.numItems / 3;

    };


/**
 * Provide the draw call for the mesh.
 *
 * `GpuMesh` reuses the same position, UV, secondary-UV, and index buffers for
 * every program. It creates one VAO per program because shader attribute
 * locations differ by program. `attrNames` maps `GpuMesh.AttrNames` slots to
 * the attribute names used by that program.
 *
 * Any program uniforms need to be set before this call.
 *
 * @param program Program used by the draw call.
 * @param attrNames Attribute names for this program's mesh data slots. These
 * are honored only on the first call for a given program; later calls reuse
 * the cached VAO.
 */

draw2(program: GpuProgram, attrNames: GpuMesh.AttrNames) {

    const gl = this.gl;

    if (!program.program) throw new Error('no program');

    let vao!: WebGLVertexArrayObject;

    if (this.vaos.has(program)) {
        vao = this.vaos.get(program)!;
    } else {
        vao = this.createVAO(program, attrNames);
        this.vaos.set(program, vao);
    }

    gl.bindVertexArray(vao);

    if (this.indexBuffer) {
        gl.drawElements(gl.TRIANGLES, this.indexBufferLayout.numItems,
                        gl.UNSIGNED_SHORT, 0);
    } else {
        gl.drawArrays(gl.TRIANGLES, 0, this.vertexBufferLayout.numItems);
    }

    gl.bindVertexArray(null);
}


private createVAO(program: GpuProgram, attrNames: GpuMesh.AttrNames)
    : WebGLVertexArrayObject {

    const gl = this.gl;

    // data type
    let dataType: GLenum;

    switch (this.vertexDataType) {
        case VertexDataType.FLOAT:
            dataType = gl.FLOAT; break;
        case VertexDataType.UNSIGNED_SHORT:
            dataType = gl.UNSIGNED_SHORT; break;
    }

    // vao
    const vao = gl.createVertexArray()!;

    gl.bindVertexArray(vao);

    // positions (required)
    const vertexAttribute = program.getAttribLocation(attrNames['position']);

    if (vertexAttribute == -1)
        __DEV__ && program.log(
            `Program does not have attribute ${attrNames.position}`);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    if (vertexAttribute != -1) {
        gl.enableVertexAttribArray(vertexAttribute)
        gl.vertexAttribPointer(vertexAttribute, this.vertexBufferLayout.itemSize,
                               dataType, this.normalize, 0, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    if (this.uvBuffer && attrNames['uvs']) {

        // uvs (only when the program has them)
        const uvAttribute = program.getAttribLocation(attrNames['uvs']);

        if (uvAttribute == -1)
            __DEV__ && program.log(`Program does not have attribute ${attrNames['uvs']}`);

        if (uvAttribute != -1) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
            gl.enableVertexAttribArray(uvAttribute)
            gl.vertexAttribPointer(uvAttribute, this.uvBufferLayout.itemSize,
                                   dataType, true, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }
    }

    if (this.uv2Buffer && attrNames['uvs2']) {

        // uvs2 (only when the program has them)
        const uv2Attribute = program.getAttribLocation(attrNames['uvs2']);

        if (uv2Attribute == -1)
            __DEV__ && program.log(`Program does not have attribute ${attrNames['uvs2']}`);

        if (uv2Attribute != -1) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uv2Buffer);
            gl.enableVertexAttribArray(uv2Attribute)
            gl.vertexAttribPointer(uv2Attribute, this.uv2BufferLayout.itemSize,
                                   dataType, true, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }
    }

    if (this.indexBuffer)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

    gl.bindVertexArray(null); // done with VAO setup

    return vao;
}

/**
 * The *legacy* draw API without VAOs, deprecated. It creates the attribute bindings
 * for vertex positions and optionally also for internal and external/normal map
 * texture UVs.
 *
 * @param program the program to use in draw call
 * @param attrVertex vertex position attribute name (aPosition)
 * @param attrUV internal texture UV attribute name (aTexCoord)
 * @param attrUV2 external texture (or normal map) UV attribute name (aTexCoord2)
 * @param _ former barycentric buffer attr name, long dead now
 * @param skipDraw just binds the buffers, does not issue the draw call
 */

// Draws the mesh, given the two vertex shader attributes locations.
draw(program: GpuProgram, attrVertex: string, attrUV: string, attrUV2: string,
     _: string | null, skipDraw: boolean = false) {

    var gl = this.gl;

    if (gl == null) {
        return;
    }

    // we should handle this through binding a VAO
    if (this.use16bit) {

        //bind vetex positions
        var vertexAttribute = program.getAttribLocation(attrVertex);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.vertexAttribPointer(vertexAttribute, this.vertexBufferLayout.itemSize, gl.UNSIGNED_SHORT, this.normalize, 0, 0);

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


/** Releases all GPU buffer and vertex array objects. */
[Symbol.dispose](): void {

    if (this.disposed_) return;
    this.disposed_ = true;
    if (!this.gl) return;

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

    this.vaos.forEach((vao) => this.gl.deleteVertexArray(vao));
    this.vaos.clear();

    this.vertexBuffer = null;
    this.uvBuffer = null;
    this.uv2Buffer = null;
    this.indexBuffer = null;
}

// mesh.js calls this directly; remove once mesh.js is TS.
kill() { this[Symbol.dispose](); }

} // class GpuMesh



// export types
export namespace GpuMesh {

export type MeshData = {

    bbox: any,
    vertices: Uint16Array | Float32Array,
    uvs?: Uint16Array | Float32Array,
    uvs2?: Uint16Array | Float32Array,
    indices?: Uint16Array
    vertexSize?: GLint,
    uvSize?: GLint,
    uv2Size?: GLint
}

/**
 * Shader attribute names for the mesh data slots.
 *
 * The keys name fixed `GpuMesh` buffers. The values name attributes in a
 * specific shader program.
 */
export type AttrNames = {

    /** Attribute that receives `vertexBuffer`. */
    position: string,

    /** Attribute that receives `uvBuffer`, when the mesh has one. */
    uvs?: string,

    /** Attribute that receives `uv2Buffer`, when the mesh has one. */
    uvs2?: string
}

} // export namespace GpuMeshTypes

// local types

type Layout = {

    itemSize: GLint, numItems: GLint
}


enum VertexDataType {

    FLOAT, UNSIGNED_SHORT
}


export default GpuMesh;
