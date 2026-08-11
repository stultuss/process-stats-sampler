# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This package is maintained primarily for personal use, so version numbers
follow release cadence rather than strict semantic versioning.

## [1.1.0] - 2026-08-11

### Added

- `sample()` as the primary one-shot sampling API.
- `reset(filename)` to clear a file's sampling state (CPU baseline), giving the
  retained per-file state an explicit lifecycle.
- Native ESM entry point (`import`) alongside `require`. The ESM wrapper
  re-exports the CJS implementation, so both entry points share one module
  instance and one set of sampling baselines (no dual-package state split).
- Regression tests for the real-elapsed CPU rate, per-file baseline isolation,
  `reset()`, deterministic write-failure rejection, and ESM/CJS state sharing.

### Changed

- `monitor()` was removed; use `sample()` instead.
- The `interval` parameter was removed; the CPU rate now uses the actual
  wall-clock time between consecutive samples of the same file, so an irregular
  call cadence no longer distorts the reading.
- `user` / `system` are now JSON numbers rounded to 3 decimals instead of
  fixed-point strings.
- Runtime failures (e.g. file I/O errors) now reject the returned promise
  instead of logging a warning and resolving; the `logger` / `onError` options
  were removed.
- The timestamp, the memory snapshot and the CPU counters are all captured at
  the start of the sample, before the lag probe, so they are aligned.
- Sampling state is isolated per output file: independent baselines and
  serialization queues.
- `machine-percent` now derives the available core count on Linux from the
  cgroup CPU quota and cpuset (preserving fractional quotas such as 0.5 core)
  and re-reads it on every sample.
- The default output path is `/tmp/stats.json` (was `/tmp/stats.log`).

## [1.0.0] - 2026-08-11

### Added

- Initial release: periodic memory/CPU JSON sampling (`monitor()`) and the
  event-loop execution delay probe (`lag()`).
- Atomic file writes (temp file + rename), argument validation, CPU output
  units (`ratio` / `percent` / `machine-percent`), concurrent-call
  serialization, CI across Node 18–24, and a documented public API.
