import fs from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import {performance} from 'node:perf_hooks';

/** Node 定时器允许的最大延迟（约 24.8 天），超过后 setTimeout 会立即触发 */
const MAX_TIMER_DELAY = 2_147_483_647;

/** 默认 lag 探测等待毫秒数 */
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
}

export interface MonitorOptions {
    /**
     * 采样失败时用于记录警告信息的 logger；
     * 未提供或缺少 warn 方法时自动降级到 console.warn
     */
    logger?: {warn: (message: string) => void};
    /**
     * CPU 输出单位：
     * - ratio（默认）: CPU 微秒 / 墙钟毫秒，单核满载约为 1000（与 Demo 行为一致）
     * - percent: 单核百分比，单核满载为 100
     * - machine-percent: 整机百分比（单核百分比 ÷ CPU 核数）
     */
    unit?: CpuUnit;
    /**
     * 是否在采样输出中记录 lag（事件循环延迟探测，与 lag() 同一语义）：
     * - true（默认）: 以 1ms 定时器探测事件循环执行延迟
     * - false: 不探测，lag 字段写 0
     * - number: 自定义探测等待毫秒数（正的有限数，最大约 24.8 天）
     */
    lag?: boolean | number;
}

/**
 * 上次采样时的 CPU 用量，作为本次差值的基线。
 * 首次调用时基线取当前 cpuUsage()，因此首次采样的 CPU 速率接近 0。
 */
let lastCpuUsage: NodeJS.CpuUsage | undefined;

/** 串行化采样队列，避免并发调用互相污染 CPU 基线与文件写入 */
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

/** 将 lag 选项归一化为探测毫秒数：false 为 0（不探测），true 为默认值 */
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
 * 原子写入：先写临时文件再 rename，进程中断时不会留下截断的目标文件。
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
     * 延迟测量：等待指定毫秒数，返回实际经过时间与预期时间的差值
     *
     * 用于检测 Node 事件循环的执行延迟：事件循环被同步任务阻塞时，
     * 定时器会晚触发，返回值即阻塞导致的延迟（毫秒）。
     *
     * @param {number} ms - 预期的延迟时间，默认为 1000 毫秒
     * @returns {Promise<number>} 实际延迟与预期延迟的差值（毫秒，>= 0）
     * @throws {TypeError} ms 不是非负有限数时
     * @throws {RangeError} ms 超过 Node 定时器上限（约 24.8 天）时
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
     * 采样 Node.js 进程内存与 CPU 使用情况，以 JSON 形式写入文件
     *
     * @param {string} filename - 输出文件路径，默认 /tmp/stats.log
     * @param {number} interval - 采样间隔（秒），用于计算 CPU 速率，默认 30
     * @param {MonitorOptions} options - 可选配置
     * @returns {Promise<void>}
     * @throws {TypeError} filename 为空、interval 非正数、unit 或 lag 非法时
     * @throws {RangeError} interval 或 lag 数值过大时
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
 * 便捷函数别名，用法与 ShellTools.monitor 一致：
 * monitor('/tmp/stats.log', 30)
 */
export const monitor = ProcessStatsSampler.monitor;

/**
 * 便捷函数别名，用法与 ShellTools.lag 一致：
 * const delay = await lag(1000)
 */
export const lag = ProcessStatsSampler.lag;
