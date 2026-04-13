/** Height mode for coordinate conversions and hit-testing. */
export type HeightMode = 'fix' | 'float';

/**
 * Level-of-detail hint for coordinate conversions and height sampling.
 * A higher value requests a finer terrain mesh.
 */
export type Lod = number;

/**
 * Map from event name to its payload type.
 *
 * Payloads from the legacy JS core are typed as `unknown` until the
 * underlying JS is migrated to TypeScript.
 */
export interface CoreEventMap {
    'map-mapconfig-loaded': unknown;
    'map-loaded': unknown;
    'map-unloaded': unknown;
    'map-update': unknown;
    'map-position-changed': unknown;
    'map-position-fixed-height-changed': unknown;
    'tick': unknown;
    'gpu-context-lost': unknown;
    'gpu-context-restored': unknown;
    'geo-feature-enter': unknown;
    'geo-feature-leave': unknown;
    'geo-feature-hover': unknown;
    'geo-feature-click': unknown;
}
