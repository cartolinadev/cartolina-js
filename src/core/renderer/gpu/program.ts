

import GpuDevice from './device';

type Optional<T> = T | null;


export class GpuProgram {

    gpu: GpuDevice;
    vertex: string;
    fragment: string;
    gl: WebGL2RenderingContext;
    program: Optional<WebGLProgram>;
    ready: boolean;
    uniformLocationCache: Record<string, WebGLUniformLocation>;
    attributeLocationCache: Record<string, GLint>;
    m: Float32Array;

    /**
      * Create a new gpu program, compile and link sources.
      * @ubBindings the optional dictionary of uniform block bindings, maps
      *      a block name to its ubo binding point.
      */

    constructor(gpu: GpuDevice, vertex: string, fragment: string,
              ubBindings: {[key:string]: number} = {},
              samplerUnitMappings: {[key:string]: number} = {}) {

        this.gpu = gpu;
        this.vertex = vertex;
        this.fragment = fragment;
        this.gl = gpu.gl;
        this.program = null;
        this.uniformLocationCache = {};
        this.attributeLocationCache = {};
        this.m = new Float32Array(16);
        this.ready = false;
        this.createProgram(vertex, fragment, ubBindings, samplerUnitMappings);
    };


createShader(source: string, vertexShader: boolean): WebGLShader {
    var gl = this.gl;

    if (!source || !gl) {
        return null;
    }

    let shader : WebGLShader;

    if (vertexShader !== true) {
        shader = gl.createShader(gl.FRAGMENT_SHADER);
    } else {
        shader = gl.createShader(gl.VERTEX_SHADER);
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {

        var errorLog = gl.getShaderInfoLog(shader);

        const numberedSource = source
            .split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n');

        throw new Error(
            `Shader compilation failed:\n${errorLog}\nSource:\n${numberedSource}`);
    }

    return shader;
};

createProgram(vertex: string, fragment: string,
              ubBindings: {[key:string]: number},
              samplerUnitMappings: {[key:string]: number}): void {
    var gl = this.gl;
    if (gl == null) return;

    let vertexShader = this.createShader(vertex, true);
    let fragmentShader = this.createShader(fragment, false);

    if (!vertexShader ||  !fragmentShader) {
        return;
    }

    let program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const linkError = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`Program linking failed:\n${linkError}`);
    }

    // Clean up shaders (optional - they can be deleted after successful linking)
    gl.detachShader(program, vertexShader);
    gl.detachShader(program, fragmentShader);

    // create the uniform block bindings
    Object.entries(ubBindings).forEach(([blockName, bindingPoint])=> {

        const idx = gl.getUniformBlockIndex(program, blockName);

        if (idx === gl.INVALID_INDEX) {
            console.warn(`Invalid uniform block name '${blockName} `
            + `(invalid index) in program ${program}.`);
            return;
        }

        gl.uniformBlockBinding(program, idx, bindingPoint);
    });

    // sampler unit sampler unit mappings
    Object.entries(samplerUnitMappings).forEach(([sampler, unitIdx])=>{

        let location = this.getUniform(sampler);

        if (location === null) {

            console.warn(`Uniform '${sampler}' not found in program ${program}.`);
            return;
        }

        gl.uniform1i(location, unitIdx);
    });

    // this is probably useless
    // program is set for real in GpuDevice.useProgram in the rendering loop
    gl.useProgram(program);

    this.program = program;
    this.ready = true;
};


setSampler(name: string, index: GLint): void {
    var gl = this.gl;
    if (gl == null || this.program == null) return;

    var key = this.getUniform(name);
    if (key != null) {
        gl.uniform1i(key, index);
    }
};

isReady() : boolean {
    return this.ready;
};

setMat4(name: string, m: Float32List, zoffset?: number): void {

    var gl = this.gl;
    if (gl == null || this.program == null) return;

    var key = this.getUniform(name);
    if (key != null) {
        if (zoffset) {
            zoffset = ((1+zoffset)*2)-1;
           
            var m3 = this.m;
            
            m3[0] = m[0];  
            m3[1] = m[1];  
            m3[2] = m[2] * zoffset;  
            m3[3] = m[3];  

            m3[4] = m[4];  
            m3[5] = m[5];  
            m3[6] = m[6] * zoffset;  
            m3[7] = m[7];  

            m3[8] = m[8];
            m3[9] = m[9];
            m3[10] = m[10] * zoffset;  
            m3[11] = m[11];

            m3[12] = m[12];  
            m3[13] = m[13];  
            m3[14] = m[14] * zoffset;  
            m3[15] = m[15];  

            gl.uniformMatrix4fv(key, false, m3);
            
        } else {
            gl.uniformMatrix4fv(key, false, m);
        }
    }
};


setMat3(name: string, m: Float32List): void {
    var gl = this.gl;
    if (gl == null || this.program == null) return;

    var key = this.getUniform(name);
    if (key != null) {
        gl.uniformMatrix3fv(key, false, m);
    }
};


setVec2(name: string, m: Float32List): void {
    var gl = this.gl;
    if (gl == null || this.program == null) return;

    var key = this.getUniform(name);
    if (key != null) {
        gl.uniform2fv(key, m);
    }
};


setVec3(name: string, m: Float32List) {
    var gl = this.gl;
    if (gl == null || this.program == null) return;

    var key = this.getUniform(name);
    if (key != null) {
        gl.uniform3fv(key, m);
    }
};


setVec4(name: string, m: Float32List): void {
    var gl = this.gl;
    if (gl == null || this.program == null) return;

    var key = this.getUniform(name);
    if (key != null) {
        gl.uniform4fv(key, m);
    }
};


setFloat(name: string, value: GLfloat): void {
    var gl = this.gl;
    if (gl == null || this.program == null) return;

    var key = this.getUniform(name);
    if (key != null) {
        gl.uniform1f(key, value);
    }
};


setFloatArray(name: string, array: Float32List): void {
    var gl = this.gl;
    if (gl == null || this.program == null) return;

    var key = this.getUniform(name);
    if (key != null) {
        gl.uniform1fv(key, array);
    }
};


getAttribLocation(name: string): GLint {
    var gl = this.gl;
    if (gl == null || this.program == null) return;

    var location = this.attributeLocationCache[name];

    if (location == null) {
        location = gl.getAttribLocation(this.program, name);

        this.attributeLocationCache[name] = location;
    }

    return location;
};


getUniform(name: string) {
    var gl = this.gl;
    if (gl == null || this.program == null) return;

    var location = this.uniformLocationCache[name];

    if (location == null) {
        location = gl.getUniformLocation(this.program, name);
        this.uniformLocationCache[name] = location;
    }
    
    return location;
};


} // class GpuProgram

export default GpuProgram;
