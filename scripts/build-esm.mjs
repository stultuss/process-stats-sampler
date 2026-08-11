import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/**
 * ESM wrapper: re-exports the CJS implementation so both entry points share
 * one module instance (and one set of sampling baselines). Keep the export
 * list in sync with src/index.ts.
 */
const wrapper = `import cjs from './index.js';

export const ProcessStatsSampler = cjs.ProcessStatsSampler;
export const sample = cjs.sample;
export const reset = cjs.reset;
export const lag = cjs.lag;
`;

const declaration = `export * from './index.js';
`;

await writeFile(path.join(distDir, 'index.mjs'), wrapper);
await writeFile(path.join(distDir, 'index.d.mts'), declaration);
