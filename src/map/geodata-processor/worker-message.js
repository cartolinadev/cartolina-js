
import {globals as globals_, stringToUint8Array as stringToUint8Array_ } from './worker-globals.js';

import * as vts from '../../constants';

//get rid of compiler mess
var globals = globals_, stringToUint8Array = stringToUint8Array_;
var packedEvents = [];
var packedTransferables = [];


function postPackedMessage(message, transferables) {

    if (globals.geodataJobId != null) {
        message['jobId'] = globals.geodataJobId;
    }

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


function postGroupMessageFast(command, type, message, buffers, signature) {

    var message2 = stringToUint8Array(JSON.stringify(message));
    var messageSize = 1+1+4+message2.byteLength, i, li;

    for (i = 0, li = buffers.length; i < li; i++) {
        messageSize += 4+buffers[i].byteLength;
    }

    var buff = new Uint8Array(messageSize);
    var view = new DataView(buff.buffer), index = 0, index2 = 0;

    view.setUint8(index, command); index += 1;
    view.setUint8(index, type); index += 1;
    view.setUint32(index, message2.byteLength); index += 4;
    buff.set(message2, index); index += message2.byteLength;
    index2 = index;

    for (i = 0, li = buffers.length; i < li; i++) {
        view.setUint32(index, buffers[i].length); index += 4;
        buff.set( new Uint8Array(buffers[i].buffer), index); index += buffers[i].byteLength;
    }

    postGroupMessageDirect(command, type, buff.buffer, index2, signature, message['hitable'], message['totalPoints'], (type == vts.WORKER_TYPE_LINE_LABEL) ? message : null);
}


function postGroupMessageLite(command, type, number) {
    var messageSize = 1+1+4, index = 0;

    var buff = new ArrayBuffer(messageSize);
    var view = new DataView(buff), index = 0;

    view.setUint8(index, command); index += 1;
    view.setUint8(index, type); index += 1;
    view.setUint32(index, (number ? number : 0)); index += 4;

    postGroupMessageDirect(command, type, buff, index, "");
}


function postGroupMessageDirect(command, type, message, buffersIndex, signature, hitable, totalPoints, job2) {

    if (globals.messageBufferIndex >= globals.messageBufferSize) { 
        var oldBuffer = globals.messageBuffer; 
        globals.messageBufferSize += 65536;
        globals.messageBuffer = new Array(globals.messageBufferSize);
        
        for (var i = 0, li = globals.messageBufferIndex; i < li; i++) {
            globals.messageBuffer[i] = oldBuffer[i];
        }
    }
    
    globals.messageBuffer[globals.messageBufferIndex] = { command: command, type: type, job : message, buffersIndex: buffersIndex, signature: signature, hitable: hitable, totalPoints: totalPoints, job2: job2 };
    globals.messageBufferIndex++;
    globals.messagePackSize += message.byteLength;
}


function optimizeGroupMessages() {

    //loop messages
    var messages = globals.messageBuffer;
    var j, lk, k, message2, bufferSize, buffer, view, index, length, count;


    for (var i = 0, li = globals.messageBufferIndex; i < li; i++) {
        var message = messages[i];
        var job = message.job;
        var type = message.type;
        var signature = message.signature;

        //console.log('command: ' + message.command + ' type:' + message.type);
        
        if (!message.hitable && !message.reduced && 
            (type >= vts.WORKER_TYPE_FLAT_LINE && type <= vts.WORKER_TYPE_POLYGON)) {
            
            switch(type) {
            case vts.WORKER_TYPE_POLYGON:
            case vts.WORKER_TYPE_FLAT_LINE:
                count = 0;
                var matches = [];

                //get message vertices length
                length = (new DataView(message.job)).getUint32(message.buffersIndex) * 4;
                bufferSize = length;

                for (j = i + 1; j < li; j++) {
                    message2 = messages[j];

                    if (message2.signature == signature) {
                        message2.reduced = true;
                        matches.push(message2);
                        count++;

                        //get message2 vertices length
                        length = (new DataView(message2.job)).getUint32(message2.buffersIndex) * 4;
                        bufferSize += length;
                    }
                }

                if (count > 0) {

                    //create new message with merged vertices
                    buffer = new Uint8Array(message.buffersIndex+2*(4+bufferSize));
                    view = new DataView(buffer.buffer);
                    buffer.set(new Uint8Array(message.job, 0, message.buffersIndex), 0);

                    view.setUint32(message.buffersIndex, bufferSize / 4);
                    index = message.buffersIndex + 4;
                    length = (new DataView(message.job)).getUint32(
                        message.buffersIndex) * 4;
                    buffer.set(new Uint8Array(
                        message.job, message.buffersIndex + 4, length), index);
                    index += length;

                    for (j = 0; j < matches.length; j++) {
                        message2 = matches[j];
                        length = (new DataView(message2.job)).getUint32(
                            message2.buffersIndex) * 4;
                        buffer.set(new Uint8Array(
                            message2.job, message2.buffersIndex + 4, length),
                        index);
                        index += length;
                    }

                    globals.messagePackSize -= message.job.byteLength;
                    globals.messagePackSize += buffer.byteLength;
                    message.job = buffer.buffer;
                }

                break;
                    
            case vts.WORKER_TYPE_PIXEL_LINE:
            case vts.WORKER_TYPE_LINE_LABEL:
            case vts.WORKER_TYPE_FLAT_RLINE:

                count = 0;
                matches = [];

                //get message vertices length
                length = (new DataView(message.job)).getUint32(message.buffersIndex);
                //console.log('count: ' + count + ' totalPoints:' + message.totalPoints + ' length: ' + length);
                length *= 4;
                bufferSize = length;

                for (j = i + 1; j < li; j++) {
                    message2 = messages[j];

                    if (message2.signature == signature) {
                        message2.reduced = true;
                        matches.push(message2);
                        globals.messagePackSize -= message2.job.byteLength;
                        count++;

                        //get message2 vertices length
                        length = (new DataView(message2.job)).getUint32(message2.buffersIndex);
                        length *= 4;
                        bufferSize += length;

                        if (type == vts.WORKER_TYPE_LINE_LABEL) {
                            var files = message.job2['files'];
                            var files2 = message2.job2['files'];

                            for (k = 0, lk = files2.length; k < lk; k++) {
                                if (!files[k]) {
                                    files[k] = [];
                                }

                                for (var m = 0, lm = files2[k].length; m < lm; m++) {
                                    if (files[k].indexOf(files2[k][m]) == -1) {
                                        files[k].push(files2[k][m]);
                                    }
                                }
                            }
                        }
                    }
                }

                if (count > 0) {

                    //create new message with merged vertices

                    if (type == vts.WORKER_TYPE_LINE_LABEL) { //we have to rebuild header
                        var buffjob = stringToUint8Array(JSON.stringify(message.job2));

                        buffer = new Uint8Array(1+1+4+buffjob.byteLength+2*(4+bufferSize));
                        view = new DataView(buffer.buffer), index = 0;

                        view.setUint8(index, message.command); index += 1;
                        view.setUint8(index, type); index += 1;
                        view.setUint32(index, buffjob.byteLength); index += 4;
                        buffer.set(buffjob, index); index += buffjob.byteLength;

                        message.buffersIndex = index;
                    } else {
                        buffer = new Uint8Array(message.buffersIndex+2*(4+bufferSize));
                        view = new DataView(buffer.buffer);
                        buffer.set(new Uint8Array(message.job, 0, message.buffersIndex), 0);
                    }

                    view.setUint32(message.buffersIndex, bufferSize / 4);
                    view.setUint32(message.buffersIndex + 4 + bufferSize, bufferSize / 4);

                    var vertexIndex = message.buffersIndex + 4;
                    var normalIndex = vertexIndex + bufferSize + 4;
                    var sources = [message].concat(matches);

                    for (j = 0; j < sources.length; j++) {
                        message2 = sources[j];
                        length = (new DataView(message2.job)).getUint32(
                            message2.buffersIndex) * 4;
                        buffer.set(new Uint8Array(
                            message2.job, message2.buffersIndex + 4, length),
                        vertexIndex);
                        buffer.set(new Uint8Array(
                            message2.job,
                            message2.buffersIndex + 8 + length,
                            length), normalIndex);
                        vertexIndex += length;
                        normalIndex += length;
                    }

                    globals.messagePackSize -= message.job.byteLength;
                    globals.messagePackSize += buffer.byteLength;
                    message.job = buffer.buffer;

                }

                break;
            }
        
        }
    }

    var buffer = new Uint8Array(globals.messagePackSize), index = 0;

    for (var i = 0, li = globals.messageBufferIndex; i < li; i++) {
        var message = globals.messageBuffer[i];

        if (!message.reduced) {
            buffer.set(new Uint8Array(message.job), index);
            index += globals.messageBuffer[i].job.byteLength;
        }

        messages[i] = null;
    }

    //console.log('send:' + buffer.length);

    postPackedMessage({'command' : 'addPackedCommands', 'buffer': buffer}, [buffer.buffer]);

    globals.messageBufferIndex = 0;
    globals.messagePackSize = 0;
} 


function postPackedMessages() {
    if (packedEvents.length > 0) {
        if (packedTransferables.length > 0) {
            postMessage({'command': 'packed-events', 'messages':packedEvents}, packedTransferables);
        } else {
            postMessage({'command': 'packed-events', 'messages':packedEvents});
        }

        packedEvents = [];
        packedTransferables = [];
    }
}


export {optimizeGroupMessages, postGroupMessageFast, postGroupMessageLite, postPackedMessage, postPackedMessages};
