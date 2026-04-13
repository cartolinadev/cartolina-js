
import * as math from './math';
import {utilsUrl} from './url';


export const useCredentials = false;


export function validateBool(value: unknown, defaultValue: boolean) {
    if (typeof value === 'boolean') {
        return value;
    } else {
        return defaultValue;
    }
};


export function validateNumber(
    value: unknown, minValue: number,
    maxValue: number, defaultValue: number,
) {
    if (typeof value === 'number') {
        return math.clamp(value, minValue, maxValue);
    } else {
        return defaultValue;
    }
};


export function validateNumberArray(
    array: unknown, arraySize: number,
    minValues: number[], maxValues: number[], defaultValues: number[],
) {
    if (Array.isArray(array) && array.length == arraySize) {
        for (var i = 0; i < arraySize; i++) {
            array[i] = math.clamp(array[i], minValues[i], maxValues[i]);
        }
        return array;
    } else {
        return defaultValues;
    }
};


export function validateString(value: unknown, defaultValue: string) {
    if (typeof value === 'string') {
        return value;
    } else {
        return defaultValue;
    }
};


export function padNumber(n: number, width: number) {
    var z = '0';

    if (n < 0) {
        const s = String(-n);
        width--;
        return s.length >= width
            ? ('-' + s)
            : '-' + (new Array(width - s.length + 1).join(z) + s);
    } else {
        const s = String(n);
        return s.length >= width ? s : new Array(width - s.length + 1).join(z) + s;
    }
};


export function decodeFloat16(binary: number) {
    var exponent = (binary & 0x7C00) >> 10;
    var fraction = binary & 0x03FF;
    return (binary >> 15 ? -1 : 1) * (
        exponent ?
        (
            exponent === 0x1F ?
            fraction ? NaN : Infinity :
            Math.pow(2, exponent - 15) * (1 + fraction / 0x400)
        ) :
        6.103515625e-5 * (fraction / 0x400)
    );
};


export function simpleFmtObj(str: string, obj: Record<string, unknown>) {
    if (!str || str == '') {
        return '';
    }

    return str.replace(
        /{([$a-zA-Z0-9()][$a-zA-Z0-9()]*)}/g,
        (_s, match: string) => (match in obj ? String(obj[match]) : _s),
    );
};


export function simpleWikiLinks(str: string, plain: boolean) {
    if (!str || str == '') {
        return '';
    }

    var str2 = simpleFmtObj(
        str, {'copy':'&copy;', 'Y': (new Date().getFullYear())},
    );

    return str2.replace(/\[([^\]]*)\]/g, function(_s, match: string) {
        match  = match.trim();
        var urls = match.split(' ');//, 1);
        
        if (urls[0].indexOf('//') != -1) {
            if (plain) {
                if (urls.length > 1) {
                    return '' + match.substring(urls[0].length);
                } else {
                    return '' + urls[0];
                }
            } else {
                if (urls.length > 1) {
                    return '<a href=' + urls[0] + ' target="blank">' + match.substring(urls[0].length)+'</a>';
                } else {
                    return '<a href=' + urls[0] + ' target="blank">' + urls[0]+'</a>';
                }
            }
        }
        
        return match;
    });
}


export function simpleFmtObjOrCall(str: string, map: Record<string, unknown>,
  call?: (key: string) => string) {
  if (!str) return '';
  return str.replace(/\{([$A-Za-z_][\w$]*)\}/g, (_s, key) =>
    Object.prototype.hasOwnProperty.call(map, key)
      ? String(map[key])
      : call ? call(key) : `{${key}}`
  );
}

export function getABGRFromHexaCode(code: string) {
    var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(code);

    return result ?
    [ parseInt(result[4], 16),
        parseInt(result[3], 16),
        parseInt(result[2], 16),
        parseInt(result[1], 16)]
    : [0,0,0,255];
};


export function stringifyFunction(fn: (...args: any[]) => any) {
    // Stringify the code
    return '(' + fn + ').call(self);';
};


export function isPowerOfTwo(value: number) {
    return (value & (value - 1)) === 0 && value !== 0;
};


export function nearestPowerOfTwo(value: number) {
    return Math.pow(2, Math.round(Math.log(value) / Math.LN2));
};


export function fitToPowerOfTwo(value: number) {
    return Math.pow(2, Math.ceil(Math.log(value) / Math.LN2));
};


export function getHash(str: string) {
    if (!str || str.length === 0) {
        return 0;
    }

    var hash = 0, c: number;
    for (var i = 0, li = str.length; i < li; i++) {
        c   = str.charCodeAt(i);
        hash  = ((hash << 5) - hash) + c;
        hash |= 0; // Convert to 32bit integer
    }

    return hash;
};


export function convertRGB2YCbCr(r: number, g: number, b: number) {
  return [( .299 * r + .587 * g  +  0.114 * b) + 0,
          ( -.169 * r + -.331 * g +  0.500 * b) + 128,
          ( .500 * r + -.419 * g +  -0.081 * b) + 128];
};


export function convertYCbCr2RGB(y: number, cb: number, cr: number) {
  return [1 * y +  0 * (cb-128)      +  1.4 * (cr-128),
          1 * y +  -.343 * (cb-128)  +  -.711 * (cr-128),
          1 * y +  1.765 * (cb-128)  +  0 * (cr-128)];
};


export function convertHSL2RGB(h: number, s: number, l: number) {
    var r: number, g: number, b: number, m: number, c: number, x: number;

    h /= 60;
    if (h < 0) h = 6 - (-h % 6);
    h %= 6;

    s = Math.max(0, Math.min(1, s / 100));
    l = Math.max(0, Math.min(1, l / 100));

    c = (1 - Math.abs((2 * l) - 1)) * s;
    x = c * (1 - Math.abs((h % 2) - 1));

    if (h < 1) {
        r = c, g = x, b = 0;
    } else if (h < 2) {
        r = x, g = c, b = 0;
    } else if (h < 3) {
        r = 0, g = c, b = x;
    } else if (h < 4) {
        r = 0, g = x, b = c;
    } else if (h < 5) {
        r = x, g = 0, b = c;
    } else {
        r = c, g = 0, b = x;
    }

    m = l - c / 2
    
    return [(r + m),
            (g + m),
            (b + m)];
}


export function getHashColor(str: string) {
    var h = getHash(str);
    var c = convertRGB2YCbCr(h&255,(h>>8)&255,(h>>16)&255);
    c[0] = math.clamp(c[0], 50, 200);
    return convertRGB2YCbCr(c[0],c[1],c[2]);
};


export function getHashColor2(counter: number) {
    var h = Math.floor(counter / 18);
    var l = 50;

    if (h >= 1) {
        if (h % 2) {
            l = 50 + ((l * 10) % 30);
        } else {
            l = 50 - (((l-1) * 10) % 30);
        }
     }

    h = (counter % 18) * 20;

    return convertHSL2RGB(h,100,l);
};


type XhrParams = Record<string, string> | null | undefined;
type XhrCallback = ((data: any) => void) | null | undefined;
type XhrErrCallback = ((status?: number) => void) | null | undefined;
type HeadCallback =
    ((headers: string, status: number) => void) | null | undefined;

export function loadText(
    path: string, onLoaded: XhrCallback, onError: XhrErrCallback,
    withCredentials: boolean, xhrParams: XhrParams,
) {
    loadJSON(path, onLoaded, onError, true, withCredentials, xhrParams);
};


export function loadXML(
    path: string, onLoaded: XhrCallback, onError: XhrErrCallback,
    withCredentials: boolean, xhrParams: XhrParams,
) {
    const onLoaded2 = (data: string) => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(data, 'text/xml');
        if (onLoaded) {
            onLoaded(doc);
        }
    };

    loadJSON(path, onLoaded2, onError, true, withCredentials, xhrParams);
};


export async function loadJson(path: string) {

    let retval: unknown;

    try {

        let r = await fetch(path);
        if (!r.ok) throw new Error(`HTTP ${r.status}.`);
        retval = await r.json();

    } catch(err) {

        console.error(`Failed to load or parse ${path}:`, err);
        throw new Error();

    }

    return retval;
}

export function loadJSON(
    path: string, onLoaded: XhrCallback, onError: XhrErrCallback,
    skipParse: boolean, withCredentials: boolean, xhrParams: XhrParams,
) {
    var xhr = new XMLHttpRequest();

    xhr.onreadystatechange = () => {

        switch (xhr.readyState) {
        case 0 : // UNINITIALIZED
        case 1 : // LOADING
        case 2 : // LOADED
        case 3 : // INTERACTIVE
            break;
        case 4 : // COMPLETED

            if (xhr.status >= 400 || xhr.status == 0) {
                if (onError) {
                    onError(xhr.status);
                }
                break;
            }

            var data = xhr.response;
            var parsedData = data;

            if (!skipParse) {
                try {
                    parsedData = JSON.parse(data);
                } catch(e) {
                    // eslint-disable-next-line
                    const msg = e instanceof Error ? e.message : '';
                    console.log('JSON Parse Error ('+path+'): ' + msg);

                    if (onError) {
                        onError(xhr.status);
                    }

                    return;
                }
            }

            if (onLoaded) {
                onLoaded(parsedData);
            }

            break;
        }

    };

    /*
    xhr.onerror  = (function() {
        if (onError) {
            onError();
        }
    }).bind(this);*/

    xhr.open('GET',  path, true);
    xhr.withCredentials = withCredentials;
    
    if (xhrParams && xhrParams['token'] /*&& xhrParams["tokenHeader"]*/) {
        //xhr.setRequestHeader(xhrParams["tokenHeader"], xhrParams["token"]); //old way
        xhr.setRequestHeader('Accept', 'token/' + xhrParams['token'] + ', */*');
    }

    if (xhrParams && xhrParams['charset']) {
        xhr.overrideMimeType('text/xml; charset=' + xhrParams['charset']);
        //xhr.setRequestHeader('Content-type', xhrParams['Content-type']);
    }
    
    xhr.send('');
};


export function loadBinary(
    path: string, onLoaded: XhrCallback, onError: XhrErrCallback,
    withCredentials: boolean, xhrParams: XhrParams,
    responseType: XMLHttpRequestResponseType,
) {
    var xhr = new XMLHttpRequest();

    xhr.onreadystatechange = () => {

        switch (xhr.readyState) {
        case 0 : // UNINITIALIZED
        case 1 : // LOADING
        case 2 : // LOADED
        case 3 : // INTERACTIVE
            break;
        case 4 : // COMPLETED

            if (xhr.status >= 400 || xhr.status == 0) {
                if (onError) {
                    onError(xhr.status);
                }
                break;
            }

            var abuffer = xhr.response;

            if (!abuffer) {
                if (onError) {
                    onError();
                }
                break;
            }

            if (onLoaded) {
                onLoaded(abuffer);
            }

            break;

        default:

            if (onError) {
                onError();
            }

            break;
        }

    };
    
    /*
    xhr.onerror  = (function() {
        if (onError) {
            onError();
        }
    }).bind(this);*/

    xhr.open('GET', path, true);
    xhr.responseType = responseType ? responseType : 'arraybuffer';
    xhr.withCredentials = withCredentials;

    if (xhrParams && xhrParams['token'] /*&& xhrParams["tokenHeader"]*/) {
        //xhr.setRequestHeader(xhrParams["tokenHeader"], xhrParams["token"]); //old way
        xhr.setRequestHeader('Accept', 'token/' + xhrParams['token'] + ', */*');
    }

    xhr.send('');
};


export function headRequest(
    url: string, onLoaded: HeadCallback, onError: XhrErrCallback,
    withCredentials: boolean, xhrParams: XhrParams,
) {
    var xhr = new XMLHttpRequest();

    xhr.onreadystatechange = () => {

        switch (xhr.readyState) {
        case 0 : // UNINITIALIZED
        case 1 : // LOADING
        case 2 : // LOADED
        case 3 : // INTERACTIVE
            break;
        case 4 : // COMPLETED
            if (onLoaded != null) {
                onLoaded(xhr.getAllResponseHeaders(), xhr.status);
            }
            break;

        default:

            if (onError != null) {
                onError();
            }

            break;
        }

    };

    xhr.onerror = () => {
        if (onError != null) {
            onError();
        }
    };

    xhr.open('HEAD', url, true);
    //xhr.responseType = responseType ? responseType : "arraybuffer";
    xhr.withCredentials = withCredentials;

    if (xhrParams && xhrParams['token'] /*&& xhrParams["tokenHeader"]*/) {
        //xhr.setRequestHeader(xhrParams["tokenHeader"], xhrParams["token"]); //old way
        xhr.setRequestHeader('Accept', 'token/' + xhrParams['token'] + ', */*');
    }

    xhr.send('');
};


export function loadImage(
    url: string,
    onload: ((this: GlobalEventHandlers, ev: Event) => any) | null,
    onerror: OnErrorEventHandler,
    withCredentials: boolean,
    direct: boolean,
) {
    var image = new Image();
    image.onerror = onerror;
    image.onload = onload;

    if (!direct){
        image.crossOrigin = withCredentials ? 'use-credentials' : 'anonymous';
    }

    image.src = url;
    return image;
};


export function getParamsFromUrl(url: string) {
    return utilsUrl.getParamsFromUrl(url);
};


//var textDecoderUtf8 = null; //(typeof TextDecoder !== 'undefined') ? (new TextDecoder('utf-8')) : null;
var textDecoderUtf8 = (typeof TextDecoder !== 'undefined') ? (new TextDecoder('utf-8')) : null;

export function unint8ArrayToString(array: Uint8Array) {
    if (textDecoderUtf8) {
        return textDecoderUtf8.decode(array);
    } else {
//        return String.fromCharCode.apply(null, new Uint8Array(array.buffer));

        /*
        var buff = new Uint16Array(array.buffer, array.byteOffset, array.byteLength);
        var getChar = String.fromCharCode;
        //var buff2 = new Array(buff.length);
        var str = '';

        for (var i = 0, li = buff.length; i < li; i++) {
            //buff2[i] = getChar(buff[i]);
            str += getChar(buff[i]);
        }

        return str;
        //return buff2.join('');
        */

        var s = '';
        //var code_points2 = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        var code_points2 = new Uint8Array(array.byteLength);
        code_points2.set(array);
        var code_points = new Uint32Array(code_points2.buffer);

        for (var i = 0, li = code_points.length; i < li; ++i) {
          var cp = code_points[i];
          if (cp <= 0xFFFF) {
            s += String.fromCharCode(cp);
          } else {
            cp -= 0x10000;
            s += String.fromCharCode((cp >> 10) + 0xD800,
                                     (cp & 0x3FF) + 0xDC00);
          }
        }
        return s;

    }
}

/**
 * Log all parameterrs the fnction was called with, diagnostics tools
 */
export function log<T extends (...args: any[]) => any>(fn: T): T {
  return ((...args: Parameters<T>): ReturnType<T> => {
    const start = performance.now();
    console.log(fn.name || "<anonymous>", "called with:", ...args);
    const result = fn(...args);
    const duration = performance.now() - start;
    console.log(fn.name || "<anonymous>", "returned:", result, `(${duration.toFixed(2)} ms)`);
    return result;
  }) as T;
}

/**
 * A TypeScript method decorator, useful for diagnostics. Logs and times every
 * call. Put @log immediately before the definition of the method you want
 * logged to use it.
 */
export function Log(
  _target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor
) {
  const original = descriptor.value; // the method being decorated
  descriptor.value = function (...args: any[]) {
    const start = performance.now();
    console.log(`${propertyKey} called with:`, ...args);
    const result = original.apply(this, args);
    const duration = performance.now() - start;
    console.log(`${propertyKey} returned:`, result,
                `(${duration.toFixed(2)} ms)`);
    return result;
  };
}


/**
 * helper for logging of numerical tuples (tile id's)
 */

export function idToString(id: number[]): string {

    return id.join('-');
};

/**
 * test tuple (tile id) equivalence
 */

export function compareTuples<T>(a: T[], b: T[]) {

    return a.length === b.length && a.every((val, i) => val === b[i]);
}


// Simple global log once utility
export const warnOnce = (() => {

    const logged = new Set();  // Each call creates new closure

    return (message: string): void => {

        if (!logged.has(message)) {
            console.warn(message); logged.add(message);
        }
    };

})();

export const logOnce = (() => {

    const logged = new Set();  // Each call creates new closure

    return (message: string): void => {

        if (!logged.has(message)) {
            console.log(message); logged.add(message);
        }
    };

})();


export function isIos(): boolean {

    if (typeof navigator === "undefined") return false;

    const ua = navigator.userAgent || "";

    // Classic iPhone/iPad/iPod UA
    const classicIOS = /\b(iPad|iPhone|iPod)\b/i.test(ua);

    // iPadOS 13+ masquerades as Mac; touch points > 1 distinguishes it from real Macs
    // navigator.platform is deprecated but still the most reliable cross-browser signal here.
    const iPadOS13Plus =
        !classicIOS &&
        navigator.platform === "MacIntel" &&
        (navigator as any).maxTouchPoints > 1;

    return classicIOS || iPadOS13Plus;
}


