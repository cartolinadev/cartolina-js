# Implemented RFCs

Archive of RFCs whose implementation is complete. Newest first.

- RFC 11 [rfc11-mapconfig-to-style.md](rfc11-mapconfig-to-style.md) —
  legacy mapConfig support retired from Cartolina proper: the exported
  `mapConfigToStyle()` converter produces styles and construction values
  before initialization, named views become Viewer visibility profiles, and
  the second runtime map model is deleted; post-implementation review closed
  2026-08-06
- RFC 1 [rfc01-config-store.md](rfc01-config-store.md) — single
  `ConfigStore<ViewerConfig>` replacing the three config objects and
  the stringly-typed `setConfigParam` routing; subsystems watch their
  keys; `core.js` deleted with its shell absorbed into `Map`; typed
  public `setParam` / `getParam` and factory-option boundaries; the
  round-6 revision collapsed the per-key artifacts into one spec
  catalogue deriving types, producer defaults, normalization, public
  subsets, URL parsing, and per-key documentation; implemented
  2026-07-13
- RFC 2 [rfc02-event-bus.md](rfc02-event-bus.md) — typed
  `EventBus<ViewerEventMap>` owned by `Map` replacing the `Core`
  listener array; browser-layer events promoted into the typed map;
  `wait` parameter removed; `Browser.kill()` leak fixed; implemented
  2026-07-11
- RFC 9
  [rfc09-metadata-first-traversal.md](rfc09-metadata-first-traversal.md) —
  metadata-first combined terrain descent, stable front-to-back loading
  order, and a bounded cross-version structural descent policy;
  implemented 2026-07-11
- RFC 7 [rfc07-metanode-store.md](rfc07-metanode-store.md) — precomputed
  metanode store replacing the serve-time DEM warp: paged mmapped
  orthometric `{flags, minZ, maxZ}` store paired with the flag tile
  index, unified one-pass tiling (subsumes the coverage-mask
  `mapproxy-tiling` redesign), warp kept as fallback; planetary
  bring-up measured; implemented 2026-06-12 (tileserver
  `feature/metanode-store`)
- RFC 3 [rfc03-draw-traversal.md](rfc03-draw-traversal.md) — unified
  recursive tile-tree traversal replacing the five legacy draw modes;
  client-side geographic mask compositing replacing server-side glues;
  watertight fast path, deferred-rectangle coverage, and
  edge-preserving erosion; implemented 2026-06-08
- RFC 6 [rfc06-map-frame.md](rfc06-map-frame.md) — moved the per-frame
  entry point onto typed `Map`: `MapDraw.drawMap` became `Map.draw`,
  `LegacyMap.update` became `Map.tick` with a residual
  `LegacyMap.tick`; implemented 2026-05-26
- RFC 5 [rfc05-remove-3dtiles.md](rfc05-remove-3dtiles.md) — removed the
  OGC 3D Tiles / VTS octree pipeline and the removable legacy tile
  shader family (`drawSubmesh`, `progTile*`); implemented 2026-05-23
- RFC 4 [rfc04-bump-bake.md](rfc04-bump-bake.md) — collapse bump layers
  into the normal map inside `TileRenderRig`, eliminating per-frame
  texture units, UBO slots, and shader iterations for each collapsed
  bump layer; implemented 2026-05-21
