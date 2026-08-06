/*
 * config-store.test.js - focused ConfigStore scheduling invariants
 *
 * 1. Consumers retain one live values object.
 * 2. A watcher can reschedule itself for the next flush.
 * 3. Re-setting a value still requests a refresh.
 * 4. Unsubscribing during a flush prevents later delivery.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ConfigStore =
    require('../tmp/unit-build/src/config-store').default;


test('values keeps one live object', () => {

    const store = new ConfigStore({ a: 1 });
    const values = store.values;

    store.set({ a: 2 });

    assert.strictEqual(store.values, values);
    assert.strictEqual(values.a, 2);
});


test('a watcher can reschedule itself for the next flush', () => {

    const store = new ConfigStore({ a: 1 });
    const seen = [];

    store.watch(['a'], (values) => {

        seen.push(values.a);
        if (values.a === 10) store.set({ a: 20 });
    });

    store.set({ a: 10 });
    store.flush();
    store.flush();
    store.flush();

    assert.deepStrictEqual(seen, [10, 20]);
});


test('re-setting a value still requests a refresh', () => {

    const store = new ConfigStore({ a: 1 });
    let calls = 0;

    store.watch(['a'], () => calls++);
    store.set({ a: 1 });
    store.flush();

    assert.strictEqual(calls, 1);
});


test('unsubscribing during a flush prevents later delivery', () => {

    const store = new ConfigStore({ a: 1, b: 2 });
    const seen = [];
    let unsubscribeSecond;

    store.watch(['a'], (values) => {

        seen.push(['a', values.a]);
        unsubscribeSecond();
    });
    unsubscribeSecond =
        store.watch(['b'], (values) => seen.push(['b', values.b]));

    store.set({ a: 10, b: 20 });
    store.flush();

    assert.deepStrictEqual(seen, [['a', 10]]);
});
