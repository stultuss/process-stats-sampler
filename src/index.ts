import fs from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import {performance} from 'node:perf_hooks';

/** Maximum delay allowed by Node timers (~24.8 days); beyond this setTimeout fires immediately */
const MAX_TIMER_DELAY = 2_147_483_647;

/** Default lag probe wait in ms */
const DEFAULT_LAG_PROBE_MS = 1;

/**
 * Number of CPU cores available to the process.
 *
 * On Linux this reads the cgroup CPU quota first, so containerized
 * deployments report the allowed core count instead of the host's.
 */
const CPU_COUNT = getCpuCount();

/** Read a cgroup v2 "quota period" limit; returns undefined when unreadable or unlimited. */
function readCgroupLimit(file: string): number | undefined {
    try {
        const parts = fs.readFileSync(file, 'utf8').trim().split(/\s+/);
        const quota = Number(parts[0]);
        const period = Number(parts[1]);
        if (quota > 0 && period > 0) {
            return Math.max(1, Math.round(quota / period));
        }
    } catch {
        // file missing or unreadable; no cgroup limit visible
    }
    return undefined;
}

function getCpuCount(): number {
    const hostCores = os.cpus().length;
    if (process.platform !== 'linux') {
        return hostCores;
    }
    // cgroup v2: /sys/fs/cgroup/cpu.max contains "quota period" (quota may be "max")
    const v2 = readCgroupLimit('/sys/fs/cgroup/cpu.max');
    if (v2 !== undefined) {
        return v2;
    }
    // cgroup v1: quota and period live in separate files
    try {
        const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim());
        if (quota > 0) {
            const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim());
            if (period > 0) {
                return Math.max(1, Math.round(quota / period));
            }
        }
    } catch {
        // no cgroup limits; use host cores
    }
    return hostCores;
}

export type CpuUnit = 'ratio' | 'percent' | 'machine-percent';

export interface ProcessStatsSample {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
    /** CPU microseconds per actual wall-clock millisecond between samples; ~1000 for a fully utilized core */
    user: number;
    system: number;
    /** Event-loop execution delay probe in ms (0 when disabled) */
    lag: number;
    /** Epoch milliseconds when the sample was taken (captured before the lag probe) */
    timestamp: number;
}

export interface MonitorOptions {
    /**
     * Logger used to report sampling warnings.
     * Falls back to console.warn when missing or without a warn method.
     */
    logger?: {warn: (message: string) => void};
    /**
     * Called with runtime sampling errors (e.g. file I/O failures).
     * Without it, errors are only logged via `logger`; the promise never rejects.
     */
    onError?: (error: Error) => void;
    /**
     * CPU output unit:
     * - ratio (default): CPU microseconds / wall-clock milliseconds, ~1000 for a fully utilized core
     * - percent: percent of one core, a fully utilized core is 100
     * - machine-percent: percent of the whole machine (percent of one core / number of cores available to the process)
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
 * serialization queue, so sampling several targets in one process never pollutes
 * each other's CPU deltas.
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

function assertArgs(filename: string, interval: number, unit: CpuUnit): void {
    if (typeof filename !== 'string' || filename.trim().length === 0) {
        throw new TypeError(`filename must be a non-empty string, got ${JSON.stringify(filename)}`);
    }
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
        throw new TypeError(`interval must be a positive finite number (seconds), got ${interval}`);
    }
    if (unit !== 'ratio' && unit !== 'percent' && unit !== 'machine-percent') {
        throw new TypeError(`unit must be 'ratio' | 'percent' | 'machine-percent', got ${JSON.stringify(unit)}`);
    }
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
 */
function formatCpu(deltaUs: number, elapsedMs: number, unit: CpuUnit): number {
    if (elapsedMs <= 0) {
        return 0;
    }
    const ratio = deltaUs / elapsedMs;
    if (unit === 'percent') {
        return ratio / 10;
    }
    if (unit === 'machine-percent') {
        return ratio / 10 / CPU_COUNT;
    }
    return ratio;
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
     * same file, so an irregular call cadence does not distort the reading.
     *
     * @param {string} filename - output file path, defaults to /tmp/stats.log
     * @param {number} interval - kept for backward compatibility and validation; the CPU
     *                            rate is computed from real elapsed time, not this value
     * @param {MonitorOptions} options - optional configuration
     * @returns {Promise<void>}
     * @throws {TypeError} when filename is empty, interval is not positive, or unit/lag is invalid
     * @throws {RangeError} when interval or lag values are too large
     */
    public static async sample(filename: string = '/tmp/stats.log', interval: number = 30, options: MonitorOptions = {}): Promise<void> {
        const opts = options ?? {};
        const unit = opts.unit ?? 'ratio';
        assertArgs(filename, interval, unit);

        const ms = interval * 1000;
        if (!Number.isFinite(ms)) {
            throw new RangeError(`interval is too large, got ${interval}`);
        }

        const probeMs = normalizeLagOption(opts.lag ?? true);
        const loggerWarn = opts.logger?.warn;
        const warn = typeof loggerWarn === 'function' ? loggerWarn : console.warn;
        const onError = typeof opts.onError === 'function' ? opts.onError : undefined;

        const stream = getStream(filename);

        const run = async () => {
            try {
                const now = performance.now();
                const timestamp = Date.now();
                const preCPU = stream.lastCpuUsage ?? process.cpuUsage();
                const curCPU = process.cpuUsage();
                stream.lastCpuUsage = curCPU;
                const elapsedMs = stream.lastSampleTime === undefined ? 0 : now - stream.lastSampleTime;
                stream.lastSampleTime = now;

                const lagValue = probeMs > 0 ? await ProcessStatsSampler.lag(probeMs) : 0;
                const stats: ProcessStatsSample = {
                    ...process.memoryUsage(),
                    user: formatCpu(curCPU.user - preCPU.user, elapsedMs, unit),
                    system: formatCpu(curCPU.system - preCPU.system, elapsedMs, unit),
                    lag: lagValue,
                    timestamp,
                };

                await atomicWrite(filename, JSON.stringify(stats));
            } catch (e) {
                const error = e instanceof Error ? e : new Error(String(e));
                warn(error.message);
                onError?.(error);
            }
        };

        const task = stream.queue.then(run);
        stream.queue = task.catch(() => undefined);
        return task;
    }

    /**
     * @deprecated Use {@link ProcessStatsSampler.sample} instead. Kept as an alias for
     *             backward compatibility with v1.0.0.
     */
    public static async monitor(filename: string = '/tmp/stats.log', interval: number = 30, options: MonitorOptions = {}): Promise<void> {
        return ProcessStatsSampler.sample(filename, interval, options);
    }
}

/**
 * Convenience function alias with the same signature as ShellTools.monitor:
 * monitor('/tmp/stats.log', 30)
 *
 * @deprecated Use `sample` instead.
 */
export const monitor = ProcessStatsSampler.monitor;

/**
 * One-shot sample; preferred over `monitor`:
 * sample('/tmp/stats.log', 30)
 */
export const sample = ProcessStatsSampler.sample;

/**
 * Convenience function alias with the same signature as ShellTools.lag:
 * const delay = await lag(1000)
 */
export const lag = ProcessStatsSampler.lag;
