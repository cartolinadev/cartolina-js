/*
 * event-bus.test.js - focused EventBus dispatch invariants
 *
 * 1. Listener changes take effect after the current dispatch snapshot.
 * 2. A one-time listener is removed before it runs.
 * 3. Listener exceptions abort dispatch and leave emit().
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const EventBus =
    require('../tmp/unit-build/src/map/event-bus').default;


test('listener removal takes effect after the current dispatch', () => {

    const bus = new EventBus();
    const seen = [];
    let unsubscribeSecond;

    bus.on('a', () => {

        seen.push('first');
        unsubscribeSecond();
    });
    unsubscribeSecond = bus.on('a', () => seen.push('second'));

    bus.emit('a', {});
    assert.deepStrictEqual(seen, ['first', 'second']);

    bus.emit('a', {});
    assert.deepStrictEqual(seen, ['first', 'second', 'first']);
});


test('a throwing one-time listener is already removed', () => {

    const bus = new EventBus();
    let calls = 0;

    bus.once('a', () => {

        calls++;
        throw new Error('listener failure');
    });

    assert.throws(() => bus.emit('a', {}), /listener failure/);
    bus.emit('a', {});

    assert.strictEqual(calls, 1);
});


test('a listener exception aborts dispatch and leaves emit', () => {

    const bus = new EventBus();
    let secondCalls = 0;

    bus.on('a', () => {

        throw new Error('listener failure');
    });
    bus.on('a', () => secondCalls++);

    assert.throws(() => bus.emit('a', {}), /listener failure/);
    assert.strictEqual(secondCalls, 0);
});
