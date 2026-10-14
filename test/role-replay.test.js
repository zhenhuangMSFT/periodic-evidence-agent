import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configAt, exclusions, hash, json, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { evidenceEnvelope } from '../src/sources.js';
import { acceptReview } from '../src/coordinator.js';
import { planImprovement } from '../src/improvements.js';
import { makePlannedImprovementAssignment, minimalEnvironment } from '../src/workers.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';
import { replayRecordedEvidence, replayRecordedReview, roleExecutionIdentity, verifyRecordedRoleHandoff } from '../src/role-replay.js';
import { continueRoleValidation } from '../src/role-continuation.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'role-replay-'));
  const prior = new Ledger(join(root, 'prior'));
  const audit = new Ledger(join(root, 'audit'));
  const ledgers = [prior, audit];
  t.after(() => { ledgers.forEach(ledger => ledger.close()); rmSync(root, { recursive: true, force: true }); });
  const config = configAt('pilot.example.json');
  config.stateDirectory = audit.directory;
  config.statePolicy.accessApproved = true;
  config.activation = { collect: false, review: true, dispatch: false };
  config.reviewMethod = 'agent-evidence-review';
  config.limits = { ...config.limits, maxItems: 100, workerMaxToolCalls: 20 };
  config.repositories = [{
    id: 'office-agent', projectId: 'fixture-project', owner: 'fixture-owner', routingApproved: true,
    routingRules: ['Fixture coverage'], referenceCheckout: join(root, 'reference'),
    baseRef: 'main', remote: 'https://example.invalid/project/_git/repo',
    allowedWritePrefixes: ['test'], commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    validationGates: [{ id: 'test', approved: true, executable: process.execPath, args: [], timeoutMs: 1000 }],
    skillBindings: [{
      id: 'fixture-skill', capability: 'integration-test-authoring',
      skillPath: 'docs/skill.md', enabled: true, qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'], requiresBehaviorCard: false,
      sideEffects: { commit: false, push: false, createDraftPR: false }
    }]
  }];
  const file = (name, value) => {
    const path = join(root, `${name}.json`);
    writeFileSync(path, json(value));
    return { path, sha256: hash(readFileSync(path)) };
  };
  const payload = { id: 42, rev: 1, fields: { 'System.Title': 'Fixture behavior' } };
  const envelope = evidenceEnvelope('ado', 'example/project', '42', '1',
    'https://example.invalid/item/42', 'fixture', now());
  envelope.source.provenance = 'authenticated-source';
  const runId = prior.startRun('ado:created', config.window);
  const evidence = prior.evidence(envelope, payload, runId);
  prior.finishRun(runId, 'complete');
  const investigation = {
    recordType: 'investigation', schemaVersion: '1.0',
    id: `investigation-${hash(json([evidence.source.namespace, evidence.source.recordId]))}`, version: 1,
    evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'Established behavior needs a regression assertion.',
    expectedBehavior: 'Keep the established behavior covered.', hypotheses: [], counterEvidence: [],
    classification: 'functional', defectConfirmation: 'unconfirmed', reportEligibility: 'included',
    handoffEligibility: 'eligible', exclusionReasons: [], rationale: 'Recorded fixture review.', confidence: 0.9,
    review: { method: config.reviewMethod, reviewer: 'original-reviewer', reviewedAt: now() },
    repoIds: ['office-agent'], existingFixes: [], nextAction: 'Add the bounded assertion.'
  };
  const review = { investigation, exclusionsChecked: exclusions };
  acceptReview(config, prior, review);
  const planningInput = {
    improvement: {
      investigationIds: [investigation.id], category: 'missing-test-coverage', theme: 'Fixture behavior',
      observedBehavior: investigation.observedBehavior, expectedBehavior: investigation.expectedBehavior,
      rationale: 'Recorded bounded improvement.', repoIds: ['office-agent'],
      capabilities: ['integration-test-authoring']
    },
    testCoverage: {
      repoId: 'office-agent', capability: 'integration-test-authoring', sourceRevision: 'a'.repeat(40),
      searchStatus: 'complete', existingTests: [], coverageGaps: ['Missing fixture assertion.'],
      unknowns: [], rationale: 'Recorded source-bound inventory.'
    }
  };
  const planned = planImprovement(prior, planningInput);
  const contract = repositoryValidationContract(config.repositories[0]);
  prior.qualify(skillQualificationId('office-agent', 'fixture-skill'), {
    state: 'qualified-read-only', repoId: 'office-agent', bindingId: 'fixture-skill',
    capability: 'integration-test-authoring', remote: config.repositories[0].remote,
    baseRef: 'main', baseRevision: 'a'.repeat(40), skillPath: 'docs/skill.md',
    skillSha256: 'b'.repeat(64), qualificationSource: 'local-reference',
    validationContractVersion: contract.version, validationContractSha256: contract.sha256,
    sideEffects: { commit: false, push: false, createDraftPR: false }
  });
  const assignment = makePlannedImprovementAssignment(config, prior, investigation, planned.testCoveragePlan.id);
  prior.put(assignment);
  const collectorInput = {
    format: 'recorded-evidence-replay-v1',
    evidence: [{ record: file('evidence', evidence), capture: file('capture', payload) }]
  };
  const filterInput = {
    format: 'recorded-review-replay-v1',
    inputProvenance: { mode: 'captured-inputs' },
    review: file('review', review), improvement: file('improvement', planned.improvement),
    testCoveragePlan: file('plan', planned.testCoveragePlan),
    planningInput: file('planning-input', planningInput), assignment: file('assignment', assignment)
  };
  return { root, prior, audit, ledgers, config, file, evidence, review, assignment, planningInput,
    collectorInput, filterInput };
}

async function replay(fixture) {
  const collected = await replayRecordedEvidence(fixture.config, fixture.audit, fixture.collectorInput);
  const filtered = await replayRecordedReview(fixture.config, fixture.audit, {
    ...fixture.filterInput, collectorReceipt: collected.recordedRoleHandoff
  });
  return { collected, filtered };
}

test('role identity Git commands use the minimal environment rather than parent overrides', async t => {
  const f = setup(t);
  const saved = { GIT_DIR: process.env.GIT_DIR, PILOT_ROLE_TEST_TOKEN: process.env.PILOT_ROLE_TEST_TOKEN };
  try {
    process.env.GIT_DIR = join(f.root, 'not-a-git-directory');
    process.env.PILOT_ROLE_TEST_TOKEN = 'fixture-package-value';
    assert.equal(minimalEnvironment().PILOT_ROLE_TEST_TOKEN, undefined);
    const identity = await roleExecutionIdentity('collector');
    assert.match(identity.controllerRevision, /^[a-f0-9]{40}$/);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('role CLI imports captured-record fixtures and replays decisions without workers', t => {
  const f = setup(t);
  const configPath = f.file('held.local', f.config).path;
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const invoke = (role, operation, input) => {
    const result = spawnSync(process.execPath, ['--no-warnings', cli, 'agent', role, operation,
      '--file', f.file(`${role}-input`, input).path, '--config', configPath],
    { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const collected = invoke('collector', 'replay-evidence', f.collectorInput);
  const filtered = invoke('filter', 'replay-review', {
    ...f.filterInput, collectorReceipt: collected.result.recordedRoleHandoff
  });
  assert.equal(collected.acceptance, 'not-inferred');
  assert.equal(collected.result.freshCollection, false);
  assert.equal(filtered.result.freshReview, false);
  assert.equal(filtered.result.completeCohortAcceptance, false);
  assert.equal(filtered.result.held, true);
  assert.equal(filtered.result.dispatchAllowed, false);
  assert.deepEqual(f.audit.get('evidence', f.evidence.id), f.evidence);
  assert.deepEqual(f.audit.get('investigation', f.review.investigation.id), f.review.investigation);
  assert.match(filtered.result.execution.controllerRevision, /^[a-f0-9]{40}$/);
  assert.equal(filtered.result.execution.skill.name, 'evidence-filter');
  assert.equal(f.audit.status().jobs.length, 0);
  assert.equal(f.audit.all('assignment').length, 0);
  const verified = verifyRecordedRoleHandoff(filtered.result.recordedRoleHandoff, f.prior, f.assignment.id);
  assert.equal(verified.assignmentId, f.assignment.id);
});

test('recorded role replay is idempotent and preserves original timestamps and decision versions', async t => {
  const f = setup(t);
  const first = await replay(f);
  const second = await replay(f);
  assert.deepEqual(second, first);
  assert.equal(f.audit.status().runs.length, 1);
  assert.equal(f.audit.status().operations.length, 2);
  assert.equal(f.audit.get('testCoveragePlan', f.assignment.testCoveragePlanId).version, 1);
});

test('changed capture and synthetic source imports fail before writing evidence', async t => {
  const f = setup(t);
  writeFileSync(f.collectorInput.evidence[0].capture.path, '{}');
  await assert.rejects(replayRecordedEvidence(f.config, f.audit, f.collectorInput), /input changed/);
  assert.equal(f.audit.all('evidence').length, 0);
  f.collectorInput.evidence[0].record = f.file('synthetic-evidence',
    { ...f.evidence, source: { ...f.evidence.source, provenance: 'synthetic' } });
  await assert.rejects(replayRecordedEvidence(f.config, f.audit, f.collectorInput), /synthetic evidence/);
});

test('missing exclusion checks and altered planning inputs cannot create a recorded handoff', async t => {
  const f = setup(t);
  const collected = await replayRecordedEvidence(f.config, f.audit, f.collectorInput);
  const input = { ...f.filterInput, collectorReceipt: collected.recordedRoleHandoff };
  input.review = f.file('incomplete-review', { ...f.review, exclusionsChecked: [] });
  await assert.rejects(replayRecordedReview(f.config, f.audit, input), /exclusion/i);
  assert.equal(f.audit.all('investigation').length, 0);
  input.review = f.filterInput.review;
  input.planningInput = f.file('changed-planning', {
    ...f.planningInput, testCoverage: { ...f.planningInput.testCoverage, rationale: 'Different decision.' }
  });
  await assert.rejects(replayRecordedReview(f.config, f.audit, input), /original decision/);
  assert.equal(f.audit.all('investigation').length, 0);
  assert.equal(f.audit.all('areaToImprove').length, 0);
});

test('held replay never grants collection or dispatch activation', async t => {
  const f = setup(t);
  f.config.activation.dispatch = true;
  await assert.rejects(replayRecordedEvidence(f.config, f.audit, f.collectorInput), /disabled/);
  assert.equal(f.audit.all('evidence').length, 0);
});

test('recorded evidence replay enforces the exact configured item ceiling', async t => {
  const f = setup(t);
  f.config.limits.maxItems = 1;
  const oversized = { ...f.collectorInput, evidence: [
    ...f.collectorInput.evidence, ...f.collectorInput.evidence
  ] };
  await assert.rejects(replayRecordedEvidence(f.config, f.audit, oversized), /configured item bound/);
  assert.equal(f.audit.all('evidence').length, 0);
  const accepted = await replayRecordedEvidence(f.config, f.audit, f.collectorInput);
  assert.equal(accepted.recordReferences.length, 1);
});

test('handoff verification rejects changed receipts and superseded records', async t => {
  const f = setup(t);
  const { filtered } = await replay(f);
  const ref = filtered.recordedRoleHandoff;
  assert.throws(() => verifyRecordedRoleHandoff({ ...ref, sha256: '0'.repeat(64) },
    f.prior, f.assignment.id), /receipt is missing, incomplete or changed/);
  const investigation = f.prior.get('investigation', f.assignment.investigationId);
  f.prior.put({ ...investigation, version: 2, nextAction: 'Superseded decision.' });
  assert.throws(() => verifyRecordedRoleHandoff(ref, f.prior, f.assignment.id), /superseded source records/);
});

test('recovered inputs stay labeled and require unchanged original recovery artifacts', async t => {
  const f = setup(t);
  const notebook = f.file('recorded-notebook', { reason: f.review.investigation.rationale });
  f.filterInput.inputProvenance = { mode: 'recovered-input-projection', sources: [notebook] };
  const { filtered } = await replay(f);
  assert.deepEqual(filtered.inputProvenance, f.filterInput.inputProvenance);
  assert.equal(filtered.freshReview, false);
  writeFileSync(notebook.path, '{}');
  await assert.rejects(replay(f), /input changed/);
});

test('handoff verification requires original captured bytes in both ledgers', async t => {
  const f = setup(t);
  const { filtered } = await replay(f);
  f.audit.db.prepare('DELETE FROM captures WHERE hash=?').run(f.evidence.capture.sha256);
  assert.throws(() => verifyRecordedRoleHandoff(filtered.recordedRoleHandoff, f.prior, f.assignment.id),
    /capture changed/);
});

test('a structurally valid different review is not accepted as the original review', async t => {
  const f = setup(t);
  f.filterInput.review = f.file('different-review', {
    ...f.review, investigation: { ...f.review.investigation, hypotheses: ['An unapproved different hypothesis.'] }
  });
  const { filtered } = await replay(f);
  assert.throws(() => verifyRecordedRoleHandoff(filtered.recordedRoleHandoff, f.prior, f.assignment.id),
    /changed or superseded source records/);
});

test('continuation CLI requires one explicit mode before configuration access', t => {
  const f = setup(t);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  for (const flags of [[], ['--prepare', '--execute']]) {
    const result = spawnSync(process.execPath, ['--no-warnings', cli, 'agent', 'proposer',
      'continue-local-validation', ...flags, '--file', join(f.root, 'missing.json'),
      '--config', join(f.root, 'missing-config.json')], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr);
    assert.equal(error.role, 'proposer');
    assert.equal(error.error.code, 'blocked-authorization');
    assert.match(error.error.message, /exactly one/);
  }
});

test('continuation adapter requires real replay linkage and retains canonical preparation guards', async t => {
  const f = setup(t);
  await assert.rejects(continueRoleValidation(f.config, f.audit, {}, 'prepare'),
    /actual recorded Collector\/FILTER handoff/);
  await assert.rejects(continueRoleValidation(f.config, f.audit, { assignmentId: f.assignment.id }, 'execute'),
    /no prepared Collector\/FILTER handoff/);
  const { filtered } = await replay(f);
  const previousConfig = { ...f.config, stateDirectory: f.prior.directory };
  const previousConfigPath = f.file('previous-config.local', previousConfig).path;
  await assert.rejects(continueRoleValidation(f.config, f.audit, {
    previousConfigPath, previousAssignmentId: f.assignment.id,
    recordedRoleHandoff: filtered.recordedRoleHandoff, authorization: {}, preservedProposal: {}
  }, 'prepare'), /explicitly pinned LFS materialization/);
  assert.equal(f.prior.status().operations.length, 0);
  assert.equal(f.audit.status().jobs.length, 0);
});

test('continuation execution reaches the canonical dispatcher without weakening its activation gate', async t => {
  const f = setup(t);
  const { filtered } = await replay(f);
  const worker = new Ledger(join(f.root, 'worker'));
  f.ledgers.push(worker);
  const workerConfig = { ...f.config, executionMode: 'standalone-sdk', stateDirectory: worker.directory };
  const job = worker.prepare(f.assignment);
  const detail = {
    previousConfigPath: f.file('previous.local', { ...f.config, stateDirectory: f.prior.directory }).path,
    previousAssignmentId: f.assignment.id, recordedRoleHandoff: filtered.recordedRoleHandoff,
    nextAssignmentId: f.assignment.id, nextAttemptId: job.session_id
  };
  const link = `${f.assignment.id}:recorded-role-handoff`;
  worker.operation(link, f.assignment.id, 'recorded-role-handoff', detail);
  worker.finishOperation(link, 'recorded', detail);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, ['--no-warnings', cli, 'agent', 'proposer',
    'continue-local-validation', '--execute',
    '--file', f.file('execute', { assignmentId: f.assignment.id }).path,
    '--config', f.file('worker.local', workerConfig).path], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stderr).error.message, /Worker dispatch is disabled/);
  const trace = worker.status().operations.find(row => row.kind === 'role-validation-execution');
  assert.equal(trace.state, 'failed');
  assert.match(JSON.parse(trace.detail).execution.controllerRevision, /^[a-f0-9]{40}$/);
  assert.equal(worker.all('workerResult').length, 0);
  assert.equal(worker.job(f.assignment.id).state, 'prepared');
});

test('continuation execution rechecks the pinned original authoring identity before dispatch', async t => {
  const f = setup(t);
  const { filtered } = await replay(f);
  const worker = new Ledger(join(f.root, 'worker'));
  f.ledgers.push(worker);
  const workerConfig = { ...f.config, executionMode: 'standalone-sdk', stateDirectory: worker.directory };
  const job = worker.prepare(f.assignment);
  const origin = { stateDirectory: f.prior.directory, assignmentId: f.assignment.id };
  const detail = {
    previousConfigPath: f.file('previous.local', { ...f.config, stateDirectory: f.prior.directory }).path,
    previousAssignmentId: f.assignment.id, recordedRoleHandoff: filtered.recordedRoleHandoff,
    nextAssignmentId: f.assignment.id, nextAttemptId: job.session_id
  };
  const link = `${f.assignment.id}:recorded-role-handoff`;
  worker.operation(link, f.assignment.id, 'recorded-role-handoff', detail);
  for (const changed of [
    { ...origin, assignmentId: 'unrelated-assignment' },
    { ...origin, stateDirectory: f.audit.directory }
  ]) {
    worker.finishOperation(link, 'recorded', { ...detail, roleVerificationOrigin: changed });
    await assert.rejects(continueRoleValidation(workerConfig, worker,
      { assignmentId: f.assignment.id }, 'execute'), /original authoring identity changed/);
    assert.equal(worker.status().operations.some(row => row.kind === 'role-validation-execution'), false);
    assert.equal(worker.job(f.assignment.id).state, 'prepared');
  }
  worker.finishOperation(link, 'recorded', { ...detail, roleVerificationOrigin: origin });
  await assert.rejects(continueRoleValidation(workerConfig, worker,
    { assignmentId: f.assignment.id }, 'execute'), /Worker dispatch is disabled/);
  const trace = worker.status().operations.find(row => row.kind === 'role-validation-execution');
  assert.deepEqual(JSON.parse(trace.detail).roleVerificationOrigin, origin);
  assert.equal(JSON.parse(trace.detail).previousAssignmentId, f.assignment.id);
  assert.equal(worker.all('workerResult').length, 0);
});
