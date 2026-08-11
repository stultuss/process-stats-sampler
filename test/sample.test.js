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

test('sample writes memory and CPU fields', async () => {
    const sampleFile = path.join(os.tmpdir(), `process-stats-sampler-${Date.now()}.json`);

    await ProcessStatsSampler.sample(sampleFile);

    const raw = await fsp.readFile(sampleFile, 'utf8');
    const stats = JSON.parse(raw);
    assert.equal(typeof stats.rss, 'number');
    assert.equal(typeof stats.heapTotal, 'number');
    assert.equal(typeof stats.heapUsed, 'number');
    assert.equal(typeof stats.external, 'number');
    assert.equal(typeof stats.arrayBuffers, 'number');
    assert.equal(typeof stats.user, 'number');
    assert.equal(typeof stats.system, 'number');
    assert.ok(Number.isFinite(stats.user));
    assert.ok(Number.isFinite(stats.system));
    assert.ok(stats.user >= 0);
    assert.ok(stats.system >= 0);
    assert.equal(typeof stats.lag, 'number');
    assert.ok(stats.lag >= 0, 'lag is a non-negative number');
    assert.equal(typeof stats.timestamp, 'number');
    assert.ok(stats.timestamp > 0, 'timestamp is a positive epoch ms value');

    await fsp.unlink(sampleFile).catch(() => undefined);
});

test('sample lag: false writes lag as 0 and skips the probe', async () => {
    const sampleFile = path.join(os.tmpdir(), `process-stats-sampler-nolag-${Date.now()}.json`);

    await ProcessStatsSampler.sample(sampleFile, {lag: false});

    const stats = JSON.parse(await fsp.readFile(sampleFile, 'utf8'));
    assert.equal(stats.lag, 0);
    await fsp.unlink(sampleFile).catch(() => undefined);
});

test('sample supports a numeric custom lag probe duration', async () => {
    const sampleFile = path.join(os.tmpdir(), `process-stats-sampler-lag10-${Date.now()}.json`);

    await ProcessStatsSampler.sample(sampleFile, {lag: 10});

    const stats = JSON.parse(await fsp.readFile(sampleFile, 'utf8'));
    assert.equal(typeof stats.lag, 'number');
    assert.ok(stats.lag >= 0 && stats.lag < 10, 'drift of a 10ms probe is below 10ms');
    await fsp.unlink(sampleFile).catch(() => undefined);
});

test('sample records significant lag while the event loop is blocked by CPU-bound work', async () => {
    const sampleFile = path.join(os.tmpdir(), `process-stats-sampler-busy-${Date.now()}.json`);

    // Let sample schedule its probe timer first, then block the event loop for 100ms
    const pending = ProcessStatsSampler.sample(sampleFile, {lag: 10});
    await new Promise((resolve) => setImmediate(resolve));
    busyWait(100);
    await pending;

    const stats = JSON.parse(await fsp.readFile(sampleFile, 'utf8'));
    assert.ok(stats.lag >= 50, `lag recorded by sample should rise after a 100ms block, got ${stats.lag}`);
    await fsp.unlink(sampleFile).catch(() => undefined);
});

test('sample creates missing directories', async () => {
    const dir = path.join(os.tmpdir(), `process-stats-sampler-dir-${Date.now()}`);
    const sampleFile = path.join(dir, 'nested', 'stats.json');

    await ProcessStatsSampler.sample(sampleFile);

    const stats = JSON.parse(await fsp.readFile(sampleFile, 'utf8'));
    assert.equal(typeof stats.rss, 'number');

    await fsp.rm(dir, {recursive: true, force: true});
});

test('CPU rate reflects the actual elapsed time between samples', async () => {
    const sampleFile = path.join(os.tmpdir(), `process-stats-sampler-rate-${Date.now()}.json`);

    await ProcessStatsSampler.sample(sampleFile);
    const first = JSON.parse(await fsp.readFile(sampleFile, 'utf8'));
    assert.equal(first.user, 0, 'the first sample only establishes the baseline');

    busyWait(50);
    await ProcessStatsSampler.sample(sampleFile);
    const second = JSON.parse(await fsp.readFile(sampleFile, 'utf8'));
    assert.ok(second.user > 300, `50ms of busy work should show a near-full-core rate, got ${second.user}`);

    await fsp.unlink(sampleFile).catch(() => undefined);
});

test('independent files keep isolated baselines and reset clears them', async () => {
    const dir = path.join(os.tmpdir(), `process-stats-sampler-isolated-${Date.now()}`);
    const f1 = path.join(dir, 'a.json');
    const f2 = path.join(dir, 'b.json');

    await ProcessStatsSampler.sample(f1);
    busyWait(50);
    await ProcessStatsSampler.sample(f2);
    const f2stats = JSON.parse(await fsp.readFile(f2, 'utf8'));
    assert.equal(f2stats.user, 0, 'a fresh file starts from its own zero baseline despite process CPU load');

    await ProcessStatsSampler.sample(f1);
    const f1stats = JSON.parse(await fsp.readFile(f1, 'utf8'));
    assert.ok(f1stats.user > 300, `f1 sees the busy window, got ${f1stats.user}`);

    ProcessStatsSampler.reset(f1);
    await ProcessStatsSampler.sample(f1);
    const resetStats = JSON.parse(await fsp.readFile(f1, 'utf8'));
    assert.equal(resetStats.user, 0, 'reset clears the baseline');

    await fsp.rm(dir, {recursive: true, force: true});
});

test('sample rejects on write failure instead of silently swallowing errors', async () => {
    const dir = path.join(os.tmpdir(), `process-stats-sampler-reject-${Date.now()}`);
    await fsp.mkdir(dir, {recursive: true});
    const blocker = path.join(dir, 'blocker');
    await fsp.writeFile(blocker, 'x');
    const target = path.join(blocker, 'stats.json'); // parent is a file: mkdir deterministically fails

    await assert.rejects(() => ProcessStatsSampler.sample(target), (err) => err instanceof Error);

    await fsp.rm(dir, {recursive: true, force: true});
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

test('sample rejects invalid arguments', async () => {
    await assert.rejects(() => ProcessStatsSampler.sample(''), TypeError);
    await assert.rejects(() => ProcessStatsSampler.sample('   '), TypeError);
    await assert.rejects(() => ProcessStatsSampler.sample(123), TypeError);
    await assert.rejects(() => ProcessStatsSampler.sample('/tmp/x.json', {unit: 'bogus'}), TypeError);
    await assert.rejects(() => ProcessStatsSampler.sample('/tmp/x.json', {lag: -1}), TypeError);
    await assert.rejects(() => ProcessStatsSampler.sample('/tmp/x.json', {lag: NaN}), TypeError);
    await assert.rejects(() => ProcessStatsSampler.sample('/tmp/x.json', {lag: 'x'}), TypeError);
    await assert.rejects(() => ProcessStatsSampler.sample('/tmp/x.json', {lag: 2 ** 31}), RangeError);
});

test('sample supports percent and machine-percent units with finite output', async () => {
    for (const unit of ['percent', 'machine-percent']) {
        const sampleFile = path.join(os.tmpdir(), `process-stats-sampler-${unit}-${Date.now()}.json`);
        await ProcessStatsSampler.sample(sampleFile, {unit});
        const stats = JSON.parse(await fsp.readFile(sampleFile, 'utf8'));
        assert.equal(typeof stats.user, 'number', `${unit} user is a number`);
        assert.ok(Number.isFinite(stats.user), `${unit} user is a finite value`);
        assert.ok(Number.isFinite(stats.system), `${unit} system is a finite value`);
        await fsp.unlink(sampleFile).catch(() => undefined);
    }
});

test('sample serializes concurrent calls to the same file and leaves no tmp files', async () => {
    const dir = path.join(os.tmpdir(), `process-stats-sampler-conc-${Date.now()}`);
    const sampleFile = path.join(dir, 'a.json');

    await Promise.all([
        ProcessStatsSampler.sample(sampleFile),
        ProcessStatsSampler.sample(sampleFile),
    ]);

    const stats = JSON.parse(await fsp.readFile(sampleFile, 'utf8'));
    assert.equal(typeof stats.rss, 'number');

    const leftovers = (await fsp.readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    await fsp.rm(dir, {recursive: true, force: true});
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
