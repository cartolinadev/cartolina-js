# Glue alien flag

See `index.md` for the wiki table of contents.

## The problem

A glue G(A, B) covers the seam between surface A and surface B and is
stored once on disk. Both surface A's tile tree and surface B's tile
tree cover the seam area, so both need to consult G(A, B) when
selecting a tile source. The glue must therefore be reachable from
either side — but the sort priority in `surfaceSequence` depends on
which surface is the "primary" owner.

## Server side

When the server builds the aggregated (virtual surface) driver, it
embeds G(A, B)'s tile index into both constituent tilesets. The copy
embedded in the secondary tileset (the one that is not G's primary
owner) is marked with an `alien` bit in the tile-index flags:

```cpp
// aggregated.cpp:596
bool alien(glue.id.back() != tsg.tilesetId);
```

The server also writes a per-node `alien` bitflag into the metatile
bitplane for every node that belongs to an alien glue entry.

## Client side

`generateSurfaceSequence` (`surface-sequence.ts:103`) adds every glue
to `surfaceSequence` twice:

- **Proper** (`isAlien = false`): sorted under the primary surface's
  index, as if the glue belongs to that surface.
- **Alien** (`isAlien = true`): the primary surface's index is stripped
  from the sort key, so the entry sorts under the secondary surface
  instead.

The `isAlien` boolean is the second element of each
`[surface_or_glue, isAlien]` pair in `surfaceSequence`.

When `createVirtualMetanode` (`surface-tile.js:520`) picks a winner
among the overlapping entries for a seam tile, it requires the sequence
entry's alien flag to match the metanode's alien flag decoded from the
metatile bitplane:

```js
// surface-tile.js:534
if (alien != metanode.alien) {
    continue;
}
```

This ensures that each glue is evaluated only from the perspective it
was designed to serve. Without the check, a proper entry could win for
a tile that the server indexed as alien (or vice versa), producing
incorrect geometry selection at seams.
