#!/usr/bin/env python3
"""
Convert the Playwright evaluate output from hitmap-vis (browser side) into
a 16-bit grayscale TIFF.

Usage:
    python3 scripts/hitmap-to-tiff.py <result-file> <output.tiff> [max_km]

Where <result-file> is the .txt file written by the Playwright MCP tool
when the hitmap-vis evaluate call exceeds the token limit, and max_km is
the depth range in kilometres (default 400).

The browser-side code to produce the result file:
    (function() {
        var map = window.__viewer.legacyMap_;
        map.renderer.lastHitmapCopyTime = 0;
        map.hitMapDirty = true;
        map.draw.drawHitmap();
        var r = map.renderer;
        var hw = r.hitmapWidth, hh = r.hitmapHeight;
        var data = r.hitmapData;
        var maxD = <max_km> * 1000;
        var out = new Uint16Array(hw * hh);
        for (var vy = 0; vy < hh; vy++) {
            var glY = hh - 1 - vy;
            for (var vx = 0; vx < hw; vx++) {
                var idx = (glY * hw + vx) * 4;
                var rv = data[idx], gv = data[idx+1],
                    bv = data[idx+2], av = data[idx+3];
                var di = vy * hw + vx;
                if (rv===255 && gv===255 && bv===255 && av===255) {
                    out[di] = 0;
                } else {
                    var d = rv*(1/255) + gv + bv*255 + av*65025;
                    out[di] = Math.round(65535 * Math.min(1, d / maxD));
                }
            }
        }
        var bytes = new Uint8Array(out.buffer);
        var str = '';
        for (var i = 0; i < bytes.length; i += 8192)
            str += String.fromCharCode.apply(null, bytes.subarray(i, i+8192));
        return {w: hw, h: hh, b64: btoa(str)};
    }())
"""
import sys, base64, re
import numpy as np
from PIL import Image

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    src, dst = sys.argv[1], sys.argv[2]
    txt = open(src).read()

    w = int(re.search(r'"w":\s*(\d+)', txt).group(1))
    h = int(re.search(r'"h":\s*(\d+)', txt).group(1))
    b64 = re.search(r'"b64":\s*"([A-Za-z0-9+/=]+)"', txt).group(1)

    raw = base64.b64decode(b64)
    pixels = np.frombuffer(raw, dtype='<u2').reshape(h, w)

    img = Image.fromarray(pixels, mode='I;16')
    img.save(dst)
    print(f'Saved {w}x{h} 16-bit TIFF to {dst}  '
          f'(min={pixels.min()} max={pixels.max()})')

if __name__ == '__main__':
    main()
