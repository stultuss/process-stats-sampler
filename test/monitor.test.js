'use strict';

const {test} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const {ProcessStatsSampler} = require('../dist/index.js');

/** 同步忙等，强制占用 CPU 阻塞事件循环 */
function busyWait(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* block */ }
}

test('monitor 输出包含内存与 CPU 字段', async () => {
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
    assert.ok(stats.lag >= 0, 'lag 为非负数值');

    await fsp.unlink(monitorFile).catch(() => undefined);
});

test('monitor lag: false 时 lag 字段为 0 且不探测', async () => {
    const monitorFile = path.join(os.tmpdir(), `process-stats-sampler-nolag-${Date.now()}.json`);

    await ProcessStatsSampler.monitor(monitorFile, 0.001, {lag: false});

    const stats = JSON.parse(await fsp.readFile(monitorFile, 'utf8'));
    assert.equal(stats.lag, 0);
    await fsp.unlink(monitorFile).catch(() => undefined);
});

test('monitor 支持数字自定义 lag 探测时长', async () => {
    const monitorFile = path.join(os.tmpdir(), `process-stats-sampler-lag10-${Date.now()}.json`);

    await ProcessStatsSampler.monitor(monitorFile, 0.001, {lag: 10});

    const stats = JSON.parse(await fsp.readFile(monitorFile, 'utf8'));
    assert.equal(typeof stats.lag, 'number');
    assert.ok(stats.lag >= 0 && stats.lag < 10, '10ms 探测的漂移应小于 10ms');
    await fsp.unlink(monitorFile).catch(() => undefined);
});

test('monitor 在事件循环被强制占用 CPU 时记录显著 lag', async () => {
    const monitorFile = path.join(os.tmpdir(), `process-stats-sampler-busy-${Date.now()}.json`);

    // 让 monitor 先调度探测定时器，再同步阻塞事件循环 100ms
    const pending = ProcessStatsSampler.monitor(monitorFile, 0.001, {lag: 10});
    await new Promise((resolve) => setImmediate(resolve));
    busyWait(100);
    await pending;

    const stats = JSON.parse(await fsp.readFile(monitorFile, 'utf8'));
    assert.ok(stats.lag >= 50, `阻塞 100ms 后 monitor 记录的 lag 应显著上升, 实际 ${stats.lag}`);
    await fsp.unlink(monitorFile).catch(() => undefined);
});

test('monitor 自动创建不存在的目录', async () => {
    const dir = path.join(os.tmpdir(), `process-stats-sampler-dir-${Date.now()}`);
    const monitorFile = path.join(dir, 'nested', 'stats.json');

    await ProcessStatsSampler.monitor(monitorFile, 0.001);

    const stats = JSON.parse(await fsp.readFile(monitorFile, 'utf8'));
    assert.equal(typeof stats.rss, 'number');

    await fsp.rm(dir, {recursive: true, force: true});
});

test('monitor 写入失败时记录警告而不是抛错', async () => {
    const warnings = [];
    const logger = {warn: (message) => warnings.push(message)};

    // 指向一个不可写的路径（根目录下无权限创建）
    await ProcessStatsSampler.monitor('/nonexistent-root-dir/stats.json', 0.001, {logger});

    assert.ok(warnings.length > 0, '应记录警告信息');
});

test('lag 返回的延迟差不为负且实际等待达到指定毫秒数', async () => {
    const lagStart = Date.now();
    const delay = await ProcessStatsSampler.lag(50);
    assert.ok(delay >= 0, '延迟差不为负');
    assert.ok(Date.now() - lagStart >= 45, '实际等待达到指定毫秒数（容忍时钟取整）');
});

test('lag 默认等待 1000ms 且返回小延迟', async () => {
    const lagStart = Date.now();
    const delay = await ProcessStatsSampler.lag();
    assert.ok(Date.now() - lagStart >= 995, '默认等待约 1000ms');
    assert.ok(delay >= 0 && delay < 500, '默认场景延迟差为小数值');
});

test('lag 在事件循环被强制占用 CPU 时显著上升', async () => {
    // 对照组：空闲时延迟很小
    const idle = await ProcessStatsSampler.lag(1);
    assert.ok(idle < 25, `空闲时 lag 应很小, 实际 ${idle}`);

    // 实验组：先调度 1ms 探测定时器，再同步阻塞事件循环 80ms
    const pending = ProcessStatsSampler.lag(1);
    busyWait(80);
    const busy = await pending;
    assert.ok(busy >= 50, `阻塞 80ms 后 lag 应显著上升, 实际 ${busy}`);
    assert.ok(busy > idle + 40, `阻塞后 lag 应远大于空闲时, idle=${idle}, busy=${busy}`);
});

test('monitor 拒绝非法参数', async () => {
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

test('monitor 支持 percent 与 machine-percent 单位且输出有限数值', async () => {
    for (const unit of ['percent', 'machine-percent']) {
        const monitorFile = path.join(os.tmpdir(), `process-stats-sampler-${unit}-${Date.now()}.json`);
        await ProcessStatsSampler.monitor(monitorFile, 0.001, {unit});
        const stats = JSON.parse(await fsp.readFile(monitorFile, 'utf8'));
        assert.match(stats.user, /^-?\d+\.\d{2}$/, `${unit} user 为两位小数`);
        assert.ok(Number.isFinite(Number(stats.user)), `${unit} user 为有限数值`);
        assert.ok(Number.isFinite(Number(stats.system)), `${unit} system 为有限数值`);
        await fsp.unlink(monitorFile).catch(() => undefined);
    }
});

test('monitor 并发调用串行化且不产生 tmp 残留', async () => {
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

test('logger 缺少 warn 时降级到 console 而不抛错', async () => {
    await assert.doesNotReject(() => ProcessStatsSampler.monitor('/nonexistent-root-dir/x.json', 0.001, {logger: {}}));
});

test('lag 拒绝非法 ms', async () => {
    await assert.rejects(() => ProcessStatsSampler.lag(-1), TypeError);
    await assert.rejects(() => ProcessStatsSampler.lag(NaN), TypeError);
    await assert.rejects(() => ProcessStatsSampler.lag(2 ** 31), RangeError);
});

test('lag(0) 立即返回约 0', async () => {
    const delay = await ProcessStatsSampler.lag(0);
    assert.ok(delay >= 0 && delay < 100);
});
