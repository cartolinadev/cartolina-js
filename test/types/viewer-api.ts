/*
 * viewer-api.ts - compile-time contract of the public Viewer runtime
 * configuration API; compiled by tsconfig.types.json, never executed
 */

import Viewer from '../../src/browser/viewer';
import { map } from '../../src/browser/index';
import type MapStyle from '../../src/core/map/style';
import type { PositionInput } from '../../src/core/types';
import type { PublicRuntimeConfig } from '../../src/core/viewer-config';

declare const viewer: Viewer;
declare const container: HTMLElement;
declare const style: MapStyle.StyleSpecification;
declare const position: PositionInput;

// The namespace re-export and the core definition are the same type.
declare const runtimeConfig: Viewer.PublicRuntimeConfig;
const sameType: PublicRuntimeConfig = runtimeConfig;
void sameType;

// Valid keys accept values of their declared type and chain.
const chained: Viewer = viewer
    .setParam('mapFlagLighting', false)
    .setParam('rendererCssDpi', 192)
    .setParam('sensitivity', [1, 0.06, 0.05])
    .setParam('navigationMode', 'free')
    .setParam('autoPan', [10, 90]);
void chained;

// @ts-expect-error a boolean key rejects a number value
viewer.setParam('mapFlagLighting', 1);

// @ts-expect-error a misspelled key is rejected
viewer.setParam('mapFlagLigthing', false);

// @ts-expect-error a tuple key rejects a wrong-length array
viewer.setParam('sensitivity', [1, 0.06]);

// @ts-expect-error a catalogued but non-public key is rejected
viewer.setParam('mapProfileGpu', true);

// @ts-expect-error a construction-only key is rejected
viewer.setParam('rendererAntialiasing', false);

// @ts-expect-error a UI key read only when its control is built is
// rejected
viewer.setParam('controlLoading', true);

// @ts-expect-error a command key with a dedicated method is rejected
viewer.setParam('position', null);

// @ts-expect-error a legacy alias is rejected on the typed surface
viewer.setParam('pan', [0, 0]);

// getParam infers the key-specific return type.
const lighting: boolean = viewer.getParam('mapFlagLighting');
void lighting;

const dpi: number = viewer.getParam('rendererCssDpi');
void dpi;

const sensitivity: [number, number, number] =
    viewer.getParam('sensitivity');
void sensitivity;

// @ts-expect-error the boolean return type is not a number
const wrongType: number = viewer.getParam('mapFlagLighting');
void wrongType;

// @ts-expect-error a misspelled key is rejected on reads as well
viewer.getParam('mapFlagLigthing');

// The factory options bag accepts runtime and construction keys.
void map({
    container, style, position,
    options: {
        mapFlagLighting: false,
        rendererAntialiasing: false,
        controlLoading: true,
        controlSearchElement: container,
    },
});

void map({
    container, style, position,
    // @ts-expect-error a misspelled factory option is rejected
    options: { mapFlagLigthing: false },
});

void map({
    container, style, position,
    // @ts-expect-error a wrong-typed factory option value is rejected
    options: { mapFlagLighting: 123 },
});

void map({
    container, style, position,
    // @ts-expect-error an internal-only key is rejected
    options: { mapProfileGpu: true },
});

void map({
    container, style, position,
    // @ts-expect-error a debug key is rejected
    options: { debugMode: true },
});

// The README construction form: a style URL string, no position.
void map({ container: 'map', style: './style.json' });

// @ts-expect-error a non-style value is rejected
void map({ container: 'map', style: 42 });
