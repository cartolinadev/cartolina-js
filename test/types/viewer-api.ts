/*
 * viewer-api.ts - compile-time contract of the public Viewer runtime
 * configuration API; compiled by tsconfig.types.json, never executed
 */

import Viewer from '../../src/browser/viewer';
import type { PublicRuntimeConfig } from '../../src/core/viewer-config';

declare const viewer: Viewer;

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
