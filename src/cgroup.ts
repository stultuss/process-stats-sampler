import fs from 'node:fs';
import * as os from 'node:os';

/**
 * Count CPUs listed in a cpuset value like "0-3,5" or "0,2".
 * Returns undefined when the value is empty or malformed.
 */
export function countCpuset(cpus: string): number | undefined {
    if (cpus.length === 0) {
        return undefined;
    }
    let count = 0;
    for (const part of cpus.split(',')) {
        const [startStr, endStr] = part.split('-');
        const start = Number(startStr);
        const end = endStr === undefined ? start : Number(endStr);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
            return undefined;
        }
        count += end - start + 1;
    }
    return count;
}

/**
 * Parse a cgroup v2 "quota period" line (e.g. "100000 100000" or "max 100000").
 * Returns quota / period (a fractional core count is preserved), or undefined
 * when the quota is unlimited ("max") or the line is malformed.
 */
export function parseCgroupV2Quota(text: string): number | undefined {
    const [quotaStr, periodStr] = text.trim().split(/\s+/);
    const quota = Number(quotaStr);
    const period = Number(periodStr);
    if (quota > 0 && period > 0) {
        return quota / period;
    }
    return undefined;
}

/**
 * Compute core count from cgroup v1 cfs quota/period values (microseconds).
 * Returns undefined when the quota is unlimited (-1) or values are malformed.
 */
export function cgroupV1Cores(quotaUs: string, periodUs: string): number | undefined {
    const quota = Number(quotaUs);
    const period = Number(periodUs);
    if (quota > 0 && period > 0) {
        return quota / period;
    }
    return undefined;
}

/**
 * Combine quota/cpuset/host limits into the binding constraint: the smallest
 * positive limit, falling back to the host core count when none is set.
 */
export function effectiveCores(limits: Array<number | undefined>, hostCores: number): number {
    const positive = limits.filter((n): n is number => n !== undefined && n > 0);
    return positive.length > 0 ? Math.min(...positive) : hostCores;
}

/**
 * Number of CPU cores effectively available to the process.
 *
 * On Linux this reads the cgroup CPU quota (v2 cpu.max / v1 cfs quota) and the
 * cpuset, and returns the binding constraint. Fractional quotas (e.g. 0.5 core
 * in Kubernetes) are preserved instead of being rounded away. Re-read on every
 * call so runtime changes (docker update, HPA) are picked up.
 */
export function getCpuCount(): number {
    const hostCores = os.cpus().length;
    if (process.platform !== 'linux') {
        return hostCores;
    }

    let quotaCores: number | undefined;
    try {
        // cgroup v2: /sys/fs/cgroup/cpu.max contains "quota period"
        quotaCores = parseCgroupV2Quota(fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8'));
    } catch {
        // not cgroup v2; try v1 below
    }
    if (quotaCores === undefined) {
        try {
            const quota = fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8');
            const period = fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8');
            quotaCores = cgroupV1Cores(quota, period);
        } catch {
            // no quota; fall through to cpuset
        }
    }

    let cpusetCores: number | undefined;
    for (const file of ['/sys/fs/cgroup/cpuset.cpus.effective', '/sys/fs/cgroup/cpuset/cpuset.cpus']) {
        try {
            cpusetCores = countCpuset(fs.readFileSync(file, 'utf8').trim());
            if (cpusetCores !== undefined) {
                break;
            }
        } catch {
            // try the next cpuset file
        }
    }

    return effectiveCores([quotaCores, cpusetCores], hostCores);
}
