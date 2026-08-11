import fs from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import {performance} from 'node:perf_hooks';

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
    user: string;
    system: string;
    lag: number;
    /** Epoch milliseconds when the sample was taken */
    timestamp: number;
}

export interface MonitorOptions {
    /**
     * Logger used to report sampling warnings.
     * Falls back to console.warn when missing or without a warn method.
     */
    logger?: {warn: (message: string) => void};
    /**
     * CPU output unit:
     * - ratio (default): CPU microseconds / wall-clock milliseconds, a fully utilized core is about 1000
     * - percent: percent of one core, a fully utilized core is 100
     * - machine-percent: percent of the whole machine (percent of one core / number of cores)
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
 * CPU usage at the previous sample, used as the baseline for the delta.
 * On the first call the baseline is the current cpuUsage(), so the first sample's CPU rate is near 0.
 */
let lastCpuUsage: NodeJS.CpuUsage | undefined;

/** Serialized sampling queue so concurrent calls never pollute CPU baselines or file writes */
let queue: Promise<void> = Promise.resolve();

function assertMonitorArgs(filename: string, interval: number, unit: CpuUnit): void {
    if (typeof filename !== 'string' || filename.trim().length === 0) {
        throw new TypeError(`monitor: filename must be a non-empty string, got ${JSON.stringify(filename)}`);
    }
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
        throw new TypeError(`monitor: interval must be a positive finite number (seconds), got ${interval}`);
    }
    if (unit !== 'ratio' && unit !== 'percent' && unit !== 'machine-percent') {
        throw new TypeError(`monitor: unit must be 'ratio' | 'percent' | 'machine-percent', got ${JSON.stringify(unit)}`);
    }
}

/** Normalize the lag option to a probe duration in ms: false -> 0 (no probe), true -> default */
function normalizeLagOption(lag: boolean | number): number {
    if (typeof lag === 'boolean') {
        return lag ? DEFAULT_LAG_PROBE_MS : 0;
    }
    if (typeof lag !== 'number' || !Number.isFinite(lag) || lag <= 0) {
        throw new TypeError(`monitor: options.lag must be a boolean or a positive finite number, got ${JSON.stringify(lag)}`);
    }
    if (lag > MAX_TIMER_DELAY) {
        throw new RangeError(`monitor: options.lag must not exceed ${MAX_TIMER_DELAY}, got ${lag}`);
    }
    return lag;
}

function formatCpu(deltaUs: number, ms: number, unit: CpuUnit): string {
    const ratio = deltaUs / ms;
    let value = ratio;
    if (unit === 'percent') {
        value = ratio / 10;
    } else if (unit === 'machine-percent') {
        value = ratio / 10 / os.cpus().length;
    }
    return value.toFixed(2);
}

/**
 * Atomic write: write to a temp file then rename, so an interrupted process
 * never leaves a truncated target file.
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
     * @param {string} filename - output file path, defaults to /tmp/stats.log
     * @param {number} interval - sampling interval in seconds used to compute the CPU rate, defaults to 30
     * @param {MonitorOptions} options - optional configuration
     * @returns {Promise<void>}
     * @throws {TypeError} when filename is empty, interval is not positive, or unit/lag is invalid
     * @throws {RangeError} when interval or lag values are too large
     */
    public static async monitor(filename: string = '/tmp/stats.log', interval: number = 30, options: MonitorOptions = {}): Promise<void> {
        const opts = options ?? {};
        const unit = opts.unit ?? 'ratio';
        assertMonitorArgs(filename, interval, unit);

        const ms = interval * 1000;
        if (!Number.isFinite(ms)) {
            throw new RangeError(`monitor: interval is too large, got ${interval}`);
        }

        const probeMs = normalizeLagOption(opts.lag ?? true);
        const loggerWarn = opts.logger?.warn;
        const warn = typeof loggerWarn === 'function' ? loggerWarn : console.warn;

        const run = async () => {
            try {
                const preCPU = lastCpuUsage ?? process.cpuUsage();
                const curCPU = process.cpuUsage();
                lastCpuUsage = curCPU;

                const lagValue = probeMs > 0 ? await ProcessStatsSampler.lag(probeMs) : 0;
                const stats: ProcessStatsSample = {
                    ...process.memoryUsage(),
                    user: formatCpu(curCPU.user - preCPU.user, ms, unit),
                    system: formatCpu(curCPU.system - preCPU.system, ms, unit),
                    lag: lagValue,
                    timestamp: Date.now(),
                };

                await atomicWrite(filename, JSON.stringify(stats));
            } catch (e) {
                warn(e instanceof Error ? e.message : String(e));
            }
        };

        const task = queue.then(run);
        queue = task.catch(() => undefined);
        return task;
    }
}

/**
 * Convenience function alias with the same signature as ShellTools.monitor:
 * monitor('/tmp/stats.log', 30)
 */
export const monitor = ProcessStatsSampler.monitor;

/**
 * Convenience function alias with the same signature as ShellTools.lag:
 * const delay = await lag(1000)
 */
export const lag = ProcessStatsSampler.lag;
