'use strict';

const {test} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const {
    countCpuset,
    parseCgroupV2Quota,
    cgroupV1Cores,
    effectiveCores,
    getCpuCount,
} = require('../dist/cgroup.js');

test('countCpuset parses ranges and lists', () => {
    assert.equal(countCpuset('0-3,5'), 5);
    assert.equal(countCpuset('0,2'), 2);
    assert.equal(countCpuset('0-7'), 8);
    assert.equal(countCpuset('0-3,5-7'), 7);
    assert.equal(countCpuset('0'), 1);
});

test('countCpuset rejects empty and malformed values', () => {
    assert.equal(countCpuset(''), undefined);
    assert.equal(countCpuset('abc'), undefined);
    assert.equal(countCpuset('5-3'), undefined);
    assert.equal(countCpuset('0-1,abc'), undefined);
});

test('parseCgroupV2Quota preserves fractional quotas', () => {
    assert.equal(parseCgroupV2Quota('100000 100000'), 1);
    assert.equal(parseCgroupV2Quota('200000 100000'), 2);
    assert.equal(parseCgroupV2Quota('50000 100000'), 0.5);
});

test('parseCgroupV2Quota treats unlimited or malformed lines as undefined', () => {
    assert.equal(parseCgroupV2Quota('max 100000'), undefined);
    assert.equal(parseCgroupV2Quota(''), undefined);
    assert.equal(parseCgroupV2Quota('abc 100000'), undefined);
    assert.equal(parseCgroupV2Quota('100000'), undefined);
});

test('cgroupV1Cores preserves fractional quotas and rejects unlimited', () => {
    assert.equal(cgroupV1Cores('100000', '100000'), 1);
    assert.equal(cgroupV1Cores('50000', '100000'), 0.5);
    assert.equal(cgroupV1Cores('-1', '100000'), undefined);
    assert.equal(cgroupV1Cores('abc', '100000'), undefined);
});

test('effectiveCores takes the binding constraint', () => {
    assert.equal(effectiveCores([1, 4, 8], 8), 1);
    assert.equal(effectiveCores([0.5, 2, 8], 8), 0.5);
    assert.equal(effectiveCores([undefined, undefined], 8), 8);
    assert.equal(effectiveCores([], 8), 8);
});

test('getCpuCount returns a positive finite value', () => {
    const cores = getCpuCount();
    assert.ok(Number.isFinite(cores), 'core count is finite');
    assert.ok(cores > 0, 'core count is positive');
    if (process.platform !== 'linux') {
        assert.equal(cores, os.cpus().length);
    }
});
