import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const threads = require('node:worker_threads');
const originalWatch = fs.watch;
const OriginalWorker = threads.Worker;
const watchers = new Map();
let onWorkerResult = null;
let onWatch = null;
fs.watch = (path, options, callback) => {
  const watcher = new EventEmitter();
  watcher.callback = callback;
  watcher.closed = false;
  watcher.close = () => { watcher.closed = true; };
  watcher.unref = () => watcher;
  watchers.set(path, watcher);
  onWatch?.(watcher);
  return watcher;
};
threads.Worker = class extends OriginalWorker {
  constructor(...args) {
    super(...args);
    // Deliver the injected OS event after hashing, before the controller
    // receives the result, without mocking the fingerprint computation.
    this.prependListener('message', result => onWorkerResult?.(result));
  }
};
syncBuiltinESMExports();
const { outputFingerprint, verifyPreparedOutputs } =
  await import('../src/workers.js');
after(() => {
  fs.watch = originalWatch;
  threads.Worker = OriginalWorker;
  syncBuiltinESMExports();
});

async function fixture(t, rootPath = 'node_modules') {
  onWorkerResult = null;
  onWatch = null;
  const workspace = mkdtempSync(join(tmpdir(), 'prepared-guard-'));
  const root = join(workspace, rootPath);
  const nested = join(root, 'fixture', 'nested');
  mkdirSync(nested, { recursive: true });
  const file = join(nested, 'value.js');
  writeFileSync(file, 'export default 1;\n');
  t.after(() => {
    onWorkerResult = null;
    onWatch = null;
    for (const [path, watcher] of watchers) {
      if (path.startsWith(workspace)) {
        watcher.close();
        watchers.delete(path);
      }
    }
    rmSync(workspace, { recursive: true, force: true });
  });
  const captured = await outputFingerprint(workspace, [rootPath], true);
  const outputs = { paths: [rootPath], sha256: captured.sha256 };
  const receipt = join(workspace, 'receipt.json');
  const verify = () => verifyPreparedOutputs(receipt, workspace, outputs);
  const initialize = () => verifyPreparedOutputs(
    receipt, workspace, outputs, captured.entries);
  const watcher = () => watchers.get(root);
  return { workspace, root, nested, file, outputs, verify, initialize, watcher };
}

for (const rootPath of ['node_modules', 'dist']) {
  for (const mutation of ['modify', 'delete', 'add']) {
    test(`ancestor-only ${rootPath} event detects nested ${mutation}`, async t => {
      const ctx = await fixture(t, rootPath);
      assert.equal((await ctx.initialize()).valid, true);
      if (mutation === 'modify') writeFileSync(ctx.file, 'corrupt\n');
      if (mutation === 'delete') rmSync(ctx.file);
      if (mutation === 'add')
        writeFileSync(join(ctx.nested, 'injected.js'), 'injected\n');
      ctx.watcher().callback('change', 'fixture');
      const result = await ctx.verify();
      assert.equal(result.valid, false);
      assert.match(result.reason, /content-changed/);
    });
  }
}

test('ancestor and leaf metadata events coalesce into one recursive task', async t => {
  const ctx = await fixture(t);
  assert.equal((await ctx.initialize()).valid, true);
  writeFileSync(ctx.file, readFileSync(ctx.file));
  ctx.watcher().callback('change', 'fixture');
  ctx.watcher().callback('change', 'fixture/nested/value.js');
  const result = await ctx.verify();
  assert.equal(result.valid, true);
  assert.equal(result.details.coalescedPathCount, 1);
  assert.equal(result.details.workerTaskCount, 1);
  assert.equal(result.details.recursiveDirectoryCount, 1);
  assert.equal(result.details.hashedFileCount, 1);
});

for (const initial of [false, true]) {
  for (const event of ['rename', 'delete', 'watch-error', 'null-filename']) {
    test(`${initial ? 'initial' : 'warm'} verification rejects ${event} during hashing`,
      async t => {
        const ctx = await fixture(t);
        if (initial) {
          onWatch = watcher => setImmediate(() =>
            watcher.callback('change', 'fixture'));
        } else {
          assert.equal((await ctx.initialize()).valid, true);
          ctx.watcher().callback('change', 'fixture');
        }
        let injected = false;
        onWorkerResult = () => {
          if (injected) return;
          injected = true;
          if (event === 'rename') {
            renameSync(ctx.file, join(ctx.nested, 'renamed.js'));
            ctx.watcher().callback('rename', 'fixture/nested/value.js');
          } else if (event === 'delete') {
            rmSync(ctx.file);
            ctx.watcher().callback('rename', 'fixture/nested/value.js');
          } else if (event === 'watch-error') {
            ctx.watcher().emit('error', new Error('injected watcher failure'));
          } else {
            ctx.watcher().callback('change', null);
          }
        };
        const result = await (initial ? ctx.initialize() : ctx.verify());
        assert.equal(injected, true);
        assert.equal(result.valid, false);
        assert.equal(ctx.watcher().closed, true);
      });
  }
}

test('a repeated change delivered after hashing must be revalidated', async t => {
  const ctx = await fixture(t);
  assert.equal((await ctx.initialize()).valid, true);
  ctx.watcher().callback('change', 'fixture/nested/value.js');
  let injected = false;
  onWorkerResult = () => {
    if (injected) return;
    injected = true;
    setTimeout(() => {
      writeFileSync(ctx.file, 'changed after fingerprint\n');
      ctx.watcher().callback('change', 'fixture/nested/value.js');
    }, 10);
  };
  const result = await ctx.verify();
  assert.equal(injected, true);
  assert.equal(result.valid, false);
  assert.equal(result.details.settlementPassCount, 2);
});

test('watcher loss before settlement reports current events instead of stale warm telemetry',
  async t => {
    const ctx = await fixture(t);
    assert.equal((await ctx.initialize()).valid, true);
    const quiet = await ctx.verify();
    assert.equal(quiet.details.observedEventCount, 0);
    ctx.watcher().callback('change', null);
    const lost = await ctx.verify();
    assert.equal(lost.valid, false);
    assert.match(lost.reason, /unknown/);
    assert.equal(lost.details.observedEventCount, 1);
    assert.equal(lost.details.nullFilenameEventCount, 1);
    assert.equal(lost.details.workerTaskCount, 0);
    assert.equal(lost.details.durationMs, 0);
  });
