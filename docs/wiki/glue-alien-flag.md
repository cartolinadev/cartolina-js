# Glue alien flag

See `index.md` for the wiki table of contents.

Background on VTS storage, the aggregated tileset driver, and how
virtual surfaces are produced and served is in
[vts-storage-and-virtual-surfaces.md](vts-storage-and-virtual-surfaces.md).

The `isAlien` flag is a glue-only concept. Plain surface entries in
`surfaceSequence` always carry `isAlien = false`; only glue entries ever
carry `isAlien = true`.


## Background

When multiple surfaces are active, all surfaces and all applicable glues
are assembled into one ordered list: `tree.surfaceSequence`. Each entry
is a pair `[surface_or_glue, isAlien]`. There is no per-surface tile
tree; there is one combined sequence for the whole view.

`generateSurfaceSequence` (`surface-sequence.ts:92`) adds each glue
twice:

- **Proper** (`isAlien = false`): sort key includes the numeric indices
  of all the glue's surfaces, so the entry sorts alongside the primary
  surface (the one whose ID is last in the glue's sorted `id` array).
- **Alien** (`isAlien = true`): the first element of the sort key is
  dropped, so the entry sorts alongside the secondary surface (the
  second-to-last in the `id` array) instead.

The server side also has an alien concept, though it works differently
than the client side. The aggregated tileset driver builds **one unified
tile index** by merging the tile indexes of all constituents (surfaces
and glues). For each glue, `addTileIndex` is called twice — once as
proper (`alien=false`) and once as alien (`alien=true`) — and the
combiner uses the alien flag to decide which call may claim a given tile
address:

```cpp
// aggregated.cpp:111
if (alien != TiFlag::isAlien(n)) {
    // different alien flag
    return o;
}
```

`n` here is the value from the constituent's own tile index. For
standalone glue tilesets, `TiFlag::isAlien(n)` is always false, so the
proper call (`alien=false`) claims all tiles and the alien call
(`alien=true`) claims none. The alien bit is routing metadata consumed
during the index merge; it is stripped from the output value written
into the unified index.

The metatile binary produced by the aggregated driver never carries the
alien flag. `MetaTile::update` (`metatile.cpp:860`) explicitly resets it
for every node it writes:

```cpp
outn.reset(MetaNode::Flag::alien);
```

Standalone tilesets (surfaces, glues) also never write this bit. The
binary format does have an alien flagplane and the save/load code
handles it correctly, but every version of `MetaTile::update` has
always zeroed the flag before the node is written to the output
metatile. No metatile binary with `alien=true` has ever been produced
by this codebase. `metanode.alien` is therefore always false regardless
of the server type.

The intended usage in `createVirtualMetanode` (`surface-tile.js:534`):

```js
if (alien != metanode.alien) {
    continue;
}
```

This was designed to match each sequence entry's `isAlien` against the
metatile node's alien bit, so that only the correctly-positioned copy of
a glue could win at a seam. It was never wired through: the aggregated
driver does not write the bit into metatile output, and standalone glue
metatiles do not carry it either.


## Why the mechanism is permanently dead

`metanode.alien` is always false. The binary format and the save/load
code support the flag, but every version of `MetaTile::update` has
always zeroed it before writing — so no metatile binary with
`alien=true` has ever been produced. Every alien sequence entry
(`isAlien = true`) therefore always fails the `alien != metanode.alien`
check and is skipped. The check is a no-op in both code paths, not just
in known deployments but in any deployment using any version of
vts-libs.

**Virtual surface path.** When a `mapConfig.virtualSurfaces` composite
matches the active surface set, `generateSurfaceSequence` replaces the
entire surface+glue list with a single entry and sets
`vsurfaceCount = 1` (`surface-sequence.ts:48`). The
`if (vsurfaceCount > 1)` guard at line 53 prevents any glue assembly,
so no alien entries are created. `createVirtualMetanode` is never
called; `sourceReference` in the metatile resolves the winning
constituent directly.

**Non-virtual path.** When no virtual surface matches (as in the
Benatky test config, which has two surfaces and one glue but
`virtualSurfaces: []`), the full sequence is assembled with proper and
alien glue entries, and `createVirtualMetanode` is called for seam
tiles. Metatile data comes from standalone glue servers. Standalone glue
metatiles never have the alien flagplane set, so `metanode.alien` is
always false. Every alien sequence entry is skipped; only proper and
plain surface entries can win.

The alien entries in the sequence and the alien bit check in
`createVirtualMetanode` are vestigial.
