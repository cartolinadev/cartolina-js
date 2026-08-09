<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cartolinadev/assets/refs/heads/main/media/logo-composite-b.webp">
    <img alt="cartolina-js" src="https://raw.githubusercontent.com/cartolinadev/assets/refs/heads/main/media/logo-composite-w.webp">
  </picture>
</p>


`cartolina-js` is a library for authoring web-based 3D 
terrain maps. It's the primary frontend component of [cartolina](http://cartolina.dev/), 
an experimental software stack for web-based 3D terrain cartography. 

`cartolina-js` started as a fork of [vts-browser-js](https://github.com/melowntech/vts-browser-js/), 
which was authored and developed by Melown Technologies/Leica Geosystems in 
2017-2023 and which is now officially discontinued.  

Please refer to the [cartolina website](http://cartolina.dev/) for more information,
live examples, etc.

## Features


- interactive cartographic renditions of terrain data at arbitrary resolution and scale

- purely client-side, runtime fusion of different terrain data sources

- relief shading based on a native lighting model

- scale-dependent vertical exaggeration 

- bump-mapping based on satellite or aerial imagery

- background haze and foreground shadows

- sun glints based on land-cover classifications

- seamless support for high-latitude and polar regions

- arbitrary frames of reference, including extra-terrestrial bodies for planetary science

- point labels with well defined visual hierarchy 


## Usage

The library is an ES module, hosted at 

```
https://cdn.tspl.re/libs/cartolina/dist/current/
```

or, if you want to lock to a specific version

```
https://cdn.tspl.re/libs/cartolina/dist/<version>/
```

Place the following in the head section of your page

```html
<link rel="stylesheet" type="text/css" href="https://cdn.tspl.re/libs/cartolina/dist/current/cartolina.min.css" />
```

Then, in the body:

```html
<div id="map"></div>
<script type="module">
import { map as createMap } from 'https://cdn.tspl.re/libs/cartolina/dist/current/cartolina.min.esm.js';

let map = createMap({
    container: 'map',
    style: './style.json',
    position: ['obj', 15, 50, 'fix', 3313, -133, -25, 0.00, 33347, 45]
  });
  
</script>
```

A global/UMD build (`cartolina.min.js`, exposing `window.cartolina`)
is still published next to the ES module. It exists for deployments
that predate the ES module and is not the way to start a new
application; it will be withdrawn once those have migrated.

### Minimal map style

At a bare minimum, your `style.json` should include a terrain source and a terrain
definition referring to that source. Illumination definition is optional, but you 
probably want to use it in this context.

```json
{
    "version": 2,
    "sources": {
         "topoearth-copernicus-dem-glo30": {
              "type": "cartolina-surface",
               "url": "https://cdn.tspl.re/mapproxy/melown2015/surface/topoearth/copernicus-dem-glo30/",
         },
    },
    "terrain": {
        "sources": ["topoearth-copernicus-dem-glo30"]
    },
    "illumination": {
        "light": {
            "type": "tracking",
            "azimuth": 315,
            "elevation": 45
        }
    }
}
```

Use `"tracking"` for observer-relative lighting, or `"geographic"` for
lighting defined in the local north-east-down frame at the scene center.

<!-- ### NPM -->
<!-- add the npm section once it is tested to work -->

## Examples

See the usage examples on the [cartolina website](https://cartolina.dev/examples).

You may also examine the [demos](/demos) directory in this repository.


### Build from source

Clone this repository

```bash
git clone https://github.com/cartolinadev/cartolina-js.git 
```

then do

```bash
npm install
npm start
```

Point your web browser to [http://localhost:8080/demos/](http://localhost:8080/demos/)
to check the `cartolina-js` demos running directly off your working copy.

`cartolina-js` uses the webpack 5 module bundler, the `npm start` command runs 
the dev server with live reload enabled.

Once you're happy with your changes (if any), you can do  

```bash
npm run dist
```

to obtain the production builds of `cartolina-js`. Find them in 
the `./dist/<version>-branch.<short-hash>` directory.


## Documentation

For usage examples, refer to [this page](#usage) and to the
[examples on cartolina website](https://cartolina.dev/examples).

There is currently no API reference manual. Use the code's JSDoc
annotations for API details.

For architecture notes, subsystem details, and contributor-oriented project
knowledge, start with the [wiki index](docs/wiki/index.md).

Tileserver operator and implementation documentation starts at the
[cartolina-tileserver documentation index](https://github.com/cartolinadev/cartolina-tileserver/blob/main/docs/index.md).

As a last resort, use the legacy
[vts-browser-js documentation](https://github.com/melowntech/vts-browser-js/wiki).


## Tests

With the [devserver running](#build-from-source), you can manually compare the 
appearance of the map for predefined test map configurations by looking at
`http://localhost:8080/test/`.


There are also automatic performance regression tests based on Playwright. 

To run them, do

```bash
npm run test:perf:headed 
```

Afterwards, you can see the performance metrics at 
`http://localhost:8080/test/perf`.


## What's different from legacy vts-browser-js

Unlike its predecessor, which strived to be a general-purpose web-based 3D 
mapping engine, `cartolina-js` has a more narrow focus: cartographic 
3D terrain representation. 

To achieve the desired functionality, I made numerous changes to the 
original code and data design. Most importantly:

- the complex multi-component architecture has been radically simplified: there
  are now only two components, the
  [tileserver backend](https://github.com/cartolinadev/cartolina-tileserver)
  and this frontend

- a new API, using map styles (loosely inspired by Mapbox /
  MapLibre GL JS), has replaced the legacy map configurations. The
  legacy configurations are still supported through a separate
  compatibility endpoint

- the unwieldy server-side terrain merging pipeline has been retired
  and replaced by more flexible on-the-fly, client-side terrain fusion

These changes were feature-driven, but I have also tried to make the
code more modern. The new code (currently about 30% of the codebase)
is strict TypeScript, and the rendering engine is now WebGL2. Much of
the legacy tile-rendering pipeline has been redesigned and rewritten.

`cartolina-js` still retains a large part of the legacy
`vts-browser-js` codebase and some degree of backward compatibility.
The old vts-geospatial map configurations usually still work, or can
be ported easily. I make no guarantee that they will keep working and
have no incentive to maintain vts-geospatial compatibility in any
future release.

## Work in progress

`cartolina-js` is a work in progress. There are bugs and rough edges. There may 
be breaking changes to the API, to the runtime defaults etc. in future releases. 
Lock to the specific version you base your application on and test well before 
deploying or upgrading.

## How to contribute

Check out the [CONTRIBUTING.md](CONTRIBUTING.md) file.

## License

`cartolina-js` is open source under a permissive BSD 2-clause license. See
[LICENSE](LICENSE) for details.

See the `LICENSE` file for VTS Browser JS license, run `webpack` and check the
`build/3rdpartylicenses.txt` file for third-party licenses.
