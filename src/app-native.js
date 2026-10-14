import { existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { Ledger } from './ledger.js';
import { collectAdo, collectWorkiq, adoTransport } from './sources.js';
import { principalPath, validateWorkiqPath, messageSelect, verifyPrincipal } from './runtime.js';
import { acceptReview, report } from './coordinator.js';
import { makeAssignment, makePlannedImprovementAssignment, requireCurrentAssignment, reconcileHostedAssignment } from './workers.js';
import { agencyTaskId, requireAgencyQualification, reserveAgencyRequest, recordAgencySubmission, activeWorkerCount } from './agency-executor.js';
import { requireThat, hash, json, now, utc, uuid, positive, PilotError, safeError } from './common.js';
import { planImprovement } from './improvements.js';
import { skillQualificationId, verifyRepositorySkillWorkspace } from './repository-skills.js';

const passes = ['ado:created', 'ado:changed', 'workiq:created', 'workiq:changed', 'icm:created'];
const failures = ['blocked-auth', 'unavailable', 'failed-source'];
const receiptKeys = ['id', 'observedAt', 'requestedAt', 'tool', 'request', 'response', 'failure', 'completionEventId', 'actorSessionId'];
function object(value, keys, required = keys) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(k => keys.includes(k)) && required.every(k => Object.hasOwn(value, k)),
  'Invalid app-native object shape', 'invalid-record');
}
function identifier(value) {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value),
    'Invalid app-native identifier', 'invalid-record');
}
export function noCredentials(value) {
  if (typeof value === 'string') requireThat(!/\bBearer\s+[a-zA-Z0-9._~-]+|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\./.test(value),
    'Credential-shaped content is not permitted in receipts', 'invalid-record');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    requireThat(!/^(authorization|headers|cookie|set-cookie|access_?token|refresh_?token|id_?token|client_?secret|password)$/i.test(key),
      'Transport credentials/headers are not permitted in receipts', 'invalid-record');
    noCredentials(child);
  }
}
function configured(input) {
  requireThat(input.executionMode === 'app-native', 'Select executionMode app-native explicitly');
  identifier(input.agent?.id);
  requireThat(input.statePolicy.accessApproved, 'Local evidence storage approval is required');
}
function directory(config, runId, dry) {
  identifier(runId);
  return dry ? join(config.stateDirectory, 'app-native', 'dry-runs', runId)
    : join(config.stateDirectory, 'app-native', 'live');
}
function tables(ledger) {
  ledger.db.exec(`
    CREATE TABLE IF NOT EXISTS app_runs(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_events(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,pass TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_passes(run_id TEXT NOT NULL,pass TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,pass));
    CREATE TABLE IF NOT EXISTS app_workers(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_transport(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,pass TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_artifacts(run_id TEXT NOT NULL,ref TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(run_id,ref));
    CREATE TABLE IF NOT EXISTS app_workiq_continuations(run_id TEXT PRIMARY KEY,pass TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_thread_context(
      run_id TEXT NOT NULL,pass TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,pass,id));
    CREATE UNIQUE INDEX IF NOT EXISTS app_worker_handle ON app_workers(json_extract(body,'$.sessionId'))
      WHERE json_extract(body,'$.sessionId') IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS immutable_app_event BEFORE UPDATE ON app_events
      BEGIN SELECT RAISE(ABORT,'App events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_workiq_continuation BEFORE UPDATE ON app_workiq_continuations
      BEGIN SELECT RAISE(ABORT,'WorkIQ continuation bindings are immutable'); END;
  `);
}
function getRun(ledger, id) {
  const row = ledger.db.prepare('SELECT body FROM app_runs WHERE id=?').get(id);
  requireThat(row, 'Unknown app-native run', 'invalid-record');
  return JSON.parse(row.body);
}
export function workiqContinuation(ledger, runId, pass) {
  const row = ledger.db.prepare('SELECT body FROM app_workiq_continuations WHERE run_id=? AND pass=?').get(runId, pass);
  return row ? JSON.parse(row.body) : null;
}
export function openApp(config, runId, dry = true) {
  configured(config);
  const path = directory(config, runId, dry);
  requireThat(existsSync(join(path, 'ledger.sqlite')), 'App run must be begun before importing');
  const ledger = new Ledger(path);
  try {
    tables(ledger);
    const run = getRun(ledger, runId);
    requireThat(run.configHash === hash(json(config)) && run.dryRun === dry, 'Run configuration changed; start a separate run');
    return { ledger, run };
  } catch (error) { ledger.close(); throw error; }
}
export function beginApp(config, input) {
  configured(config);
  object(input, ['runId', 'executorSessionId', 'dryRun', 'provenance', 'continuationFrom'], ['runId', 'dryRun', 'provenance']);
  identifier(input.runId);
  if (input.executorSessionId) identifier(input.executorSessionId);
  if (input.continuationFrom !== undefined) identifier(input.continuationFrom);
  requireThat(typeof input.dryRun === 'boolean' && ['app-tool', 'synthetic'].includes(input.provenance), 'Invalid run mode/provenance');
  requireThat(input.dryRun || config.activation.collect, 'Production collection is not activated');
  const limits = input.dryRun ? config.dryRun.limits : config.limits;
  positive(limits.maxItems, 'maxItems'); positive(limits.maxCalls, 'maxCalls');
  if (input.dryRun) requireThat(config.dryRun.collectionOnly &&
    json(config.dryRun.window) === json(config.window), 'Dry-run limits apply only to the approved window');
  const ledger = new Ledger(directory(config, input.runId, input.dryRun));
  try {
    tables(ledger);
    const existing = ledger.db.prepare('SELECT body FROM app_runs WHERE id=?').get(input.runId);
    if (existing) {
      const run = JSON.parse(existing.body);
      requireThat(run.configHash === hash(json(config)) && json(run.input) === json(input), 'Run identity conflict');
    } else {
      const run = { ...input, input, agentId: config.agent.id, configHash: hash(json(config)), window: config.window,
        limits: { maxItems: limits.maxItems, maxCalls: limits.maxCalls }, startedAt: now(), executionMode: 'app-native' };
      ledger.db.prepare('INSERT INTO app_runs VALUES(?,?)').run(input.runId, json(run));
    }
    return appStatus(ledger, input.runId);
  } finally { ledger.close(); }
}
function receipt(call, pass) {
  object(call, receiptKeys, ['id', 'observedAt', 'tool', 'request']);
  identifier(call.id); utc(call.observedAt);
  if (call.requestedAt) utc(call.requestedAt);
  if (call.actorSessionId) identifier(call.actorSessionId);
  if (call.completionEventId) identifier(call.completionEventId);
  requireThat(Boolean(call.response) !== Boolean(call.failure), 'Receipt needs exactly one response or failure');
  requireThat(call.tool === (pass.startsWith('workiq') ? 'workiq-fetch' : 'ado-delegated-read'),
    'Receipt tool does not match source');
  if (call.failure) {
    object(call.failure, ['code', 'statusCode', 'requestId', 'errorCode', 'recoveryAction'], ['code']);
    requireThat(failures.includes(call.failure.code), 'Unrecognized source failure');
    if (call.failure.statusCode !== undefined) requireThat(Number.isInteger(call.failure.statusCode), 'Invalid failure status');
    if (call.failure.requestId !== undefined) identifier(call.failure.requestId);
    if (call.failure.errorCode !== undefined) identifier(call.failure.errorCode);
    if (call.failure.recoveryAction !== undefined) identifier(call.failure.recoveryAction);
  }
  noCredentials(call);
}
function workiqRequest(config, actual, expected) {
  object(actual, ['entityUrls']);
  requireThat(Array.isArray(actual.entityUrls) && actual.entityUrls.length === 1, 'Exactly one entity path per receipt');
  const path = actual.entityUrls[0];
  if (expected === principalPath) {
    requireThat(path === expected, 'First WorkIQ receipt must be the exact designated /me read');
    return;
  }
  requireThat(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') &&
    !/%2f|%5c|%2e|\\|\.\./i.test(path.split('?')[0]), 'Invalid scoped WorkIQ path', 'blocked-scope');
  const a = new URL(path, 'https://scope.invalid'), e = new URL(expected, 'https://scope.invalid');
  const select = a.searchParams.get('$select')?.split(',');
  requireThat(select?.includes('id') && select.includes('createdDateTime') &&
    select.every(field => messageSelect.split(',').includes(field)), 'Unsupported or insufficient projection', 'blocked-scope');
  const normalized = new URL(a);
  normalized.pathname = a.pathname.split('/').map(p => encodeURIComponent(decodeURIComponent(p))).join('/');
  normalized.searchParams.set('$select', config.sources.workiq.projection ?? messageSelect);
  validateWorkiqPath(config, normalized.pathname + normalized.search);
  // Metadata-only app reads are valid evidence with explicit missing body/revision fields.
  a.searchParams.delete('$select'); e.searchParams.delete('$select');
  a.searchParams.sort(); e.searchParams.sort();
  requireThat(decodeURIComponent(a.pathname) === decodeURIComponent(e.pathname) && a.search === e.search,
    'Receipt does not match the next scoped request', 'blocked-scope');
}
function workiqData(response) {
  object(response, ['results', 'requestId', 'note'], ['results']);
  if (response.note !== undefined) requireThat(typeof response.note === 'string', 'Invalid WorkIQ envelope note');
  requireThat(Array.isArray(response.results) && response.results.length === 1, 'Expected one WorkIQ result');
  const result = response.results[0];
  object(result, ['statusCode', 'data']);
  requireThat(result.statusCode === 200 && result.data && typeof result.data === 'object',
    'Successful receipt must contain a 200 data envelope; record failures explicitly');
  return result.data;
}
function identity(config, value) {
  object(value, ['objectId', 'tenantId', 'userPrincipalName', 'verifiedAt', 'toolCallId']);
  utc(value.verifiedAt); identifier(value.toolCallId);
  requireThat(value.objectId === config.identity.objectId && value.tenantId === config.identity.tenantId &&
    value.userPrincipalName?.toLowerCase() === config.identity.designatedUser.toLowerCase(),
  'Designated delegated identity mismatch', 'blocked-auth');
}
async function replay(config, run, pass, currentCalls, principal, directAdoVerified, directWorkiqVerified, continuation = null) {
  const local = structuredClone(config);
  local.limits = { ...local.limits, ...run.limits };
  const inherited = continuation?.calls ?? [];
  const calls = continuation ? [currentCalls[0], ...inherited, ...currentCalls.slice(1)] : currentCalls;
  const currentIds = new Set(currentCalls.map(call => call.id));
  local.limits.maxCalls += inherited.length;
  local.limits.maxItems += continuation?.examinedRecords ?? 0;
  const firstPage = calls.find(c => c.request?.entityUrls?.[0] !== principalPath && c.request?.entityUrls);
  if (firstPage) local.sources.workiq.projection = new URL(firstPage.request.entityUrls[0], 'https://scope.invalid').searchParams.get('$select');
  let index = 0, currentConsumed = 0, nextRequest = null, active, identityVerified = false;
  const evidence = [], contexts = [], stats = {};
  const provenance = run.provenance === 'synthetic' ? 'synthetic' : directWorkiqVerified ? 'workiq-cli-verified'
    : directAdoVerified ? 'authenticated-source' : 'app-tool-reported';
  const sourceContext = () => ({ runId: continuation?.origins?.[active.id]?.runId ?? run.runId,
    callId: active.id, query: active.request.entityUrls[0],
    requestedAt: active.requestedAt ?? null, observedAt: active.observedAt,
    actorSessionId: active.actorSessionId ?? null,
    provenance: continuation?.origins?.[active.id]?.provenance ?? provenance });
  const consume = request => {
    nextRequest = request;
    requireThat(index < calls.length, 'Next source response has not been supplied', 'awaiting-receipt');
    active = calls[index++];
    if (currentIds.has(active.id)) currentConsumed++;
    if (pass.startsWith('workiq')) workiqRequest(config, active.request, request.entityUrls[0]);
    else requireThat(json(active.request) === json(request), 'ADO receipt differs from approved query/batch', 'blocked-scope');
    if (active.failure) throw new PilotError(active.failure.code, 'App source call failed; see structured receipt');
    const data = pass.startsWith('workiq') ? workiqData(active.response) : active.response;
    if (pass.startsWith('workiq') && request.entityUrls[0] === principalPath) {
      verifyPrincipal(config, data); identityVerified = true;
    }
    return data;
  };
  const emit = async (record, payload) => {
    if (!pass.startsWith('workiq')) {
      record.queriedAt = active.observedAt; record.observedAt = active.observedAt;
      record.source.provenance = provenance;
    }
    evidence.push({ record, payload });
  };
  let cursor = null, state, error = null, budgetStop = false;
  try {
    if (pass.startsWith('workiq')) cursor = await collectWorkiq(local, run.window, emit,
      async path => consume({ entityUrls: [path] }), pass.split(':')[1],
      { stats, readContext: sourceContext, onMessage: entry => contexts.push(entry) });
    else {
      requireThat(principal, 'ADO identity receipt is required before collection', 'blocked-auth');
      identity(config, principal);
      identityVerified = true;
      cursor = await collectAdo(local, run.window, emit, pass.split(':')[1],
        async (endpoint, body) => consume({ endpoint, body }));
    }
    state = 'complete'; nextRequest = null;
  } catch (failure) {
    if (!['awaiting-receipt', 'partial', ...failures].includes(failure.code)) throw failure;
    state = failure.code === 'awaiting-receipt' || failure.code === 'partial' ? 'partial' : failure.code;
    error = safeError(failure);
    budgetStop = failure.code === 'partial' && [
      'Tool-call budget exhausted; coverage is partial', 'Item budget exhausted; coverage is partial'
    ].includes(failure.message);
  }
  requireThat(currentConsumed === currentCalls.length, 'Unconsumed receipts exceed the approved traversal or budget', 'blocked-budget');
  requireThat(!continuation || !identityVerified ||
    (index >= inherited.length + 1 && stats.examined >= continuation.examinedRecords),
  'Inherited checkpoint no longer reconstructs the recorded examination offset', 'blocked-reconciliation');
  const returned = pass.startsWith('workiq')
    ? Math.max(stats.returned, continuation?.returnedRecords ?? 0)
    : calls.reduce((n, c) => n + (c.response?.workItems?.length ?? 0), 0);
  requireThat(currentCalls.length <= run.limits.maxCalls, 'Imported responses exceed approved read-call limit', 'blocked-budget');
  const examined = pass.startsWith('workiq')
    ? Math.max(stats.examined, continuation?.examinedRecords ?? 0) : Math.min(returned, run.limits.maxItems);
  if (identityVerified && returned > local.limits.maxItems) {
    state = 'partial'; cursor = null; nextRequest = null;
    budgetStop = true;
    error = { code: 'partial', message: 'Response exceeds remaining examined-item budget; extra returned records are unexamined' };
  }
  const inheritedExamined = continuation?.examinedRecords ?? 0;
  return { evidence, contexts, result: { pass, state, error, cursor, nextRequest: error?.code === 'awaiting-receipt' ? nextRequest : null,
    readCalls: currentCalls.length, examinedRecords: examined - inheritedExamined, evidenceCount: evidence.length,
    returnedRecords: returned - (continuation?.returnedRecords ?? 0),
    ...(!pass.startsWith('workiq') ? { returnedRecords: returned } : {
      cumulativeReturnedRecords: returned, cumulativeExaminedRecords: examined,
      inheritedReadCalls: inherited.length, inheritedExaminedRecords: inheritedExamined,
      inheritedBufferedRecords: continuation ? continuation.returnedRecords - inheritedExamined : 0,
      duplicateVersions: stats.duplicates, threadContextCount: contexts.length,
      cumulativeTraversal: { rootVersions: stats.roots, replyVersions: stats.replies, threadsExhausted: stats.threads },
      continuation: state === 'partial' && budgetStop ? {
        kind: 'immutable-receipt-replay', newRunAndAdditionalBudgetRequired: true,
        bufferedRecords: returned - examined, receiptHash: hash(json(calls)),
        sourceContinuationMayExpire: true
      } : null,
      limitations: ['No historical snapshot or complete edit history', 'No delta/watermark optimization established',
        'Coverage requires all roots and replies, including older roots', 'Absence is not a deletion signal']
    }),
    unexaminedReturnedRecords: returned - examined,
    provenance: run.provenance === 'synthetic' ? 'synthetic' : directWorkiqVerified ? 'workiq-cli-verified' : directAdoVerified ? 'authenticated-source' : 'app-tool-reported',
    execution: directWorkiqVerified ? 'local-workiq-cli-stdio' : directAdoVerified ? 'delegated-source-adapter' : 'external-app-tool',
    identityVerification: directWorkiqVerified ? 'cli-fetch-verified-object-id-and-UPN' : directAdoVerified ? 'adapter-verified-tenant-and-object-id; UPN is configured binding' : 'validated-app-reported-principal',
    identityVerified,
    coverage: 'Current source enumeration, not a historical reconstruction',
    classification: 'not-performed', evidenceIds: [] } };
}
export async function appendApp(config, ledger, runId, input, { directAdoVerified = false, directWorkiqVerified = false } = {}) {
  object(input, ['eventId', 'pass', 'calls', 'principal'], ['eventId', 'pass', 'calls']);
  identifier(input.eventId);
  requireThat(passes.includes(input.pass) && input.pass !== 'icm:created', 'Unsupported collection pass');
  requireThat(Array.isArray(input.calls) && input.calls.length > 0, 'Append at least one actual call receipt');
  const run = getRun(ledger, runId);
  requireThat(run.configHash === hash(json(config)), 'Run configuration changed');
  const continuation = workiqContinuation(ledger, runId, input.pass);
  const binding = ledger.db.prepare('SELECT pass FROM app_workiq_continuations WHERE run_id=?').get(runId);
  requireThat(!run.continuationFrom || continuation?.parentRunId === run.continuationFrom,
    'Continuation preparation is incomplete; no receipt accepted', 'blocked-reconciliation');
  requireThat(!binding || binding.pass === input.pass, 'A continuation run is restricted to its bound source pass');
  input.calls.forEach(call => receipt(call, input.pass));
  if (input.principal) identity(config, input.principal);
  const stored = ledger.db.prepare('SELECT body,run_id FROM app_events WHERE id=?').get(input.eventId);
  if (stored) {
    requireThat(stored.run_id === runId && stored.body === json(input), 'Event id reused with different content', 'invalid-record');
    return appStatus(ledger, runId);
  }
  const oldEvents = ledger.db.prepare('SELECT body FROM app_events WHERE run_id=? AND pass=? ORDER BY rowid').all(runId, input.pass).map(r => JSON.parse(r.body));
  const priorPass = ledger.db.prepare('SELECT body FROM app_passes WHERE run_id=? AND pass=?').get(runId, input.pass);
  if (priorPass) {
    const prior = JSON.parse(priorPass.body);
    requireThat(prior.state === 'partial' && prior.nextRequest, 'Pass is terminal or budget exhausted; no retry in this run', 'blocked-reconciliation');
    if (input.pass.startsWith('workiq')) requireThat(
      (prior.execution === 'local-workiq-cli-stdio') === directWorkiqVerified,
      'Cannot change WorkIQ execution binding within a pass');
  }
  const calls = [...oldEvents.flatMap(e => e.calls), ...input.calls];
  requireThat(new Set(calls.map(c => c.id)).size === calls.length, 'Duplicate call receipt identity');
  const principal = input.principal ?? oldEvents.find(e => e.principal)?.principal;
  if (principal) requireThat(oldEvents.every(e => !e.principal || json(e.principal) === json(principal)), 'Principal receipt changed within pass');
  if (continuation) {
    requireThat(hash(json(continuation.calls)) === continuation.callsHash, 'Continuation receipts changed', 'invalid-record');
    requireThat(!calls.some(c => continuation.calls.some(old => old.id === c.id)), 'Receipt identity reused across continuation');
  }
  const replayed = await replay(config, run, input.pass, calls, principal, directAdoVerified, directWorkiqVerified, continuation);
  ledger.transaction(() => {
    const count = ledger.db.prepare('SELECT COUNT(*) n FROM app_events WHERE run_id=? AND pass=?').get(runId, input.pass).n;
    requireThat(count === oldEvents.length, 'Concurrent receipt append; refresh before retrying', 'overlap');
    ledger.db.prepare('INSERT INTO app_events VALUES(?,?,?,?)').run(input.eventId, runId, input.pass, json(input));
    const sourceRun = `${runId}:${input.pass}`;
    ledger.db.prepare('INSERT OR IGNORE INTO runs(id,source,state,started_at,window) VALUES(?,?,?,?,?)')
      .run(sourceRun, input.pass, 'collecting', run.startedAt, json(run.window));
    for (const item of replayed.evidence) replayed.result.evidenceIds.push(ledger.evidence(item.record, item.payload, sourceRun).id);
    for (const entry of replayed.contexts) {
      const id = hash(json([entry.teamId, entry.channelId, entry.rootId, entry.messageId, entry.versionHash, entry.observation.callId]));
      ledger.db.prepare('INSERT OR IGNORE INTO app_thread_context VALUES(?,?,?,?)').run(runId, input.pass, id, json(entry));
    }
    ledger.db.prepare('UPDATE runs SET state=?,finished_at=?,error=? WHERE id=?')
      .run(replayed.result.state, now(), replayed.result.error && json(replayed.result.error), sourceRun);
    ledger.db.prepare('INSERT INTO app_passes VALUES(?,?,?) ON CONFLICT(run_id,pass) DO UPDATE SET body=excluded.body')
      .run(runId, input.pass, json(replayed.result));
    if (replayed.result.state === 'complete') ledger.db.prepare('INSERT INTO cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value')
      .run(`app:${input.pass}`, json(replayed.result.cursor));
  });
  return appStatus(ledger, runId);
}
function installWorkiqContinuation(config, input, provenance, continuation) {
  beginApp(config, { runId: input.runId, dryRun: true, provenance, continuationFrom: input.fromRunId });
  const { ledger } = openApp(config, input.runId);
  try {
    ledger.transaction(() => {
      const existing = workiqContinuation(ledger, input.runId, input.pass);
      requireThat(!existing || json(existing) === json(continuation), 'Continuation binding conflict', 'blocked-reconciliation');
      if (!existing) requireThat(!ledger.db.prepare('SELECT 1 FROM app_events LIMIT 1').get(),
        'Unbound target already has receipts; inspect before recovery', 'blocked-reconciliation');
      ledger.db.prepare('INSERT OR IGNORE INTO app_workiq_continuations VALUES(?,?,?)')
        .run(input.runId, input.pass, json(continuation));
      for (const call of continuation.calls) {
        const bytes = Buffer.from(json(call.response)), digest = hash(bytes);
        ledger.db.prepare('INSERT OR IGNORE INTO captures VALUES(?,?)').run(digest, bytes);
        ledger.db.prepare('INSERT OR IGNORE INTO app_artifacts VALUES(?,?,?)')
          .run(input.runId, `sqlite:capture:${digest}`, 'inherited-workiq-receipt');
      }
    });
    return appStatus(ledger, input.runId);
  } finally { ledger.close(); }
}
export async function prepareWorkiqContinuation(config, input) {
  object(input, ['fromRunId', 'runId', 'pass', 'additionalBudgetApproved']);
  identifier(input.fromRunId); identifier(input.runId);
  requireThat(input.fromRunId !== input.runId && input.additionalBudgetApproved === true,
    'Continuation requires a distinct run and explicit additional-budget authorization');
  requireThat(['workiq:created', 'workiq:changed'].includes(input.pass), 'Only WorkIQ passes support continuation');
  const { ledger: parent, run } = openApp(config, input.fromRunId);
  let owner, child;
  const lock = `cli-workiq:${input.fromRunId}`;
  const operation = `workiq-continuation:${input.fromRunId}:${input.pass}`;
  try {
    owner = parent.acquire(lock);
    requireThat(!parent.db.prepare('SELECT body FROM app_passes WHERE run_id=? AND pass LIKE ?').all(input.fromRunId, 'workiq:%')
      .some(r => JSON.parse(r.body).state === 'blocked-auth'), 'Parent WorkIQ authentication is blocked; no continuation');
    const existing = parent.db.prepare('SELECT state,detail FROM operations WHERE id=?').get(operation);
    if (existing) {
      const detail = JSON.parse(existing.detail);
      requireThat(['started', 'prepared'].includes(existing.state) && json(detail.input) === json(input),
        'Continuation already reserved; reconcile it rather than creating another child', 'blocked-reconciliation');
      if (existing.state === 'started') {
        requireThat(detail.continuation &&
          hash(parent.db.prepare('SELECT body FROM app_passes WHERE run_id=? AND pass=?').get(input.fromRunId, input.pass).body) ===
            detail.continuation.parentPassHash,
        'Reserved continuation lacks an unchanged checkpoint; inspect before recovery', 'blocked-reconciliation');
        const result = installWorkiqContinuation(config, input, run.provenance, detail.continuation);
        parent.finishOperation(operation, 'prepared', { input, childRunId: input.runId, callsHash: detail.continuation.callsHash });
        return result;
      }
      ({ ledger: child } = openApp(config, input.runId));
      requireThat(workiqContinuation(child, input.runId, input.pass)?.parentRunId === input.fromRunId,
        'Prepared continuation binding is missing', 'blocked-reconciliation');
      return appStatus(child, input.runId);
    }
    const priorRow = parent.db.prepare('SELECT body FROM app_passes WHERE run_id=? AND pass=?').get(input.fromRunId, input.pass);
    const prior = priorRow && JSON.parse(priorRow.body);
    requireThat(prior?.state === 'partial' && prior.error?.code === 'partial' && !prior.nextRequest,
      'Only a budget-stopped pass can continue; auth, uncertain and source failures require separate resolution');
    const pending = parent.db.prepare("SELECT 1 FROM operations WHERE state='started' LIMIT 1").get();
    requireThat(!pending, 'Parent has unfinished operations; reconcile offline first', 'blocked-reconciliation');
    const transport = parent.db.prepare('SELECT body FROM app_transport WHERE run_id=? AND pass=?')
      .all(input.fromRunId, input.pass).map(r => JSON.parse(r.body));
    requireThat(transport.every(r => r.state === 'received'), 'Parent has uncertain/failed transport; continuation denied');
    const events = parent.db.prepare('SELECT body FROM app_events WHERE run_id=? AND pass=? ORDER BY rowid')
      .all(input.fromRunId, input.pass).map(r => JSON.parse(r.body));
    const currentCalls = events.flatMap(e => e.calls ?? []);
    requireThat(currentCalls.length && currentCalls.every(c => c.response && !c.failure),
      'Continuation requires successful immutable source receipts');
    const previous = workiqContinuation(parent, input.fromRunId, input.pass);
    const verification = await replay(config, run, input.pass, currentCalls, null, false,
      prior.execution === 'local-workiq-cli-stdio', previous);
    requireThat(verification.result.continuation &&
      verification.result.examinedRecords === prior.examinedRecords &&
      verification.result.readCalls === prior.readCalls,
    'Stored budget stop cannot be reconstructed exactly; no continuation prepared', 'blocked-reconciliation');
    const calls = [...(previous?.calls ?? []), ...currentCalls.slice(1)];
    const origins = { ...(previous?.origins ?? {}) };
    for (const call of currentCalls.slice(1)) origins[call.id] = { runId: input.fromRunId, provenance: prior.provenance };
    const continuation = { parentRunId: input.fromRunId, pass: input.pass, calls, callsHash: hash(json(calls)), origins,
      parentPassHash: hash(priorRow.body),
      examinedRecords: verification.result.cumulativeExaminedRecords,
      returnedRecords: verification.result.cumulativeReturnedRecords,
      additionalBudget: run.limits, preparedAt: now(), authorization: 'explicit-new-run-additional-budget' };
    requireThat(!existsSync(join(directory(config, input.runId, true), 'ledger.sqlite')), 'Target run already exists');
    parent.transaction(() => {
      requireThat(parent.db.prepare('SELECT body FROM app_passes WHERE run_id=? AND pass=?')
        .get(input.fromRunId, input.pass).body === priorRow.body, 'Parent changed during continuation preparation', 'overlap');
      parent.operation(operation, input.fromRunId, 'workiq-continuation-reservation', { input, continuation });
    });
    // Recover the same reserved child offline; never reserve a second child after a crash.
    const result = installWorkiqContinuation(config, input, run.provenance, continuation);
    parent.finishOperation(operation, 'prepared', { input, childRunId: input.runId, callsHash: continuation.callsHash });
    return result;
  } finally {
    child?.close();
    if (owner) parent.release(lock, owner);
    parent.close();
  }
}
export function threadContext(ledger, runId, pass) {
  getRun(ledger, runId);
  requireThat(['workiq:created', 'workiq:changed'].includes(pass), 'Invalid thread-context pass');
  return ledger.db.prepare('SELECT body FROM app_thread_context WHERE run_id=? AND pass=? ORDER BY rowid')
    .all(runId, pass).map(r => JSON.parse(r.body));
}
export function unavailableApp(ledger, runId, input) {
  object(input, ['pass', 'reason']);
  requireThat(input.pass === 'icm:created' && input.reason === 'no-approved-connector', 'Only unavailable IcM declaration supported');
  ledger.db.prepare('INSERT OR IGNORE INTO app_passes VALUES(?,?,?)')
    .run(runId, input.pass, json({ pass: input.pass, state: 'unavailable', reason: input.reason,
      readCalls: 0, examinedRecords: null, evidenceCount: null, evidenceIds: [], identityVerified: false }));
  return appStatus(ledger, runId);
}
export function blockApp(config, ledger, runId, input) {
  object(input, ['eventId', 'pass', 'call']);
  identifier(input.eventId);
  requireThat(['workiq:created', 'workiq:changed'].includes(input.pass) && input.call.failure?.code === 'blocked-auth',
    'External terminal blocker must be a WorkIQ authentication failure');
  receipt(input.call, input.pass);
  const path = input.call.request?.entityUrls?.[0];
  requireThat(input.call.request.entityUrls.length === 1, 'Exactly one failed read path required');
  if (path !== principalPath) {
    const local = structuredClone(config);
    local.sources.workiq.projection = new URL(path, 'https://scope.invalid').searchParams.get('$select');
    validateWorkiqPath(local, path);
  }
  ledger.transaction(() => {
    const previous = ledger.db.prepare('SELECT body FROM app_events WHERE id=?').get(input.eventId);
    if (previous) { requireThat(previous.body === json(input), 'Blocker event identity conflict'); return; }
    const row = ledger.db.prepare('SELECT body FROM app_passes WHERE run_id=? AND pass=?').get(runId, input.pass);
    const prior = row ? JSON.parse(row.body) : { pass: input.pass, readCalls: 0, examinedRecords: 0, evidenceCount: 0, evidenceIds: [], identityVerified: false };
    requireThat(prior.readCalls < getRun(ledger, runId).limits.maxCalls, 'Read-call budget exhausted');
    ledger.db.prepare('INSERT INTO app_events VALUES(?,?,?,?)').run(input.eventId, runId, input.pass, json(input));
    const result = { ...prior, state: 'blocked-auth', partialEvidenceRetained: prior.examinedRecords > 0,
      readCalls: prior.readCalls + 1, nextRequest: null, cursor: null, failure: input.call.failure,
      error: { code: 'blocked-auth', message: 'Latest app-native read requires authentication; no continuation authorized' } };
    ledger.db.prepare('INSERT INTO app_passes VALUES(?,?,?) ON CONFLICT(run_id,pass) DO UPDATE SET body=excluded.body')
      .run(runId, input.pass, json(result));
    ledger.db.prepare('UPDATE runs SET state=?,error=? WHERE id=?').run('blocked-auth', json(result.error), `${runId}:${input.pass}`);
  });
  return appStatus(ledger, runId);
}
export function appStatus(ledger, runId) {
  const run = getRun(ledger, runId);
  const outcomes = new Map(ledger.db.prepare('SELECT pass,body FROM app_passes WHERE run_id=?').all(runId).map(r => [r.pass, JSON.parse(r.body)]));
  const boundPass = ledger.db.prepare('SELECT pass FROM app_workiq_continuations WHERE run_id=?').get(runId)?.pass;
  const collection = passes.filter(pass => pass !== 'workiq:changed' || outcomes.has(pass) || boundPass === pass)
    .map(pass => outcomes.get(pass) ?? { pass, state: 'not-started', evidenceCount: null });
  const summary = { runId, executionMode: 'app-native', provenance: run.provenance, dryRun: run.dryRun,
    agentId: run.agentId, executorSessionId: run.executorSessionId ?? null, window: run.window, limits: run.limits,
    state: collection.every(p => p.state === 'complete') ? 'complete' : 'partial-or-blocked',
    collection, report: report(ledger),
    workers: ledger.db.prepare(
      'SELECT body FROM app_workers WHERE json_extract(body,\'$.runId\')=?'
    ).all(runId).map(r => JSON.parse(r.body)),
    threadContext: { table: 'app_thread_context',
      observations: ledger.db.prepare('SELECT COUNT(*) n FROM app_thread_context WHERE run_id=?').get(runId).n,
      indexedPasses: collection.filter(p => Number.isInteger(p.threadContextCount)).map(p => p.pass),
      purpose: 'Captured root/reply context only; not independently eligible findings' },
    continuation: (() => {
      const row = ledger.db.prepare('SELECT body FROM app_workiq_continuations WHERE run_id=?').get(runId);
      if (!row) return null;
      const c = JSON.parse(row.body);
      return { parentRunId: c.parentRunId, pass: c.pass, inheritedReadCalls: c.calls.length,
        inheritedExaminedRecords: c.examinedRecords, inheritedBufferedRecords: c.returnedRecords - c.examinedRecords,
        callsHash: c.callsHash, additionalBudget: c.additionalBudget, preparedAt: c.preparedAt };
    })(),
    modelCallsByHelper: 0, sourceWritesByHelper: 0, nativeSessionLaunchesByHelper: 0,
    scheduleEnabledByHelper: false, productionLedgerTouched: !run.dryRun,
    sourceArtifacts: ledger.db.prepare('SELECT ref,kind FROM app_artifacts WHERE run_id=?').all(runId),
    sdkWorkiqGate: 'not-applicable; historical SDK auth results are not app-native results',
    evidenceTrust: 'Use per-pass/evidence provenance: imported app receipts are locally validated; CLI reads verify /me. Neither is cryptographic attestation.',
    summaryPath: join(ledger.directory, `${runId}-summary.json`) };
  writeFileSync(summary.summaryPath, json(summary), { mode: 0o600 });
  return summary;
}
export function listAppRuns(config) {
  configured(config);
  const root = join(config.stateDirectory, 'app-native', 'dry-runs');
  const locations = existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => join(root, e.name)) : [];
  locations.push(join(config.stateDirectory, 'app-native', 'live'));
  const runs = [];
  for (const location of locations) {
    if (!existsSync(join(location, 'ledger.sqlite'))) continue;
    const ledger = new Ledger(location);
    try {
      tables(ledger);
      for (const row of ledger.db.prepare('SELECT body FROM app_runs').all()) {
        const run = JSON.parse(row.body);
        runs.push({ runId: run.runId, agentId: run.agentId, dryRun: run.dryRun,
          window: run.window, startedAt: run.startedAt, stateDirectory: location,
          summaryPath: join(location, `${run.runId}-summary.json`) });
      }
    } finally { ledger.close(); }
  }
  return { agentId: config.agent.id, executionMode: 'app-native', runs };
}
export async function importParentReceipts(config, ledger, runId, bundle) {
  requireThat(bundle.format === 'parent-app-source-receipts-v1' && Array.isArray(bundle.receipts) &&
    json(bundle.sourceWindow) === json(getRun(ledger, runId).window),
  'Parent receipt bundle format/window mismatch');
  identifier(bundle.appSessionId); noCredentials(bundle);
  const bytes = Buffer.from(json(bundle)), digest = hash(bytes);
  // Preserve the permitted original envelopes and provenance, independent of the originating session directory.
  ledger.db.prepare('INSERT OR IGNORE INTO captures VALUES(?,?)').run(digest, bytes);
  ledger.db.prepare('INSERT OR IGNORE INTO app_artifacts VALUES(?,?,?)').run(runId, `sqlite:capture:${digest}`, 'original-app-receipt-bundle');
  for (const original of bundle.receipts) {
    requireThat(original.provenance === 'app-tool-reported' && original.appSessionId === bundle.appSessionId &&
      original.toolName === 'workiq-fetch', 'Parent receipt origin mismatch');
    const call = { id: original.toolCallId, tool: original.toolName, actorSessionId: original.appSessionId,
      completionEventId: original.completionEventId, requestedAt: original.requestedAt,
      observedAt: original.observedAt, request: { entityUrls: [original.requestPath] } };
    const result = original.envelope?.results?.[0];
    if (result?.statusCode === 200) {
      call.response = original.envelope;
      await appendApp(config, ledger, runId, { eventId: original.completionEventId, pass: 'workiq:created', calls: [call] });
    } else {
      requireThat(result?.errorCode === 'AuthenticationRequired', 'Unrecognized failure envelope in parent bundle');
      call.failure = { code: 'blocked-auth', statusCode: result.statusCode,
        errorCode: result.errorCode, recoveryAction: result.recoveryAction, requestId: original.envelope.requestId };
      blockApp(config, ledger, runId, { eventId: original.completionEventId, pass: 'workiq:created', call });
    }
  }
  return { ...appStatus(ledger, runId), originalBundleRef: `sqlite:capture:${digest}` };
}
export function appReview(config, ledger, runId, bundle) {
  const run = getRun(ledger, runId);
  requireThat(!run.dryRun, 'Collection-only dry runs cannot review or dispatch');
  return ledger.transaction(() => {
    const reviewed = acceptReview(config, ledger, bundle);
    const id = `app-review:${reviewed.id}:${reviewed.version}`;
    ledger.operation(id, runId, 'external-app-agent-review', { agentId: run.agentId, investigationId: reviewed.id });
    ledger.finishOperation(id, 'recorded', { execution: 'external-app-agent', modelExecutedByHelper: false, review: reviewed.review });
    return reviewed;
  });
}
function worker(ledger, id) {
  const row = ledger.db.prepare('SELECT body FROM app_workers WHERE id=?').get(id);
  requireThat(row, 'Unknown native assignment'); return JSON.parse(row.body);
}
function saveWorker(ledger, value) {
  ledger.db.prepare('UPDATE app_workers SET body=? WHERE id=?').run(json(value), value.id);
  return value;
}
export function appWorker(config, ledger, runId, action, input) {
  const run = getRun(ledger, runId);
  requireThat(!run.dryRun && run.provenance === 'app-tool' && config.activation.dispatch,
    'Native worker activation is disabled for this run');
  noCredentials(input);
  if (action === 'prepare') {
    object(input, ['investigationId', 'repoId', 'intent', 'testCoveragePlanId', 'requestedOutcome'],
      ['investigationId', 'repoId', 'intent']);
    const investigation = ledger.get('investigation', input.investigationId);
    requireThat(investigation && !['closed', 'blocked', 'waiting'].includes(investigation.state), 'Investigation is not dispatchable');
    const assignment = input.testCoveragePlanId
      ? makePlannedImprovementAssignment(config, ledger, investigation, input.testCoveragePlanId,
        input.requestedOutcome ?? 'add-or-update-tests')
      : makeAssignment(config, investigation, input.repoId, input.intent);
    requireThat(assignment.repoId === input.repoId && assignment.intent === input.intent,
      'Prepared assignment does not match the requested repository or intent', 'blocked-scope');
    const latest = new Set(ledger.latestEvidence().map(e => e.id));
    requireThat(assignment.evidenceIds.every(id => latest.has(id) &&
      ['authenticated-source', 'app-tool-reported', 'workiq-cli-verified'].includes(ledger.get('evidence', id).source.provenance) &&
      !ledger.trackedState(ledger.get('evidence', id))), 'Stale, synthetic or reconciled evidence cannot dispatch');
    if (assignment.execution === 'hosted') requireAgencyQualification(config, ledger, agencyTaskId(assignment));
    return ledger.transaction(() => {
      const job = ledger.prepare(assignment, { bucket: json(run.window), maxNew: config.limits.maxAssignments });
      const value = { id: job.id, agentId: `repo-owner:${job.repo}`, coordinatorAgentId: run.agentId,
        state: 'prepared', projectId: assignment.execution === 'hosted' ? null : config.repositories.find(r => r.id === job.repo).projectId,
        repoId: job.repo, runId, assignment, sessionId: null, claimId: null,
        execution: assignment.execution === 'hosted' ? 'agency' : 'external-app-native-session' };
      requireThat(assignment.execution === 'hosted' || value.projectId, 'Native repository project binding is missing');
      ledger.db.prepare('INSERT OR IGNORE INTO app_workers VALUES(?,?)').run(job.id, json(value));
      return worker(ledger, job.id);
    });
  }
  return ledger.transaction(() => {
    object(input, ['assignmentId', 'claimId', 'coordinatorAgentId', 'sessionId', 'projectId', 'workspace',
      'baseRevision', 'outcome', 'evidenceRef', 'agencyRequest', 'agencySubmission', 'agencyResult'], ['assignmentId', 'claimId']);
    identifier(input.claimId);
    const value = worker(ledger, input.assignmentId);
    const before = value.state;
    requireThat(value.runId === runId, 'Assignment belongs to another app run');
    if (action === 'claim') {
      requireThat(input.coordinatorAgentId === run.agentId, 'Only configured coordinator agent may claim');
      if (value.claimId === input.claimId) return value;
      requireThat(value.state === 'prepared', 'Assignment already claimed; reconcile, never relaunch', 'overlap');
      const current = ledger.get('investigation', value.assignment.investigationId);
      requireThat(current?.version === value.assignment.investigationVersion &&
        !['closed', 'blocked', 'waiting'].includes(current.state), 'Investigation changed before native claim', 'blocked-reconciliation');
      requireCurrentAssignment(config, ledger, current, value.assignment);
      if (value.execution === 'agency') requireAgencyQualification(config, ledger, agencyTaskId(value.assignment));
      const latest = new Set(ledger.latestEvidence().map(e => e.id));
      requireThat(value.assignment.evidenceIds.every(id => latest.has(id) &&
        !ledger.trackedState(ledger.get('evidence', id))), 'Evidence changed before native claim', 'blocked-reconciliation');
      const active = activeWorkerCount(ledger);
      requireThat(active < config.limits.maxWorkers, 'Concurrent native worker cap reached', 'blocked-budget');
      value.state = 'claimed'; value.claimId = input.claimId;
    } else {
      requireThat(value.claimId === input.claimId, 'Native assignment claim does not match', 'overlap');
      if (value.execution === 'agency') {
        const taskId = agencyTaskId(value.assignment);
        if (action === 'agency-reserve') {
          requireThat(value.state === 'claimed', 'Only a freshly claimed Agency assignment may reserve a request');
          const current = ledger.get('investigation', value.assignment.investigationId);
          requireThat(current?.version === value.assignment.investigationVersion &&
            !['closed', 'blocked', 'waiting'].includes(current.state), 'Investigation changed before Agency reservation');
          requireCurrentAssignment(config, ledger, current, value.assignment);
          const latest = new Set(ledger.latestEvidence().map(e => e.id));
          requireThat(value.assignment.evidenceIds.every(id => latest.has(id) &&
            !ledger.trackedState(ledger.get('evidence', id))), 'Evidence changed before Agency reservation');
          const reserved = reserveAgencyRequest(config, ledger, taskId, input.agencyRequest);
          value.state = 'uncertain';
          value.requestSha256 = reserved.requestSha256;
          value.agencyTaskId = taskId;
          value.resubmitAllowed = false;
        } else if (action === 'agency-submission') {
          requireThat(['uncertain', 'running', 'blocked'].includes(value.state), 'Agency submission requires a prior reservation');
          const recorded = recordAgencySubmission(ledger, taskId, input.agencySubmission);
          value.providerJobId = recorded.submission.jobId;
          value.state = recorded.submissionState === 'accepted' ? 'running' :
            recorded.submissionState === 'rejected' ? 'blocked' : 'uncertain';
        } else if (action === 'agency-result') {
          const result = reconcileHostedAssignment(ledger, value.id, input.agencyResult);
          value.state = result.verdict.state;
          value.validationQualified = result.verdict.validationQualified;
          value.agencyVerdict = result.verdict;
          value.result = { outcome: result.result.outcome, evidenceRef: result.result.id };
          return saveWorker(ledger, value);
        } else requireThat(false, 'Agency assignments cannot bind or finish through local session/workspace actions');
      } else if (action === 'bind') {
        identifier(input.sessionId);
        const repo = config.repositories.find(r => r.id === value.repoId);
        requireThat(input.projectId === value.projectId && isAbsolute(input.workspace) &&
          /^[a-f0-9]{40,64}$/.test(input.baseRevision), 'Native session binding lacks project/workspace/source revision');
        if (value.assignment.skillQualification)
          verifyRepositorySkillWorkspace(config, value.assignment, input.workspace, input.baseRevision,
            ledger.qualification(skillQualificationId(value.repoId, value.assignment.skillBindingId)));
        const rel = relative(resolve(repo.referenceCheckout), resolve(input.workspace));
        requireThat(rel && (rel.startsWith('..') || isAbsolute(rel)), 'Native worker cannot use primary checkout');
        if (value.sessionId) {
          requireThat(value.sessionId === input.sessionId && value.workspace === input.workspace &&
            value.baseRevision === input.baseRevision, 'Conflicting native session receipt', 'overlap');
          return value;
        }
        requireThat(['claimed', 'uncertain'].includes(value.state), 'Native assignment is not awaiting binding');
        Object.assign(value, { state: 'running', sessionId: input.sessionId, workspace: input.workspace, baseRevision: input.baseRevision });
      } else if (action === 'result') {
        requireThat(value.sessionId && input.sessionId === value.sessionId, 'Result must match bound native session');
        requireThat(['rca-complete', 'blocked', 'draft-reported'].includes(input.outcome) &&
          typeof input.evidenceRef === 'string' && input.evidenceRef.length > 0, 'Native result needs supported outcome and evidence reference');
        const result = { outcome: input.outcome, evidenceRef: input.evidenceRef };
        if (input.outcome === 'rca-complete') requireThat(value.assignment.intent === 'rca-only',
          'Code-change assignments need source-bound validation reconciliation; cannot finish as RCA only');
        if (value.result) { requireThat(json(value.result) === json(result), 'Immutable result conflict'); return value; }
        requireThat(value.state === 'running', 'Assignment is not running');
        value.state = input.outcome === 'rca-complete' ? 'completed' : 'uncertain';
        value.result = result;
        value.validationQualified = false;
      } else if (action === 'uncertain') {
        requireThat(value.state === 'claimed' || value.state === 'uncertain', 'Only unbound launch can be marked uncertain');
        value.state = 'uncertain';
      } else requireThat(false, 'Unknown native worker action');
    }
    ledger.moveJob(value.id, before, value.state);
    if (value.sessionId) ledger.db.prepare('UPDATE jobs SET session_id=? WHERE id=?').run(value.sessionId, value.id);
    return saveWorker(ledger, value);
  });
}
export function appPlanImprovement(config, ledger, runId, input) {
  const run = getRun(ledger, runId);
  requireThat(!run.dryRun && run.provenance === 'app-tool' && config.activation.review,
    'Native improvement planning is disabled for this run');
  noCredentials(input);
  return planImprovement(ledger, input);
}
export async function collectAppAdo(config, ledger, runId, pass, transportFactory = adoTransport) {
  requireThat(['ado:created', 'ado:changed'].includes(pass), 'Expected an approved ADO pass');
  requireThat(!ledger.db.prepare('SELECT 1 FROM app_passes WHERE run_id=? AND pass=?').get(runId, pass),
    'ADO pass already recorded; do not launch duplicate live reads');
  const run = getRun(ledger, runId);
  requireThat(run.provenance === 'app-tool', 'Synthetic run cannot collect live evidence');
  requireThat(!ledger.db.prepare('SELECT body FROM app_passes WHERE run_id=? AND pass LIKE ?').all(runId, 'ado:%')
    .some(row => JSON.parse(row.body).state === 'blocked-auth'), 'ADO authentication is blocked in this run; no cross-pass retry', 'blocked-auth');
  const local = structuredClone(config); local.limits = { ...local.limits, ...run.limits };
  const request = await transportFactory(local), calls = [];
  let authenticated = false;
  const principal = { objectId: config.identity.objectId, tenantId: config.identity.tenantId,
    userPrincipalName: config.identity.designatedUser, verifiedAt: now(), toolCallId: `ado-identity-${uuid()}` };
  const recorder = async (endpoint, body) => {
    const call = { id: uuid(), observedAt: now(), tool: 'ado-delegated-read', request: { endpoint, body } };
    try { call.response = await request(endpoint, body); authenticated = true; }
    catch (error) {
      call.failure = { code: error.code === 'blocked-auth' ? 'blocked-auth' : 'failed-source' };
      calls.push(call);
      ledger.db.prepare('INSERT INTO app_transport VALUES(?,?,?,?)').run(call.id, runId, pass, json(call));
      throw new PilotError(call.failure.code, 'ADO source request failed');
    }
    noCredentials(call);
    ledger.db.prepare('INSERT INTO app_transport VALUES(?,?,?,?)').run(call.id, runId, pass, json(call));
    calls.push(call); return call.response;
  };
  const owner = ledger.acquire(`app-ado:${runId}:${pass}`);
  try {
    ledger.operation(`app-source:${runId}:${pass}`, runId, 'delegated-ado-collection', { pass, execution: 'deterministic-helper' });
    try { await collectAdo(local, run.window, async () => {}, pass.split(':')[1], recorder); }
    catch (error) { if (!['partial', ...failures].includes(error.code)) throw error; }
    // Identity is checked inside adoTransport before any service query; UPN is the configured oid binding.
    if (!authenticated) {
      const failure = calls.at(-1)?.failure ?? { code: 'failed-source' };
      const result = { pass, state: failure.code, readCalls: calls.length, examinedRecords: null,
        evidenceCount: null, identityVerified: false, evidenceIds: [], failure };
      ledger.db.prepare('INSERT INTO app_passes VALUES(?,?,?)').run(runId, pass, json(result));
      ledger.finishOperation(`app-source:${runId}:${pass}`, failure.code, result);
      return appStatus(ledger, runId);
    }
    const result = await appendApp(config, ledger, runId, { eventId: uuid(), pass, calls, principal }, { directAdoVerified: true });
    ledger.finishOperation(`app-source:${runId}:${pass}`, 'recorded', { pass });
    return result;
  } finally { ledger.release(`app-ado:${runId}:${pass}`, owner); }
}
export async function reconcileAppAdo(config, ledger, runId, pass) {
  requireThat(['ado:created', 'ado:changed'].includes(pass), 'Expected approved ADO pass');
  const operation = ledger.db.prepare('SELECT state FROM operations WHERE id=?').get(`app-source:${runId}:${pass}`);
  requireThat(operation?.state === 'started', 'No interrupted deterministic ADO operation to reconcile');
  const calls = ledger.db.prepare('SELECT body FROM app_transport WHERE run_id=? AND pass=? ORDER BY rowid')
    .all(runId, pass).map(r => JSON.parse(r.body));
  requireThat(calls[0]?.response, 'No successful delegated identity/access receipt to reconcile');
  const principal = { objectId: config.identity.objectId, tenantId: config.identity.tenantId,
    userPrincipalName: config.identity.designatedUser, verifiedAt: calls[0].observedAt, toolCallId: calls[0].id };
  const result = await appendApp(config, ledger, runId, { eventId: `reconcile-${runId}-${pass.replace(':', '-')}`,
    pass, calls, principal }, { directAdoVerified: true });
  ledger.finishOperation(`app-source:${runId}:${pass}`, 'recorded', { pass, reconciledFromDurableTransport: true, newSourceReads: 0 });
  return result;
}
