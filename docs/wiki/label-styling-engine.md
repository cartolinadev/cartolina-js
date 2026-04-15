# Styling reference

This page collects non-obvious reference notes about the shared style
engine used for geodata labels and line decoration.

## Scope

The relevant implementation lives mainly in:

- `src/core/map/style.ts`
- `src/core/map/geodata-processor/worker-style.js`
- `src/core/map/geodata-processor/worker-linestring.js`
- `src/core/renderer/draw.js`

## Layer-family structure

In `src/core/map/style.ts`, both `LabelsLayer` and `LinesLayer` are
aliases of the same `LetteringLayerBase` type.

Practical consequence: `labels` and `lines` are not implemented as two
fully separate style systems. They share one broader lettering-oriented
property family, which is why line, point, icon, and label properties
appear together in one property block.

## Property values can be expressions

Properties such as `line-width` are declared as `Property<T>`, not just
as plain values.

Practical consequence: many styling fields can be driven by expression
objects instead of fixed constants.

## Default domain for `linear` and `discrete`

The worker evaluates plain `linear` and `discrete` expressions against
the current `lod` by default.

Practical consequence: this form is implicitly LOD-based:

```json
{
    "line-width": {
        "linear": [
            [4, 2],
            [15, 8]
        ]
    }
}
```

This is convenient, but not self-documenting. For readability, prefer
the explicit `linear2` / `discrete2` forms when the driver matters to
future readers.

## Explicit domain with `linear2` and `discrete2`

`linear2` and `discrete2` take the domain expression explicitly as the
first item and the stop list as the second item.

Example:

```json
{
    "line-width": {
        "linear2": [
            "#lod",
            [
                [4, 2],
                [15, 8]
            ]
        ]
    }
}
```

Practical consequence: use `linear2` when you want the style itself to
state clearly that a property is LOD-driven rather than relying on the
engine's implicit default.

## Built-in style variables relevant to scale

The style worker exposes several built-in values through `#...`
expressions, including:

- `#lod`
- `#pixelSize`
- `#metric`
- `#dpr`

Practical consequence: a property does not have to be driven by LOD
only. With `linear2` or `discrete2`, the driver can be another exposed
style value.

## `lod-scaled`

The expression engine supports a dedicated `lod-scaled` form:

```json
{
    "line-width": {
        "lod-scaled": [baseLod, baseValue, factor]
    }
}
```

If the middle item is numeric, the worker computes:

`baseValue * pow(2 * factor, baseLod - lod)`

If the middle item is a stop list, the worker first resolves the stops
and then applies the same extra LOD scaling.

Practical consequence: `lod-scaled` is a distinct helper for geometric
LOD-dependent scaling, not just a synonym for `linear`.

## `line-width` units

The line worker reads both:

- `line-width`
- `line-width-units`

Supported units are:

- `pixels`
- `meters`
- `ratio`

Practical consequence: width behavior depends on both the numeric value
and the unit mode. If a line does not seem to react to zoom or scale as
expected, inspect `line-width-units` before changing the expression.

## Textured line path

There is no dedicated numeric dash-array property analogous to
Mapbox's `line-dasharray`.

Instead, patterned geodata lines use a bitmap-repeated line style via:

- `line-style`
- `line-style-texture`
- `line-style-background`

When the line style is non-solid, the worker switches to one of the
textured line render-job variants and passes bitmap slice metadata to
the renderer, which then repeats the selected strip along the line.

Practical consequence: custom dash, dot, or dot-dash patterns are not
described numerically. They are authored as bitmap strips.

## `line-style` spelling mismatch

There is currently a type/runtime mismatch.

`src/core/map/style.ts` declares:

- `line-style: 'solid' | 'textured'`

But the runtime validator in `worker-style.js` accepts:

- `solid`
- `texture`

Practical consequence: styles currently need to use `"texture"` at
runtime even though the TypeScript declaration says `"textured"`.

## Shape of `line-style-texture`

`line-style-texture` is a three-item array:

- bitmap id
- vertical offset within the bitmap
- slice height

The worker resolves the bitmap id through the stylesheet `bitmaps`
table and passes the selected vertical strip to the renderer.

Practical consequence: a single bitmap can hold multiple horizontal
pattern strips stacked vertically, with the style selecting one strip
by offset and height.
