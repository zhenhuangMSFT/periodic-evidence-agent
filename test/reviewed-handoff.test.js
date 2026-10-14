import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configAt, hash, json, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import {
  acceptReviewedHandoff, prepareReviewedHandoff, validateReviewedHandoffReceipt
} from '../src/reviewed-handoff.js';
import { dispatch, command, provision } from '../src/workers.js';
import { prepareLocalPreModelContinuation } from '../src/local-continuation.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/onenote-bootstrap-progress.reviewed-handoff.json', import.meta.url),
  'utf8'));
const repairDrill = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/validation-repair-drill.json', import.meta.url),
  'utf8'));
const oneJsFixture = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/1js-bizchat-excel.reviewed-handoff.json', import.meta.url),
  'utf8'));

async function setup(t, { inputFormat = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reviewed-handoff-'));
  const reference = join(root, 'reference');
  const remote = join(root, 'remote.git');
  const state = join(root, 'state');
  const skillPath = '.github/skills/integration-test-authoring/SKILL.md';
  mkdirSync(join(reference, '.github', 'skills', 'integration-test-authoring'), { recursive: true });
  mkdirSync(join(reference, 'src'), { recursive: true });
  writeFileSync(join(reference, skillPath), '# Fixture integration-test skill\nAdd focused tests.\n');
  writeFileSync(join(reference, 'src', 'value.js'), 'export const value = 1;\n');
  const git = args => command('git', ['-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], reference);
  await git(['init', '--quiet']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Fixture base']);
  const baseRevision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const config = configAt('pilot.example.json');
  config.stateDirectory = state;
  config.statePolicy.accessApproved = true;
  config.limits = {
    ...config.limits,
    maxItems: 100,
    workerMaxToolCalls: 20
  };
  config.limits.maxItems = 10;
  config.limits.workerMaxToolCalls = 20;
  config.repositories = [{
    id: 'office-agent',
    projectId: 'fixture-project',
    owner: 'fixture-owner',
    routingApproved: true,
    routingRules: ['Reviewed handoff integration'],
    referenceCheckout: reference,
    baseRef: 'HEAD',
    remote,
    allowedWritePrefixes: ['test'],
    commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    validationGates: [{
      id: 'fixture-test',
      approved: true,
      isolationVerified: true,
      executable: process.execPath,
      args: ['--test', 'test/behavior.test.js'],
      timeoutMs: 10000
    }],
    skillBindings: [{
      id: 'oa-integration-test-core',
      capability: 'integration-test-authoring',
      skillPath,
      ...(inputFormat ? { inputFormat } : {}),
      enabled: true,
      qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'],
      requiresBehaviorCard: true,
      sideEffects: { commit: true, push: true, createDraftPR: true }
    }]
  }];
  const ledger = new Ledger(state);
  const additionalLedgers = [];
  const validationContract = repositoryValidationContract(config.repositories[0]);
  ledger.qualify(skillQualificationId('office-agent', 'oa-integration-test-core'), {
    state: 'qualified-read-only',
    repoId: 'office-agent',
    bindingId: 'oa-integration-test-core',
    capability: 'integration-test-authoring',
    referenceCheckout: reference,
    remote,
    baseRef: 'HEAD',
    baseRevision,
    skillPath,
    skillSha256: hash('# Fixture integration-test skill\nAdd focused tests.\n'),
    qualificationSource: 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    sideEffects: { commit: true, push: true, createDraftPR: true }
  });
  t.after(() => {
    for (const additional of additionalLedgers) additional.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, remote, config, ledger, baseRevision, additionalLedgers };
}

async function blockedPreModelFixture(t, mutateResult = () => {}) {
  const ctx = await setup(t);
  ctx.config.executionMode = 'standalone-sdk';
  ctx.config.limits.maxAiCreditsPerSession = 10;
  const prepared = prepareReviewedHandoff(ctx.config, ctx.ledger, fixture);
  const repo = ctx.config.repositories[0];
  await command('git', ['remote', 'add', 'origin', repo.remote], repo.referenceCheckout);
  const isolated = await provision(ctx.config, prepared.job, repo, prepared.assignment.skillQualification);
  const error = { code: 'blocked-repository-git', message: 'Repository skill Git show failed' };
  ctx.ledger.moveJob(prepared.job.id, 'prepared', 'running', isolated);
  ctx.ledger.moveJob(prepared.job.id, 'running', 'blocked', { error });
  const limit = prepared.assignment.bounds.maxToolCalls;
  const result = {
    recordType: 'workerResult', schemaVersion: '1.0', id: 'pre-model-fixture',
    assignmentId: prepared.job.id, attemptId: prepared.job.session_id,
    reportedAt: now(), outcome: 'blocked', findings: 'Fixture pre-model Git failure',
    evidenceIds: prepared.assignment.evidenceIds, sourceRevision: null, draftPR: null,
    validation: [], validationAttempts: [], skillExecution: null,
    toolUsage: { limit, used: 0, remaining: limit,
      byTool: { pilot_list: 0, pilot_search: 0, pilot_read: 0, pilot_write: 0, pilot_finish: 0 }, rounds: [] },
    blocker: { owner: repo.owner, reason: error.message, unblockCondition: 'Explicit user authorization after fix' },
    nextAction: 'Reconcile without replay'
  };
  mutateResult(result);
  ctx.ledger.put(result);
  const nextConfig = { ...structuredClone(ctx.config), stateDirectory: join(ctx.root, 'continuation') };
  const nextLedger = new Ledger(nextConfig.stateDirectory);
  ctx.additionalLedgers.push(nextLedger);
  const authorization = {
    approved: true, authorizedBy: 'user', authorizedAt: now(), maxModelAttempts: 1,
    previousAssignmentId: prepared.job.id, previousAttemptId: prepared.job.session_id,
    sourceRevision: ctx.baseRevision, nextConfigSha256: hash(json(nextConfig)),
    controllerRevision: (await command('git', ['rev-parse', 'HEAD'], process.cwd())).stdout.trim(),
    reason: 'Synthetic authorization for fixture only'
  };
  return { ...ctx, prepared, isolated, result, nextConfig, nextLedger, authorization };
}

test('authorized pre-model continuation preserves the blocked attempt and reserves exactly one fresh preparation', async t => {
  const ctx = await blockedPreModelFixture(t);
  const priorJob = ctx.ledger.job(ctx.prepared.job.id);
  const priorResult = ctx.ledger.get('workerResult', ctx.result.id);
  const continued = await prepareLocalPreModelContinuation(ctx.config, ctx.ledger, priorJob.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization);
  assert.equal(continued.job.state, 'prepared');
  assert.notEqual(continued.job.session_id, priorJob.session_id);
  assert.equal(continued.job.workspace, null);
  assert.deepEqual(ctx.ledger.job(priorJob.id), priorJob);
  assert.deepEqual(ctx.ledger.get('workerResult', ctx.result.id), priorResult);
  assert.deepEqual(continued.assignment, ctx.prepared.assignment);
  assert.deepEqual(ctx.nextLedger.get('evidence', ctx.prepared.evidence.id), ctx.prepared.evidence);
  assert.equal(ctx.nextLedger.all('workerResult').length, 0);
  assert.equal(ctx.ledger.status().operations[0].state, 'prepared');
  await assert.rejects(prepareLocalPreModelContinuation(ctx.config, ctx.ledger, priorJob.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization), /Prior operations/);
});

test('pre-model continuation permits only an explicitly pinned runtime credit-ceiling correction', async t => {
  const ctx = await blockedPreModelFixture(t);
  ctx.nextConfig.limits.maxAiCreditsPerSession = 30;
  ctx.authorization.nextConfigSha256 = hash(json(ctx.nextConfig));
  await assert.rejects(prepareLocalPreModelContinuation(ctx.config, ctx.ledger, ctx.prepared.job.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization), /credit-ceiling change requires explicit authorization/);
  assert.equal(ctx.ledger.status().operations.length, 0);
  ctx.authorization.runtimeBudgetChange = { previousCeiling: 10, newCeiling: 30 };
  const continued = await prepareLocalPreModelContinuation(ctx.config, ctx.ledger, ctx.prepared.job.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization);
  assert.deepEqual(continued.audit.authorization.runtimeBudgetChange,
    { previousCeiling: 10, newCeiling: 30 });
  assert.equal(ctx.config.limits.maxAiCreditsPerSession, 10);
  assert.equal(continued.job.state, 'prepared');
});

for (const condition of ['missing-authorization', 'wrong-attempt', 'config-drift',
  'wrong-controller', 'model-started', 'validation-started', 'publication-started', 'dirty-workspace',
  'source-drift', 'superseded-evidence']) {
  test(`pre-model continuation refuses ${condition}`, async t => {
    const ctx = await blockedPreModelFixture(t, result => {
      if (condition === 'model-started')
        result.toolUsage.rounds.push({ round: 0, used: 0, cumulativeUsed: 0, status: 'failed' });
      if (condition === 'validation-started') result.sourceRevision = 'a'.repeat(40);
    });
    if (condition === 'missing-authorization') ctx.authorization.approved = false;
    if (condition === 'wrong-attempt') ctx.authorization.previousAttemptId = 'wrong-attempt';
    if (condition === 'wrong-controller') ctx.authorization.controllerRevision = 'd'.repeat(40);
    if (condition === 'config-drift') ctx.nextConfig.limits.workerMaxToolCalls++;
    if (condition === 'publication-started')
      ctx.ledger.operation('uncertain-push', ctx.prepared.job.id, 'push', {});
    if (condition === 'dirty-workspace')
      writeFileSync(join(ctx.isolated.workspace, 'src', 'value.js'), 'modified\n');
    if (condition === 'source-drift')
      await command('git', ['-c', 'core.hooksPath=', '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty',
        '--quiet', '-m', 'Advance fixture source'], ctx.config.repositories[0].referenceCheckout);
    if (condition === 'superseded-evidence') {
      const evidence = structuredClone(ctx.prepared.evidence);
      evidence.source.revision = 'new-fixture-version';
      evidence.queriedAt = '2099-01-01T00:00:00Z';
      ctx.ledger.evidence(evidence, { changed: true }, 'changed-fixture');
    }
    await assert.rejects(prepareLocalPreModelContinuation(ctx.config, ctx.ledger, ctx.prepared.job.id,
      ctx.nextConfig, ctx.nextLedger, ctx.authorization),
    error => ['blocked-authorization', 'blocked-reconciliation'].includes(error.code));
    assert.equal(ctx.ledger.job(ctx.prepared.job.id).state, 'blocked');
    assert.equal(ctx.nextLedger.status().jobs.length, 0);
  });
}

test('reviewed handoff fixture prepares real planning and assignment records', async t => {
  const { config, ledger, baseRevision } = await setup(t);
  const prepared = prepareReviewedHandoff(config, ledger, fixture);
  assert.equal(prepared.evidence.source.kind, 'fixture');
  assert.equal(prepared.evidence.source.provenance, 'synthetic');
  assert.equal(prepared.investigation.handoffEligibility, 'eligible');
  assert.equal(prepared.testCoveragePlan.sourceRevision, baseRevision);
  assert.equal(prepared.assignment.skillBindingId, 'oa-integration-test-core');
  assert.match(prepared.assignment.questions[0],
    /contracts\/apps\/onenote\/omni-onenote-bootstrap-progress\.contract\.test\.ts/);
  assert.equal(prepared.job.state, 'prepared');
});

test('reviewed handoff preserves validated declarative E2E mini-spec input through assignment', async t => {
  validateReviewedHandoffReceipt(oneJsFixture);
  const { config, ledger } = await setup(t, {
    inputFormat: 'declarative-e2e-mini-spec-batch-v1'
  });
  const mapped = structuredClone(oneJsFixture);
  mapped.review.repoIds = ['office-agent'];
  mapped.planning.improvement.repoIds = ['office-agent'];
  mapped.planning.improvement.capabilities = ['integration-test-authoring'];
  mapped.planning.testCoverage.repoId = 'office-agent';
  mapped.planning.testCoverage.capability = 'integration-test-authoring';
  mapped.planning.requestedOutcome = 'add-or-update-tests';
  const prepared = prepareReviewedHandoff(config, ledger, mapped);
  assert.deepEqual(prepared.testCoveragePlan.skillInput, mapped.planning.skillInput);
  assert.deepEqual(prepared.assignment.skillInput, mapped.planning.skillInput);
  assert.notStrictEqual(prepared.assignment.skillInput, mapped.planning.skillInput);
});

test('reviewed handoff production API is the only controller path', async t => {
  const { config, ledger } = await setup(t);
  assert.equal(typeof prepareReviewedHandoff, 'function');
  assert.equal(typeof acceptReviewedHandoff, 'function');
  const prepared = prepareReviewedHandoff(config, ledger, fixture);
  assert.equal(prepared.receipt.id, fixture.id);
});

test('submit-reviewed-handoff CLI uses the production controller path', async t => {
  const { root, config } = await setup(t);
  const configPath = join(root, 'pilot.json');
  const fixturePath = join(root, 'reviewed-handoff.json');
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const output = spawnSync(process.execPath, [
    'src\\cli.js', 'submit-reviewed-handoff',
    '--file', fixturePath, '--config', configPath, '--prepare'
  ], { encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.receipt.id, fixture.id);
  assert.equal(result.job.state, 'prepared');
});

test('the same reviewed handoff receipt is idempotent', async t => {
  const { config, ledger } = await setup(t);
  const first = prepareReviewedHandoff(config, ledger, fixture);
  const second = prepareReviewedHandoff(config, ledger, fixture);
  assert.equal(second.evidence.id, first.evidence.id);
  assert.equal(second.investigation.id, first.investigation.id);
  assert.equal(second.assignment.id, first.assignment.id);
  assert.equal(second.job.id, first.job.id);
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(ledger.all('investigation').length, 1);
  assert.equal(ledger.all('assignment').length, 1);
});

test('stale or conflicting reviewed handoff versions fail closed', async t => {
  const { config, ledger } = await setup(t);
  prepareReviewedHandoff(config, ledger, fixture);
  const stale = structuredClone(fixture);
  stale.version--;
  stale.source.revision = String(stale.version);
  await assert.rejects(async () => prepareReviewedHandoff(config, ledger, stale),
    /advance exactly once|superseded/);
  const before = {
    counts: ledger.status().counts,
    jobs: ledger.status().jobs,
    operations: ledger.status().operations
  };
  const conflicting = structuredClone(fixture);
  conflicting.evidence.summary = 'Conflicting evidence payload';
  conflicting.review.nextAction = 'Conflicting replay';
  await assert.rejects(async () => prepareReviewedHandoff(config, ledger, conflicting),
    /conflicts with persisted content/);
  assert.deepEqual(ledger.status().counts, before.counts);
  assert.deepEqual(ledger.status().jobs, before.jobs);
  assert.deepEqual(ledger.status().operations, before.operations);
  assert.equal(ledger.all('evidence').length, 1);
});

test('reviewed handoff requires the complete exclusion checklist', () => {
  const invalid = structuredClone(fixture);
  invalid.review.exclusionsChecked.pop();
  assert.throws(() => validateReviewedHandoffReceipt(invalid), /reviewedHandoff|exclusion/);
});

test('invalid fixture provenance is rejected before ledger materialization', async t => {
  const { config, ledger } = await setup(t);
  const invalid = structuredClone(fixture);
  invalid.source.namespace = 'icm/incidents';
  await assert.rejects(async () => prepareReviewedHandoff(config, ledger, invalid),
    /reviewedHandoff|source reference/);
  assert.equal(ledger.latestEvidence().length, 0);
  assert.equal(ledger.all('investigation').length, 0);
});

test('ordinary dispatch still rejects reviewed synthetic fixture evidence', async t => {
  const { config, ledger } = await setup(t);
  const prepared = prepareReviewedHandoff(config, ledger, fixture);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  await assert.rejects(dispatch(config, ledger, prepared.assignment.id), /Synthetic evidence/);
  assert.equal(ledger.job(prepared.assignment.id).state, 'prepared');
});

test('execution authorization is required before reviewed fixture state is persisted', async t => {
  const { config, ledger } = await setup(t);
  const authorizations = {
    authorizeSynthetic: '--authorize-synthetic',
    authorizeCommit: '--authorize-commit',
    authorizePush: '--authorize-push',
    authorizeDraftPR: '--authorize-draft-pr'
  };
  for (const [missing, expected] of Object.entries(authorizations)) {
    const options = {
      execute: true,
      authorizeSynthetic: true,
      authorizeCommit: true,
      authorizePush: true,
      authorizeDraftPR: true,
      [missing]: false
    };
    await assert.rejects(acceptReviewedHandoff(config, ledger, fixture, options),
      new RegExp(expected));
    assert.equal(ledger.latestEvidence().length, 0);
  }
});

test('repository binding must authorize commit push and Draft PR independently', async t => {
  for (const sideEffect of ['commit', 'push', 'createDraftPR']) {
    const { config, ledger } = await setup(t);
    config.repositories[0].skillBindings[0].sideEffects[sideEffect] = false;
    await assert.rejects(acceptReviewedHandoff(config, ledger, fixture, {
      execute: true,
      authorizeSynthetic: true,
      authorizeCommit: true,
      authorizePush: true,
      authorizeDraftPR: true
    }), /not authorized for commit, push and Draft PR/);
    assert.equal(ledger.latestEvidence().length, 0);
  }
});

test('production reviewed-handoff controller is repository and scenario neutral', () => {
  const source = readFileSync(new URL('../src/reviewed-handoff.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /office-agent|oa-integration|onenote/i);
});

test('authorized reviewed handoff reuses real dispatch with external boundaries injected', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  await command('git', ['init', '--bare', '--quiet', remote], root);
  const executed = await acceptReviewedHandoff(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runModel: async (currentConfig, currentLedger, current, assignment, investigation, toolkit, skill) => {
        assert.equal(investigation.review.reviewer, 'synthetic-reviewed-handoff-fixture');
        assert.equal(assignment.skillBindingId, 'oa-integration-test-core');
        assert.match(skill.instructions, /Fixture integration-test skill/);
        toolkit.write('test\\behavior.test.js',
          "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture behavior', () => assert.equal(1, 1));\n");
        toolkit.write('test\\behavior-card.md', '# Fixture behavior\n');
        toolkit.finish({
          outcome: 'propose-change',
          findings: 'Added focused fixture coverage through the real reviewed-handoff controller.',
          title: 'Add fixture behavior coverage',
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: ['test/behavior-card.md', 'test/behavior.test.js'],
            testsAddedOrUpdated: ['fixture behavior'],
            behaviorCardsAddedOrUpdated: ['test/behavior-card.md'],
            unknowns: [],
            needsHumanDecision: false
          }
        });
      },
      createDraft: async (currentConfig, currentLedger, current, repo, revision) => ({
        url: 'https://example.invalid/reviewed-handoff/draft/1',
        isDraft: true,
        headRevision: revision
      })
    }
  });
  assert.equal(executed.result.outcome, 'draft-pr-validated');
  assert.equal(executed.result.skillExecution.bindingId, 'oa-integration-test-core');
  assert.equal(executed.result.validation[0].sourceRevision, executed.result.sourceRevision);
  assert.equal(executed.result.draftPR.headRevision, executed.result.sourceRevision);
  assert.equal(executed.result.toolUsage.used, 3);
  assert.equal(executed.result.toolUsage.byTool.pilot_write, 2);
  assert.equal(executed.result.toolUsage.byTool.pilot_finish, 1);
});

test('controller validation failures feed a bounded repository-skill repair loop', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = 2;
  await command('git', ['init', '--bare', '--quiet', remote], root);
  let modelCalls = 0;
  const executed = await acceptReviewedHandoff(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runModel: async (currentConfig, currentLedger, current, assignment, investigation,
        toolkit, skill, authoring) => {
        modelCalls++;
        assert.equal(authoring.round, modelCalls - 1);
        const round = repairDrill.rounds[authoring.round];
        assert.ok(round);
        if (round.expectedFeedbackStatus === null) assert.deepEqual(authoring.validationFeedback, []);
        else {
          assert.equal(authoring.validationFeedback[0].status, round.expectedFeedbackStatus);
          assert.equal(authoring.validationFeedback[0].exitCode, 1);
        }
        for (const [path, content] of Object.entries(round.writes))
          toolkit.write(path.replaceAll('/', '\\'), content);
        toolkit.finish({
          outcome: 'propose-change',
          findings: round.findings,
          title: round.title,
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: repairDrill.skillResult
        });
      },
      createDraft: async (currentConfig, currentLedger, current, repo, revision) => ({
        url: 'https://example.invalid/reviewed-handoff/draft/repair',
        isDraft: true,
        headRevision: revision
      })
    }
  });
  assert.equal(modelCalls, 2);
  assert.equal(executed.result.outcome, 'draft-pr-validated');
  assert.deepEqual(executed.result.validation.map(item => item.status), ['passed']);
  assert.deepEqual(executed.result.validationAttempts.map(attempt =>
    attempt.validation[0].status), repairDrill.expectedValidationStatuses);
  assert.notEqual(executed.result.validationAttempts[0].sourceRevision,
    executed.result.validationAttempts[1].sourceRevision);
  assert.equal(executed.result.sourceRevision,
    executed.result.validation[0].sourceRevision);
  assert.deepEqual(executed.result.toolUsage.rounds.map(round => round.used), [3, 2]);
  assert.equal(executed.result.toolUsage.used, 5);
});

for (const repairBudget of [0, 1])
test(`exhausted test-only repair budget ${repairBudget} blocks without push or Draft PR`, async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = repairBudget;
  await command('git', ['init', '--bare', '--quiet', remote], root);
  let modelCalls = 0;
  let draftCreated = false;
  const executed = await acceptReviewedHandoff(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runModel: async (currentConfig, currentLedger, current, assignment, investigation,
        toolkit, skill, authoring) => {
        modelCalls++;
        assert.equal(authoring.round, modelCalls - 1);
        toolkit.write('test\\behavior.test.js',
          `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture behavior', () => assert.equal(1, ${authoring.round + 2}));\n`);
        toolkit.write('test\\behavior-card.md', '# Fixture behavior\n');
        toolkit.finish({
          outcome: 'propose-change',
          findings: 'Added initial focused fixture coverage.',
          title: 'Add failing fixture behavior coverage',
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: ['test/behavior-card.md', 'test/behavior.test.js'],
            testsAddedOrUpdated: ['fixture behavior'],
            behaviorCardsAddedOrUpdated: ['test/behavior-card.md'],
            unknowns: [],
            needsHumanDecision: false
          }
        });
      },
      pushBranch: async () => assert.fail('failed validation must not push'),
      createDraft: async () => {
        draftCreated = true;
        throw new Error('Draft creation must not run for failed test-only validation');
      }
    }
  });
  assert.equal(modelCalls, repairBudget + 1);
  assert.equal(executed.result.outcome, 'blocked');
  assert.equal(executed.result.draftPR, null);
  assert.equal(draftCreated, false);
  assert.match(executed.result.blocker.reason, /production-code repair is prohibited/);
  assert.deepEqual(executed.result.validation.map(item => item.status), ['failed']);
  assert.equal(executed.result.validationAttempts.length, repairBudget + 1);
  assert.equal((await command('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname)'], root))
    .stdout.trim(), '');
});

for (const invalidResult of ['blocked', 'missing', 'stale', 'duplicate', 'dirty', 'changed-head'])
test(`${invalidResult} validation prevents push and Draft PR creation`, async t => {
  const { config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = 2;
  let modelCalls = 0;
  let pushed = false;
  let draftCreated = false;
  await assert.rejects(acceptReviewedHandoff(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runModel: async (currentConfig, currentLedger, current, assignment, investigation,
        toolkit) => {
        modelCalls++;
        toolkit.write('test\\behavior.test.js',
          "import test from 'node:test';\ntest('fixture behavior', () => {});\n");
        toolkit.write('test\\behavior-card.md', '# Fixture behavior\n');
        toolkit.finish({
          outcome: 'propose-change',
          findings: 'Added focused fixture coverage.',
          title: 'Add fixture behavior coverage',
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: ['test/behavior-card.md', 'test/behavior.test.js'],
            testsAddedOrUpdated: ['fixture behavior'],
            behaviorCardsAddedOrUpdated: ['test/behavior-card.md'],
            unknowns: [],
            needsHumanDecision: false
          }
        });
      },
      runValidation: async (currentConfig, currentLedger, current, repo, revision) => {
        if (invalidResult === 'missing') return [];
        if (['dirty', 'changed-head'].includes(invalidResult)) {
          writeFileSync(join(current.workspace, 'test', 'behavior.test.js'), '// changed after validation\n');
          if (invalidResult === 'changed-head') {
            await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
              'add', '--all'], current.workspace);
            await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
              '-c', 'core.hooksPath=.git/no-hooks', 'commit', '--quiet', '-m', 'Post-validation change'], current.workspace);
          }
        }
        const result = {
          gateId: 'fixture-test',
          sourceRevision: invalidResult === 'stale' ? 'a'.repeat(40) : revision,
          commandOrRunUrl: 'fixture-blocked',
          status: invalidResult === 'blocked' ? 'blocked' : 'passed',
          artifactRefs: ['fixture-validation.json'],
          owner: repo.owner,
          nextCheckAt: null,
          attemptCount: 1,
          blockedReason: invalidResult === 'blocked' ? 'runner-unavailable' : null
        };
        return invalidResult === 'duplicate' ? [result, result] : [result];
      },
      pushBranch: async () => { pushed = true; },
      createDraft: async () => {
        draftCreated = true;
        return null;
      }
    }
  }), /no push permitted/);
  assert.equal(modelCalls, 1);
  assert.equal(pushed, false);
  assert.equal(draftCreated, false);
});
