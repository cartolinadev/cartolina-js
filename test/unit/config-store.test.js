/*
 * config-store.test.js - unit tests for src/core/config-store.ts
 *
 * Run with `npm run test:unit`, which compiles the module under test
 * to tmp/unit-build before mocha executes this file.
 */

const assert = require('assert');

const ConfigStore =
    require('../../tmp/unit-build/src/core/config-store').default;

describe('ConfigStore', function() {

    it('starts fully populated from the defaults', function() {

        const store = new ConfigStore({ a: 1, b: 'x' });

        assert.strictEqual(store.get('a'), 1);
        assert.strictEqual(store.get('b'), 'x');
    });

    it('does not mutate the defaults object', function() {

        const defaults = { a: 1 };
        const store = new ConfigStore(defaults);
        store.set({ a: 2 });

        assert.strictEqual(defaults.a, 1);
        assert.strictEqual(store.get('a'), 2);
    });

    it('get() reflects set() immediately, before any flush',
        function() {

        const store = new ConfigStore({ a: 1 });
        store.set({ a: 2 });

        assert.strictEqual(store.get('a'), 2);
        assert.strictEqual(store.values.a, 2);
    });

    it('values is a stable object identity across sets', function() {

        const store = new ConfigStore({ a: 1 });
        const view = store.values;
        store.set({ a: 2 });

        assert.strictEqual(store.values, view);
        assert.strictEqual(view.a, 2);
    });

    it('watchers fire on flush, not on set', function() {

        const store = new ConfigStore({ a: 1 });
        let calls = 0;

        store.watch(['a'], () => calls++);
        store.set({ a: 2 });

        assert.strictEqual(calls, 0);
        store.flush();
        assert.strictEqual(calls, 1);
    });

    it('several sets before a flush produce one callback', function() {

        const store = new ConfigStore({ a: 1, b: 2 });
        const seen = [];

        store.watch(['a', 'b'], (values) => seen.push(values));
        store.set({ a: 10 });
        store.set({ b: 20 });
        store.flush();

        assert.deepStrictEqual(seen, [{ a: 10, b: 20 }]);
    });

    it('a watcher receives only its watched keys', function() {

        const store = new ConfigStore({ a: 1, b: 2, c: 3 });
        const seen = [];

        store.watch(['a'], (values) => seen.push(values));
        store.set({ a: 10, b: 20 });
        store.flush();

        assert.deepStrictEqual(seen, [{ a: 10 }]);
    });

    it('a watcher of untouched keys does not fire', function() {

        const store = new ConfigStore({ a: 1, b: 2 });
        let calls = 0;

        store.watch(['b'], () => calls++);
        store.set({ a: 10 });
        store.flush();

        assert.strictEqual(calls, 0);
    });

    it('a watcher fires again only after another set', function() {

        const store = new ConfigStore({ a: 1 });
        let calls = 0;

        store.watch(['a'], () => calls++);
        store.set({ a: 2 });
        store.flush();
        store.flush();

        assert.strictEqual(calls, 1);

        store.set({ a: 3 });
        store.flush();
        assert.strictEqual(calls, 2);
    });

    it('setting the same value again still marks dirty', function() {

        const store = new ConfigStore({ a: 1 });
        let calls = 0;

        store.watch(['a'], () => calls++);
        store.set({ a: 1 });
        store.flush();

        assert.strictEqual(calls, 1);
    });

    it('undefined patch entries are ignored', function() {

        const store = new ConfigStore({ a: 1 });
        let calls = 0;

        store.watch(['a'], () => calls++);
        store.set({ a: undefined });
        store.flush();

        assert.strictEqual(store.get('a'), 1);
        assert.strictEqual(calls, 0);
    });

    it('watch() returns a working unsubscribe function', function() {

        const store = new ConfigStore({ a: 1 });
        let calls = 0;

        const unsubscribe = store.watch(['a'], () => calls++);
        store.set({ a: 2 });
        store.flush();
        unsubscribe();
        store.set({ a: 3 });
        store.flush();

        assert.strictEqual(calls, 1);
    });

    it('a set from inside a callback defers to the next flush',
        function() {

        const store = new ConfigStore({ a: 1, b: 2 });
        const seen = [];

        store.watch(['a'], (values) => {
            seen.push(['a', values.a]);
            if (values.a === 10) store.set({ b: 20 });
        });
        store.watch(['b'], (values) => seen.push(['b', values.b]));

        store.set({ a: 10 });
        store.flush();

        assert.deepStrictEqual(seen, [['a', 10]]);

        store.flush();
        assert.deepStrictEqual(seen, [['a', 10], ['b', 20]]);
    });

    it('a mid-flush write to a scheduled watcher that has not run '
        + 'yet is absorbed into one delivery', function() {

        const store = new ConfigStore({ a: 1, b: 2 });
        const seen = [];

        store.watch(['a'], (values) => {
            seen.push(['a', values.a]);
            store.set({ b: 20 });
        });
        store.watch(['b'], (values) => seen.push(['b', values.b]));

        // both watchers are dirty before the flush starts
        store.set({ a: 10, b: 19 });
        store.flush();

        assert.deepStrictEqual(seen, [['a', 10], ['b', 20]]);

        store.flush();
        assert.deepStrictEqual(seen, [['a', 10], ['b', 20]]);
    });

    it('a mid-flush write to a watcher that already ran fires once '
        + 'on the next flush', function() {

        const store = new ConfigStore({ a: 1, b: 2 });
        const seen = [];

        // registration order makes the b watcher run first
        store.watch(['b'], (values) => seen.push(['b', values.b]));
        store.watch(['a'], (values) => {
            seen.push(['a', values.a]);
            store.set({ b: 20 });
        });

        store.set({ a: 10, b: 19 });
        store.flush();

        assert.deepStrictEqual(seen, [['b', 19], ['a', 10]]);

        store.flush();
        assert.deepStrictEqual(
            seen, [['b', 19], ['a', 10], ['b', 20]]);

        store.flush();
        assert.deepStrictEqual(
            seen, [['b', 19], ['a', 10], ['b', 20]]);
    });

    it('a watcher unsubscribed during a flush is not invoked',
        function() {

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
});
