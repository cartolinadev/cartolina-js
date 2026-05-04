# Rendering Sizes Redesign — Input Notes (design complete, implemented 2026-05-04)

This document records the design intent behind the planned refactor of
how rendering sizes are stored, owned, and propagated. It is the
starting point for the implementation task.

## Core claim

Two sizes belong on every render target:

**Viewport size** — the physical pixel dimensions used by the canvas
element (`canvas.width`, `canvas.height`) and passed to `gl.viewport`.

**Apparent logical size** — the size the user perceives in CSS units.
This is the size that governs aspect ratio and projection matrices, and
the size that all CPU-side rendering code working in logical pixel units
(labels, collision boxes, screen-space helpers) must use.

## Ownership

Size calculation currently lives in `Renderer.calculateSizes()`. It
should move to `GpuDevice`, which owns the canvas and therefore owns the
authority to derive both sizes from it.

`GpuDevice` should be capable of generating the two canonical sizes from
the canvas element and exposing them so that render targets can be
constructed with accurate values.

## Behavior per target class

**Canvas render target** — both viewport size and apparent logical size
map naturally to the canvas: viewport size is the physical pixel size,
apparent logical size is the CSS layout size.

**Auxiliary render target** — setting an auxiliary target modifies the
viewport size only. It does not touch the apparent logical size or the
projection. The projection must remain that of the screen view.

**Independent render target** — sets both sizes explicitly. An
independent off-screen pass acting as the main canvas pass simply copies
the canvas values. A pass that oversamples (e.g. SSAA) sets the viewport
size larger while keeping the apparent logical size equal to the canvas
apparent logical size.

The critical constraint is that there should be no special-casing of
target classes at call sites. The render target carries its own sizes,
and consumers read them uniformly regardless of target type.

## Three sizes on the render target

**Apparent logical size vs current `logicalSize`**: The current
`RenderTarget.logicalSize` is set to `cssSize` — the pre-transform
layout size. Apparent logical size is `cssSize * visibleScale`, i.e.
the actual visible extent after CSS transforms. Renaming `logicalSize`
to carry the apparent logical value is intentional. If a CSS transform
scales the map to half width and height, the projection matrix and
aspect ratio should reflect what the user actually sees. Once rendering
code uses apparent logical size directly, the `visibleScale`
compensation in screen-space helpers (the `screenPixelSize` formula)
becomes redundant and can be removed.

**Pre-transform CSS layout size**: Mouse events report coordinates in
the element's local (pre-transform) CSS coordinate space. Hit-test
conversions (`hitTest`, `hitTestGeoLayers`, `getDepth`,
`getScreenRay`) currently use `logicalSize` for this. With apparent
logical size taking over as `logicalSize`, the canvas target must also
carry the pre-transform CSS layout size as a separate field so those
conversions remain correct. This is an auxiliary field; rendering code
does not need it.

## Size calculation ownership

`calculateSizes` currently lives on `Renderer`. It should move to
`GpuDevice`, which owns the canvas element. Code analysis confirms that
both call sites (`updateSizeIfNeeded` and `switchToFramebuffer('base')`)
call `calculateSizes()` immediately before `resizeCanvas()` and
`setRenderTarget()`, so collapsing them into a single
`GpuDevice.setCanvasRenderTarget()` is the right consolidation.

## GpuDevice API shape

The central goal is uniform render target behaviour: no consumer
needs to know what kind of target is active. Three methods replace the
current fragmented call sites:

- `setCanvasRenderTarget()` — takes no arguments beyond the canvas
  element already owned by `GpuDevice`. Derives all sizes internally
  (viewport size, apparent logical size, CSS layout size, CSS scale,
  DPR), builds and installs the canvas render target. Consolidates the
  two currently duplicated call sequences in `updateSizeIfNeeded` and
  `switchToFramebuffer('base')`.
- `setAuxiliaryRenderTarget(texture, viewportSize)` — installs a
  framebuffer target, updating only the viewport size. All other size
  fields are inherited unchanged from the canvas render target.
  Projection is not touched; the caller is responsible for ensuring
  the projection was set for the canvas view before switching.
- Independent render target support — not in scope for this refactor.
  See the existing backlog entry "FEATURE: explicit offscreen
  render-pass API" in `backlog.md`, which describes the same concept
  under a slightly different API shape. This refactor is a prerequisite
  for that work.

## setProjection

`setProjection` stays on `Renderer`. It is called explicitly after
`setCanvasRenderTarget()` and is not called for auxiliary targets —
this is unchanged behaviour. With apparent logical size as the input,
the call is `setProjection(target.logicalSize)` as it is today, but
`logicalSize` now carries the correct value without a separate
`visibleScale` multiplication.

## Auxiliary sizes on the render target

The following are stored on the canvas render target but consumed
rarely or never by rendering code:

- **CSS layout size** — pre-transform size; used only by mouse-event
  coordinate conversions.
- **CSS transform scale** (currently `visibleScale`, name TBD —
  candidates: `cssScaling`, `cssScale`, `cssTransformScale`) — ratio
  of apparent logical size to CSS layout size. The collision-box offset
  division in `draw.js` (`v / visibleScale`, line 34) exists only
  because `pp` currently lives in cssSize space; once `logicalSize`
  becomes apparent logical size the division disappears. After this
  refactor, rendering callers of `renderer.visibleScale()` reduce to
  zero (confirmed: both draw.js uses go away). The only remaining
  reader is `stats.js:191`, which uses it for inspector display only.
  The value is kept as an auxiliary field on the canvas render target.
- **DPR** — used in tile LOD selection (`texelSizeFit` in `draw.js`)
  and geodata feature density (`processor.js`); both currently read
  `window.devicePixelRatio` directly. Once off-screen rendering is
  introduced, DPR will be set manually on the render target, making
  this the right place to source it.

Auxiliary targets and independent targets inherit or ignore these as
appropriate; they are first-class fields only on the canvas target.

## Redundant imageProjectionMatrix computation

`Map.prototype.getScreenDepth` ([map.js:1156](../../src/core/map/map.js))
recomputes `imageProjectionMatrix` from `renderer.curSize` after
calling `drawHitmap()`. This is dead code: `drawHitmap()` ends with
`switchToFramebuffer('base')`, which already calls `setProjection()`
and sets the same matrix. The duplicate write can be deleted. The
surrounding `ndcToScreenPixel` save/restore is the real work in that
block and is unaffected.

## Label density singularity

`RendererRMap.clear()` ([rmap.js:36](../../src/core/renderer/rmap.js))
sets the collision-grid bounds from `renderer.curSize`:

```js
this.sx2 = renderer.curSize[0];
this.sy2 = renderer.curSize[1];
```

After this refactor, `curSize` would return apparent logical size
instead of CSS layout size, shrinking the rmap grid under CSS
transforms and changing label density. Using apparent logical size is
arguably more correct (the visible area is smaller, so fewer labels
fit), but changing this is an intentional regression risk.

**Decision**: preserve the current behaviour by reading the CSS layout
size field from the render target here instead of `curSize`, with a
comment explaining the deliberate choice. This is the one call site
where CSS layout size, not apparent logical size, is used for rendering
logic.
