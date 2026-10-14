import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, json, now, requireThat, safeError, utc, uuid } from './common.js';
import { beginApp, openApp, collectAppAdo, reconcileAppAdo, noCredentials } from './app-native.js';
import { collectCliWorkiq, reconcileCliWorkiq } from './cli-collection.js';
import { loadFilterCorpus } from './filter.js';

const passes = ['ado:created', 'ado:changed', 'workiq:created', 'workiq:changed', 'icm:created'];
const integer = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function fields(value, keys) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
  'Unexpected one-shot request fields', 'invalid-record');
}
function tables(ledger) {
  ledger.db.exec(`
    CREATE TABLE IF NOT EXISTS one_shot_collections (
      id TEXT PRIMARY KEY, request TEXT NOT NULL, config_hash TEXT NOT NULL,
      app_input TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0, blocker TEXT, receipt TEXT);
    CREATE TABLE IF NOT EXISTS one_shot_collection_passes (
      run_id TEXT NOT NULL REFERENCES one_shot_collections(id), pass TEXT NOT NULL,
      state TEXT NOT NULL, reservation TEXT NOT NULL, result TEXT,
      PRIMARY KEY(run_id,pass));
    CREATE TRIGGER IF NOT EXISTS immutable_one_shot_request BEFORE UPDATE OF
      request,config_hash,app_input ON one_shot_collections
      BEGIN SELECT RAISE(ABORT,'One-shot request pins are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_one_shot_receipt BEFORE UPDATE OF receipt
      ON one_shot_collections WHEN OLD.receipt IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'One-shot collection receipt is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_one_shot_reservation BEFORE UPDATE OF
      reservation ON one_shot_collection_passes
      BEGIN SELECT RAISE(ABORT,'One-shot reservations are immutable'); END;
  `);
}
function stored(ledger, runId) {
  const row = ledger.db.prepare('SELECT * FROM one_shot_collections WHERE id=?').get(runId);
  requireThat(row, 'Unknown one-shot collection', 'invalid-record');
  return { ...row, input: JSON.parse(row.request), appInput: JSON.parse(row.app_input) };
}
function sourcePath(config, input) {
  return join(config.stateDirectory, 'app-native', input.dryRun ? 'dry-runs' : 'live',
    ...(input.dryRun ? [input.runId] : []), 'ledger.sqlite');
}
function checkedConfig(config, ledger, row) {
  requireThat(realpathSync(config.stateDirectory) === realpathSync(ledger.directory) &&
    hash(json(config)) === row.config_hash,
  'One-shot configuration or state owner changed; do not resume under new permissions',
  'blocked-reconciliation');
}
function block(ledger, runId, code, action) {
  ledger.db.prepare('UPDATE one_shot_collections SET blocker=? WHERE id=?')
    .run(json({ code, action }), runId);
  return oneShotCollectionStatus(ledger, runId);
}
function passRows(ledger, runId) {
  return ledger.db.prepare('SELECT * FROM one_shot_collection_passes WHERE run_id=? ORDER BY rowid')
    .all(runId).map(row => ({ ...row, reservation: JSON.parse(row.reservation),
      result: row.result ? JSON.parse(row.result) : null }));
}
function helperOperation(runId, pass) {
  return pass.startsWith('ado:') ? `app-source:${runId}:${pass}` :
    `cli-workiq:${runId}${pass === 'workiq:changed' ? ':changed' : ''}`;
}
function passResult(ledger, runId, pass) {
  const row = ledger.db.prepare('SELECT body FROM app_passes WHERE run_id=? AND pass=?').get(runId, pass);
  return row ? JSON.parse(row.body) : null;
}
function qualifiedPass(result, pass, reservation) {
  const workiq = pass.startsWith('workiq:');
  return result?.pass === pass && result.state === 'complete' && result.identityVerified === true &&
    result.provenance === (workiq ? 'workiq-cli-verified' : 'authenticated-source') &&
    result.execution === (workiq ? 'local-workiq-cli-stdio' : 'delegated-source-adapter') &&
    Number.isSafeInteger(result.readCalls) && result.readCalls >= 0 &&
    result.readCalls <= reservation.maxCalls &&
    Number.isSafeInteger(result.examinedRecords) && result.examinedRecords >= 0 &&
    result.examinedRecords <= reservation.maxItems && !result.nextRequest &&
    !result.continuation && !result.unexaminedReturnedRecords;
}
function reconcileAcceptedAdo(source, runId, pass) {
  const calls = source.db.prepare('SELECT body FROM app_transport WHERE run_id=? AND pass=? ORDER BY rowid')
    .all(runId, pass).map(row => JSON.parse(row.body));
  const accepted = source.db.prepare('SELECT body FROM app_events WHERE run_id=? AND pass=? ORDER BY rowid')
    .all(runId, pass).flatMap(row => JSON.parse(row.body).calls);
  requireThat(calls.length > 0 && json(calls) === json(accepted),
    'Completed ADO pass does not bind all durable transport receipts', 'blocked-reconciliation');
  // ADO appends once, after all reads. Re-appending under a new event ID would duplicate its calls.
  source.finishOperation(helperOperation(runId, pass), 'recorded', {
    pass, reconciledFromAcceptedEvent: true, newSourceReads: 0
  });
}
function snapshot(config, source, row, selected) {
  const appRun = source.db.prepare('SELECT body FROM app_runs WHERE id=?').get(row.id)?.body;
  requireThat(appRun && json(JSON.parse(appRun).input) === row.app_input,
    'One-shot source run identity changed', 'blocked-reconciliation');
  const sources = [{ ledgerPath: realpathSync(join(source.directory, 'ledger.sqlite')), runId: row.id }];
  const corpus = loadFilterCorpus(config, { format: 'stage2-sources-v1', sources });
  const recorded = source.db.prepare('SELECT pass FROM app_passes WHERE run_id=?').all(row.id);
  requireThat(recorded.length === selected.length &&
    recorded.every(value => selected.some(pass => pass.pass === value.pass)),
  'One-shot source contains an unselected or missing pass', 'blocked-reconciliation');
  for (const pass of selected) {
    const current = passResult(source, row.id, pass.pass);
    requireThat(pass.state === 'complete' && json(current) === json(pass.result) &&
      qualifiedPass(current, pass.pass, pass.reservation),
    'Selected source pass is not complete, authenticated and unchanged', 'blocked-reconciliation');
  }
  const transport = source.db.prepare('SELECT id,pass,body FROM app_transport WHERE run_id=? ORDER BY rowid').all(row.id);
  const events = source.db.prepare('SELECT id,pass,body FROM app_events WHERE run_id=? ORDER BY rowid').all(row.id);
  const operations = selected.map(pass => source.db.prepare('SELECT * FROM operations WHERE id=?')
    .get(helperOperation(row.id, pass.pass)));
  requireThat(operations.every(operation => operation && operation.state !== 'started'),
    'Collection helper operations still need reconciliation', 'blocked-reconciliation');
  return { sources, appRunSha256: hash(appRun), corpusSha256: hash(json(corpus)),
    transportSha256: hash(json(transport)), eventsSha256: hash(json(events)), operationsSha256: hash(json(operations)),
    sourceSnapshots: corpus.index.sources, collection: selected.map(({ pass, reservation, result }) =>
      ({ pass, reservation, result })) };
}

export function beginOneShotCollection(config, ledger, input) {
  fields(input, ['format', 'runId', 'owner', 'dryRun', 'passes', 'authorization']);
  fields(input.authorization, ['approvedBy', 'approvedAt', 'approvalRef', 'deadlineAt', 'maxItems', 'maxCalls']);
  Object.values(input).forEach(noCredentials);
  const a = input.authorization;
  requireThat(input.format === 'one-shot-collection-v1' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.runId ?? '') &&
    text(input.owner) && typeof input.dryRun === 'boolean' &&
    text(a.approvedBy) && text(a.approvalRef),
  'Explicit one-shot identity, owner and collection authorization required', 'blocked-authorization');
  utc(a.approvedAt); utc(a.deadlineAt);
  requireThat(Date.parse(a.approvedAt) <= Date.now() && Date.parse(a.deadlineAt) > Date.parse(a.approvedAt),
    'Invalid one-shot authorization interval', 'blocked-authorization');
  requireThat(config.executionMode === 'app-native' && config.statePolicy.accessApproved === true &&
    config.schedule.enabled === false && realpathSync(config.stateDirectory) === realpathSync(ledger.directory),
  'One-shot requires its approved local state owner, app-native mode and disabled scheduling');
  requireThat(Array.isArray(input.passes) && input.passes.length > 0 &&
    new Set(input.passes).size === input.passes.length && input.passes.every(pass => passes.includes(pass)),
  'Explicit unique selected source passes required', 'invalid-record');
  requireThat(input.passes.every(pass => config.sources[pass.split(':')[0]]?.enabled === true &&
    config.sources[pass.split(':')[0]].scopeApproved === true) &&
    Object.entries(config.sources).filter(([, source]) => source.enabled)
      .every(([kind]) => input.passes.includes(`${kind}:created`)),
  'Selected passes must cover every enabled source without expanding approved scope', 'blocked-scope');
  const limits = input.dryRun ? config.dryRun.limits : config.limits;
  requireThat([limits.maxItems, limits.maxCalls, a.maxItems, a.maxCalls].every(integer) &&
    Number.isSafeInteger(limits.maxItems * input.passes.length) &&
    Number.isSafeInteger(limits.maxCalls * input.passes.length) &&
    limits.maxItems * input.passes.length <= a.maxItems &&
    limits.maxCalls * input.passes.length <= a.maxCalls,
  'Explicit finite aggregate budget must reserve every full selected pass before collection', 'blocked-budget');
  tables(ledger);
  const existing = ledger.db.prepare('SELECT id FROM one_shot_collections WHERE id=?').get(input.runId);
  if (existing) {
    const row = stored(ledger, input.runId);
    checkedConfig(config, ledger, row);
    requireThat(row.request === json(input), 'One-shot run ID has different immutable authorization', 'blocked-reconciliation');
    return oneShotCollectionStatus(ledger, input.runId);
  }
  requireThat(Date.now() < Date.parse(a.deadlineAt), 'One-shot authorization expired', 'blocked-budget');
  // Never adopt an existing replay/import or a shared production collection ledger.
  requireThat(!existsSync(sourcePath(config, input)),
    'Fresh one-shot requires new isolated collection storage; existing runs are not fresh', 'blocked-reconciliation');
  ledger.transaction(() => {
    const appInput = { runId: input.runId, executorSessionId: uuid(), dryRun: input.dryRun, provenance: 'app-tool' };
    ledger.db.prepare('INSERT INTO one_shot_collections(id,request,config_hash,app_input) VALUES(?,?,?,?)')
      .run(input.runId, json(input), hash(json(config)), json(appInput));
    for (const pass of input.passes) {
      ledger.db.prepare('INSERT INTO one_shot_collection_passes VALUES(?,?,?,?,NULL)')
        .run(input.runId, pass, 'pending', json({ maxItems: limits.maxItems, maxCalls: limits.maxCalls }));
    }
  });
  return oneShotCollectionStatus(ledger, input.runId);
}

export function oneShotCollectionStatus(ledger, runId) {
  const row = stored(ledger, runId), selected = passRows(ledger, runId);
  const receipt = row.receipt ? JSON.parse(row.receipt) : null;
  const blocker = row.blocker ? JSON.parse(row.blocker) : null;
  return { format: 'one-shot-collection-status-v1', runId, owner: row.input.owner,
    state: blocker ? 'blocked' : row.stopped ? 'stopped' : receipt ? 'held-awaiting-filter' : 'collecting',
    sourceCoverageComplete: Boolean(receipt) && !blocker, dispatchAllowed: false,
    configSha256: row.config_hash, requestSha256: hash(row.request),
    reserved: selected.reduce((sum, pass) => ({ maxItems: sum.maxItems + pass.reservation.maxItems,
      maxCalls: sum.maxCalls + pass.reservation.maxCalls }), { maxItems: 0, maxCalls: 0 }),
    passes: selected.map(({ pass, state, reservation, result }) => ({ pass, state, reservation, result })),
    blocker, receiptSha256: row.receipt ? hash(row.receipt) : null,
    nextGate: receipt ? 'Explicit sharing/tokenizer/task qualification and external FILTER execution; no submit/observe binding is installed'
      : 'Only authorized local collection executes; stopped or uncertain operations are never retried' };
}

export function stopOneShotCollection(ledger, runId) {
  stored(ledger, runId);
  ledger.db.prepare('UPDATE one_shot_collections SET stopped=1 WHERE id=?').run(runId);
  return oneShotCollectionStatus(ledger, runId);
}

export function readOneShotCollectionReceipt(config, ledger, runId, expectedSha256 = null) {
  const row = stored(ledger, runId);
  requireThat(row.receipt && (!expectedSha256 || (digest(expectedSha256) && hash(row.receipt) === expectedSha256)),
    'Missing or changed immutable one-shot collection receipt', 'blocked-reconciliation');
  const receipt = JSON.parse(row.receipt);
  requireThat(!row.blocker && !row.stopped && receipt.configSha256 === row.config_hash &&
    receipt.requestSha256 === hash(row.request),
  'Collection is stopped, blocked or no longer matches its pins', 'blocked-reconciliation');
  const path = receipt.snapshot.sources[0].ledgerPath;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const source = { db, directory: join(path, '..') };
    requireThat(json(snapshot(config, source, row, passRows(ledger, runId))) === json(receipt.snapshot),
      'Completed collection snapshot changed', 'blocked-reconciliation');
  } finally { db.close(); }
  return receipt;
}

export async function advanceOneShotCollection(config, ledger, runId, {
  resume = false, adoTransport, workiqFactory
} = {}) {
  config = structuredClone(config);
  const owner = ledger.acquire(`one-shot-collection:${runId}`);
  let source;
  try {
    let row = stored(ledger, runId);
    checkedConfig(config, ledger, row);
    if (row.stopped && !resume) return oneShotCollectionStatus(ledger, runId);
    if (resume) ledger.db.prepare('UPDATE one_shot_collections SET stopped=0 WHERE id=?').run(runId);
    beginApp(config, row.appInput);
    ({ ledger: source } = openApp(config, runId, row.input.dryRun));
    if (row.receipt) {
      const receipt = readOneShotCollectionReceipt(config, ledger, runId);
      requireThat(json(snapshot(config, source, row, passRows(ledger, runId))) === json(receipt.snapshot),
        'Completed collection snapshot changed', 'blocked-reconciliation');
      return oneShotCollectionStatus(ledger, runId);
    }
    for (const pass of passRows(ledger, runId)) {
      row = stored(ledger, runId);
      if (row.stopped) return oneShotCollectionStatus(ledger, runId);
      if (pass.state === 'complete') {
        requireThat(json(passResult(source, runId, pass.pass)) === json(pass.result),
          'Accepted collection pass changed', 'blocked-reconciliation');
        continue;
      }
      if (pass.state === 'blocked') return oneShotCollectionStatus(ledger, runId);
      const operationId = helperOperation(runId, pass.pass);
      const operation = source.db.prepare('SELECT state FROM operations WHERE id=?').get(operationId);
      if (pass.state === 'started') {
        if (!operation) return block(ledger, runId, 'blocked-reconciliation',
          `Dispatch intent for ${pass.pass} has no helper outcome; inspect the recorded owner. Never relaunch.`);
        if (operation.state === 'started') {
          if (pass.pass.startsWith('ado:')) {
            if (qualifiedPass(passResult(source, runId, pass.pass), pass.pass, pass.reservation))
              reconcileAcceptedAdo(source, runId, pass.pass);
            else await reconcileAppAdo(config, source, runId, pass.pass);
          }
          else await reconcileCliWorkiq(config, source, runId, pass.pass);
        }
      } else {
        if (row.blocker) return oneShotCollectionStatus(ledger, runId);
        if (Date.now() >= Date.parse(row.input.authorization.deadlineAt))
          return block(ledger, runId, 'blocked-budget', 'Collection authorization expired; no new pass was launched.');
        if (pass.pass === 'icm:created' || (pass.pass.startsWith('workiq:') &&
          (!row.input.dryRun || config.runtime.workiqCli?.enabled !== true)))
          return block(ledger, runId, 'blocked-binding',
            `${pass.pass} has no authorized local binding in this mode; preserve scope and qualify a separate run.`);
        requireThat(!operation && !passResult(source, runId, pass.pass),
          'Unowned source operation or receipt exists; do not adopt it as fresh collection', 'blocked-reconciliation');
        ledger.db.prepare('UPDATE one_shot_collection_passes SET state=? WHERE run_id=? AND pass=?')
          .run('started', runId, pass.pass);
        if (pass.pass.startsWith('ado:'))
          await collectAppAdo(config, source, runId, pass.pass, adoTransport);
        else await collectCliWorkiq(config, source, runId, workiqFactory, pass.pass);
      }
      const result = passResult(source, runId, pass.pass);
      const complete = qualifiedPass(result, pass.pass, pass.reservation);
      ledger.db.prepare('UPDATE one_shot_collection_passes SET state=?,result=? WHERE run_id=? AND pass=?')
        .run(complete ? 'complete' : 'blocked', result ? json(result) : null, runId, pass.pass);
      if (!complete) return block(ledger, runId, result?.state ?? 'blocked-reconciliation',
        `${pass.pass} is incomplete or unqualified. Preserve reservations and source receipts; no retry or downstream release.`);
      ledger.db.prepare('UPDATE one_shot_collections SET blocker=NULL WHERE id=?').run(runId);
    }
    row = stored(ledger, runId);
    if (row.stopped) return oneShotCollectionStatus(ledger, runId);
    const receipt = { format: 'one-shot-collection-receipt-v1', runId, owner: row.input.owner,
      mode: 'fresh-local-collection', sourceCoverageComplete: true, dispatchAllowed: false,
      requestSha256: hash(row.request), configSha256: row.config_hash, completedAt: now(),
      authorization: row.input.authorization, snapshot: snapshot(config, source, row, passRows(ledger, runId)) };
    ledger.db.prepare('UPDATE one_shot_collections SET receipt=?,blocker=NULL WHERE id=?')
      .run(json(receipt), runId);
    return oneShotCollectionStatus(ledger, runId);
  } catch (error) {
    if (!ledger.db.prepare('SELECT id FROM one_shot_collections WHERE id=?').get(runId)) throw error;
    return block(ledger, runId, error.code ?? 'blocked-reconciliation', safeError(error).message);
  } finally {
    source?.close();
    ledger.release(`one-shot-collection:${runId}`, owner);
  }
}
