import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {getCpuCount} from './cgroup';

/** Maximum delay allowed by Node timers (~24.8 days); beyond this setTimeout fires immediately */
const MAX_TIMER_DELAY = 2_147_483_647;

/** Default lag probe wait in ms */
const DEFAULT_LAG_PROBE_MS = 1;

export type CpuUnit = 'ratio' | 'percent' | 'machine-percent';

export interface ProcessStatsSample {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
    /** CPU microseconds per actual wall-clock millisecond between samples (~1000 for a fully utilized core), rounded to 3 decimals */
    user: number;
    system: number;
    /** Event-loop execution delay probe in ms (0 when disabled) */
    lag: number;
    /** Epoch milliseconds when the sample was taken (captured before the lag probe) */
    timestamp: number;
}

export interface SampleOptions {
    /**
     * CPU output unit:
     * - ratio (default): CPU microseconds / wall-clock milliseconds, ~1000 for a fully utilized core
     * - percent: percent of one core, a fully utilized core is 100
     * - machine-percent: percent of the whole machine (percent of one core / cores available to the process)
     */
    unit?: CpuUnit;
    /**
     * Whether to record lag in the sample (event-loop delay probe, same semantics as lag()):
     * - true (default): probe event-loop execution delay with a 1ms timer
     * - false: skip the probe, the lag field is 0
     * - number: custom probe wait in ms (a positive finite number, up to ~24.8 days)
     */
    lag?: boolean | number;
}

/**
 * Per-file sampling state. Independent files keep their own CPU baseline and
 * serialization queue. State for a file is retained until `reset(filename)` is
 * called, so callers using dynamic filenames should reset them when done.
 */
interface StreamState {
    queue: Promise<void>;
    lastCpuUsage?: NodeJS.CpuUsage;
    lastSampleTime?: number;
}

const streams = new Map<string, StreamState>();

function getStream(filename: string): StreamState {
    const key = path.resolve(filename);
    let state = streams.get(key);
    if (state === undefined) {
        state = {queue: Promise.resolve()};
        streams.set(key, state);
    }
    return state;
}

/** Normalize the lag option to a probe duration in ms: false -> 0 (no probe), true -> default */
function normalizeLagOption(lag: boolean | number): number {
    if (typeof lag === 'boolean') {
        return lag ? DEFAULT_LAG_PROBE_MS : 0;
    }
    if (typeof lag !== 'number' || !Number.isFinite(lag) || lag <= 0) {
        throw new TypeError(`options.lag must be a boolean or a positive finite number, got ${JSON.stringify(lag)}`);
    }
    if (lag > MAX_TIMER_DELAY) {
        throw new RangeError(`options.lag must not exceed ${MAX_TIMER_DELAY}, got ${lag}`);
    }
    return lag;
}

/**
 * CPU rate: delta of process.cpuUsage() (microseconds) divided by the actual
 * wall-clock time between consecutive samples of the same file (milliseconds).
 * Output is a JSON number rounded to 3 decimals.
 */
function formatCpu(deltaUs: number, elapsedMs: number, unit: CpuUnit): number {
    if (elapsedMs <= 0) {
        return 0;
    }
    const ratio = deltaUs / elapsedMs;
    let value = ratio;
    if (unit === 'percent') {
        value = ratio / 10;
    } else if (unit === 'machine-percent') {
        value = ratio / 10 / getCpuCount();
    }
    return Number(value.toFixed(3));
}

/**
 * Atomic write: write to a temp file then rename, so the target file is never
 * left truncated by an interrupted process.
 */
async function atomicWrite(filename: string, data: string): Promise<void> {
    const dir = path.dirname(filename);
    await fs.promises.mkdir(dir, {recursive: true});

    const suffix = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = path.join(dir, `.${path.basename(filename)}.${suffix}.tmp`);
    try {
        await fs.promises.writeFile(tmp, data);
        await fs.promises.rename(tmp, filename);
    } catch (e) {
        await fs.promises.unlink(tmp).catch(() => undefined);
        throw e;
    }
}

export class ProcessStatsSampler {

    /**
     * Delay measurement: waits for the given milliseconds and returns the difference
     * between the actual and expected elapsed time.
     *
     * Measures the Node event-loop execution delay: when the event loop is blocked
     * by synchronous work, timers fire late and the return value is the delay (ms).
     *
     * @param {number} ms - expected wait time, defaults to 1000 ms
     * @returns {Promise<number>} difference between actual and expected delay (ms, >= 0)
     * @throws {TypeError} when ms is not a non-negative finite number
     * @throws {RangeError} when ms exceeds the Node timer limit (~24.8 days)
     */
    public static async lag(ms: number = 1000): Promise<number> {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
            throw new TypeError(`lag: ms must be a non-negative finite number, got ${ms}`);
        }
        if (ms > MAX_TIMER_DELAY) {
            throw new RangeError(`lag: ms must not exceed ${MAX_TIMER_DELAY}, got ${ms}`);
        }

        return new Promise((resolve) => {
            const start = performance.now();
            setTimeout(() => {
                resolve(Math.max(0, performance.now() - start - ms));
            }, ms);
        });
    }

    /**
     * Samples the Node.js process memory and CPU usage and writes it to a file as JSON.
     *
     * This is a one-shot sample; the caller decides when to call it (e.g. on a timer).
     * The CPU rate uses the actual wall-clock time between consecutive samples of the
     * same file, so an irregular call cadence does not distort the reading. Memory,
     * CPU and the timestamp are all captured at the start of the sample, before the
     * lag probe.
     *
     * @param {string} filename - output file path, defaults to /tmp/stats.json
     * @param {SampleOptions} options - optional configuration
     * @returns {Promise<void>} resolves when the sample is written; rejects with the
     *                          underlying Error on runtime failures (e.g. file I/O)
     * @throws {TypeError} when filename is empty or unit/lag is invalid
     * @throws {RangeError} when lag is too large
     */
    public static async sample(filename: string = '/tmp/stats.json', options: SampleOptions = {}): Promise<void> {
        const opts = options ?? {};
        const unit = opts.unit ?? 'ratio';
        if (typeof filename !== 'string' || filename.trim().length === 0) {
            throw new TypeError(`filename must be a non-empty string, got ${JSON.stringify(filename)}`);
        }
        if (unit !== 'ratio' && unit !== 'percent' && unit !== 'machine-percent') {
            throw new TypeError(`unit must be 'ratio' | 'percent' | 'machine-percent', got ${JSON.stringify(unit)}`);
        }

        const probeMs = normalizeLagOption(opts.lag ?? true);
        const stream = getStream(filename);

        const task = stream.queue.then(async () => {
            const now = performance.now();
            const timestamp = Date.now();
            const memory = process.memoryUsage();
            const preCPU = stream.lastCpuUsage ?? process.cpuUsage();
            const curCPU = process.cpuUsage();
            stream.lastCpuUsage = curCPU;
            const elapsedMs = stream.lastSampleTime === undefined ? 0 : now - stream.lastSampleTime;
            stream.lastSampleTime = now;

            const lagValue = probeMs > 0 ? await ProcessStatsSampler.lag(probeMs) : 0;
            const stats: ProcessStatsSample = {
                ...memory,
                user: formatCpu(curCPU.user - preCPU.user, elapsedMs, unit),
                system: formatCpu(curCPU.system - preCPU.system, elapsedMs, unit),
                lag: lagValue,
                timestamp,
            };

            await atomicWrite(filename, JSON.stringify(stats));
        });

        stream.queue = task.catch(() => undefined);
        return task;
    }

    /**
     * Clears the sampling state (CPU baseline and serialization queue) for a file.
     * The next sample for that file starts a fresh baseline.
     *
     * @param {string} filename - output file path whose state should be cleared
     */
    public static reset(filename: string): void {
        streams.delete(path.resolve(filename));
    }
}

/**
 * One-shot sample: sample('/tmp/stats.json', {unit: 'percent'})
 */
export const sample = ProcessStatsSampler.sample;

/**
 * Clears per-file sampling state: reset('/tmp/stats.json')
 */
export const reset = ProcessStatsSampler.reset;

/**
 * Convenience function alias with the same signature as ShellTools.lag:
 * const delay = await lag(1000)
 */
export const lag = ProcessStatsSampler.lag;
