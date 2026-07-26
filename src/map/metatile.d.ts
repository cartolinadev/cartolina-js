/**
 * Loaded metatile data and per-traversal state for a metatile block.
 */
export default class MapMetatile {

    /** Last draw traversal generation that counted this metatile. */
    drawCounter: number;

    /** Metatile format version selected by the loader. */
    useVersion: number;

    /** Metatile format version read from the binary header. */
    version: number;
}
