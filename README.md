# process-stats-sampler

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI][ci-image]][ci-url]

Samples the Node.js process's memory and CPU usage into a JSON file and measures the Node event-loop execution delay. `sample()` takes one snapshot; call it on your own schedule (e.g. with `setInterval`) to build a time series.

This library is maintained primarily for personal use, so compatibility
guarantees are pragmatic rather than semver-strict.

## Install

```bash
npm install process-stats-sampler
```

## Usage

```js
const {sample} = require('process-stats-sampler');

// Call every 30 seconds; the sample is written to /tmp/stats.json
await sample('/tmp/stats.json');
```

## ESM

The package ships both `require` and `import` entry points. They share the same module instance, so mixing both in one process is safe:

```js
import {sample, lag, reset} from 'process-stats-sampler';
```

## Measuring delay

```js
const {lag} = require('process-stats-sampler');

// Waits 1000ms and returns the difference between the actual and expected time (ms, >= 0)
const delay = await lag(1000);
```

`lag(ms = 1000)` measures the Node event-loop execution delay: when the event loop is blocked by synchronous work, timers fire late and the difference between the actual and expected elapsed time is the returned `delay`.

## API

### `sample(filename?, options?)`

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `filename` | `string` | `/tmp/stats.json` | Output JSON file path; parent directories are created automatically. Writes use a temp file + atomic rename. Each call overwrites the file with the latest sample |
| `options.unit` | `'ratio' \| 'percent' \| 'machine-percent'` | `'ratio'` | CPU output unit |
| `options.lag` | `boolean \| number` | `true` | Record lag (event-loop delay probe): `true` probes with 1ms, `false` skips the probe (field is 0), a number sets a custom probe duration in ms |

Invalid arguments (`filename` empty, invalid `unit`/`lag`, invalid `ms`) throw a `TypeError` / `RangeError`. Runtime failures (e.g. file I/O errors) reject the returned promise with the underlying `Error`.

#### CPU units

- `ratio` (default): CPU microseconds / wall-clock milliseconds between samples; a fully utilized core is about 1000
- `percent`: percent of one core; a fully utilized core is 100
- `machine-percent`: percent of the whole machine (percent of one core ÷ number of cores available to the process)

The `lag` field in the output is the event-loop execution delay probe (same semantics as `lag()`): each sample waits on a short timer; when the event loop is blocked by synchronous work the timer fires late, so the value is the current Node execution delay in ms (min 0). By default it probes with 1ms; use `options.lag` to disable it or set a custom probe duration.

### `lag(ms?)`

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `ms` | `number` | `1000` | Expected wait time in ms; a non-negative finite number up to ~24.8 days |

Returns the difference between the actual elapsed time and `ms` (ms, min 0).

Example output:

```json
{
  "rss": 41058304,
  "heapTotal": 16777216,
  "heapUsed": 8615928,
  "external": 863268,
  "arrayBuffers": 11358,
  "user": 0.25,
  "system": 0.06,
  "lag": 0,
  "timestamp": 1786320000000
}
```

## Behavior notes

- The CPU rate is the delta of `process.cpuUsage()` between two consecutive samples of the same file divided by the actual wall-clock elapsed time (via `performance.now()`). The first sample of a file is 0 because it only establishes the baseline, and an irregular call cadence does not distort the reading.
- The `timestamp`, the memory snapshot and the CPU counters are all captured at the start of the sample, before the lag probe, so they are aligned with each other.
- `user` and `system` are JSON numbers rounded to 3 decimals (CPU µs per ms of wall time, or a percentage per the chosen unit).
- Calls targeting the same file are serialized internally; different files run independently, each with its own CPU baseline and queue. Note that `process.cpuUsage()` is process-wide, so overlapping streams each report the whole process's CPU; per-target attribution requires separate processes.
- `machine-percent` derives the available core count on Linux from the cgroup CPU quota (v2 `cpu.max` / v1 `cfs_quota_us`) and the cpuset, taking the binding constraint and preserving fractional quotas (e.g. 0.5 core). It is re-read on every sample so runtime changes (`docker update`, HPA) are picked up. On other platforms it falls back to `os.cpus().length`.
- `reset(filename)` clears the sampling state (CPU baseline) for a file; the next sample starts fresh. State for each distinct filename is retained until reset, so callers using dynamic filenames should reset them when done.
- File writes are atomic (temp file + `rename`), so the target file is never left truncated. A hard kill between the write and the rename may leave an orphan temp file.
- The `lag` timer is not `unref()`ed, so a process with only a pending `lag` timer stays alive until it fires (this guarantees the promise always resolves).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## Development

```bash
npm run build   # compile to dist/
npm test        # build + run node:test tests
```

[npm-image]: https://img.shields.io/npm/v/process-stats-sampler.svg
[npm-url]: https://npmjs.org/package/process-stats-sampler
[downloads-image]: https://img.shields.io/npm/dm/process-stats-sampler.svg
[downloads-url]: https://npmjs.org/package/process-stats-sampler
[ci-image]: https://github.com/stultuss/process-stats-sampler/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/stultuss/process-stats-sampler/actions/workflows/ci.yml
