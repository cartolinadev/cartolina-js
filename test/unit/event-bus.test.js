/*
 * event-bus.test.js - unit tests for src/core/event-bus.ts
 *
 * Run with `npm run test:unit`, which compiles the module under test
 * to tmp/unit-build before mocha executes this file.
 */

const assert = require('assert');

const EventBus =
    require('../../tmp/unit-build/src/core/event-bus').default;

describe('EventBus', function() {

    it('delivers the payload to every listener', function() {

        const bus = new EventBus();
        const seen = [];

        bus.on('a', (event) => seen.push(['first', event]));
        bus.on('a', (event) => seen.push(['second', event]));
        bus.emit('a', { value: 1 });

        assert.deepStrictEqual(seen, [
            ['first', { value: 1 }],
            ['second', { value: 1 }],
        ]);
    });

    it('dispatches only to listeners of the emitted name', function() {

        const bus = new EventBus();
        const seen = [];

        bus.on('a', () => seen.push('a'));
        bus.on('b', () => seen.push('b'));
        bus.emit('b', {});

        assert.deepStrictEqual(seen, ['b']);
    });

    it('emit with no listeners is a no-op', function() {

        const bus = new EventBus();
        bus.emit('a', {});
    });

    it('on() returns a working unsubscribe function', function() {

        const bus = new EventBus();
        let calls = 0;

        const unsubscribe = bus.on('a', () => calls++);
        bus.emit('a', {});
        unsubscribe();
        bus.emit('a', {});

        assert.strictEqual(calls, 1);
    });

    it('once() fires a single time and returns unsubscribe', function() {

        const bus = new EventBus();
        let calls = 0;

        bus.once('a', () => calls++);
        bus.emit('a', {});
        bus.emit('a', {});

        assert.strictEqual(calls, 1);

        let lateCalls = 0;
        const unsubscribe = bus.once('a', () => lateCalls++);
        unsubscribe();
        bus.emit('a', {});

        assert.strictEqual(lateCalls, 0);
    });

    it('a listener added during emit does not receive it', function() {

        const bus = new EventBus();
        let lateCalls = 0;

        bus.on('a', () => {
            bus.on('a', () => lateCalls++);
        });
        bus.emit('a', {});

        assert.strictEqual(lateCalls, 0);

        bus.emit('a', {});
        assert.strictEqual(lateCalls, 1);
    });

    it('a listener removed during emit still receives the snapshot',
        function() {

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

    it('a throwing once listener is still removed', function() {

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

    it('a throwing listener aborts the remaining listeners', function() {

        const bus = new EventBus();
        let secondCalls = 0;

        bus.on('a', () => {
            throw new Error('listener failure');
        });
        bus.on('a', () => secondCalls++);

        assert.throws(() => bus.emit('a', {}), /listener failure/);
        assert.strictEqual(secondCalls, 0);
    });
});
