/**
 * Runtime overrides for map rendering behaviour.
 *
 * `defaultOverrides` is the single canonical source of defaults for
 * all per-frame rendering overrides. The legacy Map class (map.js)
 * initializes the live override object by spreading these defaults;
 * `MapDraw` and `Renderer` then share a reference to that object.
 *
 * `draw*` fields default to `false` (or their functional default).
 * `flag*` fields default to `undefined`, which means "defer to the
 * corresponding config value". Any explicit `boolean` overrides the
 * config for that frame.
 *
 * Derive the type from the constant with `typeof` so that the type
 * and the defaults cannot drift independently.
 */

export const defaultOverrides = {

    // draw-side overrides
    drawBBoxes      : false,
    drawMeshBBox    : false,
    drawLods        : false,
    drawPositions   : false,
    drawFaceCount   : false,
    drawDistance    : false,
    drawGeodataOnly : false,
    drawTextureSize : false,
    drawNodeInfo    : false,
    drawIndices     : false,
    drawResources   : false,
    drawSurfaces    : false,
    drawSurfaces2   : false,
    drawCredits     : false,
    drawLabelBoxes  : false,
    drawAllLabels   : false,
    drawHiddenLabels: false,
    drawEarth       : true,
    drawGridCells   : false,
    drawGPixelSize  : false,
    debugTextSize   : 2.0,
    maxZoom         : false,
    meshStats       : undefined as boolean | undefined,

    // render flag overrides (undefined = use config default)
    flagLighting          : undefined as boolean | undefined,
    flagNormalMaps        : undefined as boolean | undefined,
    flagDiffuseMaps       : undefined as boolean | undefined,
    flagSpecularMaps      : undefined as boolean | undefined,
    flagBumpMaps          : undefined as boolean | undefined,
    flagAtmosphere        : undefined as boolean | undefined,
    flagShadows           : undefined as boolean | undefined,
    flagLabels            : undefined as boolean | undefined,
    flagShadingLambertian : undefined as boolean | undefined,
    flagShadingSlope      : undefined as boolean | undefined,
    flagShadingAspect     : undefined as boolean | undefined,
};

export type Overrides = typeof defaultOverrides;
