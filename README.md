<img width="320" alt="VTS Browser JS" src="https://github.com/cartolinadev/assets/blob/master/brand/cartolina-logo.png?raw=true">

# cartolina-js

**cartolina-js** is a TS/JS/WebGL2 library for authoring web-based 3D 
terrain maps. It's the primary frontend component of [cartolina](http://cartolina.dev/), 
an experimental software stack for web-based 3D terrain cartography. 

`cartolina-js` is a heavily divergent fork of [vts-browser-js](https://github.com/melowntech/vts-browser-js/), 
which was authored and developed by Melown Technologies/Leica Geosystems in 
2017-2023 and which is now officially discontinued.  

Please refer to the [cartolina](http://cartolina.dev/) website for more information,
live examples, etc.


## Features

- interactive cartographic renditions of DEMs at arbitrary resolution and scale

- hillshading based on a native lighting model

- scale-dependent vertical exaggeration 

- bump-mapping based on satelitte or aerial imagery

- background haze and foreground shadows

- sun glints based on land-cover classifications

- seamless support for high-latitude and polar regions

- arbitrary frames of reference, including extra-terrestrial bodies for planetary science

- point labels with well defined visual hierarchy 


## What's different from legacy vts-browser-js

Unlike its predecessor, which strived to be a general-purpose web-based 3D 
mapping engine, `cartolina-js` has a more narrow focus: cartographic 
3D terrain representation. 

To achieve the desired functionality, I made numerous changes to the 
original code and data design. These changes were feature-driven, byt I have 
also tried to make things more modern: I use TypeScript  and whenever possible, 
I made the long-verdue transition to WebGL2 for the new code and I redesigned 
much of the tile-rendering pipeline in the process. 

For better or worse `cartolina-js` retains large part of the old `vts-browser-js` 
codebase and some degree of backward compatibility. The old vts-geospatial 
map configurations *can* still work, though I make no guarantee that they will 
and have no desire to maintain backward compatibility in any future release.


## Usage

There is both a global/UMD and an ESM build hosted at 

```
https://cdn.tspl.re/libs/cartolina/dist/current/
```

or, if you prefer specific version

```
https://cdn.tspl.re/libs/cartolina/dist/<version>/
```

Place the following in the head section of your page

```html
<link rel="stylesheet" type="text/css" href="https://cdn.tspl.re/libs/cartolina/dist/current/cartolina.min.css" />
```

To use the ESM build (prefered), do:

```html
<div id="map"></div>
<script type="module">
import { map as createMap } from 'https://cdn.tspl.re/libs/cartolina/dist/current/cartolina.min.esm.js';

let map = createMap({
    container: 'map',
    style: './quickstart.json',
    position: ['obj', 15, 50, 'fix', 3313, -133, -25, 0.00, 33347, 45], 
    options: {
        controlFullscreen: true
    }
  });
  
</script>
```

To use the UMD build

```html
<script src="../../build/cartolina.js"/>

let map = cartolina.map({
    container: 'map',
    style: './quickstart.json',
    position: ['obj', 15, 50, 'fix', 3313, -133, -25, 0.00, 33347, 45], 
    options: {
        controlFullscreen: true
    }
  });
```

<!-- ### NPM -->
<!-- add the npm section once it is tested to work -->

## Examples

See the usage examples on the [cartolina website](https://cartolina.dev/examples).

You may also examine the [/demos] directory in this repository.


### Build from source

Clone this repository

```bash
git clone https://github.com/cartolinadev/cartolina-js.git 
```

then do

```
npm install
npm start
```

Point your web browser to [http://localhost:8080/demos/](http://localhost:8080/demos/)
check cartolina-js demos running directly of your repo.

`cartolina-js` uses the webpack5 module bundler, the `npm start` command runs 
the dev server with live reload enabled.

Once you're happy with your changes (if any), you can do  

```
npm run dist
```

to obtain both the UMD and ESM production builds of cartolina-js. Find them in 
the `./dist/<version>-branch.<short-hash>` directory.


## Documentation

There is currently no stand-alone documentation for the `cartolina-js` API. Refer
to [this page](#usage), to the [examples on cartolina website](https://cartolina.dev/examples) and to the code's JSDoc 
annotations. 

As a last resort, use the legacy [vts-browser-js documentation](https://github.com/melowntech/vts-browser-js/wiki)].


## Tests

With the [devserver running](#build-from-source), you can manually compare the 
appearance of the map for predefined test map configurations by looking at
`http://localhost:8080/test/`.


There are also automatic performane regression tests based on playwright, 

To run them, do

```bash
npm run test:perf:headed 
```

Afterwards, you can see the performance metrics at 
`http://localhost:8080/test/perf`.


## Work in progress

`cartolina-js` is a work in progress. There are bugs and rough edges. There may 
be breaking changes to the API, runtime defaults etc.in future releases. Stick 
to the specific version you base your application on and test well before 
deploying or upgrading.


## How to contribute

Check out the [CONTRIBUTING.md](CONTRIBUTING.md) file.

## License

`cartolina-js` is open source under a permissive BSD 2-clause license. See
[LICENSE](LICENSE) for details.

See the `LICENSE` file for VTS Browser JS license, run `webpack` and check the
`build/3rdpartylicenses.txt` file for 3rd party licenses.


```

