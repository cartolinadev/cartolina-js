declare module 'earcut' {
    function earcut(
        data: ArrayLike<number>,
        holeIndices?: ArrayLike<number> | null,
        dim?: number,
    ): number[];

    namespace earcut {
        function deviation(
            data: ArrayLike<number>,
            holeIndices: ArrayLike<number> | null | undefined,
            dim: number,
            triangles: number[],
        ): number;

        function flatten(data: number[][][]): {
            vertices: number[];
            holes: number[];
            dimensions: number;
        };
    }

    export = earcut;
}
