# Testing notes

See `index.md` for the wiki table of contents.

This page records non-obvious test behaviour that can affect local
regression checks.

## Upstream Tile Source Failures

Some tileserver resource drivers, including `tms-normalmap` and
`tms-raster`, fetch tiles from remote GDAL sources such as WMS or WMTS
servers. When the upstream server returns a 500, the tileserver
propagates the failure. GDAL and the CDN cache cannot absorb it on the
first request.

cartolina-js handles these failures without crashing. For bump-map
layers, the tile renders without that layer. For diffuse layers, the
renderer falls back to a coarser tile.

Consequence for screenshot tests: a run after a long idle period can
report network fetch errors for affected tile URLs. These are upstream
availability failures, not cartolina-js regressions. The visual output
is degraded but structurally correct: terrain geometry and the primary
colour layer are unaffected. On a second run, CDN and GDAL caches are
usually warm and the errors disappear.

When a screenshot run reports network fetch errors, repeat the test
before treating the failure as a cartolina-js regression. Treat fetch
errors as regressions only when they persist across repeated runs.
