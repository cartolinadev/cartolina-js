/*
 * frame-profiler.ts - measure per-frame render cost (cpu, gpu, gl counts)
 */

import type { GpuDevice } from '../renderer/gpu/device';


/**
 * Measures the cost of frames that actually draw and reports robust
 * medians over the last N drawn frames.
 *
 * One sample is recorded per dirty frame (`beginFrame`/`endFrame` bracket
 * `Map.draw`): main-thread draw time, draw-call and framebuffer-switch
 * counts (read as deltas from `GpuDevice`), and — when GPU profiling is
 * enabled — GPU execution time via `EXT_disjoint_timer_query_webgl2`.
 *
 * Samples live in fixed-size ring buffers indexed by drawn frame, not by
 * wall time, so a read taken while the map is idle still reflects the last
 * real rendering rather than emptying. `result()` reports medians plus an
 * `ageMs` so a stale (idle) reading is recognisable. There is no realized
 * frame-interval "physical fps" — that is undefined at rest; `limitFps` is
 * the upper bound the per-frame cost allows.
 */
class FrameProfiler {

    private readonly device_: GpuDevice;
    private readonly cpuMs_: Ring;
    private readonly gpuMs_: Ring;
    private readonly drawCalls_: Ring;
    private readonly fboSwitches_: Ring;

    private gpuEnabled_ = false;
    private timerExt_: TimerExtension | null = null;
    private timerInited_ = false;
    private activeQuery_: WebGLQuery | null = null;
    private readonly pendingQueries_: WebGLQuery[] = [];

    private frameStart_ = 0;
    private drawCallsBase_ = 0;
    private fboSwitchesBase_ = 0;
    private lastSampleTime_ = 0;

    /**
     * @param device GPU device whose draw/framebuffer counters and gl
     *     context the profiler reads.
     * @param windowSize Number of recent drawn frames each metric keeps.
     */
    constructor(device: GpuDevice, windowSize = 120) {

        this.device_ = device;
        this.cpuMs_ = new Ring(windowSize);
        this.gpuMs_ = new Ring(windowSize);
        this.drawCalls_ = new Ring(windowSize);
        this.fboSwitches_ = new Ring(windowSize);
    }

    /** Turn GPU timer-query measurement on or off. */
    setGpuEnabled(enabled: boolean): void {

        this.gpuEnabled_ = enabled;
    }

    /** Snapshot counters and start the frame's CPU/GPU timing. */
    beginFrame(): void {

        this.frameStart_ = performance.now();
        this.drawCallsBase_ = this.device_.drawCallCount;
        this.fboSwitchesBase_ = this.device_.fboSwitchCount;

        const ext = this.timerExtension();
        if (this.gpuEnabled_ && ext && !this.activeQuery_) {

            const query = this.device_.gl.createQuery();
            if (query) {

                this.device_.gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
                this.activeQuery_ = query;
            }
        }
    }

    /** Close the frame, record one sample, and poll finished GPU queries. */
    endFrame(): void {

        const now = performance.now();

        this.cpuMs_.push(now - this.frameStart_);
        this.drawCalls_.push(this.device_.drawCallCount - this.drawCallsBase_);
        this.fboSwitches_.push(
            this.device_.fboSwitchCount - this.fboSwitchesBase_);
        this.lastSampleTime_ = now;

        // End a query begun this frame even if GPU profiling was just
        // turned off, so the context is never left mid-query.
        const ext = this.timerExt_;
        if (ext && this.activeQuery_) {

            this.device_.gl.endQuery(ext.TIME_ELAPSED_EXT);
            this.pendingQueries_.push(this.activeQuery_);
            this.activeQuery_ = null;
        }

        this.collectQueries();
    }

    /** Median render cost and counts over the last N drawn frames. */
    result(): FrameProfiler.Result {

        const cpu = this.cpuMs_.stats();
        const gpu = this.gpuMs_.stats();
        const gpuAvailable =
            this.gpuEnabled_ && !!this.timerExt_ && gpu.count > 0;

        const renderMs = Math.max(cpu.median, gpuAvailable ? gpu.median : 0);

        return {
            cpuMs: { median: cpu.median, p90: cpu.p90 },
            gpuMs: { median: gpu.median, p90: gpu.p90, available: gpuAvailable },
            drawCalls: Math.round(this.drawCalls_.stats().median),
            fboSwitches: Math.round(this.fboSwitches_.stats().median),
            renderMs,
            limitFps: renderMs > 0 ? 1000 / renderMs : null,
            samples: cpu.count,
            ageMs: this.lastSampleTime_
                ? performance.now() - this.lastSampleTime_
                : Infinity,
        };
    }

    /** Lazily fetch the timer extension once; null when unsupported. */
    private timerExtension(): TimerExtension | null {

        if (!this.timerInited_) {

            this.timerInited_ = true;
            this.timerExt_ = this.device_.gl.getExtension(
                'EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
        }

        return this.timerExt_;
    }

    /** Record results from finished queries; drop a disjoint batch. */
    private collectQueries(): void {

        const gl = this.device_.gl;
        const ext = this.timerExt_;
        if (!ext) return;

        // A disjoint event (e.g. GPU clock change) invalidates every
        // in-flight result, so the whole backlog is dropped.
        if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {

            for (const query of this.pendingQueries_) gl.deleteQuery(query);
            this.pendingQueries_.length = 0;
            return;
        }

        while (this.pendingQueries_.length) {

            const query = this.pendingQueries_[0];
            const ready = gl.getQueryParameter(
                query, gl.QUERY_RESULT_AVAILABLE);

            if (!ready) break;

            const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
            gl.deleteQuery(query);
            this.pendingQueries_.shift();
            this.gpuMs_.push(ns / 1e6);
        }

        // Bound the backlog if results never arrive (driver hiccup).
        while (this.pendingQueries_.length > 32) {

            gl.deleteQuery(this.pendingQueries_.shift()!);
        }
    }
}


/** The two constants this profiler needs from the timer-query extension. */
type TimerExtension = {
    TIME_ELAPSED_EXT: GLenum;
    GPU_DISJOINT_EXT: GLenum;
};


/** Fixed-capacity circular buffer of samples; no per-frame allocation. */
class Ring {

    private readonly data_: Float64Array;
    private head_ = 0;
    count = 0;

    constructor(capacity: number) {

        this.data_ = new Float64Array(capacity);
    }

    push(value: number): void {

        this.data_[this.head_] = value;
        this.head_ = (this.head_ + 1) % this.data_.length;
        if (this.count < this.data_.length) this.count++;
    }

    /** Median and 90th percentile over the filled samples. */
    stats(): { median: number; p90: number; count: number } {

        if (this.count === 0) return { median: 0, p90: 0, count: 0 };

        // Valid samples occupy [0, count): before the buffer fills the
        // head has not wrapped, and once full count equals the capacity.
        const sorted = Array.from(this.data_.subarray(0, this.count))
            .sort((a, b) => a - b);

        return {
            median: percentile(sorted, 0.5),
            p90: percentile(sorted, 0.9),
            count: this.count,
        };
    }
}


/** Linearly-interpolated percentile of a pre-sorted array. */
function percentile(sorted: number[], fraction: number): number {

    const index = (sorted.length - 1) * fraction;
    const low = Math.floor(index);
    const high = Math.ceil(index);

    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}


namespace FrameProfiler {

    export type Result = {
        cpuMs: { median: number; p90: number };
        gpuMs: { median: number; p90: number; available: boolean };
        drawCalls: number;
        fboSwitches: number;
        renderMs: number;
        limitFps: number | null;
        samples: number;
        ageMs: number;
    };
}


export default FrameProfiler;
