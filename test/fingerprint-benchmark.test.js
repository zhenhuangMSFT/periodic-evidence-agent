import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { benchmarkOptions, sampleSummary } from '../scripts/benchmark-fingerprint.mjs';

test('benchmark requires an explicit new local output and bounded sample counts', () => {
  const path = join(tmpdir(), `benchmark-options-${process.pid}.json`);
  assert.deepEqual(benchmarkOptions(['--output', path]), {
    output: path, samples: 3, files: 4096
  });
  for (const args of [
    [], ['--output', 'relative.json'], ['--output', path, '--samples', '0'],
    ['--output', path, '--files', '32769'], ['--output', path, '--samples', '1.5'],
    ['--output', path, '--unknown', '1'], ['--output', path, '--samples'],
    ['--output', path, '--output', path],
    ['--output', fileURLToPath(import.meta.url)],
    ['--output', join(tmpdir(), 'e2e-evidence', 'benchmark.json')]
  ]) assert.throws(() => benchmarkOptions(args));
});

test('small benchmark samples report honest raw ranges, not percentile claims', () => {
  assert.deepEqual(sampleSummary([4, 1, 7]), {
    sampleCount: 3, minMs: 1, maxMs: 7, meanMs: 4, rawMs: [4, 1, 7],
    percentileClaim: 'None: small local samples, not a stable p50/p95 estimate'
  });
  assert.throws(() => sampleSummary([]));
  assert.throws(() => sampleSummary([NaN]));
});

test('benchmark output cannot enter e2e-evidence through a directory alias', t => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-output-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'e2e-evidence'));
  symlinkSync(join(root, 'e2e-evidence'), join(root, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => benchmarkOptions([
    '--output', join(root, 'alias', 'new', 'benchmark.json')
  ]), /e2e-evidence/);
});
