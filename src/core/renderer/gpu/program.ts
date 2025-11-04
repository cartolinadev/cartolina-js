

import GpuDevice from './device';
import * as utils from '../../utils/utils';

type Optional<T> = T | null;


export class GpuProgram {

    gpu: GpuDevice;
    vertex: string;
    fragment: string;
    gl: WebGL2RenderingContext;
    program: WebGLProgram;
    ready: boolean;
    uniformLocationCache: Record<string, WebGLUniformLocation | null>;
    attributeLocationCache: Record<string, GLint>;
    m: Float32Array;

    // for diagnostics
    id!: number;
    name!: string;

    // internal id
    static nextId: number = 1;

    /**
      * Create a new gpu program, compile and link sources.
      * @ubBindings the optional dictionary of uniform block bindings, maps
      *      a block name to its ubo binding point.
      */

    constructor(gpu: GpuDevice, vertex: string, fragment: string,
              name: string = 'unnamed',
              ubBindings: {[key:string]: number} = {},
              samplerUnitMappings: {[key:string]: number} = {}) {

        this.gpu = gpu;
        this.vertex = vertex;
        this.fragment = fragment;
        this.gl = gpu.gl;
        this.uniformLocationCache = {};
        this.attributeLocationCache = {};
        this.m = new Float32Array(16);
        this.ready = false;

        this.id = GpuProgram.nextId++;
        this.name = name;

        this.createProgram(vertex, fragment, ubBindings, samplerUnitMappings);
    };


    log(message, logger: (message: string) => void = utils.warnOnce) {

        let message_ = `[GpuProgram ${this.id}:${this.name}]` + message;
        logger(message_);
    }


createShader(source: string, vertexShader: boolean): WebGLShader {
    var gl = this.gl;

    if (!source || !gl) {
        throw new Error('Invalid shader source or GL context');
    }

    let shader: WebGLShader | null;

    if (vertexShader !== true) {
        shader = gl.createShader(gl.FRAGMENT_SHADER);
    } else {
        shader = gl.createShader(gl.VERTEX_SHADER);
    }

    if (!shader) throw new Error('Failed to create shader');
    
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

    //console.log(fragment);

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
            __DEV__ && this.log(`Invalid uniform block name '${blockName} `
            + `(invalid index) in program.`);
            return;
        }

        gl.uniformBlockBinding(program, idx, bindingPoint);
    });

    // important to do this before setting any uniforms (samplers below)
    gl.useProgram(program);
    this.program = program;

    // sampler unit sampler unit mappings
    Object.entries(samplerUnitMappings).forEach(([sampler, unitIdx])=>{

        let location = this.getUniform(sampler);
        if (location === null) return;

        gl.uniform1i(location, unitIdx);
    });

    // done
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

    // the correct way to query uniform arrays is to query the first element
    var key = this.getUniform(name.endsWith("]") ? name : name + "[0]");
    if (key != null) {
        gl.uniform1fv(key, array);
    }
};


setIntArray(name: string, array: Int32List): void {
    var gl = this.gl;
    if (gl == null || this.program == null) return;

    // the correct way to query uniform arrays is to query the first element
    var key = this.getUniform(name.endsWith("]") ? name : name + "[0]");
    if (key != null) {
        gl.uniform1iv(key, array);
    }
};

getAttribLocation(name: string): GLint {
    let gl = this.gl;
    
    var location = this.attributeLocationCache[name];

    if (location == null) {
        location = gl.getAttribLocation(this.program, name);

        this.attributeLocationCache[name] = location;
    }

    return location;
};


getUniform(name: string): WebGLUniformLocation | null {

    let gl = this.gl;

    if (name in this.uniformLocationCache) {
        return this.uniformLocationCache[name];
    } 

    let location = gl.getUniformLocation(this.program, name);

    if (location === null && !/\[\d+\]$/.test(name)) {
        // try array base
        location = gl.getUniformLocation(this.program, name + "[0]");
    }

    if (__DEV__ && location === null) {
        utils.logOnce(`uniform ${name} does not exist in program `
            + `(optimized out?)\nActive uniforms:\n\t`
            + this.activeUniforms().join("\n\t"));
    }

    this.uniformLocationCache[name] = location;

    return location;
};


/**
 * logActive uniforms - for program diagnostics.
 */

activeUniforms(): string[] {
    const gl = this.gpu.gl;

    let ret = [] as string[];

    const n = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++)
        ret.push(gl.getActiveUniform(this.program, i)!.name);

    return ret;
}


} // class GpuProgram

export default GpuProgram;
