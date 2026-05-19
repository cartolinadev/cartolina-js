import type GpuMesh from '../renderer/gpu/mesh';
import type * as math from '../utils/math';

type MeshArray = Uint16Array | Float32Array;
type Matrix4 = number[];

/**
 * Legacy terrain submesh object.
 *
 * The runtime implementation is in `submesh.js`. This declaration covers the
 * fields and methods accessed by TypeScript modules.
 */
export default class MapSubmesh {

    /**
     * Internal texture coordinates parsed from the mesh, when present.
     */
    internalUVs: MeshArray | null;

    /**
     * Build the model matrix that places this submesh relative to the camera.
     *
     * @param geoPos Current camera geographic position in world coordinates.
     * @param matrix Optional matrix to fill instead of allocating a new one.
     * @returns The filled or newly allocated model matrix.
     */
    getWorldMatrix(geoPos: math.vec3, matrix?: Matrix4): Matrix4;
}
