# Implemented RFCs

Archive of RFCs whose implementation is complete. Newest first.

- [rfc-map-frame.md](rfc-map-frame.md) — moved the per-frame entry
  point onto typed `Map`: `MapDraw.drawMap` became `Map.draw`,
  `LegacyMap.update` became `Map.tick` with a residual
  `LegacyMap.tick`; implemented 2026-05-26
- [rfc-remove-3dtiles.md](rfc-remove-3dtiles.md) — removed the OGC
  3D Tiles / VTS octree pipeline and the removable legacy tile shader
  family (`drawSubmesh`, `progTile*`); implemented 2026-05-23
- [rfc-bump-bake.md](rfc-bump-bake.md) — collapse bump layers into the
  normal map inside `TileRenderRig`, eliminating per-frame texture
  units, UBO slots, and shader iterations for each collapsed bump layer;
  implemented 2026-05-21
