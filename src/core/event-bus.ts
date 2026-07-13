/*
 * event-bus.ts - typed publish/subscribe channel for map events
 */

/**
 * Typed event bus keyed by an event-map interface. `M` maps event
 * names to their payload types; `on`, `once`, and `emit` are checked
 * against it at compile time.
 *
 * Owned by `Map` (`src/core/map.ts`), which exposes `on`/`once` on
 * its public surface and hands the instance to the legacy emitters
 * (`LegacyMap`, `GpuDevice`) at construction.
 *
 * Dispatch semantics:
 *
 * - Listener sets are per event name; `emit` visits only listeners
 *   registered for the emitted name and returns immediately, with no
 *   allocation, when none are registered.
 * - `emit` iterates a snapshot of the listener set. Listeners added
 *   during the current emit do not receive it; listeners removed
 *   during the current emit are still called if they were in the
 *   snapshot.
 * - A `once` record is deleted before its listener runs, so a
 *   throwing listener does not prevent its own removal.
 * - A throwing listener aborts the remaining listeners in the same
 *   emit call; the exception propagates out of `emit`.
 */
class EventBus<M extends object> {

    private sets_: { [K in keyof M]?: Set<Record_<M[K]>> }
        = Object.create(null);

    /**
     * Subscribes to a named event.
     *
     * @param name event to subscribe to
     * @param fn invoked each time the event fires
     * @returns unsubscribe function
     */
    on<K extends keyof M & string>(
        name: K,
        fn: Listener<M[K]>,
    ): () => void {

        const set = (this.sets_[name] ??= new Set());
        const record: Record_<M[K]> = { listener: fn, once: false };
        set.add(record);
        return () => set.delete(record);
    }

    /**
     * Subscribes to a named event for a single invocation.
     *
     * @param name event to subscribe to
     * @param fn invoked once when the event fires
     * @returns unsubscribe function
     */
    once<K extends keyof M & string>(
        name: K,
        fn: Listener<M[K]>,
    ): () => void {

        const set = (this.sets_[name] ??= new Set());
        const record: Record_<M[K]> = { listener: fn, once: true };
        set.add(record);
        return () => set.delete(record);
    }

    /**
     * Fires all listeners registered for the named event.
     *
     * @param name event to fire
     * @param event payload passed to each listener
     */
    emit<K extends keyof M & string>(name: K, event: M[K]): void {

        const set = this.sets_[name];
        if (!set || set.size === 0) return;

        for (const record of [...set]) {

            if (record.once) set.delete(record);
            record.listener(event);
        }
    }
}


// Local non-exported types used by the class above.

type Listener<T> = (event: T) => void;

type Record_<T> = { listener: Listener<T>; once: boolean };


export default EventBus;
