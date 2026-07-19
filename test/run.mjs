// Bundles the TypeScript test suite and runs it.
//
// The suite imports from src/ directly, so it needs a bundling step before
// Node can execute it. Everything is written to a temporary file that is
// removed afterwards, so nothing untracked is left behind.

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'suite.ts');
const bundle = join(here, '.suite.bundle.mjs');

await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    // The Obsidian API is not available outside the app; anything importing it
    // belongs in a UI module rather than the tested logic layer.
    logLevel: 'warning',
});

const child = spawn(process.execPath, [bundle], { stdio: 'inherit' });

child.on('exit', async (code) => {
    await rm(bundle, { force: true });
    process.exit(code ?? 0);
});
