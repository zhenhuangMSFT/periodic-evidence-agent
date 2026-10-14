import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, hash, json, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { evidenceEnvelope } from '../src/sources.js';
import { recordAreaToImprove, recordTestCoveragePlan } from '../src/improvements.js';
import { qualifyRepositorySkill, skillQualificationId } from '../src/repository-skills.js';
import { command, dispatch, dispatchLocalValidationContinuation, makePlannedImprovementAssignment } from '../src/workers.js';
import { prepareLocalValidationContinuation, selectLocalValidationRoleOrigin } from '../src/local-continuation.js';

async function fixture(t, { rejectPreparation = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'validation-continuation-'));
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'prior');
  config.executionMode = 'standalone-sdk';
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 100;
  config.limits.maxItems = 100;
  config.limits.workerMaxToolCalls = 20;
  config.limits.maxWorkers = 1;
  config.limits.maxValidationRepairRounds = 0;
  config.limits.maxValidationInfrastructureRetries = 0;
  const reference = join(root, 'reference'), remote = join(root, 'remote.git');
  const skillPath = '.github/skills/test/SKILL.md', lfsPath = 'fixtures/native.xlsx';
  const content = Buffer.from('fixture native input\n'), oid = hash(content);
  mkdirSync(join(reference, '.github', 'skills', 'test'), { recursive: true });
  mkdirSync(join(reference, 'fixtures'));
  writeFileSync(join(reference, skillPath), '# Fixture native test skill\n');
  writeFileSync(join(reference, lfsPath),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`);
  const git = args => command('git', ['-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], reference);
  await git(['init', '--quiet']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Fixture base']);
  await git(['remote', 'add', 'origin', remote]);
  const baseRevision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const repo = {
    id: 'fixture', owner: 'fixture-owner', routingApproved: true,
    routingRules: ['fixture'], referenceCheckout: reference, baseRef: 'HEAD', remote,
    qualificationRefresh: 'local', validationContractVersion: 'fixture-v1',
    allowedWritePrefixes: ['test'], allowedWriteFiles: [],
    commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    validationGates: [{ id: 'native', approved: true, isolationVerified: true,
      executable: process.execPath, args: ['--test', 'test/case.test.js'], timeoutMs: 10000 }],
    skillBindings: [{ id: 'native-test', capability: 'integration-test-authoring', skillPath,
      enabled: true, qualification: 'qualified', requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'], requiresBehaviorCard: false,
      sideEffects: { commit: true, push: true, createDraftPR: true } }]
  };
  config.repositories = [repo];
  const ledger = new Ledger(config.stateDirectory), ledgers = [ledger];
  t.after(() => {
    for (const entry of ledgers) entry.close();
    rmSync(root, { recursive: true, force: true });
  });
  const envelope = evidenceEnvelope('ado', 'fixture/project', '1', '1',
    'https://dev.azure.com/fixture/project/_workitems/edit/1',
    'fixture query', '2026-10-09T01:00:00Z');
  // Simulated authenticated provider boundary; no real evidence or remote service is used.
  envelope.source.provenance = 'authenticated-source';
  const evidence = ledger.evidence(envelope, { fixture: true }, 'fixture-run');
  const investigation = {
    recordType: 'investigation', schemaVersion: '1.0', id: 'fixture-investigation', version: 1,
    evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'Missing assertion',
    expectedBehavior: 'Assert existing behavior', hypotheses: [], counterEvidence: [],
    classification: 'functional', defectConfirmation: 'unconfirmed', reportEligibility: 'included',
    handoffEligibility: 'eligible', exclusionReasons: [], rationale: 'Fixture only', confidence: 0.8,
    review: { method: 'human-review', reviewer: 'fixture', reviewedAt: now() },
    repoIds: [repo.id], existingFixes: [], nextAction: 'Add focused regression test'
  };
  ledger.put(investigation);
  const improvement = recordAreaToImprove(ledger, {
    investigationIds: [investigation.id], category: 'missing-test-coverage', theme: 'Fixture coverage',
    observedBehavior: investigation.observedBehavior, expectedBehavior: investigation.expectedBehavior,
    rationale: 'Fixture only', priority: 'medium', repoIds: [repo.id],
    capabilities: ['integration-test-authoring']
  });
  const plan = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version, repoId: repo.id,
    capability: 'integration-test-authoring', sourceRevision: baseRevision,
    searchStatus: 'complete', existingTests: [], coverageGaps: ['Fixture assertion'],
    unknowns: [], rationale: 'Fixture only'
  });
  ledger.qualify(skillQualificationId(repo.id, 'native-test'),
    await qualifyRepositorySkill(config, repo.id, 'integration-test-authoring', 'native-test'));
  const assignment = makePlannedImprovementAssignment(config, ledger, investigation, plan.id);
  const job = ledger.prepare(assignment);
  const proposal = {
    outcome: 'propose-change', findings: 'Added fixture assertion', title: 'Add fixture assertion',
    description: 'Fixture-only native coverage, validation not yet claimed',
    skillResult: { status: 'succeeded', classification: 'missing-coverage',
      changedFiles: ['test/case.test.js'], testsAddedOrUpdated: ['fixture case'],
      behaviorCardsAddedOrUpdated: [], unknowns: [], needsHumanDecision: false }
  };
  await dispatch(config, ledger, job.id, {
    runModel: async (_config, _ledger, _job, _assignment, _investigation, toolkit) => {
      toolkit.write('test/case.test.js', "import test from 'node:test'; test('fixture', () => {});\n");
      toolkit.finish(structuredClone(proposal));
    },
    ...(rejectPreparation ? {
      prepareValidation: async () => { throw Object.assign(new Error('preparation rejected'),
        { code: 23, stdout: 'native stdout', stderr: 'native preparation failure' }); }
    } : {
      runValidation: async (_config, store, current, _repo, revision) => {
        const artifact = join(root, 'fixture-prior-validation.json');
        writeFileSync(artifact, json({ fixture: true, revision, status: 'failed',
          telemetry: { validationTimings: [] } }));
        store.operation('fixture-validation', current.id, 'validation', { revision });
        store.finishOperation('fixture-validation', 'failed', { revision });
        return [{ gateId: 'native', sourceRevision: revision, status: 'failed', artifactRefs: [artifact],
          commandOrRunUrl: 'fixture-native', owner: repo.owner, nextCheckAt: null,
          attemptCount: 1, blockedReason: null }];
      }
    }),
    pushBranch: async () => assert.fail('failed run must not push')
  });
  const result = ledger.all('workerResult')[0];
  assert.equal(result.outcome, 'blocked');
  const nextConfig = structuredClone(config);
  nextConfig.stateDirectory = join(root, 'next');
  nextConfig.repositories[0].validationGates[0].lfsPaths = [lfsPath];
  const nextLedger = new Ledger(nextConfig.stateDirectory);
  ledgers.push(nextLedger);
  const proofPath = join(root, 'proof.json');
  writeFileSync(proofPath, json({
    state: 'passed', clean: true, revision: result.sourceRevision,
    nativeValidationInvoked: false, modelInvoked: false, publicationInvoked: false,
    materialization: { revision: result.sourceRevision,
      objects: [{ path: lfsPath, oid, size: content.length }] }
  }));
  const authorization = {
    approved: true, authorizedBy: 'user', scope: 'future-local-runs',
    authorizedAt: now(), recordedAt: now(), maxModelAttempts: 0,
    previousAssignmentId: job.id, previousAttemptId: job.session_id,
    sourceRevision: result.sourceRevision, nextConfigSha256: hash(json(nextConfig)),
    proposalSha256: hash(json(proposal)), provisioningProofPath: proofPath,
    provisioningProofSha256: hash(readFileSync(proofPath)),
    controllerRevision: (await command('git', ['rev-parse', 'HEAD'], process.cwd())).stdout.trim(),
    lfsChanges: [{ repoId: repo.id, gateId: 'native', previous: [], next: [lfsPath] }],
    reason: 'Fixture-only authorization after source-bound provisioning proof'
  };
  return { root, config, repo, ledger, ledgers, assignment, job: ledger.job(job.id), result, proposal,
    nextConfig, nextLedger, authorization };
}

test('validation continuation preserves actual authoring and uses canonical pass-only publication without a model', async t => {
  const ctx = await fixture(t);
  const originalJob = ctx.ledger.job(ctx.job.id);
  const continued = await prepareLocalValidationContinuation(ctx.config, ctx.ledger, ctx.job.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization, ctx.proposal);
  assert.notEqual(continued.job.session_id, originalJob.session_id);
  assert.notEqual(continued.assignment.id, ctx.assignment.id);
  await assert.rejects(dispatch(ctx.nextConfig, ctx.nextLedger, continued.assignment.id),
    /explicit recorded dispatch entrypoint/);
  let validations = 0, pushes = 0, drafts = 0;
  const result = await dispatchLocalValidationContinuation(ctx.nextConfig, ctx.nextLedger,
    continued.assignment.id, {
      runModel: async () => assert.fail('must reuse prior model authoring'),
      runValidation: async (_config, _ledger, current, _repo, revision) => {
        validations++;
        assert.equal(revision, ctx.result.sourceRevision);
        assert.notEqual(current.workspace, originalJob.workspace);
        const artifact = join(ctx.root, 'fixture-next-validation.json');
        writeFileSync(artifact, json({ fixture: true, revision, status: 'passed' }));
        return [{ gateId: 'native', sourceRevision: revision, status: 'passed',
          artifactRefs: [artifact], commandOrRunUrl: 'fixture-native', owner: ctx.repo.owner,
          nextCheckAt: null, attemptCount: 1, blockedReason: null }];
      },
      pushBranch: async () => { pushes++; },
      createDraft: async (_config, _ledger, _job, _repo, revision, proposal) => {
        drafts++;
        assert.ok(proposal.description.startsWith(ctx.proposal.description));
        assert.ok(proposal.description.includes(`clean revision \`${revision}\``));
        return { url: 'https://example.invalid/draft/1', isDraft: true, headRevision: revision };
      }
    });
  assert.equal(result.outcome, 'draft-pr-validated');
  assert.equal(result.sourceRevision, ctx.result.sourceRevision);
  assert.equal(result.toolUsage.used, 0);
  assert.deepEqual(result.toolUsage.rounds, []);
  assert.deepEqual(result.skillExecution, ctx.result.skillExecution);
  assert.equal(validations, 1);
  assert.equal(pushes, 1);
  assert.equal(drafts, 1);
  assert.deepEqual(ctx.ledger.job(ctx.job.id), originalJob);
  assert.deepEqual(ctx.ledger.get('workerResult', ctx.result.id), ctx.result);
  assert.ok(!ctx.nextLedger.status().operations.some(operation => operation.kind === 'commit'));
  await assert.rejects(prepareLocalValidationContinuation(ctx.config, ctx.ledger, ctx.job.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization, ctx.proposal), /prior continuation/);
  await assert.rejects(dispatchLocalValidationContinuation(ctx.nextConfig, ctx.nextLedger,
    continued.assignment.id), /never-dispatched/);
});

test('whole-preparation rejection is retained rather than invoking a native fallback', async t => {
  const ctx = await fixture(t, { rejectPreparation: true });
  assert.equal(ctx.result.validation[0].status, 'failed');
  const artifact = JSON.parse(readFileSync(ctx.result.validation[0].artifactRefs[0]));
  assert.equal(artifact.output.exitCode, 23);
  assert.equal(artifact.output.stderr, 'native preparation failure');
  assert.equal(artifact.telemetry.validationTimings.length, 0);
  assert.equal(artifact.telemetry.preparedSourceRevision, ctx.job.base_revision);
});

for (const condition of ['permission-drift', 'wrong-controller', 'wrong-proposal', 'changed-source',
  'dirty-source', 'publication-started', 'changed-proof', 'wrong-pointer', 'tests-already-ran']) {
  test(`validation continuation refuses ${condition} without reserving a new run`, async t => {
    const ctx = await fixture(t);
    if (condition === 'permission-drift')
      ctx.nextConfig.repositories[0].allowedWritePrefixes.push('src');
    if (condition === 'wrong-controller') ctx.authorization.controllerRevision = 'f'.repeat(40);
    if (condition === 'wrong-proposal') ctx.proposal.findings = 'different authoring';
    if (condition === 'changed-source')
      await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--allow-empty', '--quiet', '-m', 'Unreviewed commit'], ctx.job.workspace);
    if (condition === 'dirty-source')
      writeFileSync(join(ctx.job.workspace, 'test', 'case.test.js'), 'unreviewed edits');
    if (condition === 'publication-started')
      ctx.ledger.operation('uncertain-push', ctx.job.id, 'push', {});
    if (condition === 'changed-proof') writeFileSync(ctx.authorization.provisioningProofPath, '{}');
    if (condition === 'wrong-pointer') {
      const proof = JSON.parse(readFileSync(ctx.authorization.provisioningProofPath));
      proof.materialization.objects[0].oid = 'a'.repeat(64);
      writeFileSync(ctx.authorization.provisioningProofPath, json(proof));
      ctx.authorization.provisioningProofSha256 =
        hash(readFileSync(ctx.authorization.provisioningProofPath));
    }
    if (condition === 'tests-already-ran') {
      const path = ctx.result.validation[0].artifactRefs[0];
      const artifact = JSON.parse(readFileSync(path));
      artifact.telemetry.validationTimings.push({ id: 'test' });
      writeFileSync(path, json(artifact));
    }
    await assert.rejects(prepareLocalValidationContinuation(ctx.config, ctx.ledger, ctx.job.id,
      ctx.nextConfig, ctx.nextLedger, ctx.authorization, ctx.proposal),
    error => ['blocked-reconciliation', 'blocked-authorization'].includes(error.code));
    assert.equal(ctx.nextLedger.status().jobs.length, 0);
    assert.ok(!ctx.ledger.status().operations.some(operation =>
      operation.kind === 'validation-continuation'));
  });
}
test('prepared validation continuation rejects a later prior-ledger publication operation', async t => {
  const ctx = await fixture(t);
  const continued = await prepareLocalValidationContinuation(ctx.config, ctx.ledger, ctx.job.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization, ctx.proposal);
  ctx.ledger.operation('late-uncertain-push', ctx.job.id, 'push', {});
  await assert.rejects(dispatchLocalValidationContinuation(ctx.nextConfig, ctx.nextLedger,
    continued.assignment.id), /Prior authoring state or continuation reservation changed/);
  assert.equal(ctx.nextLedger.job(continued.assignment.id).state, 'prepared');
});
test('failed continued validation cannot publish or start a model repair', async t => {
  const ctx = await fixture(t);
  const continued = await prepareLocalValidationContinuation(ctx.config, ctx.ledger, ctx.job.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization, ctx.proposal);
  let validations = 0;
  const result = await dispatchLocalValidationContinuation(ctx.nextConfig, ctx.nextLedger,
    continued.assignment.id, {
      runModel: async () => assert.fail('must not repair with a model'),
      runValidation: async (_config, _ledger, _job, _repo, revision) => {
        validations++;
        const artifact = join(ctx.root, 'fixture-next-failed.json');
        writeFileSync(artifact, json({ fixture: true, revision, status: 'failed' }));
        return [{ gateId: 'native', sourceRevision: revision, status: 'failed',
          artifactRefs: [artifact], commandOrRunUrl: 'fixture-native', owner: ctx.repo.owner,
          nextCheckAt: null, attemptCount: 1, blockedReason: null }];
      },
      pushBranch: async () => assert.fail('must not push failed validation'),
      createDraft: async () => assert.fail('must not publish failed validation')
    });
  assert.equal(validations, 1);
  assert.equal(result.outcome, 'blocked');
  assert.match(result.blocker.reason, /production-code repair is prohibited/);
  assert.equal(ctx.nextLedger.job(continued.assignment.id).state, 'blocked');
  assert.equal(ctx.nextLedger.all('workerResult')[0].toolUsage.used, 0);
});

async function discoveryFixture(t) {
  const ctx = await fixture(t);
  const initial = await prepareLocalValidationContinuation(ctx.config, ctx.ledger, ctx.job.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization, ctx.proposal);
  const originalConfigPath = join(ctx.root, 'original-config.json');
  writeFileSync(originalConfigPath, json(ctx.config));
  const roleDetail = { previousConfigPath: originalConfigPath, previousAssignmentId: ctx.job.id,
    nextAssignmentId: initial.assignment.id, nextAttemptId: initial.job.session_id,
    recordedRoleHandoff: { assignmentId: ctx.job.id, sourceRevision: ctx.job.base_revision } };
  ctx.nextLedger.operation(`${initial.assignment.id}:recorded-role-handoff`,
    initial.assignment.id, 'recorded-role-handoff', roleDetail);
  ctx.nextLedger.finishOperation(`${initial.assignment.id}:recorded-role-handoff`, 'recorded', roleDetail);
  const artifact = join(ctx.root, 'fixture-discovery-failure.json');
  const failedResult = await dispatchLocalValidationContinuation(ctx.nextConfig, ctx.nextLedger,
    initial.assignment.id, {
      runModel: async () => assert.fail('no second model'),
      runValidation: async (_config, store, job, _repo, revision) => {
        writeFileSync(artifact, json({ revision, status: 'failed',
          output: { exitCode: 1, timeout: false, stdout: '',
            stderr: 'No tests found, exiting with code 1\nFiles: "case.test.js"' },
          telemetry: { validationTimings: [{ id: 'policy' }, { id: 'test' }] } }));
        store.operation('fixture-discovery', job.id, 'validation', { revision });
        store.finishOperation('fixture-discovery', 'failed', { revision });
        return [{ gateId: 'native', sourceRevision: revision, status: 'failed',
          artifactRefs: [artifact], commandOrRunUrl: 'fixture-native', owner: ctx.repo.owner,
          nextCheckAt: null, attemptCount: 1, blockedReason: null }];
      },
      pushBranch: async () => assert.fail('discovery failure cannot push')
    });
  assert.equal(failedResult.outcome, 'blocked');
  assert.match(failedResult.blocker.reason, /production-code repair is prohibited/);
  const failedJob = ctx.nextLedger.job(initial.assignment.id);
  const nextConfig = structuredClone(ctx.nextConfig);
  nextConfig.stateDirectory = join(ctx.root, 'non-dot-placement');
  const nextLedger = new Ledger(nextConfig.stateDirectory);
  ctx.ledgers.push(nextLedger);
  const sha256 = hash(readFileSync(join(failedJob.workspace, 'test', 'case.test.js')));
  const diagnosticPath = join(ctx.root, 'discovery-diagnostic.json');
  const proofPath = join(ctx.root, 'placement-proof.json');
  writeFileSync(diagnosticPath, json({ sourceRevision: ctx.result.sourceRevision,
    nativeValidationInvoked: false, testBodiesExecuted: 0, sourceModified: false,
    actual: { exists: true, rootsMatch: true, ignored: false, testMatch: false, sha256 },
    controls: { nonDotDirectoryStringsOnlyMatch: true } }));
  writeFileSync(proofPath, json({
    kind: 'discovery-placement', state: 'passed', clean: true,
    revision: ctx.result.sourceRevision, workspace: failedJob.workspace,
    nextStateDirectory: nextConfig.stateDirectory, nativeValidationInvoked: false,
    testBodiesExecuted: 0, modelInvoked: false, publicationInvoked: false,
    discovery: { path: 'test/case.test.js', selector: 'case.test.js', sha256,
      rootsMatch: true, testMatch: true, ignored: false },
    absentCaseArtifacts: [join(ctx.root, 'absent-case-results.json')]
  }));
  const authorization = {
    kind: 'discovery-placement', approved: true, authorizedBy: 'user', scope: 'future-local-runs',
    authorizedAt: ctx.authorization.authorizedAt, recordedAt: now(), maxModelAttempts: 0,
    previousAssignmentId: initial.assignment.id, previousAttemptId: failedJob.session_id,
    sourceRevision: ctx.result.sourceRevision, nextConfigSha256: hash(json(nextConfig)),
    proposalSha256: hash(json(ctx.proposal)), controllerRevision: ctx.authorization.controllerRevision,
    discoveryDiagnostic: { path: diagnosticPath, sha256: hash(readFileSync(diagnosticPath)) },
    placementProof: { path: proofPath, sha256: hash(readFileSync(proofPath)) },
    discoveryFailure: { path: artifact, sha256: hash(readFileSync(artifact)) },
    reason: 'Fixture-only zero-body native discovery placement correction'
  };
  return { ...ctx, initial, failedJob, placementConfig: nextConfig,
    placementLedger: nextLedger, placementAuthorization: authorization };
}

test('discovery placement preserves both failures and original authoring through one new native-only run', async t => {
  const ctx = await discoveryFixture(t);
  const oldJob = ctx.nextLedger.job(ctx.initial.assignment.id);
  const oldResult = ctx.nextLedger.all('workerResult')[0];
  assert.deepEqual(selectLocalValidationRoleOrigin(ctx.nextConfig, ctx.nextLedger, ctx.initial.assignment.id),
    { stateDirectory: ctx.ledger.directory, assignmentId: ctx.job.id });
  const prepared = await prepareLocalValidationContinuation(ctx.nextConfig, ctx.nextLedger,
    ctx.initial.assignment.id, ctx.placementConfig, ctx.placementLedger,
    ctx.placementAuthorization, ctx.proposal);
  assert.equal(prepared.assignment.id, ctx.initial.assignment.id);
  assert.notEqual(prepared.job.session_id, oldJob.session_id);
  assert.deepEqual(ctx.nextLedger.job(oldJob.id), oldJob);
  assert.deepEqual(ctx.nextLedger.all('workerResult')[0], oldResult);
  let validations = 0;
  const result = await dispatchLocalValidationContinuation(ctx.placementConfig, ctx.placementLedger,
    prepared.assignment.id, {
      runModel: async () => assert.fail('no replacement authoring'),
      runValidation: async (_config, _store, _job, _repo, revision) => {
        validations++;
        const path = join(ctx.root, 'fixture-placement-passed.json');
        writeFileSync(path, json({ revision, status: 'passed', fixture: true }));
        return [{ gateId: 'native', sourceRevision: revision, status: 'passed',
          artifactRefs: [path], commandOrRunUrl: 'fixture-native', owner: ctx.repo.owner,
          nextCheckAt: null, attemptCount: 1, blockedReason: null }];
      },
      pushBranch: async () => {},
      createDraft: async (_config, _ledger, _job, _repo, revision) => ({
        url: 'https://dev.azure.com/fixture/project/_git/repo/pullrequest/1',
        isDraft: true, headRevision: revision
      })
    });
  assert.equal(validations, 1);
  assert.equal(result.sourceRevision, ctx.result.sourceRevision);
  assert.equal(result.toolUsage.used, 0);
  assert.equal(ctx.placementLedger.status().operations.filter(row => row.kind === 'commit').length, 0);
  await assert.rejects(prepareLocalValidationContinuation(ctx.nextConfig, ctx.nextLedger,
    ctx.initial.assignment.id, ctx.placementConfig, ctx.placementLedger,
    ctx.placementAuthorization, ctx.proposal), /Prior correction|destination must be empty/);
});

for (const condition of ['assertion-failure', 'body-marker', 'case-results-exist',
  'changed-profile', 'dot-root', 'proof-mismatch', 'source-drift', 'role-lineage-drift']) {
  test(`discovery placement rejects ${condition} without reserving a follow-on`, async t => {
    const ctx = await discoveryFixture(t);
    const auth = structuredClone(ctx.placementAuthorization);
    const config = structuredClone(ctx.placementConfig);
    if (condition === 'changed-profile') config.repositories[0].validationGates[0].args.push('--changed');
    if (condition === 'dot-root') config.stateDirectory = join(ctx.root, '.hidden');
    if (condition === 'assertion-failure' || condition === 'body-marker') {
      const artifact = JSON.parse(readFileSync(auth.discoveryFailure.path));
      if (condition === 'assertion-failure') artifact.output.stderr = 'Expected true, received false';
      else artifact.output.stdout = 'PILOT_CHANGED_CASE: {"status":"passed"}';
      writeFileSync(auth.discoveryFailure.path, json(artifact));
      auth.discoveryFailure.sha256 = hash(readFileSync(auth.discoveryFailure.path));
    }
    if (condition === 'case-results-exist')
      writeFileSync(join(ctx.root, 'absent-case-results.json'), '{}');
    if (condition === 'proof-mismatch') auth.placementProof.sha256 = '0'.repeat(64);
    if (condition === 'source-drift')
      writeFileSync(join(ctx.failedJob.workspace, 'test', 'case.test.js'), 'changed');
    if (condition === 'role-lineage-drift') {
      const id = `${ctx.initial.assignment.id}:recorded-role-handoff`;
      const row = ctx.nextLedger.db.prepare('SELECT detail FROM operations WHERE id=?').get(id);
      const detail = JSON.parse(row.detail);
      detail.previousAssignmentId = 'different-authoring';
      ctx.nextLedger.finishOperation(id, 'recorded', detail);
    }
    auth.nextConfigSha256 = hash(json(config));
    await assert.rejects(prepareLocalValidationContinuation(ctx.nextConfig, ctx.nextLedger,
      ctx.initial.assignment.id, config, ctx.placementLedger, auth, ctx.proposal));
    assert.equal(ctx.placementLedger.status().jobs.length, 0);
    assert.equal(ctx.nextLedger.status().operations.filter(row =>
      row.kind === 'validation-continuation').length, 0);
  });
}

test('read-only ledger neither creates storage nor runs schema migrations and rejects writes', t => {
  const root = mkdtempSync(join(tmpdir(), 'readonly-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const absent = join(root, 'absent');
  assert.throws(() => new Ledger(absent, { readOnly: true }));
  assert.equal(existsSync(absent), false);
  const file = join(root, 'ledger.sqlite');
  const seed = new DatabaseSync(file);
  seed.exec('CREATE TABLE observations (run_id TEXT)');
  seed.close();
  const before = hash(readFileSync(file));
  const reader = new Ledger(root, { readOnly: true });
  try {
    assert.deepEqual(reader.db.prepare('PRAGMA table_info(observations)').all().map(row => row.name),
      ['run_id']);
    assert.throws(() => reader.db.exec('CREATE TABLE forbidden (id TEXT)'), /readonly/i);
  } finally { reader.close(); }
  assert.equal(hash(readFileSync(file)), before);
});
