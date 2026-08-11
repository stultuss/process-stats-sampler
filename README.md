# process-stats-sampler

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI][ci-image]][ci-url]

Samples the Node.js process's memory and CPU usage into a JSON file and measures the Node event-loop execution delay. `sample()` takes one snapshot; call it on your own schedule (e.g. with `setInterval`) to build a time series.

## Install

```bash
npm install process-stats-sampler
```

## Usage

```js
const {ProcessStatsSampler} = require('process-stats-sampler');

// Call every 30 seconds; the sample is written to /tmp/stats.log
await ProcessStatsSampler.sample('/tmp/stats.log', 30);
```

`monitor` is kept as a deprecated alias with the same signature:

```js
const {monitor} = require('process-stats-sampler');

await monitor('/tmp/stats.log', 30);
```

## Measuring delay

```js
const {lag} = require('process-stats-sampler');

// Waits 1000ms and returns the difference between the actual and expected time (ms, >= 0)
const delay = await lag(1000);
```

`lag(ms = 1000)` measures the Node event-loop execution delay: when the event loop is blocked by synchronous work, timers fire late and the difference between the actual and expected elapsed time is the returned `delay`.

## API

### `sample(filename?, interval?, options?)`

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `filename` | `string` | `/tmp/stats.log` | Output JSON file path; parent directories are created automatically. Writes use a temp file + atomic rename. Each call overwrites the file with the latest sample |
| `interval` | `number` | `30` | Kept for backward compatibility and validation only; the CPU rate uses the actual elapsed time between calls, so an irregular cadence does not distort the reading. Must be a positive finite number |
| `options.logger` | `{warn: (message: string) => void}` | `console` | Logger for sampling warnings; falls back to `console` when `warn` is missing |
| `options.onError` | `(error: Error) => void` | — | Called with runtime sampling errors (e.g. file I/O failures). Without it, errors are only logged via `logger`; the promise never rejects |
| `options.unit` | `'ratio' \| 'percent' \| 'machine-percent'` | `'ratio'` | CPU output unit |
| `options.lag` | `boolean \| number` | `true` | Record lag (event-loop delay probe): `true` probes with 1ms, `false` skips the probe (field is 0), a number sets a custom probe duration in ms |

`monitor(filename?, interval?, options?)` is a deprecated alias of `sample()` with the same signature.

#### CPU units

- `ratio` (default): CPU microseconds / wall-clock milliseconds between samples; a fully utilized core is about 1000
- `percent`: percent of one core; a fully utilized core is 100
- `machine-percent`: percent of the whole machine (percent of one core ÷ number of cores available to the process). On Linux the core count respects the cgroup CPU quota, so container deployments report the allowed cores instead of the host's

The `lag` field in the output is the event-loop execution delay probe (same semantics as `lag()`): each sample waits on a short timer; when the event loop is blocked by synchronous work the timer fires late, so the value is the current Node execution delay in ms (min 0). By default it probes with 1ms; use `options.lag` to disable it or set a custom probe duration.

Invalid arguments (`filename` empty, `interval` non-positive, invalid `unit`/`lag`, invalid `ms`) throw a `TypeError` / `RangeError`; runtime errors such as file I/O failures are reported through `logger.warn` and `options.onError` and never reject the caller.

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

- The CPU rate is the delta of `process.cpuUsage()` between two consecutive samples of the same file divided by the actual wall-clock elapsed time (via `performance.now()`). The first sample of a file is 0 because it only establishes the baseline.
- The `timestamp` field (epoch milliseconds) is captured at the start of the sample, before the lag probe, so it aligns with the memory and CPU readings.
- `user` and `system` are JSON numbers (CPU µs per ms of wall time, or a percentage per the chosen unit).
- Calls targeting the same file are serialized internally; different files are independent and each keeps its own CPU baseline, so sampling several targets in one process does not pollute the readings.
- File writes are atomic (temp file + `rename`), so the target file is never left truncated. A hard kill between the write and the rename may leave an orphan temp file.
- The `lag` timer is not `unref()`ed, so a process with only a pending `lag` timer stays alive until it fires (this guarantees the promise always resolves).

## Compatibility notes

- `monitor` (the v1.0.0 name) still works but is deprecated in favor of `sample`.
- `user`/`system` changed from fixed-point strings to numbers, and the CPU rate now uses the real elapsed time instead of `interval * 1000`. Both are intentional fixes; check consumers that parsed the old string format.

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
