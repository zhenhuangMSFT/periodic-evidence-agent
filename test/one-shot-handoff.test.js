import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { configAt, hash, json, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { area } from '../src/sources.js';
import { openApp } from '../src/app-native.js';
import { loadFilterCorpus } from '../src/filter.js';
import { prepareFilterBatches, checkFilterBatchResult } from '../src/filter-batches.js';
import { recordAgencySubmission, recordAgencyAnalysisCheck, reconcileAgencyResult } from '../src/agency-executor.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';
import { beginOneShotCollection, advanceOneShotCollection, readOneShotCollectionReceipt } from '../src/one-shot-collection.js';
import { advanceOneShotHandoff, prepareOneShotFilterBudget, reserveOneShotFilterRequest } from '../src/one-shot-handoff.js';

const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const sha = value => hash(bytes(value));
async function setup(t, { candidate = false, terminal = true, workiq = false, gitSource = false,
  filterLimits = {}, empty = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'one-shot-handoff-'));
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'collector');
  config.statePolicy.accessApproved = true;
  config.sources.ado = { enabled: !workiq, scopeApproved: true };
  config.sources.workiq.enabled = workiq;
  config.sources.workiq.scopeApproved = true;
  config.runtime.workiqCli.enabled = true;
  config.dryRun.limits = { maxItems: 10, maxCalls: 10 };
  const collector = new Ledger(config.stateDirectory);
  const collectionInput = { format: 'one-shot-collection-v1', runId: 'fresh', owner: 'test',
    dryRun: true, passes: [workiq ? 'workiq:created' : 'ado:created'],
    authorization: { approvedBy: 'test', approvedAt: now(), approvalRef: 'synthetic-only',
      deadlineAt: new Date(Date.now() + 60000).toISOString(), maxItems: 10, maxCalls: 10 } };
  beginOneShotCollection(config, collector, collectionInput);
  const collected = await advanceOneShotCollection(config, collector, 'fresh', {
    adoTransport: async () => async (endpoint, body) => endpoint === 'wiql'
      ? { asOf: '2026-10-09T00:00:00Z', workItems: empty || body.query.includes('[System.Id] = 0') ? [] : [{ id: 1 }] }
      : { value: [{ id: 1, rev: 1, fields: { 'System.WorkItemType': 'Bug', 'System.AreaPath': area,
        'System.Title': 'Synthetic functional behavior', 'System.State': 'Active',
        'System.CreatedDate': '2026-10-08T01:00:00Z', 'System.ChangedDate': '2026-10-08T02:00:00Z' } }] },
    workiqFactory: async () => ({ read: async path => ({ structuredContent: { results: [{ statusCode: 200,
      data: path.startsWith('/me?') ? { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser }
        : { value: empty || path.includes('/replies') ? [] : [{ id: 'root', createdDateTime: '2026-10-08T01:00:00Z',
          lastModifiedDateTime: '2026-10-08T01:00:00Z', subject: 'Synthetic functional behavior',
          body: { contentType: 'text', content: 'Synthetic body' }, webUrl: 'https://example.invalid/root' }] } }] } }),
      close: async () => {} })
  });
  assert.equal(collected.state, 'held-awaiting-filter', json(collected.blocker));
  const collectionReceipt = readOneShotCollectionReceipt(config, collector, 'fresh');
  const collectionConfig = structuredClone(config);
  const collection = { stateDirectory: config.stateDirectory, runId: 'fresh', receiptSha256: collected.receiptSha256 };
  config.stateDirectory = join(root, 'proposer');
  config.activation.dispatch = true;
  Object.assign(config.limits, { maxItems: 10, maxCalls: 10, workerMaxToolCalls: 20,
    maxWorkers: 2, workerMinutes: 1, maxAiCreditsPerSession: 1, maxValidationRepairRounds: 0 });
  const ledger = new Ledger(config.stateDirectory), execution = new Ledger(join(root, 'filter-execution'));
  t.after(() => { execution.close(); ledger.close(); collector.close(); rmSync(root, { recursive: true, force: true }); });
  let sourceRevision = 'a'.repeat(40);
  if (gitSource) {
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git(['init', '--quiet']);
    git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
      '-c', 'core.hooksPath=missing-hooks', 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic only']);
    sourceRevision = git(['rev-parse', 'HEAD']);
  }
  const skillPath = '.github/skills/integration-test-authoring/SKILL.md';
  config.repositories = [{ id: 'target', projectId: 'fixture', owner: 'test', routingApproved: true,
    qualificationRefresh: 'local', validationContractVersion: '1.0',
    routingRules: ['Synthetic'], referenceCheckout: root, baseRef: 'HEAD', remote: 'https://example.invalid/test.git',
    allowedWritePrefixes: ['test'], allowedWriteFiles: [], commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    validationGates: [{ id: 'synthetic-test', approved: true, isolationVerified: true, executable: process.execPath,
      args: ['--test'], timeoutMs: 10000 }],
    skillBindings: [{ id: 'integration', capability: 'integration-test-authoring', skillPath, enabled: true,
      qualification: 'qualified', requestedOutcomes: ['add-or-update-tests'],
      sideEffects: { commit: true, push: true, createDraftPR: true } }] }];
  const contract = repositoryValidationContract(config.repositories[0]);
  ledger.qualify(skillQualificationId('target', 'integration'), {
    state: 'qualified-read-only', repoId: 'target', bindingId: 'integration', capability: 'integration-test-authoring',
    referenceCheckout: root, remote: config.repositories[0].remote, baseRef: 'HEAD', baseRevision: sourceRevision,
    skillPath, skillSha256: hash('synthetic skill'), qualificationSource: 'local-reference',
    validationContractVersion: contract.version, validationContractSha256: contract.sha256,
    sideEffects: { commit: true, push: true, createDraftPR: true }
  });
  const verificationRef = join(root, 'token-approval.json');
  writeFileSync(verificationRef, '{"synthetic":true}');
  config.filterBatching = { approved: true, mode: 'verified', model: 'synthetic', profile: 'synthetic',
    tokenizer: 'synthetic', verifiedBy: 'test', verifiedAt: now(), verificationRef,
    verificationSha256: hash(readFileSync(verificationRef)), contextTokens: 1000, maxInputTokens: 500,
    maxPayloadBytes: 1000000, maxBatches: 1,
    reserves: { instructions: 10, sourceAnalysis: 20, output: 100, safety: 10, requestOverhead: 5 } };
  const corpus = loadFilterCorpus(config, { format: 'stage2-sources-v1', sources: collectionReceipt.snapshot.sources });
  const request = { format: 'filter-batch-request-v1', sources: collectionReceipt.snapshot.sources,
    instructions: 'Synthetic instructions only', groups: corpus.evidence.map((record, i) =>
      ({ id: `g${i}`, memberIds: [record.id], contextIds: [], reason: 'Synthetic independent report' })),
    groupingReview: { reviewer: 'test', reviewedAt: now(), rationale: 'Synthetic context' },
    sharing: { audience: 'synthetic-only', approvalRef: 'synthetic-only',
      materials: [...new Set([...corpus.evidence.map(sha), ...corpus.captures.map(c => c.sha256),
        ...corpus.contexts.map(c => c.sha256), hash('Synthetic instructions only'),
        sha(corpus.coverage.map(({ runId, coverage }) => ({ runId, coverage })))])]
        .map(sha256 => ({ sha256, eligibility: 'approved', restrictions: ['synthetic-only'] })) } };
  const manifestPath = join(root, 'manifest.json');
  await prepareFilterBatches(config, request, manifestPath, async (_config, input) =>
    ({ sha256: input.sha256, model: input.model, tokenizer: input.tokenizer, tokens: 5 }));
  const manifest = JSON.parse(readFileSync(manifestPath)), batch = manifest.batches[0];
  const resultPath = join(root, 'result.json');
  const input = { format: 'one-shot-handoff-v1', owner: 'test', collection,
    filter: { manifestPath, manifestSha256: hash(readFileSync(manifestPath)),
      executionLedgerPath: join(execution.directory, 'ledger.sqlite'), resultPaths: batch ? [resultPath] : [] },
    routing: { capability: 'integration-test-authoring' },
    authorization: { approvedBy: 'test', approvedAt: now(), approvalRef: 'synthetic-only',
      deadlineAt: new Date(Date.now() + 60000).toISOString(),
      maxFilterRequests: 1, maxFilterExecutionSeconds: 600, maxFilterReservedTokens: 1000,
      maxProposers: 1, maxProposerAiCredits: 1, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true,
      ...filterLimits } };
  config.agency = { profiles: {}, selections: [], budgetId: 'one-shot-fixture',
    maxRequests: 1, maxConcurrent: 1, maxDraftPullRequests: 0, maxExecutionSeconds: 600,
    preflightMaxAgeSeconds: 300, monitorOwner: 'test', monitorCadenceSeconds: 60 };
  if (!batch) {
    prepareOneShotFilterBudget(config, execution, input);
    return { config, ledger, collector, collectionConfig, input, execution, manifest };
  }
  const payload = JSON.parse(JSON.parse(batch.payload).payload);
  const result = { format: 'filter-batch-result-v1', cohortId: manifest.cohortId, batchId: batch.id,
    payloadSha256: batch.analysisPayloadSha256, status: 'complete',
    titles: { format: 'filter-title-decisions-v1', indexSha256: batch.indexSha256, reviewer: 'test', reviewedAt: now(),
      decisions: payload.index.entries.map(e => ({ evidenceId: e.evidenceId, source: e.source,
        captureSha256: e.captureSha256, disposition: e.title ? 'needs-details' : 'no-title',
        exclusionType: null, reason: 'Synthetic review', titleQuote: null })) },
    details: payload.index.entries.map(e => ({ evidenceId: e.evidenceId, recordSha256: e.recordSha256,
      captureSha256: e.captureSha256, status: 'reviewed', reason: 'Synthetic reviewed' })),
    candidates: candidate ? [{ id: 'candidate', evidenceIds: corpus.evidence.map(e => e.id),
      repository: 'target', sourceRevision, layer: 'integration', missingAssertion: 'Synthetic invariant',
      existingCoverage: ['Synthetic inspected assertion'], harness: 'Synthetic harness', coverageStatus: 'gap',
      blockers: [], priority: 50, confidence: 0.8, rationale: 'Synthetic coverage gap' }] : [] };
  writeFileSync(resultPath, bytes(result));
  const profile = { organization: 'synthetic', project: 'synthetic', repository: 'synthetic', initMode: 'lite' };
  const selection = { taskId: batch.id, repoId: 'target', role: 'filter', suiteId: 'analysis',
    profileId: 'synthetic', qualificationId: 'synthetic', qualificationSha256: '',
    sourceRevision, targetRef: 'refs/heads/main', payloadSha256: batch.payloadSha256,
    analysisPayloadSha256: batch.analysisPayloadSha256, instructionsSha256: hash(request.instructions),
    resultKind: 'analysis', allowPush: false, dispatchAllowed: true, maxExecutionSeconds: 600,
    allowedPaths: [], forbiddenPaths: [], caseContract: { cases: [], scenarios: [], commands: [] },
    analysisPolicy: { id: 'local-readonly-filter-v1', approvedBy: 'test', approvedAt: now(), approvalRef: 'synthetic-only' } };
  const q = { status: 'qualified', binding: {
    repoId: selection.repoId, role: selection.role, suiteId: selection.suiteId, profileId: selection.profileId,
    profileSha256: hash(json(profile)), sourceRevision, targetRef: selection.targetRef,
    instructionsSha256: selection.instructionsSha256, caseContractSha256: hash(json(selection.caseContract)),
    analysisPolicy: selection.analysisPolicy
  }, runtime: { modelId: 'synthetic', tokenizerId: 'synthetic', contextTokens: 1000, maxOutputTokens: 100 },
  expiresAt: new Date(Date.now() + 60000).toISOString(), evidenceRef: 'synthetic-only' };
  selection.qualificationSha256 = hash(json(q)); execution.qualify('synthetic', q);
  Object.assign(config.agency, { profiles: { synthetic: profile }, selections: [selection] });
  const wire = json({ organization: profile.organization, project: profile.project, repository: profile.repository,
    targetBranch: 'main', prompt: batch.payload, options: { allowPush: false,
      pullRequest: { create: false, publish: false }, branch: { createSourceBranch: false } }, metadata: { initMode: 'lite' } });
  const reservation = { request: wire, requestSha256: hash(wire),
    preflight: { repoId: 'target', targetRef: selection.targetRef, sourceRevision, observedAt: now(), requestSha256: hash(wire) },
    tokenBudget: { payloadSha256: batch.payloadSha256, modelId: 'synthetic', tokenizerId: 'synthetic', inputTokens: 5 } };
  const budget = prepareOneShotFilterBudget(config, execution, input);
  assert.equal(budget.state, 'reserved-not-submitted');
  assert.deepEqual(prepareOneShotFilterBudget(config, execution, input), budget);
  reserveOneShotFilterRequest(config, execution, input, batch.id, reservation);
  recordAgencySubmission(execution, batch.id, { operation: 'jobs-create', state: 'accepted', requestSha256: hash(wire),
    jobId: 'synthetic-job', httpStatus: 202, observedAt: now() });
  recordAgencyAnalysisCheck(execution, batch.id, bytes(result), value => {
    const checked = checkFilterBatchResult(config, manifest, JSON.parse(value));
    return Object.fromEntries(['state', 'payloadSha256', 'resultSha256', 'validator'].map(key => [key, checked[key]]));
  });
  const refs = [{ ref: 'job-local:synthetic-job:proof', sha256: hash('synthetic-proof') }];
  const terminalInput = { requestSha256: hash(wire), jobId: 'synthetic-job', observedAt: now(),
    provider: { state: 'Completed', result: 'Success' }, pipeline: { id: 'synthetic-build', state: 'completed', result: 'succeeded' },
    runtime: { profileId: 'synthetic', instructionsSha256: selection.instructionsSha256, modelId: 'synthetic', tokenizerId: 'synthetic' },
    source: { repoId: 'target', targetRef: selection.targetRef, baseRevision: sourceRevision, checkoutRevision: sourceRevision,
      outputRevision: null, testedRevision: null, commitParents: null, changedPaths: null,
      unchangedDuringValidation: null, evidenceRefs: refs }, inspection: { approved: true, evidenceRefs: refs },
    publication: null, validation: null, analysis: { payloadSha256: batch.analysisPayloadSha256,
      resultSha256: hash(bytes(result)), validator: 'filter-batch-result-v1', membershipValidated: true, evidenceRefs: refs } };
  if (terminal) assert.equal(reconcileAgencyResult(execution, batch.id, terminalInput).state, 'completed');
  return { config, ledger, collector, collectionConfig, input, execution, manifest, result, resultPath,
    terminalInput, reservation };
}

test('accepted complete no-candidate cohort ends without any proposer, including real-shaped dry-run WorkIQ', async t => {
  for (const workiq of [false, true]) {
    const s = await setup(t, { workiq });
    const status = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true });
    assert.equal(status.state, 'complete-no-candidate', json(status.blocker));
    assert.equal(status.accepted.sourceCoverageComplete, true);
    assert.equal(status.accepted.semanticAnalysisVerifiedByHelper, false);
    assert.equal(status.assignment, null);
    assert.equal(s.ledger.status().jobs.length, 0);
    assert.deepEqual(await advanceOneShotHandoff(s.config, s.ledger, s.input), status);
  }
});

test('a truly empty completed enumeration needs no invented FILTER job or proposer', async t => {
  const s = await setup(t, { empty: true, workiq: true });
  const result = await advanceOneShotHandoff(s.config, s.ledger, s.input);
  assert.equal(result.state, 'complete-no-candidate', json(result.blocker));
  assert.equal(result.accepted.reserved.filterRequests, 0);
  assert.equal(result.accepted.reserved.filterReservedTokens, 0);
  assert.equal(s.ledger.status().jobs.length, 0);
});

test('selected candidate remains held until separately authorized and never starts a worker on a check', async t => {
  const s = await setup(t, { candidate: true, workiq: true });
  const status = await advanceOneShotHandoff(s.config, s.ledger, s.input);
  assert.equal(status.state, 'complete-held', json(status.blocker));
  assert.equal(status.dispatchStarted, false);
  assert.equal(s.ledger.status().jobs.length, 0);
  assert.equal(status.accepted.cohort.consolidation.selected.definition.repository, 'target');
});

test('structural results without accepted execution stay blocked and resume only the original execution', async t => {
  const s = await setup(t, { terminal: false });
  const blocked = await advanceOneShotHandoff(s.config, s.ledger, s.input);
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.blocker.action, /execution cohort/);
  assert.equal(blocked.accepted, null);
  reconcileAgencyResult(s.execution, s.manifest.batches[0].id, s.terminalInput);
  assert.equal((await advanceOneShotHandoff(s.config, s.ledger, s.input)).state, 'complete-no-candidate');
});

test('missing, partial and modified result files cannot be accepted as no candidate', async t => {
  for (const mode of ['missing', 'partial', 'modified']) {
    const s = await setup(t);
    if (mode === 'missing') rmSync(s.resultPath);
    else {
      const value = structuredClone(s.result);
      if (mode === 'partial') value.status = 'partial';
      else value.details[0].reason = 'Changed result';
      writeFileSync(s.resultPath, bytes(value));
    }
    const status = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true });
    assert.equal(status.state, 'blocked');
    assert.equal(status.accepted, null);
    assert.equal(s.ledger.status().jobs.length, 0);
  }
});

test('collection coverage drift blocks even an otherwise accepted empty-candidate execution', async t => {
  const s = await setup(t);
  const { ledger: source } = openApp(s.collectionConfig, 'fresh');
  const result = JSON.parse(source.db.prepare('SELECT body FROM app_passes').get().body);
  result.state = 'partial';
  source.db.prepare('UPDATE app_passes SET body=?').run(json(result)); source.close();
  const status = await advanceOneShotHandoff(s.config, s.ledger, s.input);
  assert.equal(status.state, 'blocked');
  assert.match(status.blocker.action, /unchanged/);
});

test('aggregate FILTER budgets and non-retroactive authorization are mandatory', async t => {
  for (const change of [
    input => { input.authorization.maxFilterExecutionSeconds = 599; },
    input => { input.authorization.maxFilterReservedTokens = 104; },
    input => { input.authorization.approvedAt = new Date(Date.now() + 60000).toISOString(); }
  ]) {
    const s = await setup(t);
    change(s.input);
    if (Date.parse(s.input.authorization.approvedAt) > Date.now())
      await assert.rejects(advanceOneShotHandoff(s.config, s.ledger, s.input), /authorization interval/);
    else assert.equal((await advanceOneShotHandoff(s.config, s.ledger, s.input)).blocker.code, 'blocked-reconciliation');
    assert.equal(s.ledger.status().jobs.length, 0);
  }
});

test('proposer permissions and aggregate credit cap are checked before assignment creation', async t => {
  for (const credits of [false, true]) {
    const s = await setup(t, { candidate: true, filterLimits: credits
      ? { maxProposerAiCredits: 0.5 } : { authorizeDraftPR: false } });
    const status = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true });
    assert.equal(status.state, 'blocked', json(status));
    assert.equal(status.blocker.code, credits ? 'blocked-budget' : 'blocked-authorization');
    assert.equal(s.ledger.status().jobs.length, 0);
  }
});

test('whole-cohort budgets are reserved before any FILTER task, never granted retroactively', async t => {
  for (const filterLimits of [{ maxFilterReservedTokens: 104 }, { maxFilterExecutionSeconds: 599 }])
    await assert.rejects(setup(t, { filterLimits }), /preauthorized aggregate reservation/);
  const s = await setup(t);
  assert.throws(() => reserveOneShotFilterRequest(s.config, s.execution, s.input,
    s.manifest.batches[0].id, s.reservation), /already reserved/);
  s.execution.db.prepare("DELETE FROM operations WHERE kind='one-shot-filter-budget'").run();
  assert.throws(() => prepareOneShotFilterBudget(s.config, s.execution, s.input), /another one-shot cohort/);
  const result = await advanceOneShotHandoff(s.config, s.ledger, s.input);
  assert.equal(result.state, 'blocked');
  assert.match(result.blocker.action, /Missing pre-execution aggregate/);
});

test('CLI FILTER reservation and proposer check preserve exact core results and role authority', async t => {
  const s = await setup(t);
  const configPath = join(s.ledger.directory, 'pilot.local.json'), inputPath = join(s.ledger.directory, 'input.json');
  writeFileSync(configPath, json(s.config)); writeFileSync(inputPath, json(s.input));
  const invoke = (role, action, flags = []) => spawnSync(process.execPath, ['src\\cli.js', 'agent', role,
    action, '--config', configPath, '--file', inputPath, ...flags], { encoding: 'utf8', timeout: 30000 });
  const budget = invoke('filter', 'one-shot-filter-prepare');
  assert.equal(budget.status, 0, budget.stderr);
  assert.equal(JSON.parse(budget.stdout).result.state, 'reserved-not-submitted');
  const checked = invoke('proposer', 'one-shot-handoff', ['--check']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).result.state, 'complete-no-candidate');
  assert.equal(JSON.parse(checked.stdout).acceptance, 'not-inferred');
  const notAllowed = invoke('filter', 'one-shot-handoff', ['--execute']);
  assert.equal(notAllowed.status, 1);
  assert.equal(JSON.parse(notAllowed.stderr).code, 'blocked-agent');
  const missingAuthorization = invoke('proposer', 'one-shot-handoff', ['--execute']);
  assert.equal(missingAuthorization.status, 1);
  assert.equal(JSON.parse(missingAuthorization.stderr).error.code, 'blocked-authorization');
  assert.equal(s.ledger.status().jobs.length, 0);
  writeFileSync(s.resultPath, bytes({ ...s.result, status: 'partial' }));
  const blocked = invoke('proposer', 'one-shot-handoff', ['--check']);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).result.state, 'blocked');
});

test('auth retry rejects newly discovered execution intent even if job state still says prepared', async t => {
  const s = await setup(t, { candidate: true, gitSource: true });
  let attempts = 0;
  const dispatchDependencies = { preflightValidationAuthentication: async () => {
    attempts++;
    return [{ state: 'action-required-auth', reason: 'synthetic-only' }];
  } };
  const first = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true, dispatchDependencies });
  assert.equal(first.blocker.code, 'action-required-auth');
  s.ledger.operation('synthetic-unknown-effect', first.assignment.id, 'push', { revision: 'unknown' });
  const result = await advanceOneShotHandoff(s.config, s.ledger, s.input, {
    execute: true, resumeAuth: true, dispatchDependencies
  });
  assert.equal(result.state, 'blocked');
  assert.match(result.blocker.action, /positively unstarted/);
  assert.equal(attempts, 1);
});

test('dispatch intent survives preflight failure and forbids silent retry or replacement assignment', async t => {
  const s = await setup(t, { candidate: true });
  const first = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true });
  assert.equal(first.state, 'blocked');
  assert.equal(first.dispatchStarted, true, json(first.blocker));
  assert.equal(s.ledger.status().jobs.length, 1);
  const next = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true,
    dispatchDependencies: { preflightValidationAuthentication: () => assert.fail('must not redispatch') } });
  assert.equal(next.state, 'blocked');
  assert.equal(next.assignment.id, first.assignment.id);
  assert.match(next.blocker.action, /Never redispatch/);
  assert.equal(s.ledger.status().jobs.length, 1);
  const changed = structuredClone(s.input); changed.authorization.maxProposerAiCredits = 2;
  const conflict = await advanceOneShotHandoff(s.config, s.ledger, changed, { execute: true });
  assert.match(conflict.blocker.action, /request\/configuration changed/);
});

test('known pre-dispatch authentication block permits only one explicit retry and no automatic loop', async t => {
  const s = await setup(t, { candidate: true, workiq: true, gitSource: true });
  let attempts = 0;
  const dispatchDependencies = { preflightValidationAuthentication: async () => {
    attempts++;
    return [{ state: 'action-required-auth', reason: 'synthetic-only', tokenRequested: false }];
  } };
  const first = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true, dispatchDependencies });
  assert.equal(first.blocker.code, 'action-required-auth', json(first.blocker));
  assert.equal(first.authRequired, true);
  assert.equal(s.ledger.job(first.assignment.id).state, 'prepared');
  assert.equal(s.ledger.all('evidence')[0].source.provenance, 'workiq-cli-verified');
  const held = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true, dispatchDependencies });
  assert.equal(held.blocker.code, 'action-required-auth');
  assert.equal(attempts, 1);
  const retried = await advanceOneShotHandoff(s.config, s.ledger, s.input, {
    execute: true, resumeAuth: true, dispatchDependencies
  });
  assert.equal(retried.authRetryUsed, true);
  assert.equal(retried.blocker.code, 'action-required-auth');
  assert.equal(attempts, 2);
  const blocked = await advanceOneShotHandoff(s.config, s.ledger, s.input, {
    execute: true, resumeAuth: true, dispatchDependencies
  });
  assert.equal(blocked.blocker.code, 'blocked-reconciliation');
  assert.equal(attempts, 2);
  assert.equal(s.ledger.status().jobs.length, 1);
});

test('resume only recognizes a persisted draft with the original attempt and every exact-head passing gate', async t => {
  for (const mode of ['passed', 'wrong-head', 'wrong-gate', 'wrong-attempt', 'extra-gate']) {
    const s = await setup(t, { candidate: true });
    const started = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true });
    assert.equal(started.dispatchStarted, true);
    const assignment = s.ledger.get('assignment', started.assignment.id);
    const revision = 'b'.repeat(40);
    const validation = [{ gateId: mode === 'wrong-gate' ? 'another-gate' : assignment.validationGates[0],
      sourceRevision: mode === 'wrong-head' ? 'c'.repeat(40) : revision,
      status: 'passed', commandOrRunUrl: 'synthetic-only', artifactRefs: ['synthetic:pass'],
      owner: 'test', nextCheckAt: null, attemptCount: 1, blockedReason: null }];
    if (mode === 'extra-gate') validation.push({ ...validation[0], gateId: 'extra-gate' });
    s.ledger.put({
      recordType: 'workerResult', schemaVersion: '1.0', id: 'synthetic-result',
      assignmentId: assignment.id, attemptId: started.assignment.attemptId, reportedAt: now(),
      outcome: 'draft-pr-validated', findings: 'Synthetic terminal receipt only', evidenceIds: assignment.evidenceIds,
      sourceRevision: revision, draftPR: { url: 'https://example.invalid/draft', isDraft: true, headRevision: revision },
      validation, validationAttempts: [{ round: 0, sourceRevision: revision, validation }],
      toolUsage: { limit: 20, used: 0, remaining: 20,
        byTool: { pilot_list: 0, pilot_search: 0, pilot_read: 0, pilot_write: 0, pilot_finish: 0 }, rounds: [] },
      skillExecution: null, blocker: null, nextAction: 'Synthetic test only'
    });
    s.ledger.moveJob(assignment.id, 'prepared', 'completed');
    if (mode === 'wrong-attempt')
      s.ledger.db.prepare('UPDATE jobs SET session_id=? WHERE id=?').run('replacement', assignment.id);
    const status = await advanceOneShotHandoff(s.config, s.ledger, s.input, {
      execute: true, dispatchDependencies: { preflightValidationAuthentication: () => assert.fail('terminal must not dispatch') }
    });
    assert.equal(status.state, mode === 'passed' ? 'completed' : 'blocked', json(status.blocker));
    assert.equal(s.ledger.status().jobs.length, 1);
    if (mode === 'passed') {
      assert.equal(status.result.sourceRevision, revision);
      assert.deepEqual(await advanceOneShotHandoff(s.config, s.ledger, s.input), status);
    }
  }
});
