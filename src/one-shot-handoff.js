import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, json, now, requireThat, safeError, utc } from './common.js';
import { noCredentials } from './app-native.js';
import { readOneShotCollectionReceipt } from './one-shot-collection.js';
import { readAgencyRequest, requireAgencyQualification, reserveAgencyRequest } from './agency-executor.js';
import { reconcileFilterExecutionCohort } from './filter-execution.js';
import { validateFilterManifest } from './filter-batches.js';
import { prepareFilterProposerHandoff, validateFilterProposerHandoff } from './filter-handoff.js';
import { dispatch } from './workers.js';

const text = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
function fields(value, keys) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
  'Unexpected one-shot handoff fields', 'invalid-record');
}
function validateInput(input) {
  fields(input, ['format', 'owner', 'collection', 'filter', 'routing', 'authorization']);
  fields(input.collection, ['stateDirectory', 'runId', 'receiptSha256']);
  fields(input.filter, ['manifestPath', 'manifestSha256', 'executionLedgerPath', 'resultPaths']);
  fields(input.authorization, ['approvedBy', 'approvedAt', 'approvalRef', 'deadlineAt',
    'maxFilterRequests', 'maxFilterExecutionSeconds', 'maxFilterReservedTokens', 'maxProposers',
    'maxProposerAiCredits', 'authorizeCommit', 'authorizePush', 'authorizeDraftPR']);
  Object.values(input).forEach(noCredentials);
  const a = input.authorization;
  requireThat(input.format === 'one-shot-handoff-v1' && text(input.owner) &&
    text(input.collection.runId) && digest(input.collection.receiptSha256) &&
    digest(input.filter.manifestSha256) &&
    [input.collection.stateDirectory, input.filter.manifestPath, input.filter.executionLedgerPath]
      .every(path => typeof path === 'string' && isAbsolute(path)) &&
    Array.isArray(input.filter.resultPaths) && input.filter.resultPaths.every(path =>
      typeof path === 'string' && isAbsolute(path)) &&
    new Set(input.filter.resultPaths).size === input.filter.resultPaths.length,
  'One-shot handoff requires exact source, manifest and result locations', 'invalid-record');
  requireThat(text(a.approvedBy) && text(a.approvalRef) &&
    [a.maxFilterRequests, a.maxFilterExecutionSeconds, a.maxFilterReservedTokens].every(integer) &&
    a.maxProposers === 1 && Number.isFinite(a.maxProposerAiCredits) && a.maxProposerAiCredits > 0 &&
    ['authorizeCommit', 'authorizePush', 'authorizeDraftPR'].every(key => typeof a[key] === 'boolean'),
  'Explicit finite whole-cohort FILTER and single-proposer authorization required', 'blocked-budget');
  utc(a.approvedAt); utc(a.deadlineAt);
  requireThat(Date.parse(a.approvedAt) <= Date.now() && Date.parse(a.deadlineAt) > Date.parse(a.approvedAt),
    'Invalid one-shot handoff authorization interval', 'blocked-authorization');
}
function readOnly(path, fn) {
  requireThat(existsSync(path), `Required held input is missing: ${path}`, 'blocked-binding');
  const db = new DatabaseSync(path, { readOnly: true });
  try { return fn({ db, directory: join(path, '..') }); }
  finally { db.close(); }
}
function collectedManifest(config, input) {
  const collected = readOnly(join(input.collection.stateDirectory, 'ledger.sqlite'), ledger =>
    readOneShotCollectionReceipt(config, ledger, input.collection.runId, input.collection.receiptSha256));
  requireThat(collected.mode === 'fresh-local-collection' && collected.sourceCoverageComplete === true &&
    collected.snapshot.sourceSnapshots.every(source => json(source.window) === json(config.window)),
  'Fresh source coverage and exact collection window are required', 'blocked-reconciliation');
  requireThat(existsSync(input.filter.manifestPath), 'FILTER manifest is missing; prepare it with explicit sharing/tokenizer approval',
    'blocked-binding');
  const manifestBytes = readFileSync(input.filter.manifestPath);
  requireThat(hash(manifestBytes) === input.filter.manifestSha256,
    'One-shot FILTER manifest changed', 'blocked-reconciliation');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const corpus = validateFilterManifest(config, manifest);
  requireThat(manifest.budget.mode === 'verified',
    'Fresh one-shot has no qualified estimated-token policy; bounded replay approval cannot be promoted',
    'blocked-budget');
  requireThat(json(manifest.request.sources) === json(collected.snapshot.sources) &&
    hash(json(corpus)) === collected.snapshot.corpusSha256,
  'FILTER does not cover the exact complete collected corpus', 'blocked-reconciliation');
  const a = input.authorization;
  requireThat(manifest.batches.length <= a.maxFilterRequests &&
    input.filter.resultPaths.length === manifest.batches.length,
  'Every selected FILTER batch needs one bound result path within the aggregate request cap', 'blocked-budget');
  return { collected, manifest };
}
const filterBudgetId = input => `one-shot-filter:${hash(json(input.collection))}`;
function filterBudget(ledger, input) {
  const row = ledger.db.prepare('SELECT kind,detail FROM operations WHERE id=?').get(filterBudgetId(input));
  requireThat(row?.kind === 'one-shot-filter-budget',
    'Missing pre-execution aggregate FILTER reservation; historical execution cannot acquire it retroactively',
    'blocked-budget');
  return JSON.parse(row.detail);
}

export function prepareOneShotFilterBudget(config, ledger, input) {
  validateInput(input);
  requireThat(realpathSync(ledger.directory) !== realpathSync(input.collection.stateDirectory) &&
    realpathSync(join(ledger.directory, 'ledger.sqlite')) === realpathSync(input.filter.executionLedgerPath),
  'FILTER reservations must use the declared separate execution ledger', 'blocked-scope');
  const { manifest } = collectedManifest(config, input), id = filterBudgetId(input);
  return ledger.transaction(() => {
    const previous = ledger.db.prepare('SELECT id FROM operations WHERE id=?').get(id);
    if (previous) {
      const value = filterBudget(ledger, input);
      requireThat(value.inputSha256 === hash(json(input)) && value.configSha256 === hash(json(config)),
        'Aggregate FILTER authorization/configuration changed', 'blocked-reconciliation');
      return value;
    }
    requireThat(Date.now() < Date.parse(input.authorization.deadlineAt),
      'FILTER authorization expired before aggregate reservation', 'blocked-budget');
    const bucketId = `one-shot-filter-bucket:${hash(config.agency?.budgetId ?? '')}`;
    requireThat(!ledger.db.prepare('SELECT id FROM operations WHERE id=?').get(bucketId),
      'FILTER bucket already belongs to another one-shot cohort', 'blocked-budget');
    const hasRequests = ledger.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agency_requests'").get();
    requireThat(!hasRequests ||
      !ledger.db.prepare('SELECT 1 FROM agency_requests WHERE budget_id=? LIMIT 1')
        .get(config.agency?.budgetId ?? ''),
    'FILTER bucket contains previous requests; use separately approved isolated execution state',
    'blocked-budget');
    const requests = manifest.batches.map(batch => {
      requireThat(!readAgencyRequest(ledger, batch.id),
        'Aggregate FILTER budget must be reserved before any task; no retroactive approval', 'blocked-budget');
      const { selection, qualification } = requireAgencyQualification(config, ledger, batch.id);
      requireThat(selection.role === 'filter' && selection.resultKind === 'analysis' && !selection.allowPush &&
        selection.payloadSha256 === batch.payloadSha256 &&
        selection.analysisPayloadSha256 === batch.analysisPayloadSha256 &&
        selection.instructionsSha256 === hash(manifest.request.instructions) &&
        !qualification.runtime.estimation &&
        qualification.runtime.modelId === batch.tokenReceipt.model &&
        qualification.runtime.tokenizerId === batch.tokenReceipt.tokenizer &&
        integer(selection.maxExecutionSeconds) && integer(qualification.runtime.maxOutputTokens),
      'FILTER task/source/skill/runtime pins must qualify the complete prepared manifest', 'blocked-qualification');
      return { taskId: batch.id, selectionSha256: hash(json(selection)),
        inputTokens: batch.tokenReceipt.tokens, outputTokens: qualification.runtime.maxOutputTokens,
        executionSeconds: selection.maxExecutionSeconds };
    });
    const reserved = requests.reduce((total, request) => ({
      filterRequests: total.filterRequests + 1,
      filterExecutionSeconds: total.filterExecutionSeconds + request.executionSeconds,
      filterReservedTokens: total.filterReservedTokens + request.inputTokens + request.outputTokens
    }), { filterRequests: 0, filterExecutionSeconds: 0, filterReservedTokens: 0 });
    const a = input.authorization;
    requireThat(integer(config.agency.maxRequests) && config.agency.maxRequests <= a.maxFilterRequests &&
      reserved.filterRequests <= a.maxFilterRequests &&
      reserved.filterExecutionSeconds <= a.maxFilterExecutionSeconds &&
      reserved.filterReservedTokens <= a.maxFilterReservedTokens &&
      Object.values(reserved).every(Number.isSafeInteger),
    'Whole FILTER cohort exceeds its preauthorized aggregate reservation', 'blocked-budget');
    const value = { format: 'one-shot-filter-budget-v1', state: 'reserved-not-submitted',
      dispatchAllowed: false, inputSha256: hash(json(input)), configSha256: hash(json(config)),
      reservedAt: now(), requests, reserved };
    ledger.operation(id, input.collection.runId, 'one-shot-filter-budget', value);
    ledger.finishOperation(id, 'reserved', value);
    ledger.operation(bucketId, input.collection.runId, 'one-shot-filter-bucket', { operationId: id });
    ledger.finishOperation(bucketId, 'reserved', { operationId: id });
    return value;
  });
}

export function reserveOneShotFilterRequest(config, ledger, input, taskId, request) {
  const budget = prepareOneShotFilterBudget(config, ledger, input);
  const planned = budget.requests.find(value => value.taskId === taskId);
  requireThat(planned && Date.now() < Date.parse(input.authorization.deadlineAt) &&
    request?.tokenBudget?.inputTokens === planned.inputTokens,
  'FILTER request must match its pre-reserved task/token allowance before the deadline', 'blocked-budget');
  return reserveAgencyRequest(config, ledger, taskId, request,
    JSON.parse(readFileSync(input.filter.manifestPath, 'utf8')));
}

function acceptedCohort(config, input) {
  const { collected, manifest } = collectedManifest(config, input), a = input.authorization;
  for (const path of input.filter.resultPaths)
    requireThat(existsSync(path), `FILTER result is missing: ${path}; external execution/observation is required`,
      'blocked-binding');
  const resultBytes = input.filter.resultPaths.map(path => readFileSync(path, 'utf8'));
  return readOnly(input.filter.executionLedgerPath, ledger => {
    const budget = filterBudget(ledger, input);
    requireThat(budget.inputSha256 === hash(json(input)) && budget.configSha256 === hash(json(config)),
      'Original aggregate FILTER authorization/configuration changed', 'blocked-reconciliation');
    const requests = manifest.batches.map(batch => readAgencyRequest(ledger, batch.id));
    requireThat(requests.every(Boolean),
      'Missing FILTER reservation; configure qualified task/request/source pins and the external executor', 'blocked-binding');
    const reservations = ledger.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agency_requests'").get()
      ? ledger.db.prepare('SELECT task_id,budget_id FROM agency_requests WHERE budget_id=?')
        .all(config.agency?.budgetId ?? '') : [];
    requireThat(integer(config.agency?.maxRequests) && config.agency.maxRequests <= a.maxFilterRequests &&
      reservations.length === requests.length &&
      reservations.every(row => manifest.batches.some(batch => batch.id === row.task_id)),
    'One-shot FILTER requires a dedicated finite request bucket for the entire selected cohort', 'blocked-budget');
    let seconds = 0, tokens = 0;
    for (const request of requests) {
      requireThat(Date.parse(request.reservedAt) >= Date.parse(collected.completedAt) &&
        Date.parse(request.reservedAt) >= Date.parse(budget.reservedAt) &&
        Date.parse(request.reservedAt) >= Date.parse(a.approvedAt) &&
        Date.parse(request.reservedAt) < Date.parse(a.deadlineAt),
      'FILTER reservation predates collection/authorization or exceeds its deadline; replay is not fresh execution',
      'blocked-authorization');
      const planned = budget.requests.find(value => value.taskId === request.taskId);
      requireThat(planned && hash(json(request.selection)) === planned.selectionSha256 &&
        request.tokenBudget.inputTokens === planned.inputTokens &&
        request.runtime.maxOutputTokens === planned.outputTokens &&
        request.selection.maxExecutionSeconds === planned.executionSeconds,
      'FILTER request differs from the pre-execution aggregate reservation', 'blocked-budget');
      requireThat(integer(request.selection.maxExecutionSeconds) &&
        integer(request.tokenBudget.inputTokens) && integer(request.runtime.maxOutputTokens),
      'FILTER execution duration/input/output token reservations are unknown', 'blocked-budget');
      seconds += request.selection.maxExecutionSeconds;
      tokens += request.tokenBudget.inputTokens + request.runtime.maxOutputTokens;
    }
    requireThat(Number.isSafeInteger(seconds) && seconds <= a.maxFilterExecutionSeconds &&
      Number.isSafeInteger(tokens) && tokens <= a.maxFilterReservedTokens,
    'Aggregate FILTER duration or reserved-token budget exceeded', 'blocked-budget');
    // Structural consolidation alone is insufficient; grade the original immutable executions.
    const cohort = reconcileFilterExecutionCohort(config, ledger, manifest, resultBytes);
    requireThat(cohort.state === 'complete-held',
      'FILTER execution cohort is missing, failed, conflicting or unqualified; proposer remains held',
      'blocked-reconciliation');
    return { collectionReceiptSha256: input.collection.receiptSha256,
      manifestSha256: input.filter.manifestSha256,
      results: input.filter.resultPaths.map((path, index) => ({ path, sha256: hash(resultBytes[index]) })),
      requests: requests.map(request => ({ taskId: request.taskId, requestSha256: request.requestSha256,
        receiptSha256: hash(json(request)), jobId: request.submission?.jobId })),
      reserved: { filterRequests: requests.length, filterExecutionSeconds: seconds, filterReservedTokens: tokens },
      aggregateReservationSha256: hash(json(budget)),
      sourceCoverageComplete: true, semanticAnalysisVerifiedByHelper: false, cohort };
  });
}
function operation(ledger, id) {
  const row = ledger.db.prepare('SELECT kind,detail FROM operations WHERE id=?').get(id);
  requireThat(row?.kind === 'one-shot-handoff', 'Missing one-shot handoff operation', 'blocked-reconciliation');
  return JSON.parse(row.detail);
}
function save(ledger, id, detail) {
  ledger.finishOperation(id, detail.state, detail);
  return { format: 'one-shot-handoff-status-v1', operationId: id, ...detail,
    dispatchAllowed: false, externalFilterBinding: 'not-provided-by-this-helper' };
}
function preDispatchAuthProof(ledger, detail) {
  const job = ledger.job(detail.assignment.id), assignment = ledger.get('assignment', detail.assignment.id);
  requireThat(job?.state === 'prepared' && job.session_id === detail.assignment.attemptId &&
    !job.workspace && !job.base_revision && assignment?.execution === 'local' &&
    hash(json(assignment)) === detail.assignment.sha256 &&
    !ledger.db.prepare('SELECT 1 FROM operations WHERE job_id=? LIMIT 1').get(job.id) &&
    !ledger.all('workerResult').some(result => result.assignmentId === job.id) &&
    !ledger.workspaceCleanup(job.id),
  'Authentication retry requires a positively unstarted local assignment with no worker/provider operations',
  'blocked-reconciliation');
  return hash(json({ job, assignment }));
}
function reconcileProposer(ledger, detail) {
  const job = ledger.job(detail.assignment.id);
  requireThat(job && job.session_id === detail.assignment.attemptId &&
    hash(json(ledger.get('assignment', job.id))) === detail.assignment.sha256,
    'Prepared proposer assignment changed', 'blocked-reconciliation');
  const results = ledger.all('workerResult').filter(result =>
    result.assignmentId === job.id && result.attemptId === job.session_id);
  if (job.state === 'completed' && results.length === 1) {
    const result = results[0], assignment = ledger.get('assignment', job.id);
    requireThat(result.outcome === 'draft-pr-validated' && result.draftPR?.isDraft === true &&
      result.draftPR.headRevision === result.sourceRevision &&
      assignment.validationGates.length > 0 &&
      result.validation.length === assignment.validationGates.length &&
      assignment.validationGates.every(gateId => result.validation.some(gate =>
        gate.gateId === gateId && gate.status === 'passed' && gate.sourceRevision === result.sourceRevision)),
    'Proposer result lacks every exact-head passing publication gate', 'blocked-reconciliation');
    detail.state = 'completed';
    detail.result = { id: result.id, sha256: hash(json(result)), outcome: result.outcome,
      sourceRevision: result.sourceRevision, draftPR: result.draftPR };
    detail.blocker = null;
  } else {
    detail.state = 'blocked';
    detail.blocker = { code: 'blocked-reconciliation',
      action: `Proposer ${job.id} is ${job.state}; inspect its existing attempt/operations. Never redispatch an uncertain or sealed attempt.` };
  }
}

export async function advanceOneShotHandoff(config, ledger, input, {
  execute = false, resumeAuth = false, dispatchDependencies = {}
} = {}) {
  config = structuredClone(config);
  input = structuredClone(input);
  validateInput(input);
  requireThat(config.statePolicy.accessApproved === true && config.schedule.enabled === false &&
    realpathSync(config.stateDirectory) === realpathSync(ledger.directory),
  'One-shot handoff requires its approved local proposer ledger and disabled scheduling');
  const collectionKey = json([realpathSync(input.collection.stateDirectory), input.collection.runId]);
  requireThat(realpathSync(input.collection.stateDirectory) !== realpathSync(ledger.directory),
    'Collection-only state must remain separate from proposer state', 'blocked-scope');
  const id = `one-shot-handoff:${hash(collectionKey)}`, owner = ledger.acquire(id);
  let detail;
  try {
    const prior = ledger.db.prepare('SELECT id FROM operations WHERE id=?').get(id);
    if (!prior) ledger.operation(id, input.collection.runId, 'one-shot-handoff', {
      input, inputSha256: hash(json(input)), configSha256: hash(json(config)), state: 'held',
      accepted: null, assignment: null, dispatchStarted: false, authRequired: false,
      authRetryUsed: false, result: null, blocker: null
    });
    detail = operation(ledger, id);
    requireThat(detail.inputSha256 === hash(json(input)) && detail.configSha256 === hash(json(config)),
      'One-shot handoff request/configuration changed; preserve the original cohort and permissions',
      'blocked-reconciliation');
    requireThat(!resumeAuth || (detail.dispatchStarted && detail.authRequired && !detail.authRetryUsed),
      'Auth resume requires the original positive pre-dispatch block and unused explicit retry',
      'blocked-reconciliation');
    const accepted = acceptedCohort(config, input);
    if (detail.accepted) requireThat(json(detail.accepted) === json(accepted),
      'Accepted FILTER execution/result pins changed', 'blocked-reconciliation');
    else detail.accepted = accepted;
    if (!accepted.cohort.consolidation.selected) {
      detail.state = 'complete-no-candidate';
      detail.blocker = null;
      return save(ledger, id, detail);
    }
    if (detail.dispatchStarted) {
      if (detail.authRequired && resumeAuth) {
        requireThat(execute && !detail.authRetryUsed &&
          detail.preDispatchAuthSha256 === preDispatchAuthProof(ledger, detail),
        'Only one explicitly requested retry after confirmed pre-dispatch auth recovery is allowed',
        'blocked-reconciliation');
      } else {
        if (!detail.authRequired || ledger.job(detail.assignment.id)?.state !== 'prepared')
          reconcileProposer(ledger, detail);
        return save(ledger, id, detail);
      }
    }
    detail.blocker = null;
    const handoff = { format: 'filter-proposer-handoff-v1',
      filter: { manifestPath: input.filter.manifestPath, resultPaths: input.filter.resultPaths },
      routing: input.routing };
    if (!execute) {
      detail.state = 'complete-held';
      return save(ledger, id, detail);
    }
    const a = input.authorization;
    requireThat(Date.now() < Date.parse(a.deadlineAt), 'Proposer release authorization expired', 'blocked-budget');
    const { skill } = validateFilterProposerHandoff(config, handoff);
    requireThat(a.authorizeCommit && a.authorizePush && a.authorizeDraftPR &&
      skill.sideEffects.commit && skill.sideEffects.push && skill.sideEffects.createDraftPR &&
      config.activation.dispatch === true,
    'Separately authorized commit, push, draft and repository skill permissions are required',
    'blocked-authorization');
    const sessions = 1 + config.limits.maxValidationRepairRounds;
    requireThat([config.limits.maxAssignments, config.limits.maxWorkers,
      config.limits.workerMaxToolCalls].every(integer) && integer(sessions) &&
      Number.isFinite(config.limits.workerMinutes) && config.limits.workerMinutes > 0 &&
      Number.isFinite(config.limits.maxAiCreditsPerSession) && config.limits.maxAiCreditsPerSession > 0 &&
      config.limits.maxAiCreditsPerSession * sessions <= a.maxProposerAiCredits,
    'Finite proposer time/tool/worker limits and whole-run model-session credit reservation are required',
    'blocked-budget');
    ledger.transaction(() => {
      const prepared = prepareFilterProposerHandoff(config, ledger, handoff);
      requireThat(prepared.assignment.execution === 'local',
        'One-shot proposer requires the existing local executor; no hosted fallback', 'blocked-binding');
      requireThat(prepared.job.state === 'prepared',
        'Existing proposer attempt must be reconciled, never redispatched', 'blocked-reconciliation');
      if (detail.assignment) requireThat(detail.assignment.id === prepared.assignment.id &&
        detail.assignment.sha256 === hash(json(prepared.assignment)) &&
        detail.assignment.attemptId === prepared.job.session_id,
      'Auth recovery changed the original prepared assignment', 'blocked-reconciliation');
      if (detail.authRequired) {
        detail.authRetryUsed = true;
        detail.authRequired = false;
      }
      detail.assignment = { id: prepared.assignment.id, sha256: hash(json(prepared.assignment)),
        attemptId: prepared.job.session_id };
      detail.dispatchStarted = true;
      detail.reservedProposerAiCredits = config.limits.maxAiCreditsPerSession * sessions;
      detail.state = 'dispatching';
      save(ledger, id, detail);
    });
    const result = await dispatch(config, ledger, detail.assignment.id, dispatchDependencies);
    if (result.state === 'action-required-auth') {
      requireThat(result.id === detail.assignment.id && result.assignmentId === detail.assignment.id &&
        Array.isArray(result.actions) && result.actions.length > 0,
      'Unrecognized authentication outcome cannot authorize a retry', 'blocked-reconciliation');
      detail.preDispatchAuthSha256 = preDispatchAuthProof(ledger, detail);
      detail.state = 'blocked';
      detail.authRequired = true;
      detail.blocker = { code: 'action-required-auth', action: detail.authRetryUsed
        ? 'Authentication still required after the single authorized retry; stop and resolve externally.'
        : 'Complete the existing approved authentication recovery, then explicitly request one resumeAuth retry; never auto-retry.',
        actions: result.actions };
    } else reconcileProposer(ledger, detail);
    return save(ledger, id, detail);
  } catch (error) {
    if (!detail) throw error;
    detail.state = 'blocked';
    detail.blocker = { code: error.code ?? 'blocked-reconciliation', action: safeError(error).message };
    return save(ledger, id, detail);
  } finally { ledger.release(id, owner); }
}
