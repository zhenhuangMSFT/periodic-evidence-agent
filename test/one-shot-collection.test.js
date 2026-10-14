import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, hash, json, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { beginApp, openApp } from '../src/app-native.js';
import { principalPath } from '../src/runtime.js';
import { beginOneShotCollection, advanceOneShotCollection, stopOneShotCollection,
  oneShotCollectionStatus, readOneShotCollectionReceipt } from '../src/one-shot-collection.js';

function setup(t, selected = ['workiq:created'], options = {}) {
  const config = configAt('pilot.example.json');
  config.stateDirectory = mkdtempSync(join(tmpdir(), 'one-shot-collection-'));
  config.statePolicy.accessApproved = true;
  config.sources.ado = { enabled: selected.some(p => p.startsWith('ado:')), scopeApproved: true };
  config.sources.workiq.enabled = selected.some(p => p.startsWith('workiq:'));
  config.sources.workiq.scopeApproved = true;
  config.sources.icm.enabled = selected.includes('icm:created');
  config.sources.icm.scopeApproved = true;
  config.runtime.workiqCli = { enabled: true, executable: process.execPath, packageVersion: '1.0.1', timeoutMs: 1000 };
  config.dryRun.limits = { maxItems: 10, maxCalls: 10, ...options };
  const ledger = new Ledger(config.stateDirectory);
  t.after(() => { ledger.close(); rmSync(config.stateDirectory, { recursive: true, force: true }); });
  const input = { format: 'one-shot-collection-v1', runId: 'fresh', owner: 'synthetic-owner',
    dryRun: true, passes: selected, authorization: { approvedBy: 'synthetic-test', approvedAt: now(),
      approvalRef: 'synthetic:offline-only', deadlineAt: new Date(Date.now() + 60000).toISOString(),
      maxItems: config.dryRun.limits.maxItems * selected.length,
      maxCalls: config.dryRun.limits.maxCalls * selected.length } };
  return { config, ledger, input };
}
const wrapped = data => ({ structuredContent: { results: [{ statusCode: 200, data }] } });
function emptyWorkiq(config, calls, onRead = () => {}) {
  return async () => ({
    read: async path => {
      calls.push(path);
      onRead(path);
      return wrapped(path === principalPath
        ? { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser } : { value: [] });
    }, close: async () => {}
  });
}
function emptyAdo(calls) {
  return async () => async (endpoint, body) => {
    calls.push({ endpoint, body });
    return { asOf: '2026-10-09T00:00:00Z', workItems: [] };
  };
}

test('fresh one-shot executes real collector APIs and holds complete selected coverage without dispatch', async t => {
  const { config, ledger, input } = setup(t, ['ado:created', 'ado:changed', 'workiq:created']);
  const ado = [], workiq = [];
  beginOneShotCollection(config, ledger, input);
  const status = await advanceOneShotCollection(config, ledger, input.runId, {
    adoTransport: emptyAdo(ado), workiqFactory: emptyWorkiq(config, workiq)
  });
  assert.equal(status.state, 'held-awaiting-filter', json(status.blocker));
  assert.equal(ado.length, 4);
  assert.equal(workiq.length, 2);
  assert.equal(status.sourceCoverageComplete, true);
  assert.equal(status.dispatchAllowed, false);
  assert.match(status.nextGate, /external FILTER/);
  const receipt = readOneShotCollectionReceipt(config, ledger, input.runId, status.receiptSha256);
  assert.equal(receipt.mode, 'fresh-local-collection');
  assert.equal(receipt.snapshot.collection[2].result.provenance, 'workiq-cli-verified');
  const { ledger: source, run } = openApp(config, input.runId);
  assert.equal(run.dryRun, true);
  assert.equal(run.provenance, 'app-tool');
  assert.equal(source.status().jobs.length, 0);
  source.close();
  assert.equal(ledger.status().jobs.length, 0);
  assert.deepEqual(beginOneShotCollection(config, ledger, input), status);
  assert.deepEqual(await advanceOneShotCollection(config, ledger, input.runId, {
    workiqFactory: () => assert.fail('duplicate'), adoTransport: () => assert.fail('duplicate')
  }), status);
});

test('aggregate full-pass reservations reject insufficient or unbounded budgets before source work', t => {
  const { config, ledger, input } = setup(t, ['ado:created', 'workiq:created']);
  for (const value of [19, null, Infinity, 1.5]) {
    const changed = structuredClone(input); changed.authorization.maxCalls = value;
    assert.throws(() => beginOneShotCollection(config, ledger, changed), /aggregate budget/);
  }
  assert.equal(ledger.db.prepare("SELECT name FROM sqlite_master WHERE name='app_runs'").get(), undefined);
  const status = beginOneShotCollection(config, ledger, input);
  assert.deepEqual(status.reserved, { maxItems: 20, maxCalls: 20 });
  const changed = structuredClone(input); changed.authorization.maxCalls = 21;
  assert.throws(() => beginOneShotCollection(config, ledger, changed), /immutable authorization/);
});

test('enabled sources cannot disappear from a selected cohort and IcM remains an explicit binding hold', async t => {
  const { config, ledger, input } = setup(t, ['icm:created', 'workiq:created']);
  const changed = structuredClone(input); changed.passes = ['workiq:created'];
  assert.throws(() => beginOneShotCollection(config, ledger, changed), /every enabled source/);
  beginOneShotCollection(config, ledger, input);
  const status = await advanceOneShotCollection(config, ledger, input.runId, {
    workiqFactory: () => assert.fail('unsupported selected source must stop before later work')
  });
  assert.equal(status.state, 'blocked');
  assert.equal(status.blocker.code, 'blocked-binding');
  assert.equal(status.sourceCoverageComplete, false);
  assert.equal(status.passes.length, 2);
});

test('stop before dispatch and between passes needs explicit resume and preserves completed work', async t => {
  const { config, ledger, input } = setup(t, ['workiq:created', 'ado:created']);
  beginOneShotCollection(config, ledger, input);
  stopOneShotCollection(ledger, input.runId);
  const calls = [], ado = [];
  assert.equal((await advanceOneShotCollection(config, ledger, input.runId)).state, 'stopped');
  const stopped = await advanceOneShotCollection(config, ledger, input.runId, { resume: true,
    workiqFactory: emptyWorkiq(config, calls, path => {
      if (path !== principalPath) stopOneShotCollection(ledger, input.runId);
    }), adoTransport: () => assert.fail('stop between passes')
  });
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.passes[0].state, 'complete');
  assert.equal(stopped.passes[1].state, 'pending');
  const resumed = await advanceOneShotCollection(config, ledger, input.runId, { resume: true,
    workiqFactory: () => assert.fail('completed pass cannot relaunch'), adoTransport: emptyAdo(ado)
  });
  assert.equal(resumed.state, 'held-awaiting-filter', json(resumed.blocker));
  assert.equal(calls.length, 2);
  assert.equal(ado.length, 2);
});

test('partial traversal and authentication failure never become empty-success or release reservations', async t => {
  for (const auth of [false, true]) {
    const { config, ledger, input } = setup(t, ['workiq:created', 'ado:created'], { maxCalls: 2 });
    beginOneShotCollection(config, ledger, input);
    let reads = 0;
    const status = await advanceOneShotCollection(config, ledger, input.runId, {
      workiqFactory: async () => ({ read: async path => {
        reads++;
        if (path === principalPath) return wrapped({ id: config.identity.objectId,
          userPrincipalName: config.identity.designatedUser });
        if (auth) return { structuredContent: { results: [{ statusCode: 401, data: null }] } };
        return wrapped({ value: [{ id: 'root', createdDateTime: '2026-10-08T01:00:00Z',
          lastModifiedDateTime: '2026-10-08T01:00:00Z', webUrl: 'https://example.invalid/root' }] });
      }, close: async () => {} }),
      adoTransport: () => assert.fail('partial coverage must stop later stages')
    });
    assert.equal(status.state, 'blocked');
    assert.equal(status.sourceCoverageComplete, false);
    assert.equal(status.passes[0].result.state, auth ? 'blocked-auth' : 'partial');
    assert.deepEqual(status.reserved, { maxItems: 20, maxCalls: 4 });
    const { ledger: source } = openApp(config, input.runId);
    assert.equal(source.cursor('app:workiq:created'), null);
    source.close();
    await advanceOneShotCollection(config, ledger, input.runId, { resume: true,
      workiqFactory: () => assert.fail('blocked pass must never retry')
    });
    assert.equal(reads, 2);
    assert.throws(() => readOneShotCollectionReceipt(config, ledger, input.runId), /Missing/);
  }
});

test('uncertain outer dispatch never relaunches even without a helper operation', async t => {
  const { config, ledger, input } = setup(t);
  beginOneShotCollection(config, ledger, input);
  ledger.db.prepare("UPDATE one_shot_collection_passes SET state='started'").run();
  const status = await advanceOneShotCollection(config, ledger, input.runId, {
    workiqFactory: () => assert.fail('uncertain dispatch cannot relaunch')
  });
  assert.equal(status.blocker.code, 'blocked-reconciliation');
  assert.match(status.blocker.action, /no helper outcome/);
  assert.equal(status.passes[0].state, 'started');
  assert.equal(status.reserved.maxCalls, 10);
});

test('interrupted WorkIQ helper reconciles durable intent offline without new reads', async t => {
  const { config, ledger, input } = setup(t);
  beginOneShotCollection(config, ledger, input);
  const appInput = JSON.parse(ledger.db.prepare('SELECT app_input FROM one_shot_collections').get().app_input);
  beginApp(config, appInput);
  const { ledger: source } = openApp(config, input.runId);
  source.operation('cli-workiq:fresh', 'fresh', 'local-workiq-cli-collection', {});
  source.db.prepare('INSERT INTO app_transport VALUES(?,?,?,?)').run('unknown', 'fresh', 'workiq:created',
    json({ execution: 'local-workiq-cli-stdio', state: 'requested',
      call: { request: { entityUrls: [principalPath] } } }));
  source.close();
  ledger.db.prepare("UPDATE one_shot_collection_passes SET state='started'").run();
  const status = await advanceOneShotCollection(config, ledger, input.runId, {
    workiqFactory: () => assert.fail('reconciliation is offline')
  });
  assert.equal(status.state, 'blocked');
  assert.equal(status.passes[0].result.state, 'blocked-reconciliation');
  assert.equal(status.reserved.maxCalls, 10);
});

test('a crash after helper completion recovers the accepted pass without duplicate collection', async t => {
  const { config, ledger, input } = setup(t);
  beginOneShotCollection(config, ledger, input);
  const calls = [];
  await advanceOneShotCollection(config, ledger, input.runId, {
    workiqFactory: emptyWorkiq(config, calls, path => {
      if (path !== principalPath) stopOneShotCollection(ledger, input.runId);
    })
  });
  ledger.db.prepare("UPDATE one_shot_collection_passes SET state='started',result=NULL").run();
  const status = await advanceOneShotCollection(config, ledger, input.runId, { resume: true,
    workiqFactory: () => assert.fail('already completed helper')
  });
  assert.equal(status.state, 'held-awaiting-filter', json(status.blocker));
  assert.equal(calls.length, 2);
});

test('ADO crash after atomic receipt acceptance reconciles the existing event instead of re-appending calls', async t => {
  const { config, ledger, input } = setup(t, ['ado:created']);
  beginOneShotCollection(config, ledger, input);
  const calls = [];
  const factory = emptyAdo(calls);
  await advanceOneShotCollection(config, ledger, input.runId, {
    adoTransport: async (...args) => {
      const request = await factory(...args);
      return async (...requestArgs) => {
        const response = await request(...requestArgs);
        if (calls.length === 2) stopOneShotCollection(ledger, input.runId);
        return response;
      };
    }
  });
  const { ledger: source } = openApp(config, input.runId);
  source.db.prepare("UPDATE operations SET state='started' WHERE id=?").run('app-source:fresh:ado:created');
  const beforeEvents = source.db.prepare('SELECT COUNT(*) n FROM app_events').get().n;
  source.close();
  ledger.db.prepare("UPDATE one_shot_collection_passes SET state='started',result=NULL").run();
  const status = await advanceOneShotCollection(config, ledger, input.runId, {
    resume: true, adoTransport: () => assert.fail('accepted ADO read must not repeat')
  });
  assert.equal(status.state, 'held-awaiting-filter', json(status.blocker));
  const reopened = openApp(config, input.runId);
  assert.equal(reopened.ledger.db.prepare('SELECT COUNT(*) n FROM app_events').get().n, beforeEvents);
  reopened.ledger.close();
  assert.equal(calls.length, 2);
});

test('expiry and an existing owner prevent new collection, without consuming another reservation', async t => {
  const { config, ledger, input } = setup(t);
  beginOneShotCollection(config, ledger, input);
  const lock = ledger.acquire(`one-shot-collection:${input.runId}`);
  await assert.rejects(advanceOneShotCollection(config, ledger, input.runId), /Ownership held/);
  ledger.release(`one-shot-collection:${input.runId}`, lock);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(60001);
  const status = await advanceOneShotCollection(config, ledger, input.runId, {
    workiqFactory: () => assert.fail('expired approval')
  });
  assert.equal(status.blocker.code, 'blocked-budget');
  assert.equal(status.passes[0].state, 'pending');
  assert.equal(status.reserved.maxCalls, 10);
});

test('fresh identity cannot adopt prior imports, and configuration drift blocks before dispatch', async t => {
  const { config, ledger, input } = setup(t);
  beginApp(config, { runId: input.runId, dryRun: true, provenance: 'app-tool' });
  assert.throws(() => beginOneShotCollection(config, ledger, input), /existing runs are not fresh/);
  input.runId = 'different';
  beginOneShotCollection(config, ledger, input);
  config.sources.workiq.seeds[0].channelId = 'changed';
  const status = await advanceOneShotCollection(config, ledger, input.runId, {
    workiqFactory: () => assert.fail('configuration changed')
  });
  assert.equal(status.blocker.code, 'blocked-reconciliation');
});

test('immutable receipt rejects source drift even when source storage is collection-only', async t => {
  const { config, ledger, input } = setup(t);
  beginOneShotCollection(config, ledger, input);
  const status = await advanceOneShotCollection(config, ledger, input.runId, {
    workiqFactory: emptyWorkiq(config, [])
  });

  assert.ok(status.receiptSha256);
  const original = readOneShotCollectionReceipt(config, ledger, input.runId);
  assert.equal(hash(json(original)), status.receiptSha256);
  const { ledger: source } = openApp(config, input.runId);
  const body = JSON.parse(source.db.prepare('SELECT body FROM app_passes').get().body);
  body.state = 'partial';
  source.db.prepare('UPDATE app_passes SET body=?').run(json(body));
  source.close();
  assert.throws(() => readOneShotCollectionReceipt(config, ledger, input.runId), /unchanged/);
  assert.equal((await advanceOneShotCollection(config, ledger, input.runId)).state, 'blocked');
});

test('CLI one-shot role requires explicit scope and collection flag and resumes persisted state', t => {
  const { config, ledger, input } = setup(t);
  const configPath = join(config.stateDirectory, 'pilot.local.json'), inputPath = join(config.stateDirectory, 'input.json');
  writeFileSync(configPath, json(config)); writeFileSync(inputPath, json(input));
  const invoke = (action, flags = []) => spawnSync(process.execPath,
    ['src\\cli.js', 'agent', 'collector', action, '--config', configPath, ...flags],
    { encoding: 'utf8', timeout: 30000 });
  const begin = invoke('one-shot-begin', ['--file', inputPath]);
  assert.equal(begin.status, 0, begin.stderr);
  assert.equal(JSON.parse(begin.stdout).result.state, 'collecting');
  const noPermission = invoke('one-shot-collect', ['--run', input.runId]);
  assert.equal(noPermission.status, 1);
  assert.equal(JSON.parse(noPermission.stderr).error.code, 'blocked-authorization');
  const stopped = invoke('one-shot-stop', ['--run', input.runId]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const read = invoke('one-shot-status', ['--run', input.runId]);
  assert.equal(JSON.parse(read.stdout).result.state, 'stopped');
  const collectStopped = invoke('one-shot-collect', ['--run', input.runId, '--collect']);
  assert.equal(collectStopped.status, 0, collectStopped.stderr);
  assert.equal(JSON.parse(collectStopped.stdout).result.state, 'stopped');
  assert.equal(oneShotCollectionStatus(ledger, input.runId).passes[0].state, 'pending');
});
