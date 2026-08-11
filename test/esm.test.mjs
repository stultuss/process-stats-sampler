import test from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readFile, unlink} from 'node:fs/promises';
import * as esm from '../dist/index.mjs';

const require = createRequire(import.meta.url);
const cjs = require('../dist/index.js');

/** Synchronous busy wait that occupies CPU */
function busyWait(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* block */ }
}

test('ESM entry exposes the same implementation as CJS', () => {
    assert.equal(typeof esm.sample, 'function');
    assert.equal(typeof esm.reset, 'function');
    assert.equal(typeof esm.lag, 'function');
    assert.equal(typeof esm.ProcessStatsSampler.sample, 'function');
    assert.equal(typeof esm.ProcessStatsSampler.lag, 'function');
    assert.equal(esm.sample, cjs.sample, 'ESM and CJS share one implementation instance');
    assert.equal(esm.reset, cjs.reset);
    assert.equal(esm.lag, cjs.lag);
    assert.equal(esm.ProcessStatsSampler, cjs.ProcessStatsSampler);
});

test('ESM sample writes a file', async () => {
    const sampleFile = path.join(os.tmpdir(), `process-stats-sampler-esm-${Date.now()}.json`);

    await esm.sample(sampleFile);

    const stats = JSON.parse(await readFile(sampleFile, 'utf8'));
    assert.equal(typeof stats.rss, 'number');
    assert.equal(typeof stats.user, 'number');
    await unlink(sampleFile).catch(() => undefined);
});

test('ESM and CJS share sampling state (no dual-package state split)', async () => {
    const sampleFile = path.join(os.tmpdir(), `process-stats-sampler-esm-state-${Date.now()}.json`);

    await cjs.sample(sampleFile);
    busyWait(50);
    await esm.sample(sampleFile);

    const stats = JSON.parse(await readFile(sampleFile, 'utf8'));
    assert.ok(stats.user > 300, `ESM should continue the CJS baseline and see the busy window, got ${stats.user}`);
    await unlink(sampleFile).catch(() => undefined);
});
