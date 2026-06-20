
import {globals as globals_} from './worker-globals.js';
import {parseMesh as parseMesh_} from './worker-mesh.js';


//get rid of compiler mess
var globals = globals_;
var parseMesh = parseMesh_;

var packedEvents = [];
var packedTransferables = [];

function postPackedMessage(message, transferables) {

    if (globals.config.mapPackLoaderEvents) {

        packedEvents.push(message);

        if (transferables) {
            packedTransferables = packedTransferables.concat(transferables);
        }

    } else {

        if (transferables) {
            postMessage(message, transferables);
        } else {
            postMessage(message);
        }

    }
}

function loadBinary(
    path, url, onLoaded, onError, withCredentials, xhrParams,
    responseType, kind, options, headers) {

    var xhr = new XMLHttpRequest();

    xhr.onreadystatechange = (function (){

        switch (xhr.readyState) {
        case 0 : // UNINITIALIZED
        case 1 : // LOADING
        case 2 : // LOADED
        case 3 : // INTERACTIVE
            break;
        case 4 : // COMPLETED
    
            if (xhr.status >= 400 || xhr.status == 0) {
                if (onError) {
                    postPackedMessage({'command' : 'on-error', 'path': path, 'status':xhr.status});
                }
                break;
            }
    
            var abuffer = xhr.response;
                    
            if (!abuffer) {
                if (onError) {
                    postPackedMessage({'command' : 'on-error', 'path': path});
                }
                break;
            }
    
            if (onLoaded) {
                if (kind == 'direct-texture') {
                    createImageBitmap(abuffer).then((function(bitmap){
                        postPackedMessage({'command' : 'on-loaded', 'path': path, 'data': bitmap, 'filesize': abuffer.size}, [bitmap]);                        
                    }).bind(this));
                } else if (kind == 'direct-mesh') {
                    var data = parseMesh(
                        {data:new DataView(abuffer), index:0}, options);
                    postPackedMessage({'command' : 'on-loaded', 'path': path, 'data': data.mesh}, data.transferables);
                } else {
                    postPackedMessage({'command' : 'on-loaded', 'path': path, 'data': abuffer}, [abuffer]);
                }
            }
    
            break;
    
        default:
    
            if (onError) {
                postPackedMessage({'command' : 'on-error', 'path': path});
            }
    
            break;
        }

    }).bind(this);
    
    /*
    xhr.onerror  = (function() {
        if (onError) {
            onError();
        }
    }).bind(this);*/

    xhr.open('GET', url, true);
    xhr.responseType = responseType ? responseType : 'arraybuffer';
    xhr.withCredentials = withCredentials;

    if (headers) {

        for (var key in headers) {
            xhr.setRequestHeader(key, headers[key]);
        }

    }

    if (options && options.size) {

        xhr.setRequestHeader(
            'Range',
            'bytes=' + options.offset + '-' + (options.offset + options.size));

    }

    xhr.send('');
};

self.onmessage = function (e) {
    var message = e.data;
    var command = message['command'];
    //var data = message['data'];

    //console.log("workeronmessage: " + command);

    switch(command) {

        case 'config':
            globals.config = message['data'];
            break;

        case 'tick':

            if (packedEvents.length > 0) {
                if (packedTransferables.length > 0) {
                    postMessage({'command': 'packed-events', 'messages':packedEvents}, packedTransferables);
                } else {
                    postMessage({'command': 'packed-events', 'messages':packedEvents});
                }
            }

            packedEvents = [];
            packedTransferables = [];

            break;

        case 'load-binary':
            loadBinary(
                message['path'], message['url'] || message['path'],
                true, true, message['withCredentials'],
                message['xhrParams'], message['responseType'],
                message['kind'], message['options'], message['headers']);
            break;

    }
};
