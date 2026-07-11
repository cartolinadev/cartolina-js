/*
 * config-store.ts - typed observable key-value store for runtime config
 */

/**
 * Typed, observable key-value store. `T` enumerates the valid keys
 * and value types; for the runtime configuration this is
 * `ViewerConfig` (`src/core/viewer-config.ts`).
 *
 * The store holds no domain knowledge: it does not know what a key
 * means, which subsystem owns it, or what valid values are. Callers
 * write already-normalized values.
 *
 * Change notification is deferred: `set()` records which keys
 * changed and marks the watchers of those keys dirty; `flush()` —
 * called at the start of each render frame by the frame loop —
 * fires every dirty watcher once. Several keys set together
 * therefore produce a single callback per watcher, and no subsystem
 * reconfigures mid-frame. A watcher is marked dirty on every `set`
 * of one of its keys, whether or not the value differs.
 *
 * A `set()` from inside a callback delivers exactly one callback
 * per affected watcher: a watcher scheduled in the current flush
 * that has not run yet absorbs the write into its pending delivery;
 * a watcher that already ran (or is not scheduled) fires on the
 * next flush. Payloads carry the values current at delivery time.
 *
 * Reads are immediate: `get()` and `values` always return the
 * current value with no flush required, so construction-time reads
 * see every value written before the subsystem was built.
 */
class ConfigStore<T extends object> {

    private values_: T;

    private watchers_: Set<Watcher<T>> = new Set();

    /**
     * @param defaults initial value for every key; the store starts
     *   fully populated
     */
    constructor(defaults: T) {

        this.values_ = { ...defaults };
    }

    /**
     * Returns the current value of one key.
     */
    get<K extends keyof T>(key: K): T[K] {

        return this.values_[key];
    }

    /**
     * The live value map. Values change as `set()` is applied;
     * treat as read-only.
     */
    get values(): Readonly<T> {

        return this.values_;
    }

    /**
     * Applies a patch of already-normalized values and marks the
     * watchers of the patched keys dirty. Callbacks do not fire
     * here; they fire on the next `flush()`.
     */
    set(patch: Partial<T>): void {

        for (const key of Object.keys(patch) as (keyof T)[]) {

            const value = patch[key];
            if (value === undefined) continue;

            this.values_[key] = value as T[keyof T];

            for (const watcher of this.watchers_) {

                if (watcher.keys.has(key)) watcher.dirty = true;
            }
        }
    }

    /**
     * Subscribes to changes of the given keys. The callback fires on
     * the first `flush()` after any of the keys is set, and receives
     * the current values of all watched keys.
     *
     * @param keys keys to watch
     * @param fn invoked at flush time after any watched key was set
     * @returns unsubscribe function
     */
    watch<K extends keyof T>(
        keys: K[],
        fn: (values: Pick<T, K>) => void,
    ): () => void {

        const watcher: Watcher<T> = {
            keys: new Set<keyof T>(keys),
            fn: fn as (values: Partial<T>) => void,
            dirty: false,
        };

        this.watchers_.add(watcher);
        return () => this.watchers_.delete(watcher);
    }

    /**
     * Fires every dirty watcher once with the current values of its
     * watched keys. Each watcher's dirty mark is cleared at its own
     * invocation, so a `set()` from a callback is absorbed into the
     * pending delivery of a watcher that has not run yet and
     * re-schedules a watcher that already has — one callback per
     * change either way.
     */
    flush(): void {

        const scheduled: Watcher<T>[] = [];

        for (const watcher of this.watchers_) {

            if (watcher.dirty) scheduled.push(watcher);
        }

        for (const watcher of scheduled) {

            // dropped by an unsubscribe from an earlier callback
            if (!this.watchers_.has(watcher)) continue;

            watcher.dirty = false;

            const picked: Partial<T> = {};
            for (const key of watcher.keys)
                picked[key] = this.values_[key];

            watcher.fn(picked);
        }
    }
}


// Local non-exported types used by the class above.

type Watcher<T> = {
    keys: Set<keyof T>;
    fn: (values: Partial<T>) => void;
    dirty: boolean;
};


export default ConfigStore;
