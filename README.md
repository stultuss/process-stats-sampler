# process-stats-sampler

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI][ci-image]][ci-url]

It periodically samples the Node.js process's memory and CPU usage into a JSON file and measures the Node event-loop execution delay.

## Install

```bash
npm install process-stats-sampler
```

## Usage

```js
const {ProcessStatsSampler} = require('process-stats-sampler');

// Call every 30 seconds; the sample is written to /tmp/stats.log
await ProcessStatsSampler.monitor('/tmp/stats.log', 30);
```

You can also use the convenience function alias:

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

### `monitor(filename?, interval?, options?)`

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `filename` | `string` | `/tmp/stats.log` | Output JSON file path; parent directories are created automatically. Writes use a temp file + atomic rename |
| `interval` | `number` | `30` | Sampling interval in seconds; must be a positive finite number |
| `options.logger` | `{warn: (message: string) => void}` | `console` | Logger for sampling warnings; falls back to `console` when `warn` is missing |
| `options.unit` | `'ratio' \| 'percent' \| 'machine-percent'` | `'ratio'` | CPU output unit |
| `options.lag` | `boolean \| number` | `true` | Record lag (event-loop delay probe): `true` probes with 1ms, `false` skips the probe (field is 0), a number sets a custom probe duration in ms |

#### CPU units

- `ratio` (default): CPU microseconds / wall-clock milliseconds; a fully utilized core is about 1000 (same as the original demo behavior)
- `percent`: percent of one core; a fully utilized core is 100
- `machine-percent`: percent of the whole machine (percent of one core ÷ number of cores)

The `lag` field in the output is the event-loop execution delay probe (same semantics as `lag()`): each sample waits on a short timer; when the event loop is blocked by synchronous work the timer fires late, so the value is the current Node execution delay in ms (min 0). By default it probes with 1ms; use `options.lag` to disable it or set a custom probe duration.

Invalid arguments (`filename` empty, `interval` non-positive, invalid `unit`/`lag`, invalid `ms`) throw a `TypeError` / `RangeError`; runtime errors such as file I/O failures only log a warning and never reject the caller.

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
  "user": "0.25",
  "system": "0.06",
  "lag": 0
}
```

## Behavior notes

- The CPU rate is the delta between two samples divided by `interval * 1000`; the first call uses the current `cpuUsage()` as the baseline, so the first sample is near 0.
- The `lag` field is the event-loop execution delay probe (see above); controlled via `options.lag`.
- Concurrent calls are serialized internally so CPU baselines and file writes never interfere with each other.
- File writes are atomic (temp file + `rename`), so an interrupted process never leaves a truncated JSON file.
- The `lag` timer is not `unref()`ed, so a process with only a pending `lag` timer stays alive until it fires (this guarantees the promise always resolves).

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
