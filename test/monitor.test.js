'use strict';

const {test} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const {ProcessStatsSampler} = require('../dist/index.js');

/** Synchronous busy wait that occupies CPU and blocks the event loop */
function busyWait(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* block */ }
}

test('monitor writes memory and CPU fields', async () => {
    const monitorFile = path.join(os.tmpdir(), `process-stats-sampler-${Date.now()}.json`);

    await ProcessStatsSampler.monitor(monitorFile, 0.001);

    const raw = await fsp.readFile(monitorFile, 'utf8');
    const stats = JSON.parse(raw);
    assert.equal(typeof stats.rss, 'number');
    assert.equal(typeof stats.heapTotal, 'number');
    assert.equal(typeof stats.heapUsed, 'number');
    assert.equal(typeof stats.external, 'number');
    assert.equal(typeof stats.arrayBuffers, 'number');
    assert.equal(typeof stats.user, 'string');
    assert.equal(typeof stats.system, 'string');
    assert.equal(typeof stats.lag, 'number');
    assert.ok(stats.lag >= 0, 'lag is a non-negative number');
    assert.equal(typeof stats.timestamp, 'number');
    assert.ok(stats.timestamp > 0, 'timestamp is a positive epoch ms value');

    await fsp.unlink(monitorFile).catch(() => undefined);
});

test('monitor lag: false writes lag as 0 and skips the probe', async () => {
    const monitorFile = path.join(os.tmpdir(), `process-stats-sampler-nolag-${Date.now()}.json`);

    await ProcessStatsSampler.monitor(monitorFile, 0.001, {lag: false});

    const stats = JSON.parse(await fsp.readFile(monitorFile, 'utf8'));
    assert.equal(stats.lag, 0);
    await fsp.unlink(monitorFile).catch(() => undefined);
});

test('monitor supports a numeric custom lag probe duration', async () => {
    const monitorFile = path.join(os.tmpdir(), `process-stats-sampler-lag10-${Date.now()}.json`);

    await ProcessStatsSampler.monitor(monitorFile, 0.001, {lag: 10});

    const stats = JSON.parse(await fsp.readFile(monitorFile, 'utf8'));
    assert.equal(typeof stats.lag, 'number');
    assert.ok(stats.lag >= 0 && stats.lag < 10, 'drift of a 10ms probe is below 10ms');
    await fsp.unlink(monitorFile).catch(() => undefined);
});

test('monitor records significant lag while the event loop is blocked by CPU-bound work', async () => {
    const monitorFile = path.join(os.tmpdir(), `process-stats-sampler-busy-${Date.now()}.json`);

    // Let monitor schedule its probe timer first, then block the event loop for 100ms
    const pending = ProcessStatsSampler.monitor(monitorFile, 0.001, {lag: 10});
    await new Promise((resolve) => setImmediate(resolve));
    busyWait(100);
    await pending;

    const stats = JSON.parse(await fsp.readFile(monitorFile, 'utf8'));
    assert.ok(stats.lag >= 50, `lag recorded by monitor should rise after a 100ms block, got ${stats.lag}`);
    await fsp.unlink(monitorFile).catch(() => undefined);
});

test('monitor creates missing directories', async () => {
    const dir = path.join(os.tmpdir(), `process-stats-sampler-dir-${Date.now()}`);
    const monitorFile = path.join(dir, 'nested', 'stats.json');

    await ProcessStatsSampler.monitor(monitorFile, 0.001);

    const stats = JSON.parse(await fsp.readFile(monitorFile, 'utf8'));
    assert.equal(typeof stats.rss, 'number');

    await fsp.rm(dir, {recursive: true, force: true});
});

test('monitor logs a warning instead of throwing on write failure', async () => {
    const warnings = [];
    const logger = {warn: (message) => warnings.push(message)};

    // Point at a path that cannot be created (no permission at the filesystem root)
    await ProcessStatsSampler.monitor('/nonexistent-root-dir/stats.json', 0.001, {logger});

    assert.ok(warnings.length > 0, 'a warning should be recorded');
});

test('lag returns a non-negative delay and waits the requested time', async () => {
    const lagStart = Date.now();
    const delay = await ProcessStatsSampler.lag(50);
    assert.ok(delay >= 0, 'delay is never negative');
    assert.ok(Date.now() - lagStart >= 45, 'wait reaches the requested ms (tolerating clock rounding)');
});

test('lag defaults to 1000ms and returns a small delay', async () => {
    const lagStart = Date.now();
    const delay = await ProcessStatsSampler.lag();
    assert.ok(Date.now() - lagStart >= 995, 'default wait is about 1000ms');
    assert.ok(delay >= 0 && delay < 500, 'default-scenario delay is a small value');
});

test('lag rises significantly while the event loop is blocked by CPU-bound work', async () => {
    // Control: idle lag is small
    const idle = await ProcessStatsSampler.lag(1);
    assert.ok(idle < 25, `idle lag should be small, got ${idle}`);

    // Experiment: schedule a 1ms probe timer, then block the event loop for 80ms
    const pending = ProcessStatsSampler.lag(1);
    busyWait(80);
    const busy = await pending;
    assert.ok(busy >= 50, `lag should rise significantly after an 80ms block, got ${busy}`);
    assert.ok(busy > idle + 40, `busy lag should far exceed idle lag, idle=${idle}, busy=${busy}`);
});

test('monitor rejects invalid arguments', async () => {
    await assert.rejects(() => ProcessStatsSampler.monitor('/tmp/x.json', 0), TypeError);
    await assert.rejects(() => ProcessStatsSampler.monitor('/tmp/x.json', -5), TypeError);
    await assert.rejects(() => ProcessStatsSampler.monitor('/tmp/x.json', NaN), TypeError);
    await assert.rejects(() => ProcessStatsSampler.monitor('', 30), TypeError);
    await assert.rejects(() => ProcessStatsSampler.monitor('   ', 30), TypeError);
    await assert.rejects(() => ProcessStatsSampler.monitor('/tmp/x.json', 30, {unit: 'bogus'}), TypeError);
    await assert.rejects(() => ProcessStatsSampler.monitor('/tmp/x.json', Infinity), TypeError);
    await assert.rejects(() => ProcessStatsSampler.monitor('/tmp/x.json', 30, {lag: -1}), TypeError);
    await assert.rejects(() => ProcessStatsSampler.monitor('/tmp/x.json', 30, {lag: NaN}), TypeError);
    await assert.rejects(() => ProcessStatsSampler.monitor('/tmp/x.json', 30, {lag: 2 ** 31}), RangeError);
    await assert.rejects(() => ProcessStatsSampler.monitor('/tmp/x.json', 30, {lag: 'x'}), TypeError);
});

test('monitor supports percent and machine-percent units with finite output', async () => {
    for (const unit of ['percent', 'machine-percent']) {
        const monitorFile = path.join(os.tmpdir(), `process-stats-sampler-${unit}-${Date.now()}.json`);
        await ProcessStatsSampler.monitor(monitorFile, 0.001, {unit});
        const stats = JSON.parse(await fsp.readFile(monitorFile, 'utf8'));
        assert.match(stats.user, /^-?\d+\.\d{2}$/, `${unit} user is a two-decimal string`);
        assert.ok(Number.isFinite(Number(stats.user)), `${unit} user is a finite value`);
        assert.ok(Number.isFinite(Number(stats.system)), `${unit} system is a finite value`);
        await fsp.unlink(monitorFile).catch(() => undefined);
    }
});

test('monitor serializes concurrent calls and leaves no tmp files', async () => {
    const dir = path.join(os.tmpdir(), `process-stats-sampler-conc-${Date.now()}`);
    const f1 = path.join(dir, 'a.json');
    const f2 = path.join(dir, 'b.json');

    await Promise.all([
        ProcessStatsSampler.monitor(f1, 0.001),
        ProcessStatsSampler.monitor(f2, 0.001),
    ]);

    const a = JSON.parse(await fsp.readFile(f1, 'utf8'));
    const b = JSON.parse(await fsp.readFile(f2, 'utf8'));
    assert.equal(typeof a.rss, 'number');
    assert.equal(typeof b.rss, 'number');

    const leftovers = (await fsp.readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    await fsp.rm(dir, {recursive: true, force: true});
});

test('logger without warn falls back to console without throwing', async () => {
    await assert.doesNotReject(() => ProcessStatsSampler.monitor('/nonexistent-root-dir/x.json', 0.001, {logger: {}}));
});

test('lag rejects invalid ms', async () => {
    await assert.rejects(() => ProcessStatsSampler.lag(-1), TypeError);
    await assert.rejects(() => ProcessStatsSampler.lag(NaN), TypeError);
    await assert.rejects(() => ProcessStatsSampler.lag(2 ** 31), RangeError);
});

test('lag(0) resolves to about 0', async () => {
    const delay = await ProcessStatsSampler.lag(0);
    assert.ok(delay >= 0 && delay < 100);
});
