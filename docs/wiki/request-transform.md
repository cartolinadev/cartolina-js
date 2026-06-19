# Request transform

`transformRequest(url, resourceType)` is the public request hook for
applications that need to rewrite resource URLs, attach request headers,
or choose a credentials mode. It follows the MapLibre GL JS pattern:
cartolina-js calls the callback before it loads an external resource,
and the callback returns the request fields cartolina-js should use.

The hook is accepted by both public constructors:

```ts
const viewer = cartolina.map({
    container: 'map',
    style,
    transformRequest(url, resourceType) {

        return { url };
    }
});
```

For legacy mapConfig usage:

```ts
const viewer = cartolina.browser('map', {
    map: 'https://example.com/mapConfig.json',
    transformRequest(url, resourceType) {

        return { url };
    }
});
```

## Callback Shape

The callback receives:

| Argument | Meaning |
|---|---|
| `url` | resolved resource URL |
| `resourceType` | category of the resource being requested |

It must return:

```ts
{
    url: string;
    headers?: Record<string, string>;
    credentials?: 'include' | 'same-origin' | 'omit';
}
```

`url` is required. `headers` and `credentials` are optional.

`credentials` is not a token or password value. It is a policy that
chooses whether cartolina-js should ask the web browser to attach
credentials the web browser already owns, such as cookies or HTTP
authentication state:

- `include` allows web-browser-managed credentials on this request,
  including cross-origin requests when the server permits them.
- `same-origin` allows web-browser-managed credentials only when the
  resource URL has the same origin as the application.
- `omit` asks the web browser not to send web-browser-managed
  credentials.

When `credentials` is omitted, cartolina-js keeps the default credential
behavior for the loader that is making the request.

To send an explicit token, add it to `headers` instead:

```ts
transformRequest(url) {

    return {
        url,
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'omit'
    };
}
```

## Resource Types

The `resourceType` value is one of:

| Type | Used for |
|---|---|
| `Style` | style JSON and legacy stylesheet JSON |
| `Tile` | metatiles, meshes, texture blobs, navtiles, geodata tiles |
| `Image` | image loads performed through `HTMLImageElement` |
| `Glyph` | binary font metadata and font atlas pages |
| `Source` | surface and bound-layer definition JSON |
| `MapConfig` | legacy map manifests and mapConfig-format surface definitions |
| `Other` | utility calls that do not identify a narrower type |

## Coverage

The hook is applied to:

- JSON loaded through `fetch()` or XHR
- binary tile, mesh, texture, metadata, geodata, and navtile loads
- HEAD checks before texture downloads
- image loads performed through `HTMLImageElement`
- glyph metadata and glyph atlas pages
- loader-worker requests

Loader-worker requests are transformed on the main thread before the
message is posted to the worker. The callback function itself is not
sent to workers because functions cannot be cloned by `postMessage`.

Headers are applied to XHR, Fetch, and worker XHR requests. Headers
returned for `HTMLImageElement` loads are ignored by the web browser
because that API cannot attach custom headers. Use URL rewriting or
server-side cookies for that path, or configure the map to load the
resource through an XHR-backed path where available.

## Authentication

Applications own token lifecycle. A typical integration stores the
current token in application state, refreshes it outside the render
loop, and reads the latest value inside `transformRequest`:

```ts
let token = '';

const viewer = cartolina.map({
    container: 'map',
    style,
    transformRequest(url) {

        return {
            url,
            headers: token ? { Authorization: `Bearer ${token}` } : {}
        };
    }
});
```

The callback is synchronous. Refresh tokens outside the callback and
keep the current value available to it.
