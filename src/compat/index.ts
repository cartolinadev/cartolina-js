/*
 * index.ts - the cartolina/compat entry point: the legacy mapConfig
 * to style converter, kept out of the main style-native bundle
 */

export { mapConfigToStyle } from './mapconfig-to-style';
export type {
    MapConfigInput,
    MapConfigConversion,
    MapConfigConversionWarning,
    MapConfigConversionNote,
    MapConfigViewDefinition,
    MapConfigToStyleOptions,
} from './mapconfig-to-style';
