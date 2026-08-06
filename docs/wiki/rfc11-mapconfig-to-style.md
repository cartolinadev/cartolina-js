# RFC 11: retire legacy mapConfig support from Cartolina proper

**Status:** In review
**Opened:** 2026-07-13
**Updated:** 2026-07-16 — scope revision: `map()` factory kept, free-layer
machinery untouched, `Browser` dissolution added, open questions resolved
into design positions, conversion corpus widened to every mapConfig-based
test URL
**Updated:** 2026-07-17 — review round 1 response: the version-2 style
contract is frozen, the conversion corpus becomes the compatibility
contract, the conversion result returns visibility profiles and position
beside the style, and `Browser` dissolution moves to separate follow-up
work
**Updated:** 2026-07-18 — review round 2 response: the strict closure
gate moves into phase 3 and no-op drops become informational notes, the
existing `LayerBase` generic and diffuse type default are preserved,
inline metadata rules are scoped off URL sources, and lettering terrain
applicability gets the executable stack-intersection contract
**Updated:** 2026-07-18 — review round 3 response: one no-op-drop rule
stated everywhere, mutation methods gain the throw-before-`ready`
contract, omitted `terrain` expands against all declared
`cartolina-surface` sources
**Updated:** 2026-07-20 — review round 6 request: reopened from
`Implemented` after an implementation review found the linker's internal
stylesheet identity escaping into profile construction. Sections 4, 7.1,
and 8.3 gain the explicitly transitional stylesheet-scope terminology;
see round 6 below.
**Updated:** 2026-07-31 — post-implementation review round 10: reopened
because the URL-or-inline source union puts compatibility construction data
into the public style specification, contradicting the boundary established
in review round 1.
**Updated:** 2026-08-02 — review round 10 author response: source entries now
contain either `url` or `definition`; source and credit loading follow source
declaration order.
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

The two models are not peers, and this RFC does not merge them into a
common model. Style is the surviving contract; mapConfig is legacy input
accepted temporarily through a removable converter. The design boundary
is:

```text
mapConfig -> converter -> existing style v2 + construction values
existing style v2 -----------------------> one style runtime
```

The version-2 style contract is frozen in this RFC: every existing style
remains valid and renders unchanged, and the converter emits the existing
schema, source discriminators, and semantics. Style is extended only when
a corpus input cannot otherwise convert and the extension is
independently valid style functionality; every extension is additive and
non-breaking.

An independent compatibility adapter converts a mapConfig into a Cartolina
style and associated construction defaults before map initialization. The
adapter is called explicitly by applications and migration tools. It is not
called by `Viewer`. After conversion, every map follows the same style
constructor, loader, style state, layer sequencing, and rendering path.

The runtime concepts `MapConfig`, `MapView`, `namedViews`, and
`currentView_` are removed. The `style or mapConfig` branches in `Viewer`,
`Map`, `LegacyMap`, terrain selection, free-layer selection, and refresh
logic are removed with them. The mapConfig ingestion hosted by `Browser`
(`src/browser/browser.js`) is removed as part of the same deletion.
Dissolving the rest of `Browser` into typed `Viewer` code is separate
follow-up work; deleting the mapConfig path does not depend on it.

The replacement for the visibility part of a named view is a
**visibility profile**: a Viewer-level value that atomically selects terrain
sources and controls layer visibility or per-terrain applicability. Profiles
are not stored in `StyleSpecification`. Applications own any names or preset
registry; the style remains a MapLibre-shaped description of one map.

The primitive layer API expresses Cartolina's terrain-aware layer
applicability directly:

```ts
viewer.setLayerTerrainSources('roads', ['world-terrain']);
viewer.setLayerTerrainSources('roads', []); // inactive on every terrain
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

The Cartolina model has sources, terrain, and layers. Every layer is
selected, ordered, and controlled through one contract. Diffuse imagery,
bump maps, specular maps, labels, and lines have different layer types
and internal processors, but no public category separates them.

One drawable is deliberately outside the layer stack: a terrain surface
with internal textures (`resourceSurface.textureUrl`) draws that texture
as intrinsic terrain material. It is part of the terrain source's own
data, has no style layer id, and is not addressable by the layer
mutation API. `legacy-benatky` in the conversion corpus exercises this
case.

Three terms distinguish the shapes involved in loading a source:

- a **source specification** is one entry in the style root's `sources`
  dictionary, keyed by a unique style source id; its `type` selects a
  loader, and it supplies either a URL or equivalent inline data;
- a **source definition** is the fetched or inline data that the loader
  consumes;
- a **source instance** is the runtime loader object built from the
  definition.

The source types relate to the rest of the style as follows:

- a terrain source (`cartolina-surface`) is selected and ordered by
  `terrain.sources` and supplies terrain geometry plus the metadata
  needed to interpret it;
- a raster source (`cartolina-tms`) supplies tiled raster data and
  becomes visible only through a style layer that references its id;
- a geodata source (`cartolina-freelayer`) supplies monolithic or tiled
  geodata and becomes visible only through one or more style layers
  that reference its id;
- several layers may share one raster or geodata source without
  creating several source or GPU-resource instances.

These are the existing version-2 discriminators. This RFC does not
rename or reinterpret them; renaming is a possible separate style
proposal (section 4).

“Bound layer” and “free layer” are VTS input terms. This RFC uses them only
when naming mapConfig fields, explaining conversion, or identifying legacy
code to delete. They do not appear in the target style schema, in the
converter's output, or in visibility profiles.

One bounded exception survives outside that boundary: the existing
`Viewer.createGeodata()` / `addFreeLayer()` / `removeFreeLayer()` overlay
methods and their internal machinery keep the "free layer" spelling, per
section 4's retained-machinery decision, and the non-interactive demo
documents that transitional surface. This is a legacy compatibility path,
not part of the style/profile contract; it does not reappear in the target
style schema, the converter's output, or the profile API this RFC adds.

The source type selects a loader. The layer type selects a processor. All
layers share one array, identity, ordering, and terrain applicability
contract; the source discriminators describe the data being loaded, not
a parallel layer hierarchy.

### 2.6 Layer identity is incomplete

Lettering layers have ids. Terrain texture and constant layers do not. A
MapLibre-like runtime style API requires every mutable layer to have a
stable, unique id.

Making `id` mandatory in the schema would break existing authored
styles, which use anonymous tile layers. The schema therefore keeps `id`
optional. The converter emits an explicit stable id on every layer it
generates, and validation assigns a deterministic generated id to each
anonymous authored layer in the runtime style state (section 9) so the
mutation API can address it. Validation rejects duplicate explicit ids.
Anonymous authored styles stay valid, render unchanged, and are never
mutated in place.

### 2.7 Default position travels beside the style

`map()` accepts an optional `position` construction option, but a style
cannot carry its own default position, while a mapConfig can. The
converted initial position therefore travels beside the style in the
conversion result, and the application passes it to `map()`.

The [MapLibre style root specification][maplibre-style-root] defines
default camera properties at the style root, but adding a Cartolina
equivalent is a style-contract extension that conversion does not
require. The conversion result is deliberately wider than a style, so
it is the natural home for the value. A future proposal may add
authored style camera defaults if applications need them.

### 2.8 `Browser` hosts the mapConfig ingestion

`Viewer` is a typed facade constructed over `Browser`
(`src/browser/browser.js`), a legacy JS module. `Browser` ingests the
`browser()` config bag, re-applies mapConfig `browserOptions` after
`map-loaded`, routes the legacy `position` and `view` commands in
`applyConfigParam`, activates the `geojson` / `geodata` construction
options through `getView()` / `setView()`, and constructs and wires the
UI, autopilot, control-mode, presenter, and ROI helpers.

Removing the mapConfig model deletes the format-specific part of that
list: the config-bag ingestion, the `browserOptions` re-application,
the `view` command, and the View-based activation of the `geojson` /
`geodata` options. What remains is viewer glue with no format content:
sub-object construction, config watchers, per-tick dispatch,
position-in-URL updates, and teardown. Dissolving that remainder into
typed `Viewer` code is worthwhile — the direction is already recorded
in the removal of the vts-era `Browser` config accessors — but it is
not required to delete the mapConfig path. It is tracked as separate
follow-up work with its own construction, ownership, and teardown
design, outside this RFC's completion criteria.

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
4. Keep every existing version-2 style valid and rendering unchanged.
   The converter emits the existing style schema, discriminators, and
   semantics; the converter remains removable without changing style or
   runtime code.
5. Make the conversion corpus (section 8.6) the normative compatibility
   contract: fields and grammar forms exercised by corpus inputs
   convert exactly; fields outside the corpus produce structured
   unsupported-field diagnostics — warnings when the current client
   reads them, informational notes when it ignores them (section
   8.5) — and gain no new style or runtime representation.
6. Remove mapConfig and View state, branches, and methods from `Viewer`,
   `Map`, `LegacyMap`, traversal, and layer compilation, together with
   the mapConfig ingestion hosted by `Browser`.
7. Ensure core map and renderer code cannot observe whether a style was
   authored directly or converted.
8. Move format reconciliation into a deterministic compiler that can be
   tested without DOM, WebGL, or a running map.
9. Report compatibility loss at conversion time with actionable errors or
   structured warnings instead of reduced behavior later in the runtime.
10. Provide a flat runtime layer terrain-applicability API over the
    single style model.
11. Preserve Cartolina's terrain-specific ability to activate terrain
    sources and apply one layer to selected terrain sources.
12. Translate named mapConfig views into Viewer-level visibility
    profiles returned beside the style, without retaining the View data
    model.
13. Return the converted initial position beside the style, feeding the
    existing `map()` construction option.

These goals reduce future feature work as well as current code. A new layer
or rendering capability has one authored representation, one validation
path, one runtime state path, and one set of lifecycle rules. Supporting a
legacy input becomes converter work rather than a second implementation of
the feature.

## 4. Non-goals

- The style contract is not redesigned. Style is the surviving model;
  anything that makes style resemble mapConfig is out of scope.
  Compatibility is implemented in the converter, not in the surviving
  model. Style extensions are limited to what a named corpus input
  needs and must be additive, non-breaking, and independently valid
  style functionality.
- The source discriminators are not renamed. `cartolina-surface`,
  `cartolina-tms`, and `cartolina-freelayer` stay as they are. Better
  public names (for example `cartolina-terrain`, `cartolina-raster`,
  and `cartolina-vector`) may be worth having, but they are a separate
  non-breaking alias proposal with its own canonicalization and
  serialization rules, not part of mapConfig conversion.
- `Browser` is not dissolved here. This RFC removes only its mapConfig
  ingestion; moving the surviving viewer glue into typed `Viewer` code
  and deleting `src/browser/browser.js` is separate follow-up work
  with its own construction and teardown design.
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
- The converter does not make every historical VTS extension part of the
  Cartolina style specification. The corpus bounds what must convert
  exactly; a field outside it gets a structured diagnostic — a warning,
  or a note when the current client ignores it — not new code.
- The converter does not preserve ignored virtual-surface or glue client
  behavior. Those concepts are already absent from the client renderer.
- The linker's internal stylesheet-scope id (section 8.3) is not a new
  Cartolina concept. It exists only to qualify a colliding symbol's
  generated name during linking and must not survive into the returned
  style, a visibility profile, or any runtime API. Looking it up by a
  different identity (the free-layer key, the source id) is a defect,
  not an accepted alternate spelling.

## 5. Invariants

After this RFC:

1. Every successfully constructed map has a validated style.
2. Core map and renderer code cannot determine whether that style was
   authored directly or converted from a mapConfig.
3. `LegacyMap.style` is non-null after map creation. The property can later
   be renamed when `LegacyMap` is absorbed into `Map`.
4. The authored style is the immutable baseline for runtime style state.
5. Runtime mutations do not edit the caller's style object.
6. Every layer in runtime style state has a unique id: explicit
   authored and converter-generated ids are unique, and anonymous
   authored layers receive deterministic generated ids at validation.
   Anonymous authored styles remain valid and render unchanged.
7. A visibility-profile operation is atomic: a frame sees either the old
   style visibility or the complete new visibility state.
8. `Viewer` expands a visibility profile into primitive style mutations.
   Core `Map`, `MapStyle`, traversal, and rendering have no profile type,
   registry, active-profile field, or profile-specific branch.
9. A URL source resolves relative resources against its fetched definition;
   an inline source resolves them against the containing style document.
   Converted definitions contain absolute resource URLs.
10. `StyleSpecification` contains no visibility-profile fields.
11. “Bound layer” does not appear outside the compatibility converter
    and references to code being removed. “Free layer” survives only
    where it already exists — the `cartolina-freelayer` source
    discriminator and the internal free-layer machinery kept by the
    non-goals. Neither term names a model concept beside sources,
    terrain, and layers, and no new public API introduces either.
12. Applying a visibility profile does not enter a profile mode. Later
    direct mutations and later profile applications follow normal call
    order; the last operation affecting a value wins.
13. No `Browser` code reads mapConfig state: the config-bag ingestion,
    `browserOptions` re-application, `view` command, and View-based
    construction options are gone from `src/browser/browser.js`. The
    module itself survives until the separate dissolution work.
14. The version-2 style schema accepted before this RFC is still
    accepted, with identical rendering. Additions to the schema are
    optional fields only.

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

`MapOptions.position` stays optional, and camera behavior is unchanged:
an explicit constructor `position` wins, otherwise the existing computed
fallback applies. The style contract gains no position field; a
converted mapConfig's initial position is returned beside the style
(section 6.2) and passed to `map()` by the application. No new
pre-readiness camera state is introduced. The existing limitation that
`Viewer.setPosition()` is a no-op before the map is created predates
this RFC and is unchanged by it.

The `browser(element, config)` factory is removed, together with
`BrowserConfig` and the mapConfig-preserving `configFromUrl()` helper.
Compatibility means that mapConfig data can be converted, not that its
constructor or public API survives. The internal `Browser` class loses
its mapConfig ingestion (section 6.6) and is dissolved in separate
follow-up work.

### 6.2 Independent conversion

Export one async function:

```ts
type MapConfigInput = string | Record<string, unknown>;

interface MapConfigConversion {
    style: MapStyle.StyleSpecification;
    position: PositionInput | null;
    viewerOptions: Partial<PublicConstructionConfig>;
    profiles: Record<string, Viewer.VisibilityProfile>;
    warnings: MapConfigConversionWarning[];
    notes: MapConfigConversionNote[];
}

interface MapConfigConversionWarning {
    code: string;
    path: string;
    message: string;
    recovery: string;
}

interface MapConfigConversionNote {
    code: string;
    path: string;
    message: string;
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

The result is wider than a bare style because a mapConfig carries more
than authored rendering state. `position` is the converted initial
position; the application passes it to `map()`. `viewerOptions` are
viewer construction defaults from `browserOptions`; the application
merges them below its own constructor options, preserving the current
rule that caller configuration wins. `profiles` are the named views
translated into plain visibility profiles (section 6.4); the converter
returns no legacy view definitions and no wrapper type around the
profiles. The style loader receives none of these fields.

Every `browserOptions` key found in a corpus input is classified during
implementation: a key that still affects style-map rendering gets a
deliberate typed destination in `PublicConstructionConfig` — for the
known corpus keys `mapFeaturesReduceMode` and `mapFeaturesReduceParams`
this means promoting them from internal to public catalogue visibility
as documented label-density options — and a key the current client
ignores is dropped as an exact no-op with an informational note
(section 8.5). The declared `viewerOptions` type is the real emitted
type; the converter never widens it by assertion, and the migration
example and precedence tests use it without a cast.

`warnings` report recovered conversions: a deterministic fallback
produced a usable result that may differ from the legacy rendering.
`notes` report informational diagnostics about exact conversions, such
as a deterministic symbol rename whose references were all rewritten
(section 8.3) or a dropped construct the current client already ignores
(section 8.5). Strict mode fails on warnings, never on notes.

Typical compatibility construction is explicit:

```ts
const converted = await mapConfigToStyle(mapConfigUrl, {
    transformRequest,
});

const viewer = cartolina.map({
    container,
    style: converted.style,
    position: converted.position ?? undefined,
    options: {
        ...converted.viewerOptions,
        ...applicationOptions,
    },
    transformRequest,
});

await viewer.ready;
viewer.applyVisibilityProfile(converted.profiles.satellite);
```

The `await` is required: the runtime mutation methods throw before
`viewer.ready` resolves (section 6.3).

`transformRequest` is passed to both calls because the two hooks cover
different requests: conversion-time fetches of referenced resources and
stylesheets, and runtime tile, image, and glyph requests.

`MapConfigViewDefinition` is the validated legacy input type owned by the
converter. It is not exported as part of the map or style API.

For a URL input, the document URL supplies the base URL. For an object input,
`baseUrl` is required if any relative URL is present. Conversion rejects an
ambiguous relative URL instead of resolving it against the current page.

The function performs I/O needed to resolve referenced mapConfig resources
and stylesheets. `transformRequest` applies to those requests, and it
changes transport details only. A referenced source or stylesheet is
resolved against the logical URL of the document that contains it;
`transformRequest` is then applied to the resulting request. The emitted
style stores logical, canonical URLs, never proxy or credential-bearing
transport URLs. The returned style is JSON-serializable and can be
inspected, edited, cached, or supplied to the `map()` factory. Warnings
identify both the input location and the deterministic recovery that was
applied, so a caller can decide whether the converted result is
acceptable.

### 6.3 Runtime layer methods

`Viewer` exposes primitive methods for applications that do not want
profiles or need a one-off change:

```ts
viewer.setLayerTerrainSources(layerId, terrainIds);
viewer.getLayerTerrainSources(layerId);

viewer.setTerrainSources(sourceIds);
viewer.getTerrainSources();
```

The methods are named for what they mutate: a layer's terrain-source
applicability list, not visibility in the MapLibre sense. The plain
`visibility` name stays free for a later visible/hidden layer property.

`setLayerTerrainSources()` replaces the layer's active terrain-source
list. It validates every id as a terrain source and stores a copy of the
array. An empty array makes the layer inactive everywhere. The same
method applies to every layer type.

Runtime state is normalized: validation expands an omitted authored
`terrain` into the explicit list of every `cartolina-surface` entry in
the style's `sources` dictionary — independent of the initial
`terrain.sources` stack, preserving the current unrestricted meaning of
an omitted list. `getLayerTerrainSources()` therefore always returns an
explicit array copy, never an omitted-value sentinel, and a captured
profile round-trips exactly.

`setTerrainSources()` changes the active terrain stack. It validates ids and
preserves the caller's back-to-front order. A terrain source may remain
loaded while inactive; visibility changes do not rebuild source objects.

The public contract — the authored `terrain` field, the mutation
methods, and validation — is identical for diffuse, bump, specular,
label, line, and later layer types. Evaluation granularity differs by
processor and is part of the specified behavior:

- tile layers are evaluated per terrain tile: the renderer checks the
  layer's effective terrain list against the tile's terrain source;
- lettering layers are evaluated against the active terrain stack as a
  whole: a label or line rule is active exactly when its effective
  terrain list intersects the active stack. Stylesheet compilation in
  `MapStyle.refreshSequences()` excludes inactive rules, and the
  affected free-layer stylesheets recompile when the rule list or the
  active terrain stack changes.

Per-terrain-tile lettering is not promised by this RFC: the free-layer
drawing path compiles one stylesheet per geodata source and cannot
evaluate a rule per tile (section 4). The stack-intersection rule is
the contract the current runtime can execute.

Unknown layer ids, duplicate source ids, and non-terrain ids throw. Runtime
style mutation must not silently no-op.

The methods also have a readiness precondition. Style construction is
asynchronous, and until `viewer.ready` resolves no validated style
state — layer ids, source ids, normalized terrain lists — exists to
mutate or query. All four primitive terrain methods and both profile
methods throw when called before readiness; there is no
pending-operation queue. A second state machine for calls made before
their targets exist is not justified by conversion, and a queued
mutation could not be validated at call time without one.

The existing `terrain` field moves from `TileLayerBase` to the common
`LayerBase` and becomes the single authored terrain-applicability
representation. Both additions are optional fields on the existing
generic. Nothing about `type` changes: the current
`LayerBase<TType extends string>` shape and the `DiffuseMapLayer`
override that permits an omitted `type` (defaulting to `diffuse-map`)
are preserved, so shipped styles using that form keep validating:

```ts
export type LayerBase<TType extends string> = {
    type: TType,
    id?: string,
    terrain?: string[],
    necessity?: 'optional' | 'essential'
}
```

Every style layer type extends this common identity and
terrain-applicability contract. `id` stays optional in the authored
schema so existing anonymous styles remain valid; runtime state assigns
deterministic generated ids (section 9), computed after the omitted
diffuse type default is applied. Omitting `terrain` means all terrain
sources in the style; an empty array means inactive everywhere. Source
shape and internal processing vary by type; layer selection and
mutation do not.

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
mapConfig converter returns each profile inside `conversion.profiles`
because mapConfig supplies named views, but that compatibility result
does not become style state.

The profile is a complete snapshot: active terrain sources plus the active
terrain list for every style layer. `Viewer` rejects a profile that omits or
names an unknown layer.

`Viewer.applyVisibilityProfile()` translates that snapshot into the same
primitive changes exposed by `setLayerTerrainSources()` and
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
viewer.setLayerTerrainSources('labels', []);

// Captures `base` with labels now hidden.
const modified = viewer.getVisibilityProfile();

// Writes the complete `base` snapshot again, restoring its label state.
viewer.applyVisibilityProfile(base);
```

A direct `setLayerTerrainSources()` call replaces only that layer's
terrain
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

### 6.6 `Browser` loses its mapConfig ingestion

The mapConfig-specific members of `Browser` are removed with the
mapConfig model:

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

The surviving viewer glue — sub-object construction, config watchers,
per-tick dispatch, position-in-URL updates, and teardown — stays in
`src/browser/browser.js` for now. Dissolving it into typed `Viewer`
code is separate follow-up work (section 2.8); that work owes its own
specification of construction order, ownership, disposal, and rollback
when a constructor throws, and is not part of this RFC's completion
criteria.

## 7. Style source representation

### 7.1 URL and inline forms

Conversion starts from a fetched aggregate mapConfig. The unified style
loader must be able to consume the resource definitions already present in
that document without pretending that each one has an independent endpoint.

Each style source specification therefore accepts exactly one of a URL
or inline definition. The addition is additive to the existing version-2
specifications; URL-only sources stay valid unchanged:

```ts
type StyleSpecification = {
    sources: Record<string, SourceSpecification>;
};

// Sketch of one variant; the other discriminators follow the same
// pattern with their own definition types.
type SurfaceSourceSpecification = {
    type: 'cartolina-surface';
    url: string;
} | {
    type: 'cartolina-surface';
    definition: SurfaceSourceDefinition;
};
```

The existing source types combine their discriminator with the relevant
inline definition:

- `cartolina-surface` inline `definition` is one terrain resource definition
  plus the reference-frame, SRS, body, service, and credit metadata
  needed to initialize it;
- `cartolina-tms` inline `definition` is a tiled raster source definition;
- `cartolina-freelayer` inline `definition` is a union of the monolithic and
  tiled geodata definitions that `MapSurface` already accepts. The
  draw loop already routes monolithic geodata through
  `drawMonoliticGeodata()` and tiled geodata through the tile tree;
  the dispatch stays behind the existing discriminator. The corpus
  requires the monolithic form: `a-3d-mountain-map` selects
  `peaklist-org-ultras`, a free layer with one monolithic `geodata`
  URL.

Inline source support is part of the style loader, not a mapConfig escape
hatch. A URL source resolves relative resources against its fetched source
document. An inline source resolves them against the containing style
document retained by `LegacyMap.url`. Shared first-surface metadata follows
the same rule. `MapSrs` receives the selected document path for relative
geoid-grid resolution, and `MapStyle.loadStyle()` resolves the atmosphere
service URL from that path before constructing `Atmosphere`. `MapBody` and
`MapRefFrame` do not resolve URLs. Source construction never replaces the
style-level `LegacyMap.url`.

For a legacy mapConfig with several surfaces, the converter emits one
terrain source per surface. Shared reference metadata is copied into each
small inline source definition. Avoiding that small JSON duplication would
require a second shared-resource context and is not worth another concept.

Repeated inline metadata needs one deterministic contract. The rules
below bind the additive inline form only. URL sources keep their
current acceptance behavior — global tables taken from the first
surface document, later documents checked for reference-frame id
agreement — so every existing URL-only style loads unchanged. A future
proposal may strengthen URL-source consistency after auditing authored
styles; conversion work must not introduce that break.

- converter output is fully normalized: every URL embedded in an inline
  definition is absolute, so no loader provenance is stored in the style;
- authored styles may use either the URL or the inline form; relative
  URLs inside an inline definition resolve against the containing style
  document;
- the loader requires the reference frame and the shared SRS, body,
  and service definitions to be structurally equal across all inline
  terrain sources in one style; an inconsistency is a load error
  reported before any map object is constructed, never resolved by
  keeping the first source or letting terrain order decide;
- credits merge by id across inline sources; two definitions of the
  same credit id must be structurally equal, otherwise loading fails
  with both source ids named;
- structural equality ignores JSON object key order; array order and
  canonical URL values are significant.

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
| `surfaces` | one inline `cartolina-surface` source per surface |
| `boundLayers` | inline `cartolina-tms` sources |
| `freeLayers` | inline `cartolina-freelayer` sources |
| `stylesheets` | resolved into Cartolina geodata style layers |
| `position` | conversion result `position` |
| `view` | initial layer visibility and root rendering properties |
| `namedViews` | conversion result `profiles` |
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
profiles in `conversion.profiles` select the appropriate variant.

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

A VTS stylesheet has four symbol spaces:

- `layers`, which become entries in the Cartolina `layers` array and
  whose ids are also a referenceable symbol space;
- `constants`, which become candidates for the root `constants` table;
- `fonts`, which become candidates for the root `fonts` table;
- `bitmaps`, which become candidates for the root `bitmaps` table.

Several selected free layers, or several named views, can import
stylesheets whose symbols use the same name in any of the four spaces.
Cartolina has one root table of each kind and one flat layer-id space,
so conversion includes a linker pass after all effective stylesheets
have been loaded.

Merging needs one transitional identity per resolved stylesheet, used only
to qualify a colliding symbol's generated name: a scope id, unique across
the whole conversion. No other code — the returned style, the visibility
profiles, the runtime layer API — carries or looks anything up by this id.
Its scope is exactly the linker pass; the linker's own free-layer key and
view-id order remain the caller's identity for everything else, including
which named view activates which emitted rule.

The linker processes resolved stylesheets in deterministic source-id and
view-id order, applying the same rules to all four symbol spaces:

1. A symbol absent from the output space keeps its original name.
2. A symbol with a structurally equal definition is coalesced silently.
3. A symbol with a different definition is assigned a deterministic
   scope-qualified name.
4. References in that stylesheet's layers and constants are rewritten to
   the qualified name.
5. Dependencies are followed transitively. Renaming a constant also rewrites
   references from other constants in the same stylesheet.

For layer symbols, rewriting covers every typed layer reference:
`inherit`, `next-pass`, `selected-layer`, `selected-hover-layer`,
`hover-layer`, and `visibility-switch`. When one legacy layer id maps to
several target layers, the linker records a stable one-to-many mapping
so each reference form resolves deterministically.

Rewriting must understand the VTS stylesheet grammar. Constant references
can be standalone strings or appear in string templates. Font and bitmap
aliases occur in typed properties and can also be reached through constants.
The linker parses those references and rewrites the expression tree. A blind
text replacement can change label text and is not acceptable.

A collision whose definitions and references are all qualified and
rewritten is an exact conversion: rendering is preserved and nothing was
dropped. It produces an informational note recording the original name,
the generated name, and both source stylesheets — not a warning, and it
never fails strict mode. The note exists because the output is no longer
a straightforward flattening even though behavior is identical.

When a reference cannot be classified or rewritten, the converter keeps the
first definition, gives the later stylesheet a qualified definition where
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
VTS stylesheet layer shape. Conversion uses the discriminator matching
the enabled point or line properties. No stylesheet selected by the
conversion corpus mixes line drawing with point or label drawing in one
rule, so mixed rules get no conversion machinery: a rule that neither
discriminator accepts cleanly produces an unsupported-rule warning, is
not emitted, and fails in strict mode. Rule identity — inheritance,
multipass, selection, hover, packing, and visibility switches all refer
to it — makes any split non-trivial, and conversion never guesses from
property names or silently drops half of a rule. A generic `geodata`
layer type is likewise rejected: it would reintroduce an untyped
catch-all where the style schema is deliberately typed per aspect.

Legacy geodata `depthOffset` and `maxLod` overrides appear nowhere in
the conversion corpus, so they get no style or runtime representation.
An input that contains either field produces a structured
unsupported-field warning, promoted to an error in strict mode, per the
corpus contract (goal 5).

### 8.4 View options

The selected construction view's `surfaces` and `freeLayers` become the
generated style's initial terrain and layer visibility. Its supported
`view.options` become normal root style fields:

- `illumination` becomes `style.illumination`;
- `superelevation` is normalized to the current typed
  `style['vertical-exaggeration']` representation.

Each named view becomes one plain `VisibilityProfile` in
`conversion.profiles`. No corpus input has a named view carrying
rendering options, so the profile is the entire converted value: there
is no wrapper type, no retained legacy view definition, and no optional
illumination or exaggeration fields. Optional fields could not preserve
the legacy semantics anyway — old `setView()` actively disables
superelevation when the next view omits it, so "apply when present"
would leave stale state behind.

An application that wants view-like behavior applies the profile through
`applyVisibilityProfile()`. A caller that needs the original view
definitions for migration tooling already owns the input document.

Unknown options on the selected view are conversion errors. Any option —
including `illumination` and `superelevation` — on a non-initial named
view produces a structured warning and no output. This keeps
`VisibilityProfile` from becoming an untyped replacement for
`MapView.options`.

An explicit `options.view` passed to `mapConfigToStyle()` wins over the
mapConfig's initial view. A string resolves a named view. An object is
converted to an anonymous initial style state. The converter does this
before the Viewer exists; no runtime `setView()` path remains.

### 8.5 Warnings and errors

Warnings and notes are returned as structured values. The application
decides whether to log, display, reject, or persist them. The dividing
line is current-client behavior. Dropping a construct the current
client already ignores — non-empty virtual-surface or glue
declarations, dead browser options — preserves rendering exactly and
produces an informational note. A warning marks best-effort recovery
from an external or stylesheet-reconciliation problem, or a dropped
field that could change behavior.

Conversion has three outcomes for a field or dependency:

- **exact**: behavior is fully preserved; may carry an informational
  note, such as a deterministic symbol rename whose references were all
  rewritten (section 8.3) or a dropped construct the current client
  already ignores;
- **recovered**: a deterministic fallback produced a usable result and a
  structured warning describes the possible difference;
- **fatal**: no coherent style can be constructed.

Missing frame metadata, no usable terrain surface, malformed source ids, or
an invalid resulting style are fatal. A failed optional free-layer
stylesheet or an unrewritable symbol reference is recoverable. A field
or grammar form outside the conversion corpus gains no style or runtime
representation either way: when the current client reads it, dropping
it could change behavior, so it is recoverable with an
unsupported-field or unsupported-rule warning; when the current client
ignores it, dropping it is an exact outcome with a note. The converter
does not hide a visible difference: the warning names the omitted or
rebound element and the recovery used.

`options.strict` promotes every recoverable outcome to an error; exact
outcomes and their notes never fail. The default stays best-effort: the
function exists to load historical documents, and refusing a whole map
over one degraded optional layer would serve nobody at runtime. Strict
mode serves migration tooling and checked-in fixtures, where a new
warning must fail loudly instead of aging into an accepted diff.

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
  lettering; it selects two stylesheets with a conflicting `@name`
  constant, exercising the linker's exact qualification path, and the
  `peaklist-org-ultras` free layer, whose single monolithic `geodata`
  URL exercises inline monolithic geodata (section 7.1);
- `nacis-2023` — blend modes and view-dependent alphas across several
  bound layers;
- `legacy-benatky` — a tileset with internal textures beside a global
  terrain, whose mapConfig carries non-empty glue declarations,
  exercising the ignored-glue note path (section 8.5).

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

The authored style is a validated clone of caller input. Validation
normalizes that clone without touching the caller's object. Each
anonymous authored layer receives a deterministic generated id: the
candidate is derived from the layer's effective type — after the
omitted diffuse type default is applied — and its array position, and
while the candidate equals any explicit id in the style, a
deterministic disambiguation suffix is appended until it is unique.
Explicit ids are never rewritten; duplicate explicit ids are still
rejected. Each omitted layer `terrain` expands to the explicit list of
every `cartolina-surface` entry in the `sources` dictionary, not the
initially active stack (section 6.3). Runtime overrides introduced by
this RFC hold active terrain sources and per-layer terrain lists. The
effective state is derived at commit time and exposed to terrain
traversal and style compilation.
Existing runtime illumination and vertical-exaggeration setters remain
separate rendering APIs.

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
- the mapConfig ingestion inside
  [src/browser/browser.js](../../src/browser/browser.js) (section 6.6):
  the `originalConfig` capture, the `browserOptions` re-application,
  the `view` command, and the View-based construction-option
  activation — the module itself survives until the separate
  dissolution work;
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

Every step is additive; existing authored styles remain valid unchanged.

1. Add optional `id` to the common layer base. Validation assigns
   deterministic generated ids to anonymous layers in runtime state and
   rejects duplicate explicit ids.
2. Add explicit URL-or-definition unions to the existing source
   specifications, including the monolithic-or-tiled union for
   `cartolina-freelayer`, and the inline metadata consistency rules
   (section 7.1).
3. Move `terrain` to the common base shared by every layer type and
   define an empty list as inactive everywhere; validation expands an
   omitted list to every `cartolina-surface` source-dictionary entry
   (section 6.3).

### Phase 2: runtime mutation

1. Introduce authored and runtime style state in `MapStyle`.
2. Add the layer terrain-applicability and active-terrain methods.
3. Make terrain traversal and every layer processor read the common
   effective terrain-applicability state.
4. Add a generic atomic style-mutation batch to core `Map`.
5. Implement visibility-profile validation and expansion only in `Viewer`.

### Phase 3: compatibility conversion

1. Implement `mapConfigToStyle()` with checked-in public fixtures.
2. Convert surfaces, bound layers, free layers, stylesheets, views,
   position, and browser options. Classify every corpus
   `browserOptions` key into one of the three outcomes of sections
   6.2 and 8.5: a behaviorally active key gets a typed destination,
   a proven current-client no-op is dropped with an exact-outcome
   note, and an unsupported active key gets a structured warning,
   which blocks phase 4 through the closure gate in step 5.
3. Update compatibility callers to await conversion and construct the
   map with `map()`, `conversion.style`, and `conversion.position`.
4. Compare the converted style, position, viewer options, and profiles
   with expected snapshots before browser rendering tests.
5. Pass the compatibility closure gate: the full conversion corpus
   converts in strict mode — no-op drops surface as notes and do not
   fail; any warning is an open compatibility gap — and the snapshot
   review and pre-removal rendering comparisons complete. One rule
   applies everywhere: every behaviorally active corpus field has a
   typed style or construction destination, and a field proven to be
   a current-client no-op is dropped with an exact-outcome note. No
   opaque `legacy` field, no old parser called from the style loader.

### Phase 4: delete the second runtime

Phase 4 starts only after the phase-3 closure gate passes. There is no
post-deletion phase whose purpose is to discover or close conversion
gaps; once the mapConfig runtime is gone, the live reference path is
gone with it.

1. Remove the mapConfig initialization factory and state from `Map`.
2. Remove `MapConfig`, `MapView`, and the legacy sequence generator.
3. Remove all `if (map.style)` and `if (!map.style)` behavior branches.
4. Remove the View methods from `Viewer`, core `Map`, and `LegacyMap`,
   together with `getCurrentView()` and `refreshFreelayesInView()`.
5. Remove `browser()`, the mapConfig ingestion in
   `src/browser/browser.js`, the `geojson` / `geodata` /
   `geojsonStyle` construction options, obsolete types, events, config
   keys, demos, and documentation.

## 13. Validation

### 13.1 Conversion tests

Checked-in public fixtures cover:

- one and several surfaces;
- different raster-layer orders on different terrains;
- diffuse, bump, and specular layer parameters;
- free layers with inline and referenced stylesheets;
- several stylesheets with equal and conflicting constants, fonts, and
  bitmaps;
- conflicting layer ids across stylesheets, combined with `inherit`
  and `visibility-switch` references to the colliding family;
- transitive constant references and references embedded in templates;
- exact-outcome notes for deterministic symbol renames, distinct from
  recovered-outcome warnings, with strict mode failing only the
  latter;
- a monolithic free-layer geodata definition (`peaklist-org-ultras`),
  asserting the monolithic request and its rendered labels, not only a
  whole-scene screenshot;
- an unavailable view stylesheet with a usable free-layer default;
- a free layer for which neither stylesheet can be loaded;
- named views and an explicit construction view;
- initial-view illumination and superelevation options, and
  unsupported-option warnings for rendering options on named views;
- relative URL resolution from URL and object inputs;
- a `transformRequest` hook that rewrites the document request while
  the document contains a relative dependency, asserting logical
  resolution and transport rewrite separately;
- browser-option precedence, typed without casts;
- invalid references and unsupported fields, including `depthOffset`,
  `maxLod`, and mixed line-and-label rules.

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
- two lettering rules over one geodata source with different terrain
  lists: only rules whose lists intersect the active terrain stack are
  compiled, verified across a direct terrain switch in both
  directions;
- a style containing an anonymous layer beside an explicit id equal to
  the would-be generated id: validation yields distinct ids and both
  layers stay addressable;
- activating and deactivating terrain sources;
- repeated profile application without state leaking from the prior profile;
- direct layer and terrain changes after profile application;
- reapplying a profile overwrites intervening direct changes;
- `getVisibilityProfile()` captures the current mixed state rather than the
  last supplied profile object;
- an authored style with omitted layer `terrain` round-trips through
  normalization: the getter returns the expanded explicit list and a
  captured profile reapplies exactly;
- an omitted-`terrain` layer beside a declared but initially inactive
  terrain source: after a direct terrain switch activates that source,
  the layer applies to it without any mutation call;
- every primitive terrain method and both profile methods throw when
  called before `viewer.ready` resolves, and succeed after awaiting
  it;
- anonymous authored layers render unchanged and are addressable
  through their generated ids;
- one sequence refresh and dirty mark per profile application;
- visibility-profile validation failures occur before state changes;
- caller style objects remain unchanged;
- `conversion.position` passed to `map()` behaves exactly like a
  directly supplied constructor position, and the computed fallback
  applies when it is absent.

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

The removal is complete only when a repository search finds no mapConfig
or View reference outside the isolated compatibility converter, its
tests, and VTS-input documentation. In `src/browser/browser.js` that
means no mapConfig ingestion, `browserOptions` handling, or View-based
code remains; the module's surviving viewer glue is out of scope
(section 6.6).

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

The conversion result already returns each named view as a translated
visibility profile. Applications can apply those profiles through the
new API without another library object, and a migration tool that needs
the original view definitions owns the input document. The Browser
wrapper is rejected from the main library. If a
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
| Public construction | `map()` and `browser()`, with mapConfig ingestion in `Browser` | one `map()` factory; `Browser` keeps only format-free viewer glue |
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
input origin. The browser layer loses every mapConfig-facing member of
`Browser`; dissolving the surviving viewer glue into typed `Viewer`
code is queued as separate follow-up work.

Feature work becomes narrower. A new rendering option or layer behavior is
added to the style schema, validation, and one runtime path. If a mapConfig
can express an equivalent concept, the converter maps it. If it cannot, the
converter reports that boundary instead of introducing another core branch.

Applications retain legacy document compatibility while gaining the newer
flat API: stable layer ids, terrain-aware layer applicability, atomic
visibility profiles, and a converted default position returned beside
the style. Applications can also run
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

   *Adopted.* The initial draft had this backwards in places: it
   extended and renamed parts of the modern style contract to give
   legacy concepts a permanent home, which petrifies what the RFC
   exists to delete. The boundary and its diagram are now in the
   decision summary; goals 4 and 5, the new non-goals, and invariant 14
   enforce it. The discriminator rename, the root `position` field,
   mandatory layer ids, and the `depthOffset` / `maxLod` source fields
   are withdrawn; profiles, position, and viewer options travel beside
   the style; phase 1 is additive only; `Browser` dissolution moved to
   separate follow-up work. The RFC title now names the actual goal.

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

   *Adopted.* Goal 5 states the corpus contract; the non-goals
   restate it for VTS extensions; sections 8.3 and 8.5 define the
   unsupported-field and unsupported-rule warnings with strict-mode
   promotion; phase 5 runs the corpus strictly; section 13.1 tests the
   warning paths.

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

   *Adopted.* The source fields are gone from section 8.3 and the
   phases. Both fields now produce the unsupported-field warning, an
   error in strict mode, and section 13.1 tests them by name.

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

   *Adopted.* The optional fields are gone together with the wrapper
   type they lived on (note 18). Section 8.4 now warns on any rendering
   option carried by a non-initial named view and records why optional
   fields could not preserve the old `setView()` disable semantics.
   Initial-view illumination and superelevation still become root style
   state, which the corpus exercises.

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

   *Adopted.* Section 6.2 and phase 3 now require classifying every
   corpus `browserOptions` key. The known still-live corpus keys,
   `mapFeaturesReduceMode` and `mapFeaturesReduceParams`, are promoted
   from internal to public catalogue visibility as documented
   label-density options, making the declared `viewerOptions` type the
   real emitted type. Dead and retired keys produce structured
   warnings. Section 13.1 requires the precedence tests to type-check
   without casts.

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

   *Adopted.* Section 8.3 now treats layer ids as the fourth symbol
   space under the same deterministic qualification rules, rewrites
   `inherit`, `next-pass`, `selected-layer`, `selected-hover-layer`,
   `hover-layer`, and `visibility-switch` references transitively, and
   records a stable one-to-many mapping. Section 13.1 adds the
   collision-plus-reference tests.

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

   *Adopted.* The split is withdrawn. Section 8.3 accepts cleanly
   classifying rules only; a mixed rule produces an unsupported-rule
   warning, is not emitted, and fails strict mode. Section 13.1 tests
   the warning.

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

   *Adopted.* The conversion result now carries `notes` beside
   `warnings` (section 6.2). A fully rewritten collision is an exact
   outcome with an informational note; strict mode fails on warnings
   only (sections 8.3 and 8.5). The `a-3d-mountain-map` collision
   therefore converts exactly under strict corpus runs, and section
   13.1 snapshots the deterministic rename as a note.

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

   *Adopted.* Section 6.2 now states the rule: relative references
   resolve against the logical URL of their containing document, the
   hook applies to the resulting request, and the emitted style stores
   logical canonical URLs only. The construction example passes the
   hook to both calls, and section 13.1 adds the test that rewrites the
   document request while the document holds a relative dependency,
   asserting logical resolution and the transport request separately.

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

   *Adopted.* Resolved by removing `StyleSpecification.position`
   entirely (note 19): with no style position there is no new
   precedence ladder and no pre-readiness camera state to specify.
   Section 6.1 states that camera behavior is unchanged, and section
   13.2 tests `conversion.position` as an ordinary constructor
   position. The pre-ready `setPosition()` no-op is a pre-existing
   limitation, now explicitly out of scope.

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

    *Adopted.* Section 7.1 now takes the first option: converter output
    is fully normalized with absolute embedded URLs, so one `baseUrl`
    per source suffices and no provenance typing is needed. Authored
    styles may use either the URL or the inline form under the same
    resolution rule. The loader requires structurally equal frame, SRS,
    body, and service definitions across terrain sources, merges
    credits by id with equal definitions, and fails loading on any
    inconsistency before map objects exist.

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

    *Adopted.* The smaller model is chosen: section 2.5 defines the
    internal texture as intrinsic terrain material — part of the
    terrain source's own data, with no layer id and no layer-API
    control — and the every-drawable-is-a-layer claim is corrected
    accordingly, citing `legacy-benatky` as the corpus case.

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

    *Adopted.* The primitives are renamed `setLayerTerrainSources()` /
    `getLayerTerrainSources()` throughout, leaving `visibility` free
    for a later visible/hidden property. Runtime state is normalized at
    validation: an omitted authored `terrain` expands to the explicit
    list of declared terrain sources, so the getter always returns an
    explicit array and profiles round-trip exactly (sections 6.3, 9,
    13.2).

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

    *Adopted.* Dissolution is extracted from this RFC. Deleting the
    mapConfig path does not require it, and doing it justice needs
    exactly the construction-order, ownership, disposal, and rollback
    specification the note lists — its own piece of work. This RFC now
    removes only `Browser`'s mapConfig ingestion (sections 2.8, 6.6);
    the goals, invariants, phases, removals, and completion criteria
    no longer mention deleting `src/browser/browser.js`, and the
    dissolution-specific runtime tests are dropped from section 13.2.
    The follow-up is recorded in the backlog.

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

    *Adopted.* Section 7.1 extends `cartolina-freelayer` inline data to
    the union of monolithic and tiled geodata definitions that
    `MapSurface` already accepts, keeping the dispatch behind the
    existing discriminator. Section 8.6 records `peaklist-org-ultras`
    as the corpus basis, and section 13.1 adds the focused snapshot
    plus the monolithic-request and rendered-label assertions.

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

    *Adopted.* Section 2.5 now defines source specification, source
    definition, and source instance, and states each source type's
    relationship to `terrain.sources`, style layers, and shared
    instances in the reviewer's terms. Section 7.1 shows the `sources`
    dictionary shape and one complete specification variant. The
    document speaks of style sources; "Cartolina source" is gone.

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

    *Adopted.* The rename is withdrawn; the RFC uses
    `cartolina-surface`, `cartolina-tms`, and `cartolina-freelayer`
    throughout. Deferred, not abandoned: the broader names remain a
    candidate for a separate non-breaking alias proposal — with
    `cartolina-vector` rather than `cartolina-geodata` as the freelayer
    alias — recorded in the non-goals.

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

    *Adopted.* The conversion result now returns
    `profiles: Record<string, VisibilityProfile>` directly (section
    6.2). `ConvertedMapConfigView`, `views`, `initialView`, and the
    retained `original` definitions are gone; section 8.4 describes the
    named-view translation purely in profile terms.

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

    *Adopted.* The style field and its precedence rule are removed
    (sections 2.7 and 6.1, phase 1). The conversion result carries
    `position` and the construction example passes it to `map()`
    (section 6.2). This also dissolved note 10's pre-readiness problem.

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

    *Adopted.* `LayerBase.id` stays optional in the authored schema
    (section 6.3). The converter emits explicit stable ids on every
    generated layer, and validation assigns deterministic generated
    ids — derived from layer type and array position — to anonymous
    authored layers in the runtime clone only, never mutating caller
    input (sections 2.6 and 9). Duplicate explicit ids are rejected;
    section 13.2 tests unchanged rendering and generated-id
    addressability.

## Review round 2

The round-1 architectural boundary is now stated correctly: style survives,
mapConfig is confined to conversion, and the style contract is not reshaped
around legacy concepts. The remaining findings concern contradictions and
runtime contracts introduced while applying that boundary.

1. Compatibility closure must gate runtime deletion, not follow it.

   Phase 4 deletes the mapConfig runtime, while phase 5 then runs the corpus
   strictly and "closes compatibility gaps." At that point the live reference
   path is gone. Phase 3 must finish strict conversion, snapshot review, and
   rendering comparisons while both paths still exist; phase 4 may start only
   after that gate passes. There must be no post-deletion phase whose purpose
   is to discover or close conversion gaps.

   The current strict gate cannot pass in any case. `legacy-benatky` is in the
   normative corpus specifically to produce an ignored-glue warning, and
   `tacoma-fitonly` contains dead or retired browser options that also produce
   warnings. Strict mode promotes every warning to an error. If dropping a
   field exactly preserves the current client's no-op behavior, classify that
   result as an informational note. If dropping it can change behavior, it is
   a compatibility gap that must be resolved before deletion. Move the strict
   gate into phase 3 and make every corpus case pass it.

   *Adopted.* Section 8.5 now draws the warning/note line by
   current-client behavior: dropping an already ignored construct —
   `legacy-benatky` glue declarations, `tacoma-fitonly` dead browser
   options — is an exact outcome with an informational note, so the
   strict corpus run is satisfiable and meaningful. Phase 3 gains the
   closure gate (strict corpus, snapshot review, pre-removal rendering
   comparisons); phase 4 explicitly starts only after it passes; the
   old phase 5 is deleted. Goal 5, the non-goals, and sections 6.2 and
   8.6 were aligned with the reclassification.

2. The proposed common `LayerBase` still breaks valid version-2 styles.

   The sketch makes `type: string` mandatory for every layer. The current
   `DiffuseMapLayer` deliberately permits an omitted type, defaulting to
   `diffuse-map`, and shipped styles such as `satellite.json`, `complex.json`,
   and `full.json` use that form. Adding optional `id` and `terrain` must not
   remove that existing default. Preserve the current generic and
   `DiffuseMapLayer` override rather than replacing it with the sketched
   required field.

   Generated ids also need a collision rule. "Layer type and array position"
   is not sufficient when an explicit authored id can equal the generated
   string. Define the generated namespace or collision-avoidance algorithm,
   generate after applying the omitted diffuse type default, and test a style
   containing both an anonymous layer and a colliding explicit id.

   *Adopted.* Section 6.3 now shows the real
   `LayerBase<TType extends string>` generic with `id` and `terrain` as
   optional additions, and states that the `DiffuseMapLayer` omitted-
   type default is preserved. Section 9 defines the generation
   algorithm: candidate from effective type (after the diffuse
   default) plus array position, with a deterministic disambiguation
   suffix appended while the candidate equals any explicit id;
   explicit ids are never rewritten. Section 13.2 adds the collision
   test.

3. Inline metadata validation must not impose a new rejection on URL sources.

   Section 7.1 requires structurally equal frame, SRS, body, and service data
   across every terrain source in a style. The current URL-source loader does
   not have that contract: it takes the global tables from the first surface
   document and only asserts that later reference-frame ids agree. Applying
   strict structural equality to existing URL-only styles would violate the
   promise that every accepted version-2 style keeps loading unchanged.

   Scope the new equality and credit-conflict rules to the additive inline
   form used by converter output. Existing URL forms retain their current
   acceptance behavior. A future proposal may strengthen URL-source
   consistency after auditing authored styles, but conversion cannot silently
   introduce that breaking validation. Define structural equality as well:
   record key order must not matter, while array order and canonical URL values
   do.

   *Adopted.* Section 7.1 scopes the equality and credit-conflict
   rules to the inline form only and records that URL sources keep the
   current first-document-tables plus frame-id-agreement behavior, so
   existing URL-only styles load unchanged. Structural equality is
   defined as the reviewer states: object key order irrelevant, array
   order and canonical URL values significant.

4. Terrain applicability for lettering layers has no executable contract.

   Tile layers are evaluated per terrain tile: `TileRenderRig` checks the
   layer's `terrain` list against `resourceSurface.styleSourceId`. Lettering
   layers are different today. `MapStyle.refreshSequences()` groups every
   label and line rule by free-layer source, compiles them into one VTS
   stylesheet, and schedules that free layer once. It strips only `id`,
   `type`, and `source`, so merely adding `terrain` to the common base would
   copy an unimplemented Cartolina field into the legacy stylesheet rather
   than control the rule.

   Specify the smaller behavior that this runtime can implement. If a
   lettering rule is active when its applicability list intersects the active
   terrain stack, say so; exclude inactive rules during stylesheet compilation
   and recompile when either the rule list or active terrain stack changes. If
   the API instead promises true per-surface lettering, the existing free-layer
   path cannot provide it and the common contract must be narrowed. Add a
   multi-terrain test with two rules over one geodata source, different terrain
   lists, and a direct terrain switch.

   *Adopted.* The smaller behavior is now the specified contract:
   section 6.3 states that a lettering rule is active exactly when its
   effective terrain list intersects the active terrain stack, that
   `refreshSequences()` excludes inactive rules at stylesheet
   compilation, and that affected free layers recompile when the rule
   list or the active stack changes. Per-terrain-tile lettering is
   explicitly not promised. Section 13.2 adds the two-rule
   multi-terrain switch test.

5. Remove statements left over from the rejected design.

   Three normative statements contradict the revised body:

   - invariant 11 says "free layer" exists only in the converter, although
     `cartolina-freelayer` remains a public discriminator and the internal
     free-layer drawing path is explicitly preserved;
   - alternative 14.7 says the conversion result preserves original and
     translated view data, but that data and wrapper were removed; and
   - the Expected Result still promises a style-defined default position,
     although `position` now travels beside the style.

   Correct all three before sign-off. The final RFC must not leave the old
   architecture as an alternative description of the accepted one.

   *Adopted.* Invariant 11 now names the two surviving uses of "free
   layer" — the `cartolina-freelayer` discriminator and the internal
   machinery kept by the non-goals — while still barring the term from
   any new public model concept. Alternative 14.7 speaks of translated
   visibility profiles and the caller-owned input document. The
   Expected Result promises a converted default position returned
   beside the style.

## Review round 3

The round-2 response resolves the deletion ordering, preserves the existing
layer and URL-source contracts, and gives lettering applicability an
executable meaning. Three public contracts still need correction before
sign-off.

1. The strict closure taxonomy is still contradictory.

   Section 6.2 still says that a dead or retired `browserOptions` key produces
   a warning. Section 8.5 and the phase-3 gate now say the opposite: a field
   that the current client already ignores is an exact no-op drop with a note,
   while every warning blocks deletion. This is not editorial. The corpus
   contains retired options, so section 6.2's rule makes the required strict
   run fail.

   Phase 3 also says both that no-op fields may be dropped as notes and that
   every corpus field must be represented by typed style or construction
   state. Those statements cannot both hold. Apply one rule everywhere:
   every behaviorally active corpus field must have a typed destination;
   fields proven to be current-client no-ops may be dropped with exact-outcome
   notes. Then the strict closure gate has one satisfiable definition.

   *Adopted.* Both stale statements were round-2 misses on my side.
   Section 6.2 now says an ignored key is dropped as an exact no-op
   with a note, and the phase-3 gate states the single rule in the
   reviewer's formulation: active fields get typed destinations,
   proven no-ops drop with notes.

2. The new runtime mutation API needs a readiness contract.

   The typical construction example calls `applyVisibilityProfile()`
   immediately after `map()`. Style construction is asynchronous: the current
   style path does not assign the loaded map and its `MapStyle` until
   `MapStyle.loadStyle()` completes. Before `viewer.ready`, none of the layer
   ids, source ids, normalized terrain lists, or mutation targets exists to be
   validated. The RFC simultaneously requires unknown ids to throw and
   runtime mutation never to silently no-op, so the example has no valid
   behavior under the stated contract.

   Define the pre-readiness behavior for all four primitive terrain methods
   and both profile methods. The narrower design is to require
   `await viewer.ready`, throw when a method is called earlier, update the
   example, and test that failure. A pending-operation queue would add a second
   state machine solely for calls made before their targets exist and is not
   justified by conversion.

   *Adopted.* The narrower design is taken: section 6.3 specifies that
   all four primitive terrain methods and both profile methods throw
   before `viewer.ready` (an existing `Viewer` promise) resolves, with
   no pending-operation queue — a queued mutation could not be
   validated at call time. The section 6.2 example awaits readiness
   before applying the profile, and section 13.2 tests the pre-ready
   throw and post-ready success for every method.

3. Omitted layer `terrain` must expand against a precisely named set.

   "Every terrain source declared by the style" can mean every
   `cartolina-surface` entry in `style.sources`, or only the sources in the
   initial active `terrain.sources` stack. Those meanings diverge as soon as
   `setTerrainSources()` activates a source that was declared but initially
   inactive. Existing omitted `terrain` means unrestricted applicability: the
   tile renderer applies the layer to any terrain surface.

   Define normalization as all source-dictionary entries whose discriminator
   is `cartolina-surface`, independent of the initial active stack. Add a test
   with an omitted layer, an initially inactive declared terrain source, and a
   later direct terrain switch. Expanding only against the initial stack would
   silently narrow existing style behavior.

   *Adopted.* Normalization is defined as every `cartolina-surface`
   entry in the `sources` dictionary, independent of the initial
   `terrain.sources` stack, in sections 6.3 and 9 and in phase 1. This
   preserves the current unrestricted meaning of an omitted list.
   Section 13.2 adds the inactive-source-then-switch test.

## Review round 4

The round-3 responses correctly resolve method readiness, omitted-terrain
normalization, and the warning/note distinction in the main contract. One
old phase instruction still contradicts that distinction.

1. Phase 3 still excludes exact no-op notes from `browserOptions`
   classification.

   Phase 3 step 2 says every corpus `browserOptions` key must become either a
   typed destination or a structured warning. The same phase now requires
   retired current-client no-ops to be dropped with notes and requires strict
   conversion to pass. Because the corpus contains those keys, following step
   2 still makes the closure gate fail.

   This is the round-3 taxonomy finding at its last stale call site, not a new
   rule. Make step 2 use all three outcomes already defined by sections 6.2
   and 8.5: an active key gets a typed destination, a proven no-op gets an
   exact-outcome note, and an unsupported active key gets a warning that
   blocks phase 4. No other public design blocker remains from this review.

   *Adopted.* Step 2 was written before round 3 and kept the
   two-outcome wording. It now names the three outcomes of sections
   6.2 and 8.5 — typed destination for active keys, exact-outcome
   note for proven no-ops, structured warning for unsupported active
   keys — and states that a warning blocks phase 4 through the
   step-5 closure gate. Step 2 and the gate now apply the same rule.

## Review round 5 — sign-off

All round-4 notes are resolved. Phase 3 now applies the same three-outcome
classification as sections 6.2 and 8.5: active corpus behavior gets a typed
destination, proven current-client no-ops produce exact-outcome notes, and an
unsupported active key produces a warning that blocks runtime deletion.

The complete design was re-audited against the current style loader, runtime
readiness, terrain and lettering paths, public conversion corpus, and removal
boundary. Style remains the sole surviving map model. Visibility profiles
remain Viewer-level values rather than authored style or recreated Views, all
style additions are additive, and compatibility closure precedes deletion of
the reference runtime. No specification-level findings remain. Design
accepted.

## Addendum — 2026-07-19 — implementation note

Implemented on `feature/rfc11-mapconfig-to-style` in four commits
matching the migration phases (46dd9969, aa8d3358, 5eea454e +
47374103, 2453d76e).

**Result.** Phase 1 added the style vocabulary to
`src/core/map/style.ts`: optional `id` and the common `terrain` list
on `LayerBase`, `SourceLocation<T>` URL-or-inline source
specifications with the monolithic-or-tiled freelayer union, the
inline-metadata consistency rules, and `normalizeStyle()` (generated
ids, duplicate rejection, omitted-`terrain` expansion). Phase 2
split `MapStyle` into the authored baseline plus runtime overrides
with a derived effective state, added the atomic
`MapStyle.applyMutations()` batch, `Map.mutateStyle()` and the four
primitive terrain methods (all throwing before `ready`), and the
`Viewer` profile pair; lettering rules compile exactly when their
effective terrain list intersects the active stack. Phase 3
delivered `mapConfigToStyle()` and the VTS stylesheet linker in the
isolated `src/compat/` directory, exported from the package index;
the demo application routes `?mapConfig=` through the converter.
Phase 4 deleted the mapConfig runtime per section 11, plus the
`demos/legacy` tree built on the removed wrapper API.

**Closure gate.** All four corpus inputs convert in strict mode with
informational notes only (`test/mapconfig-corpus.js`); converted
renders are visually indistinguishable from mapConfig-path captures
taken immediately before the demo switch. The completion search
finds mapConfig and View references only in `src/compat/`, its
tests, VTS-input format documentation, and historical records.

**Validation.** `npx tsc --noEmit` clean; 72 unit tests including
the 22-test converter suite; `test/style-mutation.js` covers the
section 13.2 core (pre-ready throws, generated ids, profile
round-trip and overwrite semantics, validation atomicity) against
the dev server; all seven test URLs render without console or
network errors after a fresh build.

**Deviations from the accepted design.**

- The converter emits an `atmosphere` section with explicit zero
  eye-distance factors and a large `maxVisibility` so the style
  loader reproduces the legacy fixed-visibility atmosphere instead
  of layering its eye-distance defaults over the body values. The
  design body did not specify atmosphere conversion.
- The style contract gained one corpus-driven additive extension
  beyond section 7.1: optional `illumination.useLighting`, required
  by the `nacis-2023` initial view and already honored by the
  renderer.
- `MapBody.Configuration` fields became optional to match the
  parser's defaulting; typia validation of inline surface metadata
  rejected real body documents otherwise.
- `mapConfigToStyle()` accepts an internal `loadJson` option as the
  DOM-free test seam; the converter defers whole-style typia
  validation to the style loader, which every conversion result
  passes through in the rendering gate.
- Generated anonymous-layer ids disambiguate with an `-anon`
  suffix; linker qualified names use `name--moduleId`.
- The `map-loaded` event keeps its `browserOptions` payload field,
  now always empty. `runtimeOptionsFromUrl()` lost its third
  parsing-options parameter together with `configFromUrl()`.
- Converted demo renders differ from the legacy `browser()` path in
  UI chrome only: `map()` disables the legacy default controls.
- Section 13 items not yet automated — linker collision tests
  combined with `inherit` / `visibility-switch` references, the
  two-rule multi-terrain lettering switch, the
  anonymous-beside-colliding-explicit-id case, and a
  multi-terrain-switch public fixture — are tracked in the backlog.

## Addendum — 2026-07-20 — post-implementation conversion fixes
(f4fb3011, 6d0c8b9b)

Post-closure hardening of the converter and the schema it emits
against. Every change is additive in acceptance; the public corpus
conversion output and all seven test-URL renders are unchanged.

**Canonical layer order is a topological merge** (`f4fb3011`).
Section 8.2's first-seen implementation emitted false
layer-order-conflict warnings for a multi-surface mapConfig whose
surfaces interleave a layer that an earlier-visited surface omits,
and for a named view that orders a named-view-only layer before an
initial-view layer. The order is now Kahn's algorithm over the
precedence edges of every view's per-surface sequences: the initial
view's first-seen order breaks ties, named-only layers slot where
their constraints demand, and the warning survives only for a
genuine cross-view ordering cycle (the initial view keeps its
order). Unit tests cover the interleaving, the named-only slotting,
and the genuine-cycle warning.

**`visibility-switch` accepts levels with no layer** (`f4fb3011`,
`6d0c8b9b`). A switch pair's second element may be `null` in the
VTS grammar. The linker no longer emits an unresolved-reference
warning for such pairs while still rewriting renamed layer targets,
and the schema type is corrected to
`Array<[string, string | null]>` — the previous declaration was the
literal string pair `['string', 'string']`, which no real value
could satisfy.

**Two more `browserOptions` classifications** (`f4fb3011`), closing
the three-outcome rule for keys the phase-3 corpus did not carry:
`mapSoftViewSwitch` is behaviorally active — `surface-tile.js`
reads it per tile whenever `viewCounter` changes, which every
profile application and terrain mutation triggers, choosing whether
previous tile state is kept across the switch — and is promoted to
public (runtime) catalogue visibility as its typed destination.
`mapLogGeodataStyles` gates geodata-worker console logging only
(`worker-style.js`) and converts to a diagnostics-only
informational note; it cannot affect rendering.

**Schema admits runtime-honored properties** (`6d0c8b9b`). An
audit of the geodata processor's accepted stylesheet vocabulary
against `LetteringLayerProperties` found five properties the
runtime reads but validation rejected: `label-spacing`,
`label-line-height`, `line-label-type`, `icon-color`, and
`icon-no-overlap` (`worker-style.js`, `worker-pointarray.js`,
`worker-linestring.js`). The `bitmaps` table is retyped as
`Record<string, BitmapSpecification>` — a URL string or
`{url, filter?, tiled?}`, the shape `worker-style.js` parses — and
not expressions; besides being wrong, the old type degraded
typia's union error reporting across the whole style whenever a
bitmap table was present.

Validation: tsc clean; 76 unit tests including new coverage for the
order merge and the switch-pair rewrite; the strict public corpus
conversion is byte-identical in diagnostics and layer order; all
seven test URLs render with no console or network errors.

## Addendum — 2026-07-20 — bundle size and the removable-converter claim

Section 3's design boundary states the converter is "removable
without changing style or runtime code," and structurally it is —
`src/compat/` has no callers from `Viewer`, `Map`, or the style
loader. The finished implementation does not make it *optional at
build time*: `mapConfigToStyle()` is a static, eagerly evaluated
export of `src/browser/index.ts`, the library's one build entry
point, so every consumer's bundle includes the converter and the
stylesheet linker (~2,300 lines) regardless of whether the
application ever loads a legacy mapConfig.

Comparing production builds of the design branch (pre-implementation)
against the finished implementation: `cartolina.min.js` grew from
1,407,878 B to 1,461,279 B (+3.8%; 276,637 B to 285,901 B gzipped,
+3.6%). Measured separately, core map-runtime source outside
`src/compat/` shows a net reduction of about 500 lines (881
insertions, 1,376 deletions) over the same span — the goal-5 runtime
simplification did happen; it is masked in bundle size by the
converter's unconditional inclusion.

Splitting the converter into its own entry point or a dynamically
imported module, so it only ships to applications that use it, is
tracked as a backlog item and was not part of this RFC's scope or
completion criteria.

## Addendum — 2026-07-20 — implementation review

This addendum records a review of the complete implementation branch after
the implementation addenda above. It is a reviewer record, not an
implementation-completion claim. Author responses and fixes belong in a later
dated correction addendum; this text remains unchanged once committed.

**Verdict:** the core dependency direction is sound, but the implementation is
not mergeable. The primary architectural failure is that the refactor gives the
obsolete VTS stylesheet and free-layer models new names or new surfaces instead
of eliminating them from the new model. Three converter and linker defects also
violate signed-off RFC invariants. The `Implemented` status is premature until
the findings are fixed and the closure gate is rerun.

### Primary architectural finding

**The refactor preserves obsolete concepts under new terminology.**

The purpose of this work is to simplify Cartolina by removing mapConfig and VTS
stylesheets as runtime concepts. The intended boundary is one-way: resolve each
legacy VTS stylesheet, merge its four symbol tables into Cartolina style
namespaces, emit ordinary Cartolina layers, and discard the stylesheet
structure.

Instead, section 8.3 assigns the stylesheet a new architectural noun, and the
implementation materializes that wording in types and identifiers. The new
identity then escapes collision handling and participates in profile
construction. Blocking finding 1 shows the consequence: the temporary
stylesheet identity is confused with the free-layer identity.

A refactor that merely redresses a legacy concept can be worse than leaving the
legacy code explicit. It preserves the old ontology, adds a second vocabulary,
hides the remaining coupling, and invites new code to depend on what was meant
to disappear.

Keep the identity local and visibly transitional. Suitable names include
`ResolvedVtsStylesheet`, `VtsStylesheetInput`, and `stylesheetScopeId`. Describe
the operation as resolving and merging legacy stylesheet symbol tables, not as
introducing a new Cartolina unit. No stylesheet identity should survive in the
returned style, visibility profiles, or runtime API.

The same rule applies to "free layer." That term belongs to the legacy VTS data
model, where free layers included several kinds of content. Cartolina removed
the non-geodata path in `c87aa0f1`; the surviving monolithic and tiled forms are
both vector data. The new model should therefore use the term appropriate to
each context: vector source for stored geodata, vector layer or vector overlay
for a runtime object, and lettering layer, line, or label for styled output.

Compatibility boundaries legitimately retain the old spelling: the converter
must parse the literal mapConfig `freeLayers` field, and the frozen style
contract keeps its existing `cartolina-freelayer` discriminator. RFC 11
explicitly forbids changing that contract except for optional additions required
by the conversion. The existing `createGeodata()` / `addFreeLayer()` /
`removeFreeLayer()` public overlay path may also remain until a general runtime
source and layer API can replace it. Preserve these spellings as explicit legacy
exceptions, but do not let them dictate new runtime gates, data categories, or
general architecture terminology. The non-interactive demo is independently
valuable and must remain; retaining that demo does not require claiming that its
currently broken vector-overlay block works.

The accepted RFC already makes this distinction in sections 2.5 and 4 and in
review-round-1 note 17. Its decision to retain the existing discriminators is
sound within RFC 11's conversion scope. A separate non-breaking style proposal
may add `cartolina-terrain`, `cartolina-raster`, and `cartolina-vector` aliases
so that new authored styles need not adopt the old vocabulary. Such aliases
must normalize immediately to semantic loader categories, define one canonical
serialized spelling, and keep the existing spellings readable. They must not
create parallel loaders or leave either spelling as a runtime model concept.

### Architectural assessment

The main dependency direction is sound:

- style is the sole runtime map model;
- compatibility conversion happens before `Viewer` construction;
- `Viewer`, `Map`, and the style loader do not call the converter;
- profiles remain application-level values rather than recreating the removed
  `View` model;
- runtime mutations are atomic and validate before changing state;
- new compatibility behavior is isolated in TypeScript under `src/compat/`;
- obsolete wrappers, demos, and mapConfig runtime branches were deleted rather
  than retained behind compatibility bridges.

The implementation needs focused correction, not an architectural rollback.

### Blocking findings

1. **A named profile can activate the wrong resolved stylesheet.**

   `assembleLayers()` stores emitted lettering ids under the temporary
   stylesheet identity, but `buildProfiles()` retrieves them with the
   free-layer identity. Those keys differ when one free layer selects more than
   one stylesheet: the temporary stylesheet ids become, for example, `labels`
   and `labels-v2`, while both selections retain the `labels` free-layer key.

   A minimal input with stylesheet A in the construction view and stylesheet B
   in a named view reproduces the error. The named profile enables A's rule and
   leaves B's rule inactive. Resolve the lookup through the temporary
   stylesheet identity and test that rules from the selected stylesheet are
   active while rules from every unselected stylesheet are inactive.

2. **A generated qualified symbol can overwrite a symbol from the same
   resolved stylesheet.**

   `planRenames()` checks a qualified candidate against the accumulated output
   table only. It does not reserve original names from the stylesheet currently
   being merged or targets allocated earlier in the same pass.

   If an earlier stylesheet defines `@x` and the current stylesheet defines
   conflicting `@x` plus `@x--s2`, qualification can select the already present
   `@x--s2` name and then write both definitions to that key. References are
   rewritten to the surviving, wrong definition while the result reports an
   exact-conversion note and no warning.

   The layer allocator has the same defect: a stylesheet containing both `peak`
   and `peak--s2`, after an earlier `peak`, can emit two `peak--s2` layers. The
   generic defect also applies to fonts and bitmaps.

   Use one reservation set per symbol space, seeded with accumulated output
   names and all names in the stylesheet being merged, and reserve each
   allocated target before the next rename. Add collision tests for constants,
   layers, and another generic symbol space.

3. **Raster and lettering layers do not share a globally unique id space, and
   the converter does not validate its result.**

   Raster ids are allocated before stylesheet linking. The linker reserves only
   lettering ids, and `assembleLayers()` concatenates the two sets without
   reconciliation. A raster presentation and stylesheet rule both named
   `imagery` produce duplicate explicit layer ids with no warning.

   `mapConfigToStyle()` returns the assembled object through a type assertion.
   The duplicate is rejected only later by `MapStyle.normalizeStyle()` during
   viewer construction. Section 8.5 instead makes an invalid resulting style
   fatal during conversion.

   Allocate layer ids in one global namespace, or pass raster ids into the
   linker as reservations. Run the loader's canonical style validation and a
   normalization check before returning. Invalid output must fail in normal and
   strict modes. Add a raster-versus-lettering collision test.

### Required implementation corrections

4. **Delete the obsolete free-layer type gate.**

   Commit `c87aa0f1` removed rendering of non-geodata free layers and
   established that the active sequence contains geodata only. The only typed
   surviving source definitions are `geodata` and `geodata-tiles`. The boolean
   therefore duplicates whether the active vector sequence is nonempty. Its
   stale-true behavior after an active-to-empty profile change is one
   consequence of keeping two representations of the same fact.

   Remove the field, initializer, writes, and declaration. Where avoiding empty
   work matters, inspect the active vector sequence directly; do not reintroduce
   a type predicate. Clearing and drawing the vector job buffer can instead
   follow the label and color-pass conditions, and vector hit testing can return
   immediately when the active vector sequence is empty.

   Keep `Viewer.createGeodata()`, `Viewer.addFreeLayer()`, and
   `Viewer.removeFreeLayer()` in this bounded refactor. Section 4 already
   identifies them as retained internal-machinery exceptions. Do not rename
   them to a new vector-specific API: that would present the incomplete legacy
   registry mutation as a new design.

   The existing "runtime free layers do not render on style-based maps" backlog
   entry records that `addFreeLayer()` only changes the legacy registry while
   `MapStyle.refreshSequences()` derives rendered vectors from `style.layers`.
   Preserve the non-interactive demo's navigation, coordinate conversion, and
   hit-testing coverage, but remove or visibly suspend only its nonfunctional
   vector-overlay block and the documentation that calls that block working.

   A future general `addSource()` / `addLayer()` API should own atomic
   validation, ordering, source ownership, and removal. Migrate the demo and
   documentation to that API before deleting the legacy public methods.

   Until then, validate at `addFreeLayer()` that its input is the surviving
   geodata form; the method must not reintroduce support for historical free
   layer kinds. Keep the frozen `cartolina-freelayer` source discriminator and
   translate it at the loader boundary. Validate inline and fetched vector
   definitions before registration. With those boundary invariants in place,
   remove downstream type predicates from the new style path. Add an
   active-to-empty profile and hit-test regression.

   The non-breaking aliases contemplated by section 4 would let new styles use
   current terminology, but are not required to remove the obsolete runtime
   gate. If pursued, keep them a separate style-contract change with the
   normalization and serialization rules stated above.

5. **Complete the accepted inline-source base-URL design.**

   The style loader still temporarily replaces `LegacyMap.url` while
   constructing a surface, including inline sources. Section 7.1 requires
   resolved data and base context to reach constructors explicitly. The current
   restoration is not protected by `finally`, so an exception can retain the
   wrong URL context.

   Pass base context through the constructor path used by other inline source
   types. Test two inline surfaces with different bases and a construction error
   without mutating the style-level URL context.

6. **Make the closure tests one maintained executable gate.**

   `test/style-mutation.js` and `test/mapconfig-corpus.js` are standalone and
   are not reachable through an npm verification target. The unit suite omits
   all three blocking cases. Add a named RFC 11 verification command covering
   unit tests, runtime mutations, strict corpus conversion, and the three
   canonical screenshot comparisons. Structural assertions must precede visual
   interpretation.

7. **Give the converter a dedicated compatibility entry point.**

   The preceding addendum measures a 3.6% gzip increase because
   `src/browser/index.ts` statically exports the converter. A separate
   compatibility entry point matches the accepted architecture and makes the
   converter removable at build time, not only removable by a future source
   edit.

   Implement the `cartolina/compat` subpath described in the corresponding
   backlog entry, and remove the eager export from the main browser entry
   point. Update the `demos/map` mapConfig route to import that entry point
   explicitly. Verify that style-native bundles contain neither converter nor
   linker code, that mapConfig conversion still works through the compatibility
   entry point, and that compatibility code has no reverse dependency from the
   style runtime.

### Follow-up quality findings

8. **Remove residual implementation debris.**

   The converter contains a literal NUL byte in its stylesheet-selection cache
   key, causing text tools to classify the TypeScript file as binary. Use an
   escaped delimiter or structured key. Update the `Map` documentation, which
   still says it owns named views, and remove or deliberately retain the
   always-empty `map-loaded.browserOptions` event payload.

### Review validation

The following checks passed on the reviewed branch:

- `npm run typecheck`;
- `npm run test:unit`, 76 tests;
- `npm run dist`, with the existing asset-size warnings;
- strict conversion of all four public mapConfig corpus entries;
- `node test/style-mutation.js`;
- sequential `simple-terrain`, `complex-terrain`, and `full-terrain`
  dev-versus-production captures with no console or network errors.

The three blocking cases were then reproduced with minimal synthetic inputs
against the compiled converter and linker. The ordinary gates pass because they
do not contain those cases.

### Closure conditions

The primary architectural finding requires a revision to the signed-off design
body. Follow the RFC lifecycle: change the status from `Implemented` to
`In review`, revise the terminology, and append
`## Review round 6 — requested` describing the change. After renewed sign-off
and implementation:

1. add failing regression tests for the three blocking cases;
2. fix stylesheet-selection profile identity and symbol reservation;
3. enforce global layer ids and conversion-time style validation;
4. replace the new vocabulary with explicitly transitional VTS stylesheet
   terminology in the RFC, converter, linker, diagnostics, and tests;
5. remove the obsolete geodata flag and downstream type gates without widening
   the legacy public overlay API, then remove the temporary URL-context swap;
6. move the converter and linker behind the dedicated compatibility entry
   point and verify their absence from a style-native bundle;
7. rerun the complete public conversion and rendering gate;
8. append a dated correction addendum with the fixes, validation, and commits.

## Review round 6 — requested

This is an author request for renewed review, not reviewer feedback: it
describes a design-body change made in response to the implementation
review's primary architectural finding above.

The finding was that the linker's internal identity for one resolved
stylesheet (previously spelled `moduleId`, on a `LinkerModule` /
`LetteringModule` type) reads as a new Cartolina concept rather than a
transitional linker detail, and that reading became a real defect: profile
construction looked the identity up through the free-layer key instead of
through the identity itself, so a free layer selecting different
stylesheets per view could activate the wrong view's rules (blocking
finding 1).

Design-body changes:

- **Section 8.3** no longer calls a VTS stylesheet "a module." It states
  directly that merging needs one transitional per-stylesheet scope id,
  states its sole purpose (qualifying a colliding symbol's generated
  name), and states that no other code — the returned style, visibility
  profiles, the runtime layer API — may carry or look anything up by it.
  "Module" and "moduleId" are gone from the section; "resolved stylesheet"
  and "scope id" name the same things without implying a new unit.
- **Section 4** gains a non-goal bullet stating the scope id explicitly:
  it is linker-internal, and looking it up by a different identity is a
  defect, not an accepted alternate spelling. This is the design-level
  statement of the rule that blocking finding 1 violated.
- **Section 7.1** is corrected to describe what "one typed path" for
  inline-source construction actually covers: the source's own object
  (`MapSurface`, matching `MapBoundLayer`), not yet the shared
  first-surface metadata (`MapSrs`, `MapBody`, `MapRefFrame`,
  `Atmosphere`), which still reads a temporarily swapped `LegacyMap.url`.
  The swap is now exception-safe (`finally`); full elimination needs a
  constructor-signature change to those four classes and is out of this
  RFC's proportionate scope, tracked as backlog follow-up. The original
  wording overstated what had been achieved.

The corresponding rename in the converter and linker
(`ResolvedVtsStylesheet`, `stylesheetScopeId`, `letteringIdsByStylesheetScope`
replacing `LetteringModule`/`LinkerModule`, `moduleId`,
`letteringIdsByModule`) is implementation history and is recorded, with the
bug fixes it accompanies, in the correction addendum below rather than in
this design section.

Section 2.5 and section 8.5 were also named in the implementation review's
closure conditions. Both already stated the corrected rule before this
round: section 2.5 already scopes "free layer" to mapConfig-field,
conversion-explanation, and legacy-deletion contexts, and already excludes
it from the target style schema, Viewer API, and core map model; section
8.5 already lists an invalid resulting style as fatal. Neither needed a
text change; the gap was implementation compliance, corrected below.

## Addendum — 2026-07-20 — implementation review corrections (94b32577)

Fixes the three blocking findings and the required corrections from the
implementation review above, in the same session as the round 6 design
request.

**Blocking findings.**

1. `buildProfiles()` looked up emitted lettering-layer ids by
   `freeLayerKey`; `assembleLayers()` had indexed them by the linker's
   per-stylesheet scope id (then called `moduleId`). A free layer
   selecting different stylesheets across views produced several
   resolved stylesheets sharing one `freeLayerKey`, so the lookup always
   returned the first one's ids regardless of which view was being
   built. Fixed by looking the ids up by the scope id everywhere,
   consistently. Regression test: "activates the named view's own
   stylesheet when a free layer selects a different one per view."
2. `planRenames()` and the layer-rename pass checked only the
   accumulated output table for a free qualified name, not the
   stylesheet currently being merged. A stylesheet defining both a
   colliding symbol and the name that symbol would be qualified to
   could get two definitions written to the same output key, silently,
   with an exact-conversion note claiming success. Fixed with one
   reservation set per symbol space and per layer-rename pass, seeded
   from the output table and the stylesheet's own table, with each
   allocated name reserved before the next. Regression tests: "does not
   let a qualified constant/layer id collide with the same module's own
   conflicting symbol/layer."
3. Raster and lettering layers were allocated in separate id spaces, and
   `mapConfigToStyle()` returned its assembled style through a type
   assertion with no validation. Fixed by seeding the linker's layer-id
   space with the raster ids already allocated (`linkStylesheets()`
   gained a `reservedLayerIds` parameter), and by running the style
   loader's schema, inline-consistency, normalization, and
   duplicate-id checks before returning, in both normal and strict
   mode. That validation logic was extracted from `style.ts` into a new
   dependency-free `src/core/map/style-schema.ts` — `style.ts` imports
   `Atmosphere`, which imports `Renderer`, and pulling that into the
   compat converter would have defeated required correction 7 below and
   broken the Node-based unit tests. Regression test: "keeps raster and
   lettering layer ids in one global space."

**Primary architectural finding.** The linker's transitional
per-stylesheet identity is renamed from `moduleId` (on a `LinkerModule` /
`LetteringModule` type) to `stylesheetScopeId` (on `VtsStylesheetInput` /
`ResolvedVtsStylesheet`), across the linker, the converter, and the unit
tests, per round 6 above. `letteringIdsByModule` is renamed
`letteringIdsByStylesheetScope`. No behavior beyond blocking finding 1
depended on the old names; this is a pure rename plus the one-line lookup
fix.

**Required corrections.**

4. Deleted `freeLayersHaveGeodata` (`LegacyMap`), its declaration, its one
   write, and its three reads, replacing each read with
   `freeLayerSequence.length > 0`/`=== 0`. The two representations of
   "does the active vector sequence have geodata" could disagree: the
   flag was set true in `MapStyle.refreshSequences()` but never reset,
   so it stayed true after a profile change emptied
   `freeLayerSequence`. Suspended `demos/core/index.html`'s
   `addRouteLayer()` call — `addFreeLayer()` does not render on a
   style-based map, a pre-existing, already-tracked backlog bug unaffected
   by this RFC — and corrected `non-interactive.md`'s claim that the
   demo's vector overlay works. The function stays as API reference.
5. Wrapped the temporary `LegacyMap.url` swap in
   `MapStyle.loadStyle()` in `try`/`finally`, so a construction error
   during the shared first-surface metadata extraction can no longer
   leave the wrong base in place. Passed the inline surface's own base
   explicitly to `MapSurface`, the same constructor path already used
   for free-layer and bound-layer sources. `MapSrs`'s geoidGrid
   resolution still reads the ambient value — it has no explicit-base
   parameter — so the swap itself is not yet removable; section 7.1
   above and a new backlog entry ("Eliminate the remaining ambient
   `LegacyMap.url` swap for inline surfaces") record the remaining gap
   and why full removal needs a constructor-signature change to four
   classes, out of this correction's proportionate scope.
6. Added `npm run test:rfc11`: `test:unit`, `test/style-mutation.js`,
   `test/mapconfig-corpus.js`, then `test/screenshot.js` for
   `simple-terrain`, `complex-terrain`, and `full-terrain` in sequence.
   Structural checks (unit tests, runtime mutation assertions, strict
   corpus conversion) run before the visual screenshot comparisons.
7. Added `src/compat/index.ts`, the `cartolina/compat` entry point,
   re-exporting `mapConfigToStyle()` and its types. Removed the eager
   export from `src/browser/index.ts`. Added a `cartolina-compat`
   webpack entry (global var `cartolinaCompat` and an ESM build) and a
   `./compat` package export. `demos/map/index.html` now loads
   `cartolina-compat.js` alongside `cartolina.js` and calls
   `cartolinaCompat.mapConfigToStyle()` on its `?mapConfig=` route.
   Verified: `cartolina.js` contains no `linkStylesheets`/`qualifiedName`
   code (one incidental docstring mention of the function name in a
   JSDoc comment); `cartolina-compat.js` contains no `Atmosphere`,
   `Renderer`, or `GpuDevice` code; the `a-3d-mountain-map` legacy
   mapConfig demo still renders correctly through the new entry point.
8. Replaced the literal NUL byte in the free-layer/stylesheet cache key
   with an escaped delimiter between the key and the URL — the file
   no longer reads as binary to `file` or text tools.
   Removed the stale "named views" mention from `Map`'s class doc; `Map`
   does not hold visibility profiles, which are application-level
   values (section 6.4). Left the `map-loaded` event's always-empty
   `browserOptions` payload field as is: `rfc2-event-bus.md`'s and this
   RFC's own implementation-note addenda already record it as a
   deliberate, dated deviation, which post-acceptance addenda cannot be
   rewritten to reverse.

**Validation.** `npm run typecheck`; `npm run test:unit`, 80 tests (76
plus the 4 added here); `npm run test:rfc11` in full, after restarting
the dev server so it picked up the new webpack entries: all four public
corpus entries convert in strict mode with the same notes as before,
`test/style-mutation.js` passes every check, and `simple-terrain`,
`complex-terrain`, and `full-terrain` render pixel-identical dev-versus-prod
with no console or network errors. Additionally ran
`node test/screenshot.js a-3d-mountain-map` (a `?mapConfig=` route,
exercising the new compat entry point specifically) with the same result.

**Deviation from the 2026-07-19 implementation-note addendum.** That
addendum's "Deviations from the accepted design" list states "linker
qualified names use `name--moduleId`." The qualified-name pattern is
unchanged; only the identifier it is built from is renamed to
`stylesheetScopeId`, per the round 6 rename above. The addendum text
itself is not edited, per the append-only rule for addenda.

## Addendum — 2026-07-20 — two findings from re-running validation

Re-running conversion-corpus validation after the correction addendum
above surfaced two further small, pre-existing defects, neither
specific to any one conversion input.

1. `convertFreeLayers()` copied a free layer's raw `style` field
   (its legacy default stylesheet URL) into the emitted inline source
   data unchanged. `MapSurface.parseJson()` reads that field
   independently of `style.layers` and fetches it as a legacy
   per-surface stylesheet — a fetch RFC 11 makes redundant, since
   lettering is driven entirely by `style.layers`, and one that can
   fail loudly if a legacy default URL is stale. The converter's own
   default-stylesheet resolution still needs the field, so
   `convertFreeLayers()` now drops `style` only from the copy assigned
   to the emitted source, not from the definition it resolves
   defaults from.
2. `map()`'s own `dflts` object (`src/browser/index.ts`) has carried a
   typo, `controlFalback`, since the function was first written — no
   catalogued option of either spelling exists. It has silently logged
   an "unknown configuration key" warning on every `map()` call since;
   removed.

Both were latent — dropping a config key nothing reads, and no longer
fetching a stylesheet no longer used, changes no rendering — and
surfaced only once validation started checking console output. Fixed
alongside the round 6 correction addendum.

## Review round 7

The fixes for the three original blocking defects are accepted. Independent
verification passed the typecheck, all 80 unit tests, the complete
`test:rfc11` command, a production build, and the
`a-3d-mountain-map` compatibility-entry-point screenshot. Round 6 is not
signed off because the response leaves the following design and implementation
notes unresolved.

1. The stylesheet scope id still escapes the linker, contrary to the revised
   section 8.3.

   `LinkedLayer` exports `stylesheetScopeId`. The converter then builds
   `stylesheetByScopeId` and `letteringIdsByStylesheetScope`, and
   `buildProfiles()` retrieves emitted ids through that scope. Section 8.3 now
   says the id exists only during the linker pass and that profile construction
   uses the caller's view identity instead. The implementation does the
   opposite.

   Generate and consume the qualification scope inside the linker. Return
   emitted layers grouped in input order, or another structure that lets the
   caller pair each result with its existing resolved-stylesheet record without
   exporting or looking up the scope string. After the change,
   `stylesheetScopeId` must not occur outside the linker and its direct linker
   tests.

   *Adopted.* The linker now assigns and consumes the qualification label
   internally. It returns emitted layer ids grouped by input position, so the
   converter can pair them with its resolved-stylesheet records without
   exporting or looking up the label.

2. Required correction 4 was only partially implemented.

   Removing `freeLayersHaveGeodata` fixes the stale duplicate state, but
   `MapStyle.refreshSequences()` still contains
   `if (!freeLayer.geodata) continue`, and `addFreeLayer()` still accepts an
   unvalidated `unknown` value. The review explicitly required validation at
   that retained legacy boundary followed by removal of downstream type gates.

   Make the surviving geodata/vector invariant explicit at registration, remove
   the predicate from the style path, and add a regression that a profile
   changing from active vectors to none skips drawing and hit testing based on
   the sequence itself.

   *Adopted.* `addFreeLayer()` now rejects known non-geodata definitions at
   registration, and fetched definitions are removed when their resolved type
   is not geodata. The style path no longer checks `freeLayer.geodata`; the
   regression exercises active-to-empty draw and hit-test sequences.

3. The revised design body and current terminology still contradict each
   other.

   Section 2.5 says "free layer" does not appear in the Viewer API, core model,
   or current-behavior documentation after implementation. Section 4 retains
   `createGeodata()` / `addFreeLayer()` / `removeFreeLayer()` and the internal
   machinery, and `non-interactive.md` necessarily documents that transitional
   surface. Revise section 2.5 to name these bounded legacy exceptions rather
   than claiming they do not exist.

   The implementation review also required the new terminology to be removed
   from tests. Current test names and comments still say "links modules",
   "first module", and "same module's own". Replace those remaining uses with
   "resolved stylesheet" or a more specific phrase. Historical reviewer text
   and immutable addenda remain unchanged.

   *Adopted.* Section 2.5 now names the retained overlay methods and machinery
   as the bounded exception. Live unit-test names and comments now say
   "resolved stylesheet"; historical review and addendum text is untouched.

4. The remaining ambient `LegacyMap.url` swap has not been shown to require
   four constructor changes.

   Source inspection finds one relevant ambient read:
   `MapSrs` resolves `geoidGrid.definition` through `this.map.url`.
   `MapBody` and `MapRefFrame` do not read it, and the atmosphere URL is
   assembled by `MapStyle.loadStyle()` before `Atmosphere` construction. The
   round-6 text and backlog therefore overstate the mechanism when they say all
   four classes need constructor changes.

   Pass the source base into `MapSrs` resolution, construct the atmosphere URL
   from that same explicit context, and remove the swap. Test two inline
   surfaces with different bases and a constructor failure. If another ambient
   read prevents this, identify that read in the response; the current source
   does not contain it.

   *Adopted.* `MapSrs` now receives the source base explicitly, the atmosphere
   service URL is resolved from that same base, and `MapSurface` receives it
   for URL and inline documents. The `LegacyMap.url` swap and `MapUrl` import
   are gone. The runtime gate checks two inline surfaces with different bases,
   SRS and atmosphere resolution, and a failing `MapSrs` construction without
   changing the style-level URL object.

5. The compatibility entry point is separate, but the demo does not load it
   conditionally.

   `demos/map/index.html` has an unconditional
   `<script src="../../build/cartolina-compat.js">`, so every style-only demo
   visit still downloads and evaluates the converter. This contradicts the new
   comment that the style-only route does not pay for it and the backlog's lazy
   loading acceptance condition.

   Load the compatibility entry only inside the `?mapConfig=` path. Add a
   browser assertion that a style URL makes no compatibility-bundle request and
   that a mapConfig URL loads it and renders.

   *Adopted.* The demo injects `cartolina-compat.js` only after selecting the
   `?mapConfig=` path. The runtime gate records browser requests: its style
   route must omit the bundle, while its mapConfig route must request it and
   reach a ready viewer with a live canvas.

6. Correct the implementation-history commit references append-only.

   The correction addendum names `94b32577`, a dangling pre-amend commit; the
   committed implementation is `3e237f1b`. The later validation fixes are in
   `92dc7458`. Do not edit the committed addenda. Append a dated correction
   addendum naming the final commits and explaining that the first hash was the
   pre-amend object.

   *Adopted.* The dated correction addendum below leaves both earlier addenda
   unchanged, identifies `94b32577` as the discarded pre-amend object, and
   records `3e237f1b` and `92dc7458` as the committed changes.

The browser checks for this round followed a fresh-server protocol: the prior
Cartolina dev-server process was stopped, port 8080 was confirmed free, one new
server was started on port 8080, compilation completed, and the served version
was matched to `src/core/version.js` before capture.

## Addendum — 2026-07-20 — round 7 corrections

This addendum implements the six round 7 responses above and corrects the
implementation-history references without changing earlier addenda.

The implementation-review correction addendum names `94b32577`. That object
was the pre-amend form of the correction commit and is no longer the branch
commit. The committed correction is `3e237f1b`. The subsequent fixes found
while re-running validation are committed as `92dc7458`.

Round 7 also keeps the stylesheet qualification label inside the linker,
enforces the surviving geodata forms at the retained registration boundary,
and aligns the live terminology with the bounded compatibility exception.
Source construction now passes base URLs explicitly to `MapSrs`, atmosphere
URL resolution, and `MapSurface`, so it never replaces `LegacyMap.url`.
The demo loads the compatibility entry only on its mapConfig route.

The maintained runtime gate checks the active-to-empty vector sequence, two
inline surfaces with different bases, SRS and atmosphere URL resolution, URL
context preservation when an SRS constructor throws, and conditional browser
loading of the compatibility entry. The complete validation result is recorded
in the session log.

## Review round 8

This is a post-implementation review of the branch at `7e724f5e`, reading
the code rather than the design text.

Round 7's six responses are confirmed in the code:

1. The stylesheet qualification label is assigned and consumed inside
   `linkStylesheets()`. `stylesheetScopeId` occurs nowhere outside the
   linker; the linker returns `layerIdsByInput`, and the converter pairs
   emitted ids back to its resolved-stylesheet records by input position.
2. `Map.addFreeLayer()` rejects a non-geodata definition, `MapSurface`'s
   `onLoaded` drops a fetched free layer whose resolved type is not
   geodata, and `MapStyle.refreshSequences()` no longer reads
   `freeLayer.geodata`. `freeLayersHaveGeodata` is gone from the source.
3. Section 2.5 names the retained overlay methods as the bounded legacy
   exception; live unit-test names and comments say "resolved stylesheet".
4. `MapSrs`, the atmosphere service URL, and `MapSurface` receive the
   source base explicitly. The `LegacyMap.url` swap and the `MapUrl`
   import are gone from `MapStyle.loadStyle()`.
5. `demos/map/index.html` injects `cartolina-compat.js` only after
   selecting the `?mapConfig=` path.
6. The round 7 corrections addendum identifies `94b32577` as the
   discarded pre-amend object and records `3e237f1b` and `92dc7458`.

`npm run typecheck` and `npm run test:unit` (80 tests) pass on the branch.

One new defect blocks sign-off.

1. **A named-view profile can name a layer the style does not contain,
   which `applyVisibilityProfile()` then rejects.**

   `assembleLayers()` skips a mixed rule — a VTS rule that enables both
   line drawing and point or label drawing — emitting an
   `unsupported-rule` warning and no layer, per section 8.3.
   `buildProfiles()` does not learn of that skip: for every named view
   that selects the rule's stylesheet, it activates every id in
   `layerIdsByInput` for that input, including the skipped mixed rule's
   id. The returned profile therefore carries a `layers` key that no
   style layer matches.

   Section 6.4 states that a profile is a complete snapshot and that
   `Viewer` rejects a profile that names an unknown layer;
   `Viewer.applyVisibilityProfile()` enforces this and throws
   `Visibility profile names unknown layer(s): <id>`. So a non-strict
   conversion of a mapConfig whose named-view stylesheet holds one mixed
   rule produces a profile that crashes the moment the application applies
   it. Strict mode masks the defect, because the mixed-rule warning
   already fails conversion there.

   Reproduced against the compiled converter: a free layer with a
   `geodata` source and a stylesheet holding `labels-a` (label only) and
   `mixed-a` (label plus line), selected by both the initial view and a
   named view `detail`. The emitted style contains only `labels-a`, but
   the `detail` profile's `layers` are `labels-a` and `mixed-a`, and the
   completeness check rejects `mixed-a`.

   Have `assembleLayers()` report which linker ids it actually emitted (or
   which it skipped), and have `buildProfiles()` activate only emitted
   ids. Add a regression that a named view selecting a stylesheet with a
   mixed rule yields a profile whose keys equal the emitted style layer
   ids, and that the converted profile applies through
   `applyVisibilityProfile()` without throwing.

   *Adopted.* `buildProfiles()` now intersects each selected stylesheet's
   linked ids with the final assembled layer ids. No additional
   `assembleLayers()` result is needed because `buildProfiles()` already
   receives the assembled layer list. The unit regression checks that the
   profile keys equal the emitted style ids, and the maintained browser gate
   applies a converted mixed-rule profile through `applyVisibilityProfile()`.

The design body needs no change: section 8.3 already says a mixed rule is
not emitted, and section 6.4 already requires a profile to cover exactly
the style's layers. This is an implementation gap in `buildProfiles()`.
Fix it, add the regression, extend the maintained gate if the case is not
otherwise reachable, and record the fix in a dated correction addendum.
This round does not sign off.

## Addendum — 2026-07-21 — round 8 correction

Named-view profile construction now treats the final assembled layer list as
the authoritative emitted-id set. A mixed rule remains linked for diagnostics
and symbol processing, but its id is not activated after layer assembly omits
the rule. Every profile therefore continues to cover exactly the style's
emitted layers.

The converter unit regression selects a stylesheet containing a label rule and
a mixed rule from a named view, then compares the profile keys with the emitted
style-layer ids. The browser gate injects a mixed rule during conversion of the
public compatibility case and applies the converted named-view profile through
the live `Viewer` without an unknown-layer error.

Validation passed the typecheck, all 80 unit tests, the four-mapConfig strict
corpus, the maintained runtime gate, the production build, and the three
sequential dev/production screenshot comparisons. The six captures were
inspected and match in terrain, imagery, shading, and labels.

## Review round 9 — sign-off

The round 8 finding is resolved. `buildProfiles()` now builds the emitted-id
set from the assembled layer list and activates only ids present in it, so a
mixed rule that `assembleLayers()` omits is no longer named by a named-view
profile. Every converted profile again covers exactly the style's emitted
layers, per section 6.4.

Independently verified on the branch at `78388883`: the typecheck and all 80
unit tests pass, and the round 8 reproduction — a `geodata` free layer whose
stylesheet holds `labels-a` and a `mixed-a` rule, selected by a named view —
now yields a `detail` profile whose only key is `labels-a`, with no phantom
`mixed-a`, so the completeness check passes. The unit regression asserts the
profile keys equal the emitted style ids, and the maintained browser gate
applies a converted mixed-rule profile through the live
`applyVisibilityProfile()`. The guarded change touches only converted
named-view profile construction; it alters no rendering, and the style-native
screenshot corpus (no named views, no mixed rules) does not exercise it. The
author's round 8 correction addendum records the full gate, including the
screenshot comparisons, passing.

Rounds 7 and 8 confirmed the round 6 design change end to end: the stylesheet
qualification label stays inside the linker, the retained overlay boundary
enforces the surviving geodata forms, source construction passes its base
explicitly with no `LegacyMap.url` swap, the compatibility converter lives
behind its own entry point loaded only on the mapConfig route, and the
terminology matches the bounded legacy exception. No specification-level or
implementation findings remain. The round 6 design change and its
implementation are accepted; the RFC is `Implemented`.

## Addendum — 2026-07-26 — native and mapConfig construction defaults

`Viewer` now accepts the same complete `Options` object as the `map()` factory.
The factory delegates directly; `Viewer` owns validation and flattens the
options only at the remaining legacy `Browser` boundary. The permissive
`Viewer.Config` intermediary and the factory-local default patch are gone.

The catalogue now holds the six effective style-factory values: double-click
jump is enabled, while compass, zoom, space, search, and measure controls are
disabled. Five catalogue values changed; measure was already disabled. This
preserves native style-map behavior while making the catalogue its sole
default authority.

The converter now emits the retired mapConfig factory's corresponding default
profile in `viewerOptions`. Authored `browserOptions` override that profile,
and application options retain final precedence. A malformed authored boolean
does not count as an override: it retains the mapConfig value, matching the
fallback in effect before the catalogue defaults changed.

Focused compile contracts pin factory and constructor option equality. Unit
tests pin both default profiles and the mapConfig valid-override and
invalid-fallback behavior.

## Addendum — 2026-07-30 — map-owned raster sources

`MapBoundLayer` and the `LegacyMap.boundLayers` registry are gone. A
`cartolina-tms` definition now resolves to an immutable `RasterSource`, while
typed `Map` owns a registry containing either a ready source or its permanent
metadata failure. Source URLs name the definition JSON directly; only a
trailing slash appends the retained `boundlayer.json` protocol filename.

Raster metadata requests start together and overlap terrain metadata loading.
`Promise.allSettled()` records every result. Initial readiness rejects only
when an effective raster layer uses a failed source. A prospective visibility
mutation performs the same check before committing overrides or sequences, so
an inactive failure can remain dormant and a later failed activation leaves
the rendered state unchanged.

The runtime metadata contract is now limited to tile and coverage URLs, LOD
and tile ranges, credits, transparency, and paired metatile/mask coverage.
Mask-only metadata is ignored; meta-only metadata fails the source. Legacy
availability probes, shader filters, classification textures, numeric ids,
options, and lifecycle accessors were deleted rather than translated. The
compatibility converter emits only the supported inline fields and reports
discarded legacy fields as notes.

`TileRenderRig`, tile state, texture caches, coverage resources, credits, and
diagnostics now use raster-source terminology. Coverage selects a raster tile
or its ancestor directly from the metatile and loads a per-tile mask where
needed. The cache creates its aggregated coverage node explicitly; the old
callback timing had previously caused that branch to exist before first use.
All `TEXTURECHECK_*` and `TEXTURETYPE_*` constants, header probes,
`headRequest()`, and `GpuTexture.Type.Class` are deleted.

Validation passed the typecheck, 89 unit tests, strict public converter corpus,
the deterministic 18-check raster lifecycle gate, style-mutation gate,
production build, and sequential `simple-terrain`, `complex-terrain`,
`full-terrain`, and `legacy-benatky` screenshot comparisons. The four
development captures had no console, page, or network errors and were
inspected against their production counterparts. Matched local performance
samples at the pre-refactor commit and the implementation use the same
147-draw `simple-terrain` frame; the implementation is within 4% of baseline
FPS. Repeat load and FPS runs remain inside the 30% and 10% limits.

## Addendum — 2026-07-30 — raster-source validation record

Commit `d2e5f7f6` contains the map-owned raster-source implementation and the
preceding addendum. The recorded type, unit, lifecycle, corpus, build,
screenshot, and performance gates ran against that implementation tree. The
commit hook changed only generated version metadata after validation, which
does not alter the validated behavior.

## Addendum — 2026-07-30 — typed raster-source boundary

`RasterSource` metadata now has one declaration-merged TypeScript contract.
Typia validates fetched and inline JSON at the public construction boundary;
the private constructor receives only normalized metadata. Additional JSON
properties remain accepted at the boundary but cannot enter runtime state.
Range ordering, safe integers, credit definitions, and coverage URL pairs are
validated before an immutable source is created.
String-valued external credit documents are unsupported.

Static tile-range lookup now returns the `RasterSource.TileMatch` enum:
`None`, `Ancestor`, or `Direct`. The renderer branches on those names instead
of the old numeric convention. The parser and credit-definition helper are
private static class members, and the ad hoc number-pair guard is gone.

Each source retains its typed `Map` owner. During style construction, `Map`
exposes the legacy state being populated through its existing internal
`legacyMap` access, while keeping that state separate from the render-active
map field. This supplies the credit table during construction and the current
URL-template implementation after activation without making `LegacyMap` the
source owner. Style refreshes now rebuild sequences and mark the three dirty
flags directly in typed `Map`; the two typed call sites no longer invoke the
legacy `refreshView()` wrapper.

Validation passed the typecheck, all 90 unit tests, the deterministic
18-check raster-source lifecycle gate, the 32-check style-mutation gate, the
strict four-document conversion corpus, the production build, and the four
sequential render comparisons. The development renders reported no console,
page, or network errors and were inspected beside their production
counterparts.

## Addendum — 2026-07-30 — typed raster-source validation record

Commit `75618cae` contains the typed raster-source boundary implementation and
the preceding addendum. The recorded type, unit, lifecycle, corpus, build,
and screenshot gates ran against that implementation tree. The commit hook
changed only generated version metadata after validation, which does not
alter the validated behavior.

## Addendum — 2026-07-30 — immediate raster metadata dispatch

Commit `b38ba8dd` removes the microtask delay before raster metadata loading.
Each async load now starts as the source loop reaches it while retaining
rejected-promise handling for synchronous inline-definition failures. The
concurrency test now recognizes raster/terrain overlap independently of which
request starts first.

The typecheck, all 90 unit tests, and the deterministic 18-check raster-source
lifecycle gate passed against this commit.

## Addendum — 2026-07-30 — map-owned style refresh target

Commit `3a252065` removes the redundant legacy-map parameter from the typed
style-refresh helper. Construction and runtime mutation already expose their
respective legacy state through `Map.legacyMap`, so both paths now use that
single map-owned access.

The typecheck, deterministic 18-check raster-source lifecycle gate, and
32-check style-mutation gate passed against this commit.

## Addendum — 2026-07-30 — inline source construction precedes the map wipe

Immediate raster dispatch (`b38ba8dd`) left the map-clearing block after the
source loop. An inline definition resolves without ever suspending, so its
`RasterSource` was constructed while that loop ran and registered its credits
into a table the following statement replaced. URL definitions await their
fetch and were unaffected.

`mapConfigToStyle()` emits an inline definition for every source it
converts and the demo styles state URL sources, so the mapConfig route is
where this ran. The loss was not confined to attribution: an unregistered
credit id makes `Map.getCreditInfo` return an empty record, and the credits
control reads a missing `html` field, so every frame threw inside the tick
handler and the map never rendered.

`MapStyle.loadStyle` now clears the map before dispatching any source load.

Validation: typecheck, 90 unit tests, the 18-check raster-source lifecycle
gate, the 32-check style-mutation gate, the strict conversion corpus, and
render comparisons for the `simple-terrain`, `complex-terrain`, and
`full-terrain` style cases and the `legacy-benatky` mapConfig case.

## Addendum — 2026-07-31 — typed terrain source

`MapSurface` served two disjoint roles: the terrain source behind a
`cartolina-surface` style source, and the geodata free layer behind a
`cartolina-freelayer` one. Neither used more than about half its
fields, and both wrote the same `style` field with unrelated meanings —
the effective style specification for terrain, a vts stylesheet
reference for a free layer.

The terrain role is now `TerrainSource`, an immutable TypeScript class
built through a Typia-validated boundary, matching `RasterSource`. Its
contract is the metatile, navigation tile, and mesh URLs, the optional
internal texture and normal-map URLs, the LOD range, and credits.
`tileRange` is validated and discarded: every surface document declares
it, but tile presence is answered by metanodes. The style source id is
the source identity, so the document-level id, `styleSourceId`, and the
registration index collapse into one name.

Typed `Map` owns the sources, keyed by style source id. There is no
ready-or-failed entry union as there is for raster sources: an
unreachable surface document leaves the style unusable, so the first
failure rejects style loading. Surface documents are now requested
alongside the raster metadata and consumed in source order, so the
first document still supplies the reference frame and shared metadata.

The remainder of the class is `MapFreeLayer` in `free-layer.js`,
holding only the geodata role. Deleted rather than translated: the
tile-range predicates `hasTile`, `hasTile2`, and `hasMetatile`, whose
last caller went with the multi-surface teardown; the heightmap URL
path, which no entry point could reach; `metaBinaryOrder`, `navDelta`,
`textureLayer`, `zFactor`, `geodataNavtileInfo`, and the surface credit
number list, none of which had readers; the free-layer option
accessors; and the per-surface style field, which held the same
specification for every surface and is read from the map instead.

The per-node display size is no longer overwritten by a surface-level
value. `parseMetanode()` decodes the field and substitutes 256 whenever
`applyDisplaySize` is clear, which is what the fallback formulas in
`updateTexelSize()` read. A surface-level display size is a geodata
construct: the geodata generators are the ones that pass a display size
into metatile generation, and they publish the same number in the
free-layer document, so substituting it could only restate the decoded
value or contradict the flag.

Validation: typecheck, 98 unit tests, the 20-check terrain-source
lifecycle gate, the 18-check raster-source lifecycle gate, the 32-check
style-mutation gate, the strict conversion corpus, the production
build, and render comparisons for the `simple-terrain`,
`complex-terrain`, and `full-terrain` style cases and the
`legacy-benatky` mapConfig case. The simple and full terrain captures
are pixel-identical to production and the complex capture differs at
label edges.

## Review round 10 — post-implementation review

This review covers the source-location design and terrain-source work in
commits `c4fd2801`, `ac512132`, and `fb56eed5`. Typecheck and all 98 unit tests
pass at `fb56eed5`. The active implementation range has already been rewritten
to satisfy the public documentation rules. The findings below block renewed
sign-off.

No finding asks the implementation to support source or credit ids that name
`Object.prototype` members. Such names may be rejected once at the validation
boundary; do not change storage throughout the codebase for them. For keyed
structures, use an ordinary object for fixed fields, `Record<string, T>` for
domain dictionaries that are serialized or exposed as data, and `Map<K, V>`
only for an internal index whose contract is map operations or non-string
keys. String keys, mutability, and the word "registry" do not select `Map`.
Choose the representation at the owning boundary and do not convert it merely
to satisfy a style preference or test shape.

1. RFC 11 put compatibility construction data into the public style
   specification, contradicting its own boundary.

   Round-1 note 1 says this RFC deletes mapConfig but does not redesign style.
   It draws the conversion boundary as existing style version 2 plus
   construction values. Section 7.1 nevertheless added `SourceLocation<T>` so
   the converter could place already-fetched mapConfig resource documents in
   style source entries. Its `data`, `baseUrl`, and forbidden optional
   properties encode loader provenance, not authored style meaning.

   Round-1 note 11 found the resulting metadata duplication, URL provenance,
   and conflict-handling problems, but accepted inline style sources as
   fixed. The response made that representation more precise instead of
   applying note 1. The implementation exposes the resulting cost:
   `MapStyle.resolveSourceDefinition()` accepts the provenance union, and the
   source and shared-metadata constructors must receive the `baseUrl` stored in
   each style entry. The style loader remains the correct single construction
   path, but its public input contract now records compatibility fetch history.

   Keep the current single style-construction path and the inline definitions,
   but remove the compatibility provenance from the public shape. Spell each
   source-specific union directly instead of exposing a generic loader
   location type. For example:

   ```typescript
   type CartolinaSurfaceSource =
       | { type: 'cartolina-surface'; url: string }
       | {
           type: 'cartolina-surface';
           definition: SurfaceSourceDefinition;
       };
   ```

   The schema validator rejects both `url` and `definition` being present or
   both being absent. Raster and free-layer sources use the same explicit
   pattern with their own definition types. This remains an addition to the
   style format, but it describes what the style contains rather than where a
   loader happened to obtain it.

   Relative URLs in an authored inline definition resolve against the
   containing style document, just like the rest of the style. The style
   loader already retains that document path in `LegacyMap.url`. The converter
   continues making every embedded URL absolute, so converted definitions do
   not depend on a base at all. Remove `baseUrl` from the public specification
   and pass either the fetched source-document path or the containing
   style-document path to the existing source constructors.

   `mapConfigToStyle()` still returns a standalone serializable style, and
   `MapStyle.loadStyle()` remains the only map initialization path. Do not add
   another construction value or model. Test the shared URL-or-definition
   rule, both URL-resolution bases, and rejection of ambiguous entries. Add
   source-specific cases only where their constructors behave differently.

   *Adopted.* Section 7.1 and the style types now spell the three
   source-specific URL-or-definition unions directly. Inline definitions use
   the containing style document as their URL base, while fetched definitions
   use their own document URL. The converter emits `definition` with absolute
   embedded URLs and no `baseUrl`. Schema and browser regressions cover the
   exclusive union and both resolution bases.

2. The `MapFreeLayer` extraction changes string-valued credits into
   per-character credit ids.

   `MapSurface.parseJson()` handled a string-valued `credits` field by storing
   the external-document URL and replacing `this.credits` with an empty array.
   `MapFreeLayer.parseJson()` handles only object tables; a string remains in
   `this.credits`. `MapDraw.drawMonoliticGeodata()` then iterates
   `surface.credits` by index, treating every character in the URL as a credit
   id and adding those characters to `visibleCredits.mapdata`.

   Preserve the previous handling by replacing the string with an empty credit
   list. Add one regression covering a monolithic free-layer definition whose
   `credits` value is a string.

   *Adopted.* `MapFreeLayer.parseJson()` now replaces a string-valued credit
   field with an empty list before draw code can iterate it. The style browser
   gate constructs an inline monolithic free layer and checks the normalized
   list.

3. Source construction mutates the global credit registry in
   request-completion order.

   `RasterSource.fromMetadata()` runs in a promise continuation as each raster
   request resolves and registers credit definitions immediately.
   `TerrainSource.fromMetadata()` registers its definitions later, after every
   terrain request has settled. `LegacyMap.addCredit()` overwrites by id.
   Therefore the final definition for an id shared by terrain and raster
   sources depends on whether the raster request finishes before or after the
   terrain batch. The map-clearing regression fixed by `c4fd2801` was another
   consequence of constructors mutating shared map state during loading.

   Fetch the terrain and raster definitions concurrently, then consume the
   settled results in source declaration order. After a source validates,
   register its credit definitions directly in that loop; the existing
   `addCredit()` overwrite behavior then gives a later declared source the
   final definition. Source constructors retain the credit ids but do not
   mutate the map. No staging model or registry abstraction is needed. Keep
   the current rule that the first declared terrain source supplies shared map
   metadata; `MapStyle.initializeMapMetadata()` must say "declared," not
   "to arrive." Add one reversed-completion regression that checks both rules.

   *Adopted.* `MapStyle.loadStyle()` dispatches all terrain and raster
   definition requests together, awaits their settled results, and consumes
   them in source dictionary order. Constructors retain credit ids without
   registering definitions; the loader registers validated definitions while
   consuming each source. The lifecycle gate reverses request completion and
   checks both the shared-metadata owner and the later-declared credit value.

4. Inline credit validation covers only the top-level terrain definition.

   `checkInlineSurfaceConsistency()` examines the outer `credits` table of an
   inline `cartolina-surface` definition. It does not examine a surface
   entry's own table, an inline `cartolina-tms` definition, or an inline
   `cartolina-freelayer` definition. It also returns before checking credits
   when fewer than two inline terrain sources exist. Conflicting inline TMS
   definitions therefore pass validation and are resolved later by registry
   write order.

   Validate the effective inline credit tables for all three source kinds
   before constructing sources. Equal definitions may repeat; differing
   definitions for one id must fail with both source ids. A terrain surface
   entry overrides the outer definition for its own effective table. Cover an
   equal cross-kind case, a conflicting non-terrain case, and the distinct
   surface-entry override case. URL free layers keep their existing
   asynchronous registration and are outside the source-order guarantee.

   *Adopted.* Pre-construction validation now derives the effective credit
   table of every inline source. A terrain surface entry overrides its outer
   table. Unit cases cover equal cross-kind definitions, conflicting raster
   and free-layer definitions, and the terrain-entry override. URL free layers
   retain their asynchronous behavior.

5. The display-size change left current documentation false.

   Commit `ac512132` removes the assignment that overwrote a decoded metanode
   display size with a surface-level value. `docs/wiki/lod-selection.md` still
   says that `displaySize` comes from `metatile.surface.displaySize` and that
   `parseMetanode()` performs the overwrite.

   Update the LOD documentation in the corrected implementation commit. State
   the current decoded-value path and the effect of `applyDisplaySize` as the
   code implements them.

   *Adopted.* [lod-selection.md](lod-selection.md) now states that
   `parseMetanode()` keeps the decoded uint16 value when `applyDisplaySize` is
   set and substitutes 256 when it is clear.

6. The RFC 11 compatibility modules use `interface` for fixed object shapes.

   `src/compat/mapconfig-to-style.ts` declares four such interfaces and
   `src/compat/vts-stylesheet-linker.ts` declares five. None is intended for
   declaration merging. Convert those nine declarations to type aliases, as
   required by the repository's TypeScript conventions. This is a mechanical
   correction and requires no runtime change or new test.

   *Adopted.* All nine fixed compatibility shapes are now type aliases. No
   runtime code changed for this finding.

## Addendum — 2026-08-06 — converter test tier removed

The hand-written converter unit suite and live corpus script were removed with
the repository's ritual unit-test tier. The legacy converter is evaluated
through real applications when compatibility work changes it; it has no
permanent converter-specific test harness.

## Review round 11 — post-implementation review

The six round 10 findings are resolved in `a49edabd`:

1. Public source entries now use source-specific `url` or `definition`
   unions. Inline definitions resolve from the style document, fetched
   definitions resolve from their own document, and converter output contains
   absolute embedded URLs without loader provenance.
2. `MapFreeLayer` replaces a string-valued credit document reference with an
   empty credit-id list.
3. Terrain and raster requests start together, but their definitions and
   credits are consumed in source declaration order. The first declared
   terrain supplies shared metadata and a later declared source wins a credit
   overwrite independently of completion order.
4. Pre-construction credit validation covers every inline source kind and
   uses a terrain entry's credit definition in preference to the containing
   terrain document's definition.
5. [lod-selection.md](lod-selection.md) describes the decoded metanode
   `displaySize` and the `applyDisplaySize` fallback as implemented.
6. The nine fixed compatibility shapes named in round 10 are type aliases.

The approved test-policy cleanup in `1b73ec0e` changes no runtime source. The
remaining browser gates cover the URL bases, string-valued free-layer credits,
request overlap, declaration-order metadata and credits, and the real
mapConfig route. A current-tip browser probe also confirmed the exclusive
URL-or-definition rule, equal cross-kind credits, conflicting non-terrain
credits, and the terrain-entry override after the permanent unit suite was
removed. The typecheck, focused `ConfigStore` and `EventBus` checks,
production build, source lifecycle gates, style-mutation gate, and the three
canonical render comparisons pass. The render pairs were inspected.

One documentation finding blocks renewed sign-off:

1. [backlog.md](backlog.md), "RFC 11 validation items not yet automated," is
   no longer factual after the test cleanup. It says the implementation covers
   the conversion corpus and strict closure gate even though their script was
   removed, and it still prescribes three unit or Playwright additions without
   applying the approved test policy. Revise the entry to describe only
   current evidence and retain a proposed check only when it meets that
   policy. The project-controlled real-map fixture may remain as a separate
   forward-looking item.

   *Adopted.* The backlog entry was deleted. Its existing-gate claims referred
   to removed programs, the three proposed automatic tests had no demonstrated
   gap under the current test policy, and the proposed public fixture had no
   active feature need to justify its maintenance cost. The signed-off
   validation lists remain as historical design text.

No implementation or design-body finding remains. The RFC stays `In review`
until the current backlog entry is corrected.
