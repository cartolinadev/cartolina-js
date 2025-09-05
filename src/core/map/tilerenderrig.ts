/*
 * tilerenderrig.ts - prepare and draw mesh tiles
 */

 /**
  * A tile render rig manages the render process for a specific tile (more
  * accuretly, for a tile submesh, but tiles with more than one submesh are
  * an oddity).
  *
  * It resolves and prepares the necessary resources for rendering, keeps track
  * of their availability (or readiness in vts terminology) and eventually,
  * draws the tile using MapMesh.draw2, after binding textures and setting all
  * the necessary uniforms and samplers.
  *
  * The rig is meant to be a replacement for a swath of old vts functionality,
  * mostly in MapDrawTiles.drawMeshTile, MapDrawTiles.updateTileBounds and
  * MapMesh.drawSubmesh. Unlike the old setup split across these methods,
  * the rig renders the tile always in a single pass, using a single, unified
  * shader, including optional atmospheric scattering, hence there is no "draw
  * command" sequence.
  *
  * The rig is self-contained in the sense that it can draw independently even
  * when/while the original tile changes.
  *
  * There are two types of draw readiness: full readiness (or simply readiness)
  * and fallback readiness. The fallback readiness is meant for a tile that is
  * meant to be a replacement for better (typically higher resolution) data.
  * This matters: not all data are made ready for the sake of fallback readiness.
  */

