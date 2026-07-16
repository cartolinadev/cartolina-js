# RFC 11: retire mapConfig maps from the runtime

**Status:** In review
**Opened:** 2026-07-13
**Updated:** 2026-07-16 — scope revision: `map()` factory kept, free-layer
machinery untouched, `Browser` dissolution added, open questions resolved
into design positions, conversion corpus widened to every mapConfig-based
test URL
**Context:** the style contract already drives new terrain rendering, while
mapConfig loading still creates a second initialization path and a second
runtime model in `Viewer`, `Map`, and `LegacyMap`.

---

## 1. Decision summary

Legacy map configurations remain accepted as input, but they stop being a
kind of live map.

This separates compatibility from architecture. mapConfigs and styles
describe largely the same map resources and presentation, but they do so
with different object shapes and partially different capabilities. Keeping
both representations alive forces the core to implement their union and to
branch wherever the models disagree. Converting at the input boundary pays
that mismatch cost once and gives the rest of the library one contract.

An independent compatibility adapter converts a mapConfig into a Cartolina
style and associated construction defaults before map initialization. The
adapter is called explicitly by applications and migration tools. It is not
called by `Viewer`. After conversion, every map follows the same style
constructor, loader, style state, layer sequencing, and rendering path.

The runtime concepts `MapConfig`, `MapView`, `namedViews`, and
`currentView_` are removed. The `style or mapConfig` branches in `Viewer`,
`Map`, `LegacyMap`, terrain selection, free-layer selection, and refresh
logic are removed with them. `Browser` (`src/browser/browser.js`)
dissolves in the same effort: the mapConfig ingestion it hosts is
removed, its surviving viewer glue moves into typed `Viewer` code, and
the legacy module is deleted.

The replacement for the visibility part of a named view is a
**visibility profile**: a Viewer-level value that atomically selects terrain
sources and controls layer visibility or per-terrain applicability. Profiles
are not stored in `StyleSpecification`. Applications own any names or preset
registry; the style remains a MapLibre-shaped description of one map.

The primitive layer API expresses Cartolina's terrain-aware visibility
directly:

```ts
viewer.setLayerVisibility('roads', ['world-terrain']);
viewer.setLayerVisibility('roads', []); // hidden on every terrain
```

Terrain-stack selection and atomic profile application remain separate:

```ts
viewer.setTerrainSources(['world-terrain']);
viewer.applyVisibilityProfile(baseProfile);
```

Profiles address style layer ids and terrain source ids and apply through
the same runtime state as individual mutations. Illumination, vertical
exaggeration, camera state, and preset names are not profile fields.

## 2. Motivation

### 2.1 Overlapping formats create a permanent core fork

mapConfigs and styles are not two unrelated products. Both describe terrain
sources, imagery, geodata, credits, reference-frame resources, initial
presentation, and rendering options. Much of a mapConfig can already be
expressed as a style, and the style-era tile renderer already consumes style
layers for both kinds of map.

The overlap is incomplete. mapConfigs have views, named views,
`browserOptions`, aggregate resource definitions, and external VTS
stylesheets. Styles have typed terrain and layer definitions, Cartolina
illumination and vertical exaggeration, and the layer-oriented vocabulary
needed by the MapLibre-shaped API.

Keeping both representations live does not preserve two independent
capabilities. It makes the core model their union. Every feature touching
map state must then do one of four things:

- implement the same behavior twice;
- add a `style or mapConfig` branch;
- support one path and leave the other with reduced behavior;
- translate between the models late, after map creation.

All four outcomes increase maintenance cost. The overlap duplicates work,
while the differences spread format-specific concepts into classes that
should operate on an already normalized map.

### 2.2 Two authored inputs become two live map models

Style initialization calls `MapStyle.loadStyle()` and stores a `MapStyle`
on the loaded map. mapConfig initialization calls `MapConfig`, constructs a
`MapView`, and leaves `map.style` unset.

That distinction survives for the lifetime of the map:

- `Map` chooses between `loadMapFromStyle()` and `loadMap()`.
- `Map` has separate `createMapFromStyle()` and
  `createMapFromMapConfig()` factories.
- `LegacyMap.refreshView()` branches on the presence of `map.style`.
- terrain selection branches between `style.terrain.sources` and
  `currentView_.surfaces`.
- style maps compile free-layer sequences from style layers; mapConfig maps
  select free layers from the active view.
- the old `MapSurfaceSequence` fabricates a small style for each active
  mapConfig surface so that the style-era tile renderer can consume it.
- public `setView()`, `getView()`, and `getNamedViews()` exist only for the
  mapConfig branch.

The renderer has already converged on the style layer model. Keeping the
mapConfig model alive until draw time now adds translation work inside the
runtime instead of preserving an independent capability.

`Map` bears most of this cost. It owns loading, readiness, map creation,
terrain selection, events, and the frame loop. A format distinction at this
level therefore propagates into `LegacyMap`, source sequencing, geodata
refresh, configuration routing, and public API methods. The map object
cannot become a small typed owner of one map model while it must also decide
which historical parser created the current map.

### 2.3 Compatibility belongs at the input boundary

Legacy mapConfig documents still need to load. Removing support would move
the migration cost to every existing application and would discard complex
map descriptions that can be represented by the style system.

That requirement does not imply that mapConfig must remain an internal
runtime type. A compatibility adapter can fetch the aggregate document,
expand its referenced resources, flatten its stylesheets, reconcile shared
symbols, and emit the normalized style and construction defaults. This work
is inherently format-specific and is naturally isolated before map
creation.

The adapter is a compiler boundary:

```text
legacy input -> fetch and reconcile -> validated style -> one runtime
```

Conversion makes the complicated part explicit and testable. Failures can
name the source field, external stylesheet, or reconciled symbol before any
renderer state exists. Once conversion succeeds, no downstream class needs
to know that the style originated as a mapConfig.

This is a direct step toward the project north star: a modern web
cartography library whose public API is one flat MapLibre-shaped map
object and whose only supported map manifest is the style. Retiring
mapConfig from the library core — `Viewer`, `Map`, and the classes they
own — is the load-bearing part of this RFC. Backward compatibility is
preserved, but as an import path rather than a second architecture: an
isolated conversion suite maintains required legacy data compatibility
without making the legacy model part of the future API. A core that
retains Views, mapConfig-only methods, and format branches works
against that direction.

### 2.4 Views mix unrelated state

A VTS view contains three different kinds of state:

- a set of active terrain surfaces;
- an ordered bound-layer stack for each active surface;
- active free layers, including stylesheet and depth overrides.

It can also change illumination and legacy superelevation through
`view.options`. Treating a view as a visibility flag loses information;
keeping it as an untyped object retains the old data model.

The style model already has the right lower-level vocabulary:

- `terrain.sources` identifies terrain sources in stack order;
- style layers identify their data source;
- every layer's `terrain` list limits it to selected terrain sources;
- the style layer array defines draw order;
- illumination and vertical exaggeration are typed style properties.

What is missing is runtime mutation of this state and an atomic way to save
and restore a named combination of mutations.

### 2.5 Target vocabulary

The Cartolina model has sources, terrain, and layers. Every drawable or
styleable item is a layer. Diffuse imagery, bump maps, specular maps, labels,
and lines have different layer types and internal processors, but no public
category separates them.

“Bound layer” and “free layer” are VTS input terms. This RFC uses them only
when naming mapConfig fields, explaining conversion, or identifying legacy
code to delete. They do not appear in the target style schema, Viewer API,
core map model, or current-behavior documentation after implementation.

Style source discriminators describe the data being loaded, not a parallel
layer hierarchy:

- `cartolina-terrain` supplies terrain geometry and metadata;
- `cartolina-raster` supplies tiled raster data used by style layers;
- `cartolina-geodata` supplies tiled vector or label data used by style
  layers.

The source type selects a loader. The layer type selects a processor. All
layers still share one array, identity, ordering, visibility, and terrain
applicability contract.

### 2.6 Layer identity is incomplete

Lettering layers have ids. Terrain texture and constant layers do not. A
MapLibre-like runtime style API requires every mutable layer to have a
stable, unique id.

The style schema must therefore require `id` on every layer before runtime
layer mutation is introduced. Validation rejects duplicate ids.

### 2.7 Default position is split from the style

`map()` accepts an optional `position` construction option, but a style
cannot carry its own default position, while a mapConfig can. A
converted mapConfig therefore cannot remain self-describing: its
authored position would have to travel beside the style instead of
inside it.

The [MapLibre style root specification][maplibre-style-root] defines default
camera properties at the style root. They apply only when construction
options or application state did not set the camera. Cartolina should use
the same precedence rule with its native position representation.

### 2.8 `Browser` is the last legacy construction shell

`Viewer` is a typed facade constructed over `Browser`
(`src/browser/browser.js`), a legacy JS module. `Browser` ingests the
`browser()` config bag, re-applies mapConfig `browserOptions` after
`map-loaded`, routes the legacy `position` and `view` commands in
`applyConfigParam`, activates the `geojson` / `geodata` construction
options through `getView()` / `setView()`, and constructs and wires the
UI, autopilot, control-mode, presenter, and ROI helpers.

Removing the mapConfig model deletes the format-specific part of that
list. What remains is viewer glue with no format content: sub-object
construction, config watchers, per-tick dispatch, position-in-URL
updates, and teardown. Keeping a legacy JS constructor as the body of
every `Viewer` would preserve the shell of the removed model and keep
the public object's construction path in untyped code. The remainder
is small enough to absorb into typed `Viewer` code within the same
effort, and the direction is already recorded: the vts-era `Browser`
config accessors were removed ahead of this RFC with the note that the
remaining names retire when `Browser` dissolves.

## 3. Goals

The architectural goal is one normalized map model after input resolution.
The change succeeds when adding or changing map behavior no longer requires
an engineer to decide how the map was initialized. Retiring the mapConfig
model from the library core while keeping mapConfig documents loadable is
the step this RFC contributes to the project north star: styles become the
only supported map manifest, and legacy support becomes converter work at
the input boundary.

1. Make validated style state the only input accepted by the internal map
   constructor.
2. Make style initialization the only internal map initialization path.
3. Keep legacy mapConfig documents usable through one explicit, removable
   compatibility boundary.
4. Remove mapConfig and View state, branches, and methods from `Viewer`,
   `Map`, `LegacyMap`, traversal, and layer compilation.
5. Dissolve `Browser` into `Viewer`: delete `src/browser/browser.js`
   once its mapConfig ingestion is removed and its surviving glue is
   moved to typed code.
6. Ensure core map and renderer code cannot observe whether a style was
   authored directly or converted.
7. Move format reconciliation into a deterministic compiler that can be
   tested without DOM, WebGL, or a running map.
8. Report compatibility loss at conversion time with actionable errors or
   structured warnings instead of reduced behavior later in the runtime.
9. Provide a flat runtime layer visibility API over the single style model.
10. Preserve Cartolina's terrain-specific ability to activate terrain
    sources and apply one layer to selected terrain sources.
11. Translate named mapConfig views into Viewer-level visibility profiles
    returned separately from the style, without
    retaining the View data model.
12. Add an optional style default position with construction-option
    precedence.

These goals reduce future feature work as well as current code. A new layer
or rendering capability has one authored representation, one validation
path, one runtime state path, and one set of lifecycle rules. Supporting a
legacy input becomes converter work rather than a second implementation of
the feature.

## 4. Non-goals

- Backward compatibility for the old wrapper-object API is not restored.
- A visibility profile is not authored style, a camera bookmark, or a
  general rendering preset. Applications own profile names and storage.
- The RFC does not add general runtime source or layer authoring. It adds
  the mutations required to replace views; `addSource()` and `addLayer()`
  remain separate future work.
- The public constructor keeps its `map()` factory shape. Adopting the
  MapLibre `new Map(options)` class constructor is an independent
  public-API change with its own migration; bundling it here would widen
  the blast radius of an already broad removal without serving it.
- The internal free-layer machinery is not redesigned. Lettering style
  layers keep compiling to internal free layers behind the scenes, the
  free-layer draw path is unchanged, and the public `createGeodata()` /
  `addFreeLayer()` / `removeFreeLayer()` methods keep their current
  behavior. The free-layer mechanism has its own future refactoring;
  this RFC only removes the View-based call sites around it.
- Dissolving `Browser` does not port the UI, autopilot, control-mode,
  presenter, or ROI helpers to TypeScript. They remain legacy JS
  modules; only the glue that constructs and wires them becomes typed
  `Viewer` code.
- The converter does not make every historical VTS extension part of the
  Cartolina style specification.
- The converter does not preserve ignored virtual-surface or glue client
  behavior. Those concepts are already absent from the client renderer.

## 5. Invariants

After this RFC:

1. Every successfully constructed map has a validated style.
2. Core map and renderer code cannot determine whether that style was
   authored directly or converted from a mapConfig.
3. `LegacyMap.style` is non-null after map creation. The property can later
   be renamed when `LegacyMap` is absorbed into `Map`.
4. The authored style is the immutable baseline for runtime style state.
5. Runtime mutations do not edit the caller's style object.
6. Every style layer has a unique id.
7. A visibility-profile operation is atomic: a frame sees either the old
   style visibility or the complete new visibility state.
8. `Viewer` expands a visibility profile into primitive style mutations.
   Core `Map`, `MapStyle`, traversal, and rendering have no profile type,
   registry, active-profile field, or profile-specific branch.
9. Source URLs and inline source data have an explicit base URL. Relative
   resource paths never depend on the page URL after conversion.
10. `StyleSpecification` contains no visibility-profile fields.
11. “Bound layer” and “free layer” exist only inside the compatibility
    converter and references to code being removed. Cartolina runtime and
    public APIs speak only of sources, terrain, and layers.
12. Applying a visibility profile does not enter a profile mode. Later
    direct mutations and later profile applications follow normal call
    order; the last operation affecting a value wins.
13. `src/browser/browser.js` does not exist. `Viewer` constructs and
    owns its collaborators from typed code; the legacy JS modules it
    still uses are leaf helpers, not construction shells.

## 6. Public API

### 6.1 One style-based entry point

The `map()` factory keeps its current shape and becomes the only public
construction entry point:

```ts
const viewer = cartolina.map({
    container: 'map',
    style,
    position,
});
```

Its options object already follows the
[MapLibre `MapOptions` contract][maplibre-map-options] in field shape:
`style` accepts a style object or URL, and `container` an element or
its id. Replacing the factory with a public `new Map(options)` class
constructor is deliberately out of scope (section 4); it changes every
caller without changing what this RFC must change.

`style` is required until Cartolina has a deliberate `setStyle()` API.
MapLibre permits it to be omitted and supplied later, but accepting an empty
map before that lifecycle exists would add another partial construction
state.

`MapOptions.position` stays optional. Camera precedence is:

1. the explicit constructor `position`;
2. application camera state established before style readiness;
3. the style root `position`;
4. the existing computed fallback.

The style addition is:

```ts
interface StyleSpecification {
    position?: PositionInput;
}
```

Cartolina uses one native position field instead of copying MapLibre's
Web-Mercator-specific `center`, `zoom`, `bearing`, and `pitch` fields. The
precedence matches MapLibre even though the representation differs.

The `browser(element, config)` factory is removed, together with
`BrowserConfig` and the mapConfig-preserving `configFromUrl()` helper.
Compatibility means that mapConfig data can be converted, not that its
constructor or public API survives. The internal `Browser` class does
not remain either; section 6.6 dissolves it into `Viewer`.

### 6.2 Independent conversion

Export one async function:

```ts
type MapConfigInput = string | Record<string, unknown>;

interface MapConfigConversion {
    style: MapStyle.StyleSpecification;
    viewerOptions: Partial<PublicConstructionConfig>;
    views: Record<string, ConvertedMapConfigView>;
    initialView: ConvertedMapConfigView | null;
    warnings: MapConfigConversionWarning[];
}

interface ConvertedMapConfigView {
    original: MapConfigViewDefinition;
    visibility: Viewer.VisibilityProfile;
    illumination?: MapStyle.IlluminationSpecification;
    verticalExaggeration?:
        MapStyle.VerticalExaggerationSpecification;
}

interface MapConfigConversionWarning {
    code: string;
    path: string;
    message: string;
    recovery: string;
}

async function mapConfigToStyle(
    input: MapConfigInput,
    options?: {
        baseUrl?: string;
        view?: string | MapConfigViewDefinition;
        transformRequest?: TransformRequestCallback;
        strict?: boolean;
    },
): Promise<MapConfigConversion>;
```

The result is wider than a bare style because `browserOptions` are viewer
construction defaults and named views are application-level presets, not
authored rendering state. Putting either into the style would deepen an
existing layering mistake. The application merges `viewerOptions` below its
own constructor options, preserving the current rule that caller
configuration wins. `views` preserves the original named-view definitions
and their translations; `initialView` does the same for the selected
possibly anonymous view. The style loader receives neither field.

Typical compatibility construction is explicit:

```ts
const converted = await mapConfigToStyle(mapConfig, conversionOptions);

const viewer = cartolina.map({
    container,
    style: converted.style,
    options: {
        ...converted.viewerOptions,
        ...applicationOptions,
    },
});

const satellite = converted.views.satellite;
viewer.applyVisibilityProfile(satellite.visibility);
if (satellite.illumination) {
    viewer.setIllumination(satellite.illumination);
}
if (satellite.verticalExaggeration) {
    viewer.setVerticalExaggeration(satellite.verticalExaggeration);
}
```

`MapConfigViewDefinition` is the validated legacy input type owned by the
converter. It is not exported as part of the map or style API.

For a URL input, the document URL supplies the base URL. For an object input,
`baseUrl` is required if any relative URL is present. Conversion rejects an
ambiguous relative URL instead of resolving it against the current page.

The function performs I/O needed to resolve referenced mapConfig resources
and stylesheets. `transformRequest` applies to those requests. The returned
style is JSON-serializable and can be inspected, edited, cached, or supplied
to the `map()` factory. Warnings identify both the input location and the
deterministic recovery that was applied, so a caller can decide whether the
converted result is acceptable.

### 6.3 Runtime layer methods

`Viewer` exposes primitive methods for applications that do not want
profiles or need a one-off change:

```ts
viewer.setLayerVisibility(layerId, terrainIds);
viewer.getLayerVisibility(layerId);

viewer.setTerrainSources(sourceIds);
viewer.getTerrainSources();
```

`setLayerVisibility()` replaces the layer's active terrain-source list. It
validates every id as a terrain source and stores a copy of the array. An
empty array makes the layer inactive everywhere. The same method applies to
every layer type.

`setTerrainSources()` changes the active terrain stack. It validates ids and
preserves the caller's back-to-front order. A terrain source may remain
loaded while inactive; visibility changes do not rebuild source objects.

The public contract is identical for diffuse, bump, specular, label, line,
and later layer types. Their processors may implement visibility
differently, but those differences are below the style model and runtime
API.

Unknown layer ids, duplicate source ids, and non-terrain ids throw. Runtime
style mutation must not silently no-op.

The existing `terrain` field moves to the common layer base and becomes the
single authored visibility representation:

```ts
interface LayerBase {
    id: string;
    type: string;
    terrain?: string[];
}
```

Every style layer type extends this common identity and terrain-applicability
contract. Omitting `terrain` means all terrain sources in the style; an empty
array means hidden. Source shape and internal processing vary by type; layer
selection and mutation do not.

### 6.4 Viewer-level visibility profiles

A visibility profile is a runtime value, not part of
`MapStyle.StyleSpecification`:

```ts
interface VisibilityProfile {
    terrain: string[];
    layers: Record<string, string[]>;
}
```

The public profile API is:

```ts
viewer.applyVisibilityProfile({
    terrain: ['world-terrain'],
    layers: {
        imagery: ['world-terrain'],
        labels: [],
    },
});

const current = viewer.getVisibilityProfile();
```

`Viewer` does not register or resolve profile names. An application can keep
`Record<string, VisibilityProfile>` and pass the selected value. The
mapConfig converter returns each profile inside `conversion.views` because
mapConfig supplies named views, but that compatibility result does not
become style state.

The profile is a complete snapshot: active terrain sources plus the active
terrain list for every style layer. `Viewer` rejects a profile that omits or
names an unknown layer.

`Viewer.applyVisibilityProfile()` translates that snapshot into the same
primitive changes exposed by `setLayerVisibility()` and
`setTerrainSources()`. It submits those changes through a generic atomic
style-mutation batch. Core `Map` sees only style property changes; it does
not receive a `VisibilityProfile` or know why those changes were grouped.

The batch recompiles affected layer sequences once, clears geodata
hysteresis state when lettering changed, and marks the map dirty once.
`getVisibilityProfile()` is assembled by `Viewer` from the primitive style
queries and returns no preset name.

### 6.5 Mixing profiles and direct mutations

Applying a profile is a one-time atomic write of ordinary visibility state.
It is not a persistent binding, an active mode, or a layer over subsequent
changes. `Viewer` does not retain the supplied object or track an active
profile name.

Operations compose by call order:

```ts
viewer.applyVisibilityProfile(base);
viewer.setLayerVisibility('labels', []);

// Captures `base` with labels now hidden.
const modified = viewer.getVisibilityProfile();

// Writes the complete `base` snapshot again, restoring its label state.
viewer.applyVisibilityProfile(base);
```

A direct `setLayerVisibility()` call replaces only that layer's terrain
list. A direct `setTerrainSources()` call replaces only the active terrain
stack; layer lists remain unchanged and may name currently inactive terrain
sources in preparation for a later terrain switch.

Because a visibility profile is complete, applying one replaces the active
terrain stack and every layer's terrain list. It overwrites any intervening
direct edits. The profile is fully validated before the atomic write; an
invalid profile changes nothing.

This rule keeps both API levels predictable. Primitive methods edit one
piece of style visibility. A profile writes a saved complete snapshot. Once
expanded by `Viewer`, core `Map` processes the same primitive mutations in
both cases.

### 6.6 `Browser` dissolves into `Viewer`

With the mapConfig model gone, `Browser` keeps no format-specific work
(section 2.8). Its members split three ways.

Removed with the mapConfig model:

- the `originalConfig` capture and the re-application of mapConfig
  `browserOptions` after `map-loaded` (core `Map` already applies
  `browserOptions` through `applyBrowserOptions_`; both die with the
  mapConfig loader);
- the `view` command in `applyConfigParam` — visibility profiles are
  applied by the caller, never by config ingestion;
- the `geojson`, `geodata`, and `geojsonStyle` construction options.
  Their activation path is `getView()` / `setView()`, which this RFC
  removes, and no demo or test uses them. Applications build overlays
  with `createGeodata()` / `addFreeLayer()` directly.

Moved into typed `Viewer` code:

- construction of the UI, autopilot, control-mode, presenter, and ROI
  sub-objects, and of the config store and core `Map`;
- the config watchers for the UI control keys and autopilot options;
- per-tick dispatch to the autopilot and UI;
- position-in-URL updates and `getLinkWithCurrentPos()`;
- teardown, which merges into `Viewer[Symbol.dispose]()`.

Deleted afterwards: `src/browser/browser.js`, and the `map` and `view`
fields of the internal `Viewer.Config` glue type. The deprecated
`Viewer.ui`, `Viewer.autopilot`, and `Viewer.presenter` getters keep
their behavior but type the `Viewer`-owned objects directly instead of
through `Browser['...']` lookups.

The dissolution is the last implementation phase. It depends on the
mapConfig removals, but nothing in this RFC depends on it; if needed it
can land as an independent follow-up series without reopening this
design.

## 7. Style source representation

### 7.1 URL and inline forms

Conversion starts from a fetched aggregate mapConfig. The unified style
loader must be able to consume the resource definitions already present in
that document without pretending that each one has an independent endpoint.

Each Cartolina source therefore accepts exactly one of a URL or inline data:

```ts
type SourceLocation<T> =
    | { url: string; data?: never }
    | { data: T; baseUrl: string; url?: never };
```

The source types combine their target discriminator with the relevant
location:

- `cartolina-terrain` inline data is one terrain resource definition
  plus the reference-frame, SRS, body, service, and credit metadata needed
  to initialize it;
- `cartolina-raster` inline data is a tiled raster source definition;
- `cartolina-geodata` inline data is a tiled geodata source definition.

Inline source support is part of the style loader, not a mapConfig escape
hatch. Constructors receive resolved source data and a base URL through one
typed path. They no longer infer base URL by temporarily replacing
`LegacyMap.url`.

For a legacy mapConfig with several surfaces, the converter emits one
terrain source per surface. Shared reference metadata is copied into each
small inline source definition. Avoiding that small JSON duplication would
require a second shared-resource context and is not worth another concept.

### 7.2 Source identity

MapConfig ids become style source ids where they are unique. A collision
between ids from different mapConfig namespaces is resolved with
deterministic data-type prefixes. The converter records the mapping while
translating views.

Authored styles continue to choose their own ids. Conversion-specific id
generation is confined to the compatibility adapter.

## 8. MapConfig conversion

### 8.1 Top-level data

The converter maps:

| mapConfig field | conversion result |
|---|---|
| `surfaces` | one inline `cartolina-terrain` source per surface |
| `boundLayers` | inline `cartolina-raster` sources |
| `freeLayers` | inline `cartolina-geodata` sources |
| `stylesheets` | resolved into Cartolina geodata style layers |
| `position` | style root `position` |
| `view` | initial layer visibility and root rendering properties |
| `namedViews` | conversion result `views` with original and translated data |
| `browserOptions` | conversion result `viewerOptions` |
| frame/SRS/body/services/credits | inline surface resource metadata |

The converter validates the complete input before emitting a style. Missing
references are errors with the mapConfig field path and referenced id.

### 8.2 Layer flattening

The target style has one `layers` array. A raster entry selected from a
mapConfig surface and a rule expanded from a VTS geodata stylesheet both
become ordinary entries in that array. They have the same id, ordering,
and `terrain` visibility contract. Their layer `type` selects the
appropriate internal processor.

A mapConfig view assigns an ordered list of raster entries separately to
each surface and selects geodata through a different `freeLayers` object.
Those are VTS input-format distinctions only. The converter creates one
ordinary style containing the union of terrain sources and style layers
needed by the initial and named views. It does not reproduce bound-layer or
free-layer collections in the target model.

Each distinct layer presentation becomes a normal style layer with a stable
id. If several views use the same source, type, styling properties, and
terrain applicability, they share one layer. If those properties differ,
the converter emits separate normal layers and the returned visibility
profiles in `views` select the appropriate variant.

For example, these incompatible per-surface orders:

```text
surface A: imagery, roads
surface B: roads, imagery
```

cannot always be represented by one global layer order. The converter uses
the selected initial view as the canonical order, appends layers used only
by other views deterministically, and emits a warning for any named view
whose relative layer order cannot be reproduced by visibility changes.
It does not duplicate every layer merely to encode view order.

The generated style's layer `terrain` lists represent the selected initial
view. Each separately returned visibility profile replaces those lists.
All variants still refer to the same source objects and GPU resources.

Legacy raster parameters are translated to ordinary style-layer properties:

- diffuse, bump, and specular kinds become their corresponding Cartolina
  layer types;
- `mode: 'normal'` becomes `blendMode: 'overlay'`, matching current code;
- numeric and structured alpha values become `alpha`;
- `whitewash` becomes `whitewash`;
- the generated `terrain` list contains the selected surface source id.

Unsupported parameter values are conversion errors. Assertions and ignored
fields in the current legacy sequence generator are not carried forward.

### 8.3 External VTS stylesheet compilation

A mapConfig free-layer entry identifies a geodata source and a VTS
stylesheet. The converter resolves the selected stylesheet, including a
view-level override, and turns every VTS stylesheet rule into an ordinary
Cartolina style layer with a stable id and geodata source id. The output
layer sits in the same `layers` array and uses the same visibility and
terrain API as raster-derived layers.

This is an asynchronous expansion step, not a reference copy. A free-layer
definition may itself be a URL and may name a default stylesheet URL. A view
may replace that stylesheet with another URL. The converter downloads the
definition and the effective stylesheet, resolves their relative references
against the document that contains them, and then splits the VTS stylesheet
into Cartolina root tables and Cartolina style layers.

A VTS stylesheet is a module with four symbol spaces:

- `layers`, which become entries in the Cartolina `layers` array;
- `constants`, which become candidates for the root `constants` table;
- `fonts`, which become candidates for the root `fonts` table;
- `bitmaps`, which become candidates for the root `bitmaps` table.

Several selected free layers, or several named views, can import
stylesheets whose root tables use the same name. Cartolina has one table of
each kind, so conversion includes a linker pass after all effective
stylesheets have been loaded.

The linker processes modules in deterministic source-id and view-id
order:

1. A symbol absent from the output table keeps its original name.
2. A symbol with a structurally equal definition is coalesced without a
   warning.
3. A symbol with a different definition is assigned a deterministic
   module-qualified name.
4. References in that module's layers and constants are rewritten to the
   qualified name.
5. Dependencies are followed transitively. Renaming a constant also rewrites
   references from other constants in the same module.

Rewriting must understand the VTS stylesheet grammar. Constant references
can be standalone strings or appear in string templates. Font and bitmap
aliases occur in typed properties and can also be reached through constants.
The linker parses those references and rewrites the expression tree. A blind
text replacement can change label text and is not acceptable.

Conflicting definitions are recoverable when every reference can be
rewritten. The converter emits a warning that records the original name,
the generated name, and both source modules. The warning exists because the
output is no longer a straightforward flattening even when rendering is
preserved.

When a reference cannot be classified or rewritten, the converter keeps the
first definition, gives the later module a qualified definition where
possible, and emits a lossy-conversion warning naming every unresolved
reference. It continues converting other layers. This is the best-effort
rule for valid historical stylesheets whose expression forms are wider than
the typed Cartolina grammar. The output must never silently bind a layer to
the wrong constant, font, or bitmap.

If an override stylesheet cannot be downloaded or parsed, the converter
tries the free layer's declared default stylesheet. If that also fails, it
keeps the free-layer source, emits no style layers for it, and warns that the
layer will not render. Failure to expand one optional free layer does not
prevent terrain and other independent layers from loading.

The current `labels` and `lines` discriminators both compile to the same
VTS stylesheet layer shape. Conversion uses the discriminator matching the
enabled point or line properties. A rule that enables both splits into two
style layers over the same geodata source — a `lines` layer and a `labels`
layer with deterministic derived ids, the lines layer ordered first. Both
discriminators compile back into the same internal stylesheet shape, so
the split changes the authored representation, not the generated drawing
jobs. A generic `geodata` layer type is rejected: it would reintroduce an
untyped catch-all where the style schema is deliberately typed per aspect.
A mixed-rule property that neither discriminator accepts is a conversion
error; conversion never guesses from property names and never silently
drops half of a mixed rule.

Legacy geodata `depthOffset` and `maxLod` overrides become typed optional
fields of the `cartolina-geodata` source specification. Their legacy scope
is the free layer — one value per geodata source, not per stylesheet
rule — so a source field preserves that scope exactly. Style-layer fields
were considered and rejected: the converter would replicate one legacy
value across every layer derived from the source and would need conflict
rules for copies that later disagree. The overrides must not live in an
opaque compatibility object or a separate geodata visibility model.

### 8.4 View options

The selected construction view's `surfaces` and `freeLayers` become the
generated style's initial terrain and layer visibility. Its supported
`view.options` become normal root style fields:

- `illumination` becomes `style.illumination`;
- `superelevation` is normalized to the current typed
  `style['vertical-exaggeration']` representation.

Each named view becomes a `ConvertedMapConfigView`. `original` preserves a
clone of the input definition. `visibility` contains only the Viewer-level
visibility snapshot. Supported illumination and superelevation are
normalized into sibling fields, not added to `VisibilityProfile`.

An application that wants view-like behavior applies `visibility` and the
relevant existing rendering setters explicitly. The converter preserves the
data needed for that operation without preserving `setView()` or introducing
a View concept into the map.

Unknown options on the selected view are conversion errors. Unknown options
on other named views remain present in `original` and produce structured
warnings. This prevents `VisibilityProfile` from becoming an untyped
replacement for `MapView.options` without discarding the source data.

An explicit `options.view` passed to `mapConfigToStyle()` wins over the
mapConfig's initial view. A string resolves a named view. An object is
converted to an anonymous initial style state. The converter does this
before the Viewer exists; no runtime `setView()` path remains.

### 8.5 Warnings and errors

Warnings are returned as structured values. The application decides whether
to log, display, reject, or persist them. Warnings are reserved for behavior
the current client already documents as ignored, such as non-empty
virtual-surface or glue declarations, and for explicit best-effort recovery
from an external or stylesheet-reconciliation problem.

Conversion has three outcomes for a field or dependency:

- **exact**: represented without a warning;
- **recovered**: a deterministic fallback produced a usable result and a
  structured warning describes the possible difference;
- **fatal**: no coherent style can be constructed.

Missing frame metadata, no usable terrain surface, malformed source ids, or
an invalid resulting style are fatal. A failed optional free-layer
stylesheet, a reconciled symbol collision, or an already ignored legacy
construct is recoverable. The converter does not hide a visible difference:
the warning names the omitted or rebound element and the recovery used.

`options.strict` promotes every recoverable outcome to an error. The
default stays best-effort: the function exists to load historical
documents, and refusing a whole map over one degraded optional layer
would serve nobody at runtime. Strict mode serves migration tooling and
checked-in fixtures, where a new warning must fail loudly instead of
aging into an accepted diff.

### 8.6 Public reference conversion

The `tacoma-fitonly` dev and prod entries in
[test/urls.json](../../test/urls.json) are the first public reference case.
The prod input is a mapConfig with one terrain surface, several bound-layer
definitions, one selected free layer with an external stylesheet override,
view-level illumination and superelevation, and compatibility viewer
options. The referenced VTS stylesheet contributes four geodata layers, a
constants table, and a fonts table.

The dev input is a hand-authored style with the corresponding structural
decomposition: terrain, diffuse and bump layers, four Cartolina geodata
layers, consolidated constants and fonts, illumination, and vertical
exaggeration. It demonstrates the shape the converter should produce.

The prod entry pins an older production build, and its render has
visibly drifted from current output; the terrain normal representation
changed after that build was pinned (reported cause, not re-verified
here). The entry's role in this RFC is therefore not a pixel
reference: the mapConfig it loads is the public conversion input, and
the dev entry is the rendering reference for the converted result.
Rendering acceptance for the converted style is agreement with the dev
entry's render modulo the documented differences below, not agreement
with the prod entry's drifted output.

The pair is a design reference, not a byte-for-byte golden conversion. The
hand-authored style uses a newer geodata source and contains cartographic
tuning that differs from the mapConfig. Converter tests derive expected
values from the prod input and use the dev style to check decomposition and
layer semantics, not to justify unexplained value changes.

The tacoma pair is the structural reference because only it has a
hand-authored style counterpart, but every mapConfig-based entry in
[test/urls.json](../../test/urls.json) is a public conversion input:

- `a-3d-mountain-map` — global terrain with a single bound layer and
  lettering;
- `nacis-2023` — blend modes and view-dependent alphas across several
  bound layers;
- `legacy-benatky` — a tileset with internal textures beside a global
  terrain, whose mapConfig carries non-empty glue declarations,
  exercising the ignored-glue warning path.

These entries have no style counterpart. Their rendering reference is
the same URL's mapConfig render on the pre-removal runtime, captured
before phase 4 deletes it. The `legacy-benatky` dev entry itself loads
through the demo application's `mapConfig` query parameter; keeping the
test URLs rendering therefore requires the demo application to route
that parameter through `mapConfigToStyle()`, which makes every legacy
dev URL a living converter regression case.

## 9. Runtime style state

`MapStyle` becomes the owner of two layers of state:

```text
authored style
    + runtime overrides
    = effective style state
```

The authored style is a validated clone of caller input. Runtime overrides
introduced by this RFC hold active terrain sources and per-layer terrain
lists. The effective state is derived at commit time
and exposed to terrain traversal and style compilation. Existing runtime
illumination and vertical-exaggeration setters remain separate rendering
APIs.

This separation supports ordinary runtime visibility changes. Mutating
`layer.terrain` to `[]` in the authored style when hiding a layer would lose
the list needed to show it again. The empty-list representation is suitable
for effective runtime state only.

When a `getStyle()` accessor is added, it returns the effective style
state — a clone with runtime overrides applied — matching MapLibre,
which exposes current style state rather than the authored document.
The authored baseline stays internal; a caller that wants the original
already holds the object it passed in, which invariant 5 guarantees is
never mutated. The accessor itself is future work; the state split
above is designed so that adding it needs no rework.

`MapStyle` builds indexes by source and layer id once after validation.
Runtime setters validate through those indexes. No render-loop scan is added
for visibility changes. Profile validation and expansion stay in `Viewer`.

Terrain traversal reads the effective terrain source list. Every layer
processor reads the same effective visibility and terrain applicability.
Processor-specific work still differs by layer type, but there is no
bound-layer/free-layer distinction and no check for mapConfig origin in
the public model.

Internally, lettering style layers continue to compile into legacy free
layers for drawing, exactly as `MapStyle.refreshSequences()` already
does for style maps. That translation sits behind the style contract
and is untouched by this RFC; only the view-driven sequence rebuild —
`refreshFreelayesInView()` reading `getCurrentView()` — is removed with
the View model. `getCurrentView()`'s style branch calls
`MapStyle.legacyView()`, a method that does not exist; the junction is
dead on style maps today and is deleted rather than repaired.

## 10. Unified initialization

The construction flow becomes:

```text
authored style --------------------------+
                                         |
mapConfig -> mapConfigToStyle() -> style +
                                         |
                                         v
                                 map({ style })
                                         |
                                         v
                              load one map model
```

The application awaits conversion before construction. `Viewer` and core
`Map` receive only a style object or style URL. They do not accept a
mapConfig, a conversion result, or a promise that might resolve either one.
This keeps asynchronous compatibility I/O outside the map lifecycle.

## 11. Removals

Implementation removes:

- [src/core/map/config.js](../../src/core/map/config.js);
- [src/core/map/view.js](../../src/core/map/view.js);
- the mapConfig-only generator in
  [src/core/map/surface-sequence.ts](../../src/core/map/surface-sequence.ts),
  followed by the file if no caller remains;
- `Map.loadMap()`, `onMapConfigLoaded_()`, `mapConfigData_`,
  `mapRunning_`, `createMapFromMapConfig()`, and the mapConfig construction
  branch in [src/core/map.ts](../../src/core/map.ts);
- `namedViews`, `currentView_`, `initialView`, `setView()`, `getView()`,
  `getNamedView()`, `getNamedViews()`, `getCurrentView()` (including
  its dead `style.legacyView()` branch), `refreshFreelayesInView()`,
  and mapConfig branches in `refreshView()` from
  [src/core/map/map.js](../../src/core/map/map.js);
- `Viewer.setView()`, `Viewer.getView()`, and `Viewer.getNamedViews()` from
  [src/browser/viewer.ts](../../src/browser/viewer.ts);
- the public `browser()` factory, `BrowserConfig`, and mapConfig-preserving
  `configFromUrl()` compatibility surface from
  [src/browser/index.ts](../../src/browser/index.ts);
- [src/browser/browser.js](../../src/browser/browser.js), dissolved per
  section 6.6;
- the `geojson`, `geodata`, and `geojsonStyle` construction options
  from the config catalogue;
- `view` and `map` from internal `Viewer.Config` and `ViewerConfig`;
- mapConfig-specific browser configuration routing;
- `map-mapconfig-loaded` from the event map.

The implementation must search for behavior branches rather than deleting
only the named files. In particular, `surfaceList()`, `getCurrentView()`,
free-layer refresh, loader parameter initialization, browser-option routing,
and async readiness currently contain mapConfig assumptions.

## 12. Migration

### Phase 1: complete the style vocabulary

1. Require ids on every style layer and update authored styles.
2. Add URL-or-inline source locations with explicit base URLs.
3. Add the optional root `position` and its precedence rule.
4. Add the `cartolina-geodata` source fields `depthOffset` and
   `maxLod` (section 8.3).
5. Move `terrain` to the common base shared by every layer type and define
   an empty list as hidden.
6. Rename VTS-shaped source discriminators to `cartolina-terrain`,
   `cartolina-raster`, and `cartolina-geodata`; update authored styles.

### Phase 2: runtime mutation

1. Introduce authored and runtime style state in `MapStyle`.
2. Add the layer-visibility and active-terrain methods.
3. Make terrain traversal and every layer processor read the common
   effective visibility and terrain state.
4. Add a generic atomic style-mutation batch to core `Map`.
5. Implement visibility-profile validation and expansion only in `Viewer`.

### Phase 3: compatibility conversion

1. Implement `mapConfigToStyle()` with checked-in public fixtures.
2. Convert surfaces, bound layers, free layers, stylesheets, views,
   position, and browser options.
3. Update compatibility callers to await conversion and construct the
   map with `map()` and `conversion.style`.
4. Compare the converted style and separately returned converted views with
   expected snapshots before browser rendering tests.

### Phase 4: delete the second runtime

1. Remove the mapConfig initialization factory and state from `Map`.
2. Remove `MapConfig`, `MapView`, and the legacy sequence generator.
3. Remove all `if (map.style)` and `if (!map.style)` behavior branches.
4. Remove the View methods from `Viewer`, core `Map`, and `LegacyMap`,
   together with `getCurrentView()` and `refreshFreelayesInView()`.
5. Remove `browser()`, obsolete types, events, config keys, demos, and
   documentation.

### Phase 5: dissolve `Browser`

1. Move the surviving glue from section 6.6 into typed `Viewer` code:
   sub-object construction, config watchers, tick dispatch,
   position-in-URL, and teardown.
2. Retire the `geojson`, `geodata`, and `geojsonStyle` construction
   options.
3. Delete `src/browser/browser.js` and the `Viewer.Config` glue fields.
4. Re-type the deprecated `ui`, `autopilot`, and `presenter` getters
   against the `Viewer`-owned objects.

### Phase 6: close compatibility gaps

Run the conversion corpus with strict diagnostics. Every supported field is
represented by typed style or construction state. Any unsupported field is
either designed into the style model through review or documented as a
conversion error. Do not add an opaque `legacy` field or call old parsers
from the style loader.

## 13. Validation

### 13.1 Conversion tests

Checked-in public fixtures cover:

- one and several surfaces;
- different raster-layer orders on different terrains;
- diffuse, bump, and specular layer parameters;
- free layers with inline and referenced stylesheets;
- several stylesheets with equal and conflicting constants, fonts, and
  bitmaps;
- transitive constant references and references embedded in templates;
- an unavailable view stylesheet with a usable free-layer default;
- a free layer for which neither stylesheet can be loaded;
- named views and an explicit construction view;
- view illumination and superelevation options;
- relative URL resolution from URL and object inputs;
- browser-option precedence;
- invalid references and unsupported fields.

Snapshot tests verify the complete conversion result. Focused unit tests
verify deterministic generated ids, source mappings, qualified symbol names,
reference rewriting, warning codes, and fallback selection. The public
`tacoma-fitonly` pair is used as a structural conversion case, and the
other mapConfig-based test URLs as conversion inputs, as described in
section 8.6.

### 13.2 Runtime tests

Unit and browser tests verify:

- hiding and showing every layer kind;
- changing every layer type's terrain list;
- activating and deactivating terrain sources;
- repeated profile application without state leaking from the prior profile;
- direct layer and terrain changes after profile application;
- reapplying a profile overwrites intervening direct changes;
- `getVisibilityProfile()` captures the current mixed state rather than the
  last supplied profile object;
- one sequence refresh and dirty mark per profile application;
- visibility-profile validation failures occur before state changes;
- caller style objects remain unchanged;
- constructor position overrides style position;
- style position overrides the computed fallback;
- after the `Browser` dissolution: constructing and disposing a
  `Viewer` registers and drains every watcher and listener, the UI
  control keys and autopilot options still react to `setParam`, and
  position-in-URL updates still fire.

### 13.3 Regression rendering

Run the canonical `simple-terrain`, `complex-terrain`, and `full-terrain`
screenshot comparisons sequentially. Every mapConfig-based entry in
[test/urls.json](../../test/urls.json) stays a living regression URL
(section 8.6): the demo application's `mapConfig` parameter routes
through `mapConfigToStyle()`, and converted renders are compared against
mapConfig-path captures taken before phase 4. Add a project-controlled
public mapConfig fixture whose converted render exercises multiple
terrain and visibility-profile switches across raster-derived and
geodata-derived layers. Tests listen to both console and page-error
events and reject failed resource requests.

The removal is complete only when a repository search finds no mapConfig or
View reference outside the isolated compatibility converter, its tests, and
VTS-input documentation, and `src/browser/browser.js` no longer exists.

## 14. Alternatives rejected

### 14.1 Convert inside `Viewer`

Putting conversion methods on `Viewer` hides the boundary, makes conversion
require DOM and WebGL construction, and prevents applications from inspecting
or caching the result. `Viewer` should consume resolved construction input.
The independent converter is smaller to test and useful for migration.

### 14.2 Keep both loaders but normalize after parsing

This retains separate source construction, async state, browser-option
routing, and view setup. The runtime would still need to know which parser
ran. Conversion must happen before map creation.

### 14.3 Mutate authored `terrain` arrays to represent visibility

This is sufficient for one hide operation but loses the authored baseline
and leaks changes into caller-owned objects. Runtime visibility state
produces empty effective terrain sets without changing caller input.

### 14.4 Store named profiles in `StyleSpecification`

This would make the authored style a registry of application presets and
would add a Cartolina-only root concept for the sake of legacy named views.
It would also invite illumination, camera, and other unrelated runtime state
into the profile schema. The style stays MapLibre-shaped. Named presets are
application state; only `VisibilityProfile` values and their atomic Viewer
operation belong in the public API.

### 14.5 Preserve `setView()` as a wrapper

An arbitrary runtime view can introduce a new per-surface layer ordering and
stylesheet override that was not compiled into the style. Supporting it
would require dynamic layer authoring or a hidden view parser in the map.
The converter may translate its explicit construction-time `options.view`;
runtime applications migrate to layer methods or visibility profiles.

### 14.6 Put `browserOptions` in style `config`

Viewer controls and application behavior are not rendering style. Returning
them separately preserves compatibility without making the style config
block more permissive.

### 14.7 Retain a compatibility Browser object

A compatibility Browser could own the mapConfig, start asynchronous
conversion in its constructor, construct the style-based map when conversion
finishes, preserve named views, and implement `setView()` by applying the
translated visibility and rendering state.

That wrapper would also need its own readiness, pre-readiness call queue,
error propagation, events, teardown, and delegation rules. Arbitrary view
objects that introduce a new stylesheet would make a nominally synchronous
`setView()` asynchronous. The wrapper therefore preserves a second public
lifecycle and an API whose exact compatibility boundary is difficult to
state.

The conversion result already preserves the original and translated view
data. Applications can use that data through the new API without another
library object. The Browser wrapper is rejected from the main library. If a
concrete integration later requires API-level compatibility, it can live in
a separate optional legacy adapter built on `mapConfigToStyle()` and the
public `map()` factory.

## 15. Expected result

mapConfig becomes an import format. Style becomes the only live map model.

The final architecture differs from the starting point at each boundary:

| Concern | Before | After |
|---|---|---|
| Input compatibility | mapConfig and style loaders create different live maps | mapConfig is compiled before the one style loader runs |
| Core map state | style state or `MapView` state, selected by branches | one validated style with ordinary runtime visibility |
| Terrain and layers | separate view and style sequencing rules | one effective terrain list and one layer compilation path |
| Public mutation | mapConfig-only View methods beside style-era controls | layer methods and visibility profiles operate on every map |
| Failure reporting | unsupported behavior can emerge after map creation | conversion reports the exact field, dependency, and recovery |
| Public construction | `map()` and `browser()` over the legacy `Browser` shell | one `map()` factory over typed `Viewer` construction |
| Future features | must account for two partially overlapping models | target one style contract and one runtime implementation |
| Legacy removal | intertwined with constructors, `Map`, `LegacyMap`, and rendering | confined to one external converter |

The compatibility cost is paid once before initialization. The adapter can
be improved, tested, versioned, or eventually removed without changing
terrain traversal, layer compilation, rendering, or the public style API.
Its complexity is proportional to the legacy input problem rather than
multiplied across the lifetime of every map.

The core loses its View model, mapConfig load state, fabricated per-surface
styles, mapConfig-only API methods, and every style-versus-mapConfig behavior
branch. `Map` becomes responsible for one lifecycle and one normalized map
state. A successful load establishes the same invariants regardless of
input origin. The browser layer loses its legacy construction shell:
`Viewer` is constructed by typed code end to end, and the legacy JS
modules that remain are leaf helpers it instantiates.

Feature work becomes narrower. A new rendering option or layer behavior is
added to the style schema, validation, and one runtime path. If a mapConfig
can express an equivalent concept, the converter maps it. If it cannot, the
converter reports that boundary instead of introducing another core branch.

Applications retain legacy document compatibility while gaining the newer
flat API: stable layer ids, terrain-aware layer visibility, atomic visibility
profiles, and a style-defined default position. Applications can also run
the converter independently to inspect warnings, cache the result, and
migrate stored mapConfigs to styles.

The result is not only fewer files. It is a stricter dependency direction:
legacy formats depend on the style model, while the style model, map core,
and renderer do not depend on legacy formats. That boundary is the durable
benefit of the change.

[maplibre-style-root]: https://maplibre.org/maplibre-style-spec/root/
[maplibre-map-options]:
  <https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/MapOptions/>

## Review round 1

The direction is accepted: mapConfig should become an import format, and no
mapConfig or View state should survive in the map runtime. The findings below
concern the compatibility boundary and the new public contracts, not that
decision.

1. RFC 11 deletes mapConfig. It does not redesign style.

   Style is the surviving public contract. MapConfig is legacy input accepted
   temporarily through a removable converter. The two models are not peers,
   and this RFC must not merge them into a common model.

   The design boundary is:

   ```text
   mapConfig -> converter -> existing style v2 + construction values
   existing style v2 -----------------------> one style runtime
   ```

   Apply these rules to the entire RFC:

   - Every existing version-2 style remains valid and renders unchanged.
   - The converter emits the existing style schema, source discriminators, and
     semantics. It does not rename or reinterpret them.
   - Position, viewer options, visibility profiles, and warnings stay beside
     the style in the conversion result. They do not become style fields.
   - Return named `VisibilityProfile` values directly. Do not return legacy
     view definitions or a `ConvertedMapConfigView` replacement.
   - Generated layers receive stable ids. Existing anonymous authored layers
     remain valid.
   - Do not add style or runtime fields for unsupported legacy options. Warn,
     or fail in strict mode.
   - Extend style only when a named corpus input cannot otherwise convert and
     the extension is independently valid style functionality. The extension
     must be additive and non-breaking. Inline source data may qualify; a new
     home for every legacy field does not.
   - Once the corpus converts through the style loader, delete the mapConfig
     parser, View model, and all mapConfig runtime branches. The converter must
     remain removable without changing style or runtime code.
   - Browser dissolution is separate work unless deleting the mapConfig path
     cannot be completed without it.

   Anything that makes style resemble mapConfig is out of scope. Compatibility
   is implemented in the converter, not in the surviving model. Rewrite Goals,
   Non-goals, the public API, and migration phases to enforce this boundary
   before implementation starts.

2. The supported compatibility contract is not bounded tightly enough.

   The RFC says both that historical documents remain usable and that the
   converter need not preserve every VTS extension. That leaves the
   implementer deciding which unsupported forms deserve code. The conversion
   corpus should be the normative compatibility contract: fields and grammar
   forms exercised by those inputs must convert exactly; a field absent from
   the corpus gets no new runtime or style representation merely because dead
   parser code recognizes it. Encountering such a field should produce a
   structured unsupported-field warning, promoted to an error by strict mode.

   State this rule in Goals, Non-goals, and Validation. It is the guard against
   rebuilding the union model inside the converter.

3. `depthOffset` and `maxLod` should not enter the new source schema.

   An audit of all four public conversion inputs finds neither field anywhere
   in their mapConfigs. The proposed source fields therefore preserve dormant
   parser capability, not corpus behavior. They also model the old semantics
   incorrectly: `refreshFreelayesInView()` reads both values from the active
   view whenever it switches, so they are not immutable source properties.

   Remove the fields from phases 1 and 3 and from the conversion result. If a
   future input contains either field, emit the unsupported-field warning
   defined by note 2. Do not add runtime mutation or duplicated sources for an
   unexercised compatibility feature.

4. Named-view illumination and vertical exaggeration are also wider than the
   corpus contract, and the proposed optional fields cannot preserve the old
   transition semantics in any case.

   The public corpus has no named view carrying either option. Initial-view
   illumination and superelevation are exercised and should become root style
   state as specified. There is no corpus basis for
   `ConvertedMapConfigView.illumination` or
   `ConvertedMapConfigView.verticalExaggeration`.

   The distinction matters because old `setView()` actively disables
   superelevation when the next view omits it. An optional converted field plus
   an "apply when present" example leaves the previous exaggeration enabled.
   Remove these named-view fields and warn when a non-initial view supplies
   rendering options. If broader support is retained, the result needs an
   explicit disabled value and a public operation that can apply it; absence
   is not enough.

5. `viewerOptions: Partial<PublicConstructionConfig>` cannot carry the
   browser options required by the public corpus.

   The current mapConfig path accepts every catalogued key and then gives
   caller input precedence. Public corpus mapConfigs contain active internal
   label-reduction keys, and `tacoma-fitonly` also contains internal or removed
   keys. `PublicConstructionConfig` deliberately excludes internal keys. The
   converter therefore cannot both preserve current behavior and satisfy its
   declared return type.

   Classify every browser option found in the corpus. Options that still affect
   style-map rendering need a deliberate typed destination; dead and retired
   options produce warnings. Do not return a value typed as
   `PublicConstructionConfig` while hiding extra internal properties in it by
   assertion. The migration example and precedence tests must use the final
   typed result without a cast.

6. The stylesheet linker is missing a layer-symbol pass.

   VTS layer ids are a symbol space as well as output style ids. Several
   modules can define the same layer id differently, and layer properties can
   refer to other layer ids through `inherit`, `next-pass`, `selected-layer`,
   `selected-hover-layer`, `hover-layer`, and `visibility-switch`. Qualifying
   only constants, fonts, and bitmaps can either create duplicate Cartolina
   ids or leave those references bound to a layer from the wrong module.

   Specify deterministic qualification for conflicting layer ids and rewrite
   every typed layer reference transitively. The converter also needs a stable
   one-to-many mapping when one legacy presentation produces several target
   layers. Add focused tests for collisions combined with inheritance and
   visibility-switch references.

7. Mixed VTS rules should not be split into `lines` and `labels` layers.

   No stylesheet selected by the conversion corpus mixes line drawing with
   point or label drawing in one rule. The proposed split is therefore
   speculative. It is not behavior-neutral in the current processor: every
   stylesheet rule is evaluated over the feature collection, while
   inheritance, multipass, selection, hover, events, packing, and visibility
   switches refer to rule identity. Turning one rule into two changes that
   identity graph unless every property and reference has defined split
   semantics.

   Accept rules that classify cleanly as the `lines` or `labels` shapes used by
   the corpus. Emit an unsupported-rule warning for a mixed rule and fail in
   strict mode. This removes a sizeable compatibility subsystem with no
   supported input.

8. Lossless symbol qualification must be an exact conversion, not a warning
   that strict mode promotes to failure.

   The public `a-3d-mountain-map` input selects two stylesheets with a
   conflicting `@name` definition. The RFC says a fully rewritable collision
   emits a warning, while strict mode promotes every warning to an error and
   phase 6 runs the corpus strictly. Those rules make a required, losslessly
   converted corpus case fail by design.

   Separate informational diagnostics from degraded conversion. A collision
   whose definitions and all references are qualified without semantic loss
   belongs to the `exact` outcome. Strict mode should reject only a recovery
   that can change behavior or omit output. Snapshot the deterministic rename
   without classifying it as loss.

9. URL provenance through `transformRequest` needs an explicit rule.

   A request transform changes transport details; it must not silently change
   the document URL used to resolve relative references. Resolve a referenced
   source or stylesheet against the logical URL of its containing document,
   then apply `transformRequest` to the resulting request. Store logical,
   canonical URLs in the emitted style, not proxy or credential-bearing
   transport URLs.

   The construction example also needs to pass the hook to both
   `mapConfigToStyle()` and `map()`. Conversion-time requests and later tile,
   image, and glyph requests are separate. Add a test where the hook rewrites
   the document request and that document contains a relative dependency.

10. The camera precedence rule requires pre-readiness state that does not exist
   today.

   The RFC gives application camera state established before style readiness
   precedence over the style position. Today `Viewer.setPosition()` reaches
   `this.legacyMap?` and is a no-op until `createMapFromStyle()` assigns the
   loaded map. Adding `style.position` without a pending camera request would
   claim MapLibre precedence while discarding the application call.

   Specify where the pending requested position lives, when it is consumed,
   and whether several pre-ready calls use last-write-wins behavior. Test a
   constructor position, a `setPosition()` call made before `ready`, style
   position, and fallback as four distinct cases.

11. Inline terrain sources need one deterministic metadata and base-URL
    contract.

    The proposal copies reference frame, SRS, body, service, and credit data
    into every inline terrain source, but does not define how the loader
    reconciles those repeated global tables. It must not keep the first source
    silently or let terrain order select global map metadata. Require equal
    frame and shared definitions, define credit conflict handling, and reject
    inconsistent sources before constructing map objects.

    A single `baseUrl` is also insufficient if copied fields originated in a
    different document from the terrain definition unless conversion first
    canonicalizes every embedded URL. Either make the inline payload a fully
    normalized converter output with absolute resource URLs, or carry typed
    provenance for each merged document. State which form authored styles may
    use.

12. The target vocabulary conflicts with intrinsic terrain textures.

    `legacy-benatky` is explicitly in the public corpus because one terrain
    surface carries internal textures. `TileRenderRig` draws such a texture
    directly from `resourceSurface.textureUrl`; it has no style layer id and is
    not controlled by `setLayerVisibility()`. The claim that every drawable or
    styleable item is a layer is therefore false under the proposed design.

    Choose and document one model. The smaller one is to call the internal
    texture intrinsic terrain material, outside the authored layer stack and
    visibility API. The alternative is an explicit generated layer with an id.
    Do not leave a public invariant contradicted by a required regression case.

13. `setLayerVisibility()` consumes and returns terrain applicability, not
    visibility in the MapLibre sense.

    This spends the durable `visibility` method name on a `string[]` property
    and leaves no natural name for ordinary visible/hidden state later. Rename
    the primitives to describe what they mutate, for example
    `setLayerTerrainSources()` and `getLayerTerrainSources()`. A profile may
    still use an empty terrain list to make a layer inactive.

    Specify the getter's exact return type as well. In particular, define
    whether an authored omitted `terrain` is returned as an expanded snapshot
    of every declared terrain source or as an omitted/default sentinel. A
    complete profile and stable round-trip require one normalized answer.

14. Browser dissolution is both mandatory and optional in the current text.

    Goals, invariants, removal completeness, and Expected Result require
    `src/browser/browser.js` to be gone. Section 6.6 then says dissolution can
    land as an independent follow-up without reopening the design. Those are
    different RFC completion criteria.

    Keep dissolution in this RFC only if `Implemented` requires phase 5. If it
    may follow independently, remove it from this RFC's invariants and track it
    as separate accepted work. In either case, specify Viewer ownership and
    disposal order for UI, control mode, autopilot, presenter, ROI, config
    watchers, map listeners, core `Map`, and DOM. Include rollback when a
    constructor throws after UI creation; moving glue into TypeScript does not
    by itself preserve the construction and teardown lifecycle.

15. Inline `cartolina-freelayer` data must include monolithic geodata.

    The RFC currently defines this source as tiled geodata in sections 2.5 and
    7.1. The public `a-3d-mountain-map` conversion input selects
    `peaklist-org-ultras`, whose free-layer definition has `type: "geodata"`
    and one monolithic `geodata` URL. It is therefore part of the normative
    corpus, not a dormant compatibility form.

    This does not require another public source type or runtime path. The
    existing style loader constructs a `MapSurface` for
    `cartolina-freelayer`; `MapSurface` accepts both `geodata` and
    `geodata-tiles`; and the draw loop already sends the former through
    `drawMonoliticGeodata()` and the latter through the tile tree. Extend the
    existing `cartolina-freelayer` specification with additive inline data
    typed as a union of monolithic and tiled geodata definitions. Keep that
    internal dispatch behind the existing source discriminator.

    Add a focused conversion snapshot and browser assertion for
    `peaklist-org-ultras`. The test must verify the monolithic request and its
    rendered labels; a generic `a-3d-mountain-map` screenshot can otherwise
    pass using only its other geodata source.

16. "Cartolina source" is not defined precisely.

    The intended meaning appears to be one entry in the style root's
    `sources` dictionary, keyed by a unique style source id. Its descriptor
    selects a loader through `type` and supplies that loader either a URL for
    a source definition or equivalent inline definition data. That needs to
    be stated before the term is used.

    Define the relationships as part of the target vocabulary:

    - a terrain source is selected and ordered by `terrain.sources` and
      supplies terrain geometry plus the metadata needed to interpret it;
    - a raster source supplies tiled raster data and becomes visible only
      through a style layer that references its id;
    - a geodata source supplies monolithic or tiled geodata and becomes visible
      only through one or more style layers that reference its id;
    - several layers may share one raster or geodata source without creating
      several source or GPU-resource instances.

    Use distinct terms for the three shapes involved: **source
    specification** for the style entry, **source definition** for the fetched
    or inline data, and **source instance** for the runtime loader object. Use
    "style source" rather than "Cartolina source" elsewhere unless the latter
    names a separate concept. Also show the complete `sources` dictionary
    shape around `SourceLocation<T>`; the location union alone does not show a
    reader where the id and `type` live.

17. The proposed source discriminator rename is an unversioned style-schema
    redesign, not part of mapConfig conversion.

    The current version-2 style schema and loader define
    `cartolina-surface`, `cartolina-tms`, and `cartolina-freelayer`. Section
    2.5 replaces those discriminators with `cartolina-terrain`,
    `cartolina-raster`, and `cartolina-geodata`, and migration phase 1 requires
    every authored style to be rewritten. These strings are source type
    discriminators; they are not the source ids stored as keys in `sources`.
    The RFC currently presents the replacement terms as the existing
    Cartolina model, which hides the breaking change.

    MapConfig conversion does not require this rename. The converter can emit
    the three existing variants, and URL-or-inline locations can extend their
    specifications. The current loader distinction is also concrete:
    `cartolina-surface` loads a surface mapConfig, `cartolina-tms` loads a
    bound-layer definition, and `cartolina-freelayer` loads a monolithic or
    tiled free-layer definition. Replacing loader/package names with broad
    data-category names creates a second `terrain` vocabulary and obscures
    the inner definition type without reducing the number of concepts or code
    paths.

    Remove the rename from RFC 11 and keep the existing discriminators. If
    different public names are ever wanted, consider non-breaking aliases in a
    separate style proposal with explicit canonicalization and serialization
    rules. Do not increment the style version, rewrite authored styles, or add
    aliases as part of mapConfig conversion.

18. `ConvertedMapConfigView` retains a View-shaped public data model instead
    of returning visibility profiles directly.

    The RFC does not put named views in `StyleSpecification`, but the
    conversion result exposes `views: Record<string,
    ConvertedMapConfigView>`. Each value retains the original legacy view and
    wraps its profile with optional rendering state. This contradicts goal 11,
    which says conversion returns Viewer-level visibility profiles without
    retaining the View data model.

    The corpus requires named visibility presets, not a second public View
    DTO. Return `profiles: Record<string, VisibilityProfile>` directly. The
    selected initial view is already compiled into the returned style and
    construction values. Remove `original`, `ConvertedMapConfigView`, and the
    `views` wrapper. A conversion caller already owns the input document if
    migration tooling needs to inspect its original view definitions.

19. Root `position` is an unnecessary style-spec extension.

    The current style contract has no position, while `map()` already accepts
    one. `MapConfigConversion` is deliberately wider than a style, so it can
    return the converted initial `position` beside `style`, `viewerOptions`,
    and `profiles`; the construction example can pass that value to `map()`.
    Conversion therefore does not require a new style field or new camera
    precedence state.

    Remove `StyleSpecification.position` and its migration work from RFC 11.
    A future proposal may add authored style camera defaults if applications
    need them, but similarity to MapLibre and making the conversion result one
    field smaller do not justify changing this contract.

20. Requiring ids on every version-2 style layer is breaking.

    `LetteringLayerBase` requires an id today, but tile texture and constant
    layers do not. Existing authored styles use anonymous tile layers. Making
    `LayerBase.id` mandatory would reject those styles even though conversion
    can give every generated layer an explicit stable id.

    Keep existing version-2 styles valid. Require the converter to emit ids
    for its generated layers, then specify a non-breaking normalization for
    anonymous authored layers if the new mutation API must address them. The
    loader must not mutate the caller's style object, and existing anonymous
    layers must retain their current rendering when no mutation API is used.
