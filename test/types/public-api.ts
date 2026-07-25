/*
 * public-api.ts — compile-only contract of the package entry
 */

import { map } from '../../src/browser/index';
import type { Map } from '../../src/browser/index';


type Expect<T extends true> = T;
type Eq<A, B> =
    (<X>() => X extends A ? 1 : 2) extends
        (<X>() => X extends B ? 1 : 2) ? true : false;


type _optionsMatchFactory = Expect<Eq<
    Map.Options,
    Parameters<typeof map>[0]
>>;

const optionsMatchFactory: _optionsMatchFactory = true;
void optionsMatchFactory;

const viewer: Map = map({
    container: 'map',
    style: './style.json',
    position: ['obj', 15, 50, 'fix', 3313, -133, -25, 0, 33347, 45],
});

const overlay: Map.OverlaySpec = { render: () => undefined };
viewer.addOverlay('compile-contract', overlay);

viewer.on('map-loaded', (event) => {
    const browserOptions: Record<string, unknown> = event.browserOptions;
    void browserOptions;
});

declare const runtimeConfig: Map.PublicRuntimeConfig;
const lighting: boolean = runtimeConfig.mapFlagLighting;
void lighting;

type TransformRequestCallback =
    NonNullable<Map.Options['transformRequest']>;
declare const transformRequest: TransformRequestCallback;
const transformed = transformRequest('https://tiles.example.com', 'Tile');
void transformed;

type RequestResourceType = Parameters<TransformRequestCallback>[1];
const resourceType: RequestResourceType = 'Glyph';
void resourceType;

type OverlayContext = Parameters<Map.OverlaySpec['render']>[0];
declare const overlayContext: OverlayContext;
void overlayContext.renderer;
