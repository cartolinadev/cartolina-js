import type GpuMesh from '../renderer/gpu/mesh';
import type MapSubmesh from './submesh';

/**
 * Legacy terrain mesh object.
 *
 * The runtime implementation is in `mesh.js`. This declaration covers the
 * fields and methods accessed by TypeScript modules.
 */
export default class MapMesh {

    /**
     * CPU-side submeshes parsed from the mesh resource.
     */
    submeshes: MapSubmesh[];

    /**
     * GPU buffers built from `submeshes`; indices match `submeshes`.
     */
    gpuSubmeshes: GpuMesh[];

    /**
     * Check whether the mesh resource and its GPU buffers are ready.
     *
     * @param doNotLoad When true, do not enqueue missing mesh data.
     * @param priority Loader priority used when a request is enqueued.
     * @param doNotCheckGpu When true, return true after CPU mesh data loads
     * without building or checking GPU buffers.
     * @returns True when the mesh data is loaded and, unless skipped by
     * `doNotCheckGpu`, GPU buffers are available.
     */
    isReady(
        doNotLoad?: boolean,
        priority?: number,
        doNotCheckGpu?: boolean,
    ): boolean;

    killSubmeshes(killByCache?: boolean): void;

    /**
     * killSubmeshes nulls per-submesh CPU fields (vertices,
     * internalUVs, externalUVs, indices) but leaves the
     * submeshes array length intact - while mesh drawing needs only the
     * GPU readiness, CPU fields are needed for tile-render-rig construction.
     */
    submeshesKilled: boolean;
}
