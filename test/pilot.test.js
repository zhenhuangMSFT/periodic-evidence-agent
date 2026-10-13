import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync,
  realpathSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeWorkiq } from '../scripts/Workiq-Auth-Repro.mjs';
import { Ledger } from '../src/ledger.js';
import { configAt, hash, json, now, exclusions, PilotError, boundedPath, validateRecord, workspaceCleanupPolicy, proposerExecutorFlight, validationLfsPaths } from '../src/common.js';
import { collectAdo, collectWorkiq, collectIcm, evidenceEnvelope, area, wiql, adoRecord } from '../src/sources.js';
import { dryRun } from '../src/dry-run.js';
import { followRelated } from '../src/followup.js';
import { revisitTracked } from '../src/revisit.js';
import { collect, acceptReview, report, latestEvidence, reconcile, tick, previousUtcDay, nextDailyWake, readinessFingerprint } from '../src/coordinator.js';
import { validateSeed, restrictedSession, principalPath, unwrapWorkiq, verifyPrincipal, channelRoot, messageSelect, nextWorkiqPage, validateWorkiqPath, workiqRuntimeError, prepareWorkiq } from '../src/runtime.js';
import { makeAssignment, makePlannedImprovementAssignment, WorkerTools, provision, checkoutEnvironment, hydrateValidationLfs, prepareValidation, preflightValidationAuthentication, runValidation, pushDraftBranch, createAdoDraft, command, minimalEnvironment, dispatch, repoFor } from '../src/workers.js';
import { recordAreaToImprove, recordTestCoveragePlan } from '../src/improvements.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';
import { outputPathFingerprint } from '../src/output-fingerprint.js';
import { cleanupWorkspace, cleanupWorkspaces } from '../src/workspace-gc.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'evidence-pilot-test-'));
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'state');
  config.statePolicy.accessApproved = true;
  config.activation = { collect: true, review: true, dispatch: false };
  config.identity = { designatedUser: 'synthetic-owner', tenantId: 'synthetic-tenant', objectId: 'synthetic-user' };
  config.limits = { maxItems: 1000, maxCalls: 30, maxWorkers: 1, maxAssignments: 1, workerMinutes: 1, workerMaxToolCalls: 30, maxFileBytes: 262144 };
  config.followUp = { maxDepth: 0, maxItems: 50, maxToolCalls: 100 };
  config.reviewMethod = 'human-review';
  config.sources.ado.scopeApproved = true;
  config.sources.ado.enabled = true;
  config.sources.icm.enabled = false;
  config.sources.workiq.enabled = false;
  config.sources.workiq.seeds = [];
  config.schedule.changedEvidencePolicy = null;
  const ledger = new Ledger(config.stateDirectory);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, ledger };
}
function adoItem(id = 1, rev = 1) {
  return { id, rev, fields: {
    'System.Id': id, 'System.WorkItemType': 'Bug', 'System.Title': `Synthetic bug ${id}`,
    'System.AreaPath': `${area}\\Synthetic`, 'System.State': 'Active',
    'System.CreatedDate': '2026-10-08T01:00:00Z', 'System.ChangedDate': '2026-10-08T02:00:00Z'
  } };
}
function transport(items = [adoItem()], capture = []) {
  return async (endpoint, body) => {
    capture.push({ endpoint, body });
    if (endpoint === 'wiql') return {
      asOf: '2026-10-09T01:00:00Z', workItems: body.query.includes('[System.Id] = 0') ? [] : items.map(({ id }) => ({ id }))
    };
    return { value: items.filter(i => body.ids.includes(i.id)) };
  };
}
function addEvidence(ledger, id = '1', revision = '1', payload = { text: 'synthetic' }, provenance = 'synthetic') {
  const record = evidenceEnvelope('ado', 'office/OC', id, revision,
    `https://dev.azure.com/office/OC/_workitems/edit/${id}`, 'synthetic query', '2026-10-09T01:00:00Z');
  record.source.provenance = provenance;
  return ledger.evidence(record, payload, `run-${revision}-${id}`);
}
function review(evidence, version = 1) {
  return {
    recordType: 'investigation', schemaVersion: '1.0',
    id: `investigation-${hash(json([evidence.source.namespace, evidence.source.recordId]))}`, version,
    evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'Synthetic failure',
    expectedBehavior: 'Expected behavior', hypotheses: [], counterEvidence: [],
    classification: 'functional', defectConfirmation: 'unconfirmed', reportEligibility: 'included',
    handoffEligibility: 'eligible', exclusionReasons: [], rationale: 'Synthetic review only', confidence: 0.8,
    review: { method: 'human-review', reviewer: 'synthetic-reviewer', reviewedAt: now() },
    repoIds: [], existingFixes: [], nextAction: 'Investigate source cause'
  };
}
function repoConfig(config, root) {
  const repo = {
    id: 'fixture', owner: 'synthetic-owner', routingApproved: true, routingRules: ['synthetic only'],
    referenceCheckout: join(root, 'reference'), baseRef: 'HEAD', remote: join(root, 'remote.git'),
    allowedWritePrefixes: ['src', 'test'], allowedWriteFiles: [],
    validationGates: [], commitIdentity: { name: 'Pilot fixture', email: 'fixture@example.invalid' }
  };
  config.repositories = [repo]; return repo;
}
async function fixture(t, provenance = 'synthetic', intent = 'rca-only') {
  const ctx = setup(t);
  const repo = repoConfig(ctx.config, ctx.root);
  mkdirSync(join(repo.referenceCheckout, 'src'), { recursive: true });
  writeFileSync(join(repo.referenceCheckout, 'src', 'value.js'), 'export const value = 1;\n');
  const g = args => command('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', ...args], repo.referenceCheckout);
  await g(['init', '--quiet']);
  await g(['add', '.']);
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic fixture']);
  const evidence = addEvidence(ctx.ledger, '1', '1', { fixture: true, simulatedProvider: true }, provenance);
  const investigation = review(evidence); investigation.repoIds = [repo.id];
  ctx.ledger.put(investigation);
  if (intent !== 'rca-only') repo.validationGates = [{ id: 'source-test', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['--input-type=module', '-e',
      "import {value} from './src/value.js'; import assert from 'node:assert/strict'; assert.equal(value,2)"], timeoutMs: 10000 }];
  const assignment = makeAssignment(ctx.config, investigation, repo.id, intent);
  const job = ctx.ledger.prepare(assignment);
  return { ...ctx, repo, evidence, investigation, assignment, job, g };
}
async function stagedValidationFixture(t, {
  parallelOutputs = false, authentication = false
} = {}) {
  const ctx = await fixture(t);
  writeFileSync(join(ctx.repo.referenceCheckout, '.gitignore'),
    '.pilot/\nextra/node_modules/\n');
  writeFileSync(join(ctx.repo.referenceCheckout, 'package.json'), '{"packageManager":"fixture@1.0.0"}\n');
  writeFileSync(join(ctx.repo.referenceCheckout, 'fixture.lock'), 'locked\n');
  writeFileSync(join(ctx.repo.referenceCheckout, 'build.config.js'), 'export default {};\n');
  if (authentication) writeFileSync(
    join(ctx.repo.referenceCheckout, '.yarnrc.yml'), [
      'npmRegistryServer: "https://office.pkgs.visualstudio.com/_packaging/AugmentationLoop/npm/registry/"',
      'npmScopes:',
      '  office:',
      '    npmRegistryServer: "https://office.pkgs.visualstudio.com/_packaging/Office/npm/registry/"'
    ].join('\n'));
  mkdirSync(join(ctx.repo.referenceCheckout, 'src'), { recursive: true });
  writeFileSync(join(ctx.repo.referenceCheckout, 'src', 'value.js'), 'export const value = 1;\n');
  writeFileSync(join(ctx.repo.referenceCheckout, 'src', 'unused.js'), 'export const unused = true;\n');
  mkdirSync(join(ctx.repo.referenceCheckout, 'test'));
  writeFileSync(join(ctx.repo.referenceCheckout, 'test', 'behavior.test.js'), 'pass\n');
  await ctx.g(['add', '.']);
  await ctx.g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Add staged validation fixture']);
  const isolated = await provision(ctx.config, ctx.job, ctx.repo);
  const current = { ...ctx.job, workspace: isolated.workspace };
  const profilePath = join(ctx.config.stateDirectory, 'staged-profile.mjs');
  const plan = {
    version: authentication ? 3 : 2,
    stages: ['dependencies', 'compile', 'policy', 'test'],
    testOnlyPrefixes: ['test/'],
    lockfilePaths: ['package.json', 'fixture.lock'],
    buildConfigPaths: ['build.config.js'],
    dependencySnapshotPaths: ['.pilot/dependencies', '.pilot/install-state'],
    preparedOutputPaths: parallelOutputs
      ? ['.pilot/install-state', ...Array.from({ length: 8 },
        (_, index) => `.pilot/output-${index}`)]
      : ['.pilot/install-state']
  };
  if (authentication) plan.authentication = {
    type: 'azure-artifacts-npm',
    provider: 'artifacts-npm-credprovider',
    providerVersion: '1.2.1',
    feeds: [
      {
        scope: null,
        registry: 'https://office.pkgs.visualstudio.com/_packaging/AugmentationLoop/npm/registry/'
      },
      {
        scope: 'office',
        registry: 'https://office.pkgs.visualstudio.com/_packaging/Office/npm/registry/'
      }
    ]
  };
  writeFileSync(profilePath, `// PILOT_VALIDATION_PLAN: ${JSON.stringify(plan)}\n`);
  ctx.repo.validationGates = [{
    id: 'staged', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['{profile}'],
    profilePath, profileSha256: hash(readFileSync(profilePath)), timeoutMs: 10000
  }];
  ctx.config.limits.maxValidationInfrastructureRetries = 1;
  const calls = [];
  const behavior = {
    toolchain: '1', failPreparation: false, failTest: false,
    transientPolicy: false, policyAttempts: 0, failAuthentication: false,
    failDependencyAuthentication: false, mutateDuringAuthentication: false,
    invalidAuthenticationEvidence: false, failTestWithAuthenticationText: false,
    authenticationPreflight: 'ready', authenticationCheckDelayMs: 0,
    dependencyVersion: '2.0.0',
    failTestWithProfileError: false
  };
  const execute = async (executable, args, cwd, timeout, env) => {
    const stage = env.PILOT_VALIDATION_STAGE;
    calls.push(stage);
    if (stage === 'fingerprint') return {
      stdout: `PILOT_VALIDATION_FINGERPRINT:${JSON.stringify({
        node: behavior.toolchain, corepack: '1', yarn: '1',
        platform: process.platform, architecture: process.arch
      })}\n`,
      stderr: ''
    };
    if (stage === 'authentication-check') {
      assert.equal(env.PILOT_TEST_SECRET, undefined);
      if (behavior.authenticationCheckDelayMs)
        await new Promise(resolve => setTimeout(
          resolve, behavior.authenticationCheckDelayMs));
      const state = behavior.authenticationPreflight;
      if (state === 'invalid')
        return { stdout: 'authentication check completed without evidence\n', stderr: '' };
      const value = {
        state: state === 'ready' ? 'ready' : 'action-required-auth',
        provider: 'artifacts-npm-credprovider',
        providerVersion: '1.2.1',
        feedCount: 2,
        tokenRecorded: false
      };
      if (state !== 'ready') {
        value.reason = state;
        value.installProvider = state === 'provider-missing';
      }
      return {
        stdout: `PILOT_VALIDATION_AUTH_PREFLIGHT:${JSON.stringify(value)}\n`,
        stderr: ''
      };
    }
    if (stage === 'authentication') {
      assert.equal(env.PILOT_TEST_SECRET, undefined);
      if (behavior.mutateDuringAuthentication)
        writeFileSync(join(cwd, 'src', 'value.js'), 'authentication changed source\n');
      if (behavior.failAuthentication)
        throw Object.assign(new Error('authentication failed'), {
          code: 1, stdout: '',
          stderr: 'No authentication configured for Azure Artifacts'
        });
      return {
        stdout: behavior.invalidAuthenticationEvidence
          ? 'authentication completed without evidence\n'
          : `PILOT_VALIDATION_AUTH:${JSON.stringify({
            provider: 'artifacts-npm-credprovider',
            providerVersion: '1.2.1',
            feedCount: 2,
            tokenRecorded: false
          })}\n`,
        stderr: ''
      };
    }
    if (stage === 'dependencies') {
      if (behavior.failDependencyAuthentication)
        throw Object.assign(new Error('install authentication failed'), {
          code: 1, stdout: '',
          stderr: 'Invalid authentication (as an anonymous user)'
        });
      if (behavior.failPreparation)
        throw Object.assign(new Error('install failed'), {
          code: 1, stdout: '', stderr: 'install failure'
        });
      mkdirSync(join(cwd, '.pilot'), { recursive: true });
      mkdirSync(join(cwd, '.pilot', 'dependencies'), { recursive: true });
      writeFileSync(join(cwd, '.pilot', 'dependencies', 'package.js'), 'dependency\n');
      symlinkSync(join(cwd, 'src'), join(cwd, '.pilot', 'dependencies', 'source-link'),
        process.platform === 'win32' ? 'junction' : 'dir');
      mkdirSync(join(cwd, 'extra', 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(join(cwd, 'extra', 'node_modules', 'fixture', 'package.json'),
        `${JSON.stringify({ version: behavior.dependencyVersion })}\n`);
      writeFileSync(join(cwd, 'extra', 'node_modules', 'fixture', 'resolver.node'),
        'synthetic-native-binary\n');
      symlinkSync(join(cwd, 'src'),
        join(cwd, 'extra', 'node_modules', 'source-link'),
        process.platform === 'win32' ? 'junction' : 'dir');
      writeFileSync(join(cwd, '.pilot', 'install-state'), 'prepared\n');
    }
    if (stage === 'compile') {
      assert.equal(
        readFileSync(join(cwd, '.pilot', 'dependencies', 'source-link', 'value.js'), 'utf8'),
        readFileSync(join(cwd, 'src', 'value.js'), 'utf8'));
      assert.equal(
        readFileSync(join(cwd, 'extra', 'node_modules',
          'source-link', 'value.js'), 'utf8'),
        readFileSync(join(cwd, 'src', 'value.js'), 'utf8'));
      assert.equal(JSON.parse(readFileSync(join(cwd, 'extra', 'node_modules',
        'fixture', 'package.json'))).version, behavior.dependencyVersion);
      if (parallelOutputs) {
        for (let index = 0; index < 8; index++) {
          mkdirSync(join(cwd, '.pilot', `output-${index}`), { recursive: true });
          writeFileSync(join(cwd, '.pilot', `output-${index}`, 'compiled.js'),
            `export const value = ${index};\n`);
        }
      }
    }
    if (stage === 'policy' && behavior.transientPolicy && behavior.policyAttempts++ === 0)
      throw Object.assign(new Error('timeout'), {
        killed: true, code: null, stdout: '', stderr: 'timeout'
      });
    if (stage === 'test' && behavior.failTest)
      throw Object.assign(new Error('test failed'), {
        code: 1, stdout: '', stderr: 'fixture failure'
      });
    if (stage === 'test' && behavior.failTestWithAuthenticationText)
      throw Object.assign(new Error('test failed'), {
        code: 1, stdout: '', stderr: 'expected HTTP 403 in application behavior'
      });
    if (stage === 'test' && behavior.failTestWithProfileError)
      throw Object.assign(new Error('profile failed'), {
        code: 1, stdout: '',
        stderr: 'PILOT_VALIDATION_PROFILE_ERROR: invalid package-relative selector'
      });
    return { stdout: `${stage} passed\n`, stderr: '' };
  };
  const commit = async (path, content, message) => {
    writeFileSync(join(isolated.workspace, path), content);
    const gitArgs = args => command('git', ['-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false', ...args], isolated.workspace);
    await gitArgs(['add', '--all']);
    await gitArgs(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', message], isolated.workspace);
    return (await gitArgs(['rev-parse', 'HEAD'])).stdout.trim();
  };
  return { ...ctx, isolated, current, profilePath, calls, behavior, execute, commit };
}

async function deliveredWorkspace(t, { historicalFailure = false } = {}) {
  const ctx = await fixture(t, 'authenticated-source', 'defect-fix');
  const isolated = await provision(ctx.config, ctx.job, ctx.repo);
  ctx.ledger.moveJob(ctx.job.id, 'prepared', 'dispatching');
  ctx.ledger.moveJob(ctx.job.id, 'dispatching', 'running', isolated);
  await command('git', ['init', '--bare', '--quiet', ctx.repo.remote], ctx.root);
  await pushDraftBranch(ctx.config, isolated.workspace, ctx.repo,
    `HEAD:refs/heads/pilot/${ctx.job.id}`);
  const artifact = join(ctx.config.stateDirectory, 'delivery-validation.json');
  const status = historicalFailure ? 'failed' : 'passed';
  writeFileSync(artifact, json({ sourceRevision: isolated.baseRevision, status }));
  const result = structuredClone(JSON.parse(readFileSync('scaffold/example-flows.json'))
    .records.find(record => record.recordType === 'workerResult'));
  Object.assign(result, {
    id: `delivery-${ctx.job.id}`, assignmentId: ctx.job.id, attemptId: ctx.job.session_id,
    reportedAt: now(), outcome: historicalFailure ? 'draft-pr-validation-failed' : 'draft-pr-validated',
    sourceRevision: isolated.baseRevision,
    draftPR: { url: 'https://example.invalid/draft/1', isDraft: true, headRevision: isolated.baseRevision },
    skillExecution: null, blocker: null
  });
  result.validation = [{
    ...result.validation[0], gateId: 'source-test', status,
    sourceRevision: isolated.baseRevision, artifactRefs: [artifact]
  }];
  result.validationAttempts = [{
    round: 0, sourceRevision: isolated.baseRevision, validation: result.validation
  }];
  ctx.ledger.put(result);
  ctx.ledger.moveJob(ctx.job.id, 'running', 'completed');
  return { ...ctx, isolated, result, artifact };
}

test('portable scaffold config and all synthetic example records remain valid', () => {
  validateRecord(JSON.parse(readFileSync('scaffold/configuration.template.json')), 'configuration');
  validateRecord(JSON.parse(readFileSync('scaffold/example-flows.json')), 'examples');
});
test('dependency fingerprint rejects chained links that resolve outside the workspace', t => {
  const root = mkdtempSync(join(tmpdir(), 'dependency-fingerprint-test-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(join(workspace, 'node_modules'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'package.js'), 'external\n');
  symlinkSync(outside, join(workspace, 'bridge'),
    process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(workspace, 'bridge'), join(workspace, 'node_modules', 'package'),
    process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(outputPathFingerprint(workspace, 'node_modules'), null);
});
test('worker-result audit fields and validation attempt metadata are mandatory', () => {
  const examples = JSON.parse(readFileSync('scaffold/example-flows.json'));
  const result = examples.records.find(record => record.recordType === 'workerResult');
  for (const field of ['validationAttempts', 'toolUsage', 'skillExecution']) {
    const invalid = structuredClone(result);
    delete invalid[field];
    assert.throws(() => validateRecord(invalid, 'workerResult'), /workerResult/);
  }
  for (const field of ['attemptCount', 'blockedReason']) {
    const invalid = structuredClone(result);
    delete invalid.validation[0][field];
    assert.throws(() => validateRecord(invalid, 'workerResult'), /workerResult/);
  }
});
test('portable example uses a fixed UTC fixture window and leaves live permissions unapproved', () => {
  const config = configAt('pilot.example.json');
  assert.deepEqual(config.window, { start: '2026-10-08T00:00:00Z', end: '2026-10-09T00:00:00Z' });
  assert.deepEqual(config.activation, { collect: false, review: false, dispatch: false });
  assert.equal(config.schedule.enabled, false);
  assert.equal(config.statePolicy.accessApproved, false);
  assert.ok(Object.values(config.sources).every(s => !s.enabled && !s.scopeApproved));
  assert.ok(config.repositories.every(r => !r.projectId && !r.referenceCheckout && !r.routingApproved));
  assert.ok(config.repositories.every(r => proposerExecutorFlight(r) === 'local'));
  assert.match(config.identity.designatedUser, /@example\.invalid$/);
  assert.equal(config.limits.maxValidationRepairRounds, 10);
});
test('validation repair budget defaults to ten and rejects larger values', t => {
  const root = mkdtempSync(join(tmpdir(), 'repair-budget-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync('pilot.example.json'));
  delete config.limits.maxValidationRepairRounds;
  const configPath = join(root, 'pilot.json');
  writeFileSync(configPath, JSON.stringify(config));
  assert.equal(configAt(configPath).limits.maxValidationRepairRounds, 10);
  config.limits.maxValidationRepairRounds = 11;
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => configAt(configPath), /must not exceed 10/);
});
test('OfficeAgent Excel validation profile converts selectors to package-relative paths', () => {
  const profile = readFileSync('scripts/validation/office-agent-excel-entry-model.ps1', 'utf8');
  assert.match(profile, /git diff --name-only HEAD\^ HEAD -- 'agents\/office-agent\/tests\/integration/);
  assert.match(profile, /\^agents\/office-agent\/\(tests\/integration\/\.\+\\\.test\\\.ts\)\$/);
  assert.match(profile, /Join-Path 'agents\\office-agent' \$test/);
  assert.match(profile, /PILOT_VALIDATION_PROFILE_ERROR:/);
  assert.doesNotMatch(profile,
    /--runTestsByPath\s+agents\/office-agent\/tests\/integration/);
});
test('executor flights validate exact backend choices and preserve omitted legacy configuration', t => {
  const { root } = setup(t);
  const config = JSON.parse(readFileSync('pilot.example.json'));
  const repo = config.repositories.find(r => r.id === 'office-agent');
  const configPath = join(root, 'flight-config.json');
  for (const executor of ['local', 'agency']) {
    repo.flights = { proposerExecutor: executor };
    writeFileSync(configPath, json(config));
    const loaded = configAt(configPath);
    assert.equal(proposerExecutorFlight(loaded.repositories.find(r => r.id === 'office-agent')), executor);
    assert.equal(proposerExecutorFlight(loaded.repositories.find(r => r.id === '1js')), 'local');
    assert.deepEqual(loaded.activation, { collect: false, review: false, dispatch: false });
  }
  const doctor = spawnSync(process.execPath, ['src/cli.js', 'doctor', '--config', configPath],
    { encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.deepEqual(JSON.parse(doctor.stdout).proposerExecutors.find(r => r.repoId === 'office-agent'),
    { repoId: 'office-agent', selection: 'agency', readinessVerified: false });
  for (const flights of [null, false, [], {}, { proposerExecutor: null },
    { proposerExecutor: 'hosted' }, { proposerExecutor: true },
    { proposerExecutor: 'agency', fallback: 'local' }, { proposerExecuter: 'agency' }]) {
    repo.flights = flights;
    writeFileSync(configPath, json(config));
    assert.throws(() => configAt(configPath), /executorFlights/);
    assert.throws(() => proposerExecutorFlight(repo), /executorFlights/);
  }
  delete repo.flights;
  writeFileSync(configPath, json(config));
  assert.equal(proposerExecutorFlight(configAt(configPath).repositories.find(r => r.id === 'office-agent')), null);
});
test('configuration resolves and content-binds relative validation profiles', t => {
  const root = mkdtempSync(join(tmpdir(), 'profile-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = 'Write-Output profile';
  const profilePath = join(root, 'scripts', 'validation', 'profile.ps1');
  mkdirSync(join(root, 'scripts', 'validation'), { recursive: true });
  writeFileSync(profilePath, profile);
  const config = JSON.parse(readFileSync('pilot.example.json'));
  const gate = {
    id: 'profiled', approved: false, isolationVerified: false,
    profilePath: 'scripts/validation/profile.ps1', profileSha256: hash(profile),
    executable: null, args: ['-File', '{profile}'], timeoutMs: 10000
  };
  config.repositories.find(repo => repo.id === 'office-agent').validationGates.push(gate);
  const configPath = join(root, 'pilot.json');
  writeFileSync(configPath, JSON.stringify(config));

  const loaded = configAt(configPath);
  assert.equal(loaded.repositories.find(repo => repo.id === 'office-agent')
    .validationGates[0].profilePath, profilePath);

  gate.profileSha256 = '0'.repeat(64);
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => configAt(configPath), /profile hash mismatch/);

  delete gate.profileSha256;
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => configAt(configPath), /bind profilePath and profileSha256 together/);
});

test('package authentication configuration is explicit, value-free and contract-bound', t => {
  const { root } = setup(t);
  const config = JSON.parse(readFileSync('pilot.example.json'));
  const repo = config.repositories[0];
  const gate = { id: 'auth-config', args: [], timeoutMs: 1000 };
  repo.validationGates = [gate];
  const originalContract = repositoryValidationContract(repo);
  const configPath = join(root, 'auth-config.json');
  gate.packageAuth = { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' };
  writeFileSync(configPath, json(config));
  assert.deepEqual(configAt(configPath).repositories[0].validationGates[0].packageAuth,
    gate.packageAuth);
  assert.notEqual(repositoryValidationContract(repo).sha256, originalContract.sha256);
  for (const invalid of [null, false, [], {}, { kind: 'azure-cli' },
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PATH' },
    { kind: 'yarn-token', tokenEnvironmentVariable: 'YARN_NPM_AUTH_TOKEN' },
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN', token: 'secret' }]) {
    gate.packageAuth = invalid;
    writeFileSync(configPath, json(config));
    assert.throws(() => configAt(configPath), /Validation packageAuth/);
    assert.throws(() => repositoryValidationContract(repo), /Validation packageAuth/);
  }
  delete gate.packageAuth;
  assert.deepEqual(repositoryValidationContract(repo), originalContract);
});

test('worker writes honor exact files without broadening directory prefixes', t => {
  const { root, config } = setup(t);
  const repo = repoConfig(config, root);
  repo.allowedWritePrefixes = [];
  repo.allowedWriteFiles = ['config/allowed.yaml'];
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'config'), { recursive: true });
  const assignment = {
    repoId: repo.id,
    permissions: { editCode: true },
    bounds: { maxToolCalls: 3 }
  };
  const tools = new WorkerTools(config, assignment, workspace);
  assert.equal(tools.write('config\\allowed.yaml', 'allowed\n'), 'written');
  assert.throws(() => tools.write('config\\other.yaml', 'blocked\n'), /approved edit bounds/);
});
test('ADO WIQL preserves full area and distinct created/changed lanes', () => {
  const window = configAt('pilot.example.json').window;
  assert.match(wiql(window), /\[System.CreatedDate\]/);
  assert.match(wiql(window, 'changed'), /\[System.ChangedDate\]/);
  assert.ok(wiql(window).includes(`UNDER '${area}'`));
  assert.match(wiql(window), /<> 'Removed'/);
  assert.doesNotMatch(wiql(window), /Bug Bash|Automation/);
  assert.throws(() => wiql({ start: '2026-10-08', end: window.end }));
});
test('ADO batches at most 200, pins snapshot, distinguishes missing fields and retains revisions', async t => {
  const { config } = setup(t), calls = [], evidence = [];
  await collectAdo(config, config.window, async e => evidence.push(e), 'created',
    transport(Array.from({ length: 201 }, (_, i) => adoItem(i + 1)), calls));
  const batches = calls.filter(c => c.endpoint === 'workitemsbatch');
  assert.deepEqual(batches.map(c => c.body.ids.length), [200, 1]);
  assert.ok(batches.every(c => c.body.asOf === '2026-10-09T01:00:00Z' && c.body.errorPolicy === 'Fail'));
  assert.equal(evidence.length, 201);
  assert.equal(evidence[0].source.revision, '1');
  assert.ok(evidence[0].missingFields.includes('Office.Common.IcMID'));
  assert.equal(evidence[0].discoveryChannel, 'unknown');
});
test('ADO missing batches fail instead of treating omissions as empty success', async t => {
  const { config } = setup(t), real = transport([adoItem()]);
  await assert.rejects(collectAdo(config, config.window, async () => {}, 'created',
    (endpoint, body) => endpoint === 'workitemsbatch' ? { value: [] } : real(endpoint, body)), /missing/);
});
test('ADO out-of-scope area rejected before evidence acceptance', async t => {
  const { config } = setup(t), item = adoItem();
  item.fields['System.AreaPath'] = `${area}Unrelated`;
  await assert.rejects(collectAdo(config, config.window, async () => {}, 'created', transport([item])), /out-of-scope/);
});
test('ADO budget exhaustion is explicit and does not silently truncate', async t => {
  const { config } = setup(t); config.limits.maxItems = 1;
  await assert.rejects(collectAdo(config, config.window, async () => {}, 'created', transport([adoItem(1), adoItem(2)])),
    e => e.code === 'partial');
});
test('ADO limit splits the half-open window at one stable asOf', async t => {
  const { config } = setup(t);
  const calls = [];
  let enumerations = 0;
  const request = async (endpoint, body) => {
    calls.push(body.query);
    if (body.query.includes('[System.Id] = 0')) return { asOf: '2026-10-09T01:00:00Z', workItems: [] };
    if (++enumerations === 1) throw new PilotError('query-limit', 'limit');
    return { asOf: '2026-10-09T01:00:00Z', workItems: [] };
  };
  await collectAdo(config, config.window, async () => {}, 'created', request);
  assert.equal(calls.length, 4);
  assert.ok(calls[2].includes('2026-10-08T12:00:00.000Z'));
  assert.ok(calls[3].includes('2026-10-08T12:00:00.000Z'));
  assert.ok(calls.slice(1).every(q => q.includes("ASOF '2026-10-09T01:00:00Z'")));
});
test('partial source capture is durable, keeps cursor and deduplicates on replay', async t => {
  const { config, ledger } = setup(t);
  const adapter = async (c, window, emit) => {
    const record = evidenceEnvelope('ado', 'office/OC', 1, '1', 'https://example.invalid/1', 'synthetic', now());
    record.source.provenance = 'synthetic';
    await emit(record, { raw: 'fixture' });
    throw new PilotError('blocked-auth', 'Synthetic expired sign-in');
  };
  const result = await collect(config, ledger, { adapters: { ado: adapter } });
  assert.equal(result[0].state, 'blocked-auth');
  assert.equal(ledger.cursor('ado:created'), null);
  const skipped = await collect(config, ledger, { adapters: { ado: adapter } });
  assert.equal(skipped[0].state, 'blocked');
  assert.equal(ledger.status().runs.length, 1);
  ledger.unblockSource('ado:created', 'Synthetic reauthentication confirmed');
  ledger.unblockSource('auth:ado', 'Synthetic reauthentication confirmed');
  await collect(config, ledger, { adapters: { ado: adapter } });
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 2);
});
test('complete source cursor survives a fresh database connection', async t => {
  const { config, ledger } = setup(t);
  await collect(config, ledger, { adapters: { ado: async () => ({ end: config.window.end }) } });
  const reopened = new Ledger(config.stateDirectory);
  try { assert.equal(reopened.cursor('ado:created').end, config.window.end); } finally { reopened.close(); }
});
test('immutable evidence retains both revision versions and actual capture byte hashes', t => {
  const { ledger } = setup(t);
  const first = addEvidence(ledger), second = addEvidence(ledger, '1', '2', { text: 'changed' });
  assert.notEqual(first.id, second.id);
  const bytes = ledger.db.prepare('SELECT body FROM captures WHERE hash=?').get(first.capture.sha256).body;
  assert.equal(hash(bytes), first.capture.sha256);
  assert.throws(() => ledger.db.prepare("UPDATE records SET body='{}'").run(), /immutable/);
  assert.throws(() => ledger.put({ ...first, title: 'changed' }), /Immutable/);
});
test('older ADO revision does not replace newer evidence on a later historical read', t => {
  const { ledger } = setup(t);
  const newest = addEvidence(ledger, '1', '2');
  addEvidence(ledger, '1', '1', { historical: true });
  assert.equal(latestEvidence(ledger)[0].id, newest.id);
});
test('atomic ownership rejects another connection and wrong release token', t => {
  const { config, ledger } = setup(t), other = new Ledger(config.stateDirectory);
  try {
    const owner = ledger.acquire('collection');
    assert.throws(() => other.acquire('collection'), e => e.code === 'overlap');
    other.release('collection', 'wrong');
    assert.throws(() => other.acquire('collection'));
    ledger.release('collection', owner);
    const token = other.acquire('collection'); other.release('collection', token);
  } finally { other.close(); }
});
test('live process lock cannot be recovered even with exact owner', t => {
  const { ledger } = setup(t), owner = ledger.acquire('collection');
  assert.throws(() => ledger.recoverLock('collection', owner), /still present/);
  ledger.release('collection', owner);
});
test('owner lock remains exclusive in a separate process', t => {
  const { ledger, config } = setup(t), owner = ledger.acquire('collection');
  const script = `import {Ledger} from './src/ledger.js'; const l=new Ledger(${json(config.stateDirectory)}); try{l.acquire('collection');process.exitCode=5}catch(e){process.stdout.write(e.code)}finally{l.close()}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout, 'overlap');
  ledger.release('collection', owner);
});
test('WorkIQ only accepts exact selected entity paths, never tenant-wide search', () => {
  const valid = { id: 'seed', path: '/teams/team/channels/channel/messages/message?$select=id,body', url: 'https://teams.microsoft.com/message' };
  assert.equal(validateSeed(valid), valid);
  for (const path of ['/me/messages?$select=id', '/me/messages/one?$expand=attachments&$select=id',
    '/teams/team/channels/channel/messages/../members?$select=id', 'https://graph.microsoft.com/me/messages/one?$select=id',
    '/me/messages/%2fsecret?$select=id', '/me/messages/one?$select=id&$top=50']) {
    assert.throws(() => validateSeed({ ...valid, path }));
  }
});
test('empty WorkIQ seeds block instead of broadening', async t => {
  const { config } = setup(t); config.sources.workiq.scopeApproved = true; config.sources.workiq.identityConfirmed = true;
  let called = false;
  await assert.rejects(collectWorkiq(config, config.window, async () => {}, async () => { called = true; }), /no approved/);
  assert.equal(called, false);
});
test('WorkIQ captures only configured seeds and labels current-snapshot coverage', async t => {
  const { config } = setup(t);
  config.sources.workiq = { enabled: true, scopeApproved: true, identityConfirmed: true,
    seeds: [{ id: 'seed', path: '/me/messages/id?$select=id,body', url: 'https://outlook.office.com/mail/id' }] };
  const captured = [];
  const cursor = await collectWorkiq(config, config.window, async (e, payload) => captured.push({ e, payload }),
    async path => path === principalPath ? { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser }
      : { entity: { id: 'seed' }, synthetic: true });
  assert.equal(captured.length, 1); assert.equal(cursor.coverage[0].kind, 'exact-seed-snapshot-only');
  assert.equal(captured[0].e.source.revision, null);
});
test('IcM has an explicit unverified-query/connector blocker', async t => {
  const { config } = setup(t);
  await assert.rejects(collectIcm(config, config.window, async () => {}), /not verified/);
  config.sources.icm.scopeApproved = true; config.sources.icm.filtersVerified = true;
  await assert.rejects(collectIcm(config, config.window, async () => {}), /No supported authenticated/);
});
test('IcM owner export cannot masquerade as authenticated collection', async t => {
  const { config, root } = setup(t);
  const record = evidenceEnvelope('icm', 'icm/query/599514', 1, null, 'https://portal.microsofticm.com/imp/v5/incidents/details/1', '599514');
  record.createdAt = '2026-10-08T01:00:00Z';
  const file = join(root, 'icm.json');
  config.sources.icm = { enabled: true, scopeApproved: true, filtersVerified: true, queryId: '599514', ownerExport: file };
  writeFileSync(file, json({ queryId: '599514', window: config.window, evidence: [record] }));
  await assert.rejects(collectIcm(config, config.window, async () => {}), /owner-confirmed/);
  record.source.provenance = 'owner-provided';
  record.source.ownerConfirmation = { confirmedBy: 'synthetic-owner', confirmedAt: now(), confirmedScope: 'icm/query/599514' };
  writeFileSync(file, json({ queryId: '599514', window: config.window, evidence: [record] }));
  let captured;
  const cursor = await collectIcm(config, config.window, async e => { captured = e; });
  assert.equal(captured.source.provenance, 'owner-provided'); assert.equal(cursor.coverage, 'owner-export-only');
});
test('review requires configured method, stable identity and full exclusion checklist', t => {
  const { config, ledger } = setup(t), e = addEvidence(ledger), r = review(e);
  assert.throws(() => acceptReview(config, ledger, { investigation: r, exclusionsChecked: [] }), /All scanner exclusions/);
  assert.throws(() => acceptReview(config, ledger, { investigation: { ...r, id: 'random' }, exclusionsChecked: exclusions }), /identity/);
  const wrong = structuredClone(r); wrong.review.method = 'agent-evidence-review';
  assert.throws(() => acceptReview(config, ledger, { investigation: wrong, exclusionsChecked: exclusions }), /method/);
  assert.equal(acceptReview(config, ledger, { investigation: r, exclusionsChecked: exclusions }).defectConfirmation, 'unconfirmed');
  assert.throws(() => acceptReview(config, ledger, { investigation: r, exclusionsChecked: exclusions }), /version/);
});
test('superseded evidence cannot be reviewed using an old version', t => {
  const { config, ledger } = setup(t), e = addEvidence(ledger);
  addEvidence(ledger, '1', '2', { changed: true });
  assert.throws(() => acceptReview(config, ledger, { investigation: review(e), exclusionsChecked: exclusions }), /superseded/);
});
for (const exclusion of exclusions) {
  test(`both defect and improvement handoffs enforce ${exclusion}`, t => {
    const { config, ledger, root } = setup(t), repo = repoConfig(config, root), r = review(addEvidence(ledger));
    r.repoIds = [repo.id]; r.exclusionReasons = [exclusion]; r.handoffEligibility = 'excluded'; r.reportEligibility = 'excluded';
    for (const intent of ['defect-fix', 'improvement']) assert.throws(() => makeAssignment(config, r, repo.id, intent), /Excluded/);
  });
}
test('report distinguishes source candidates, eligibility and code-defect confirmation', t => {
  const { config, ledger } = setup(t), e = addEvidence(ledger);
  acceptReview(config, ledger, { investigation: review(e), exclusionsChecked: exclusions });
  const result = report(ledger);
  assert.equal(result.summary.functionalIds.length, 1);
  assert.equal(result.summary.confirmedCodeDefectIds.length, 0);
  assert.equal(result.issues[0].source.provenance, 'synthetic');
});
test('assignment prepare is idempotent and newer review cannot launch duplicate work', async t => {
  const { config, ledger, assignment, investigation, repo } = await fixture(t);
  const first = ledger.prepare(assignment), second = ledger.prepare(assignment);
  assert.equal(first.session_id, second.session_id);
  repo.validationGates = [{ id: 'source-test', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 1000 }];
  const differentIntent = makeAssignment(config, investigation, repo.id, 'defect-fix');
  assert.notEqual(differentIntent.id, assignment.id);
  assert.throws(() => ledger.prepare(differentIntent), /different execution semantics/);
  const newer = { ...investigation, version: 2 };
  assert.throws(() => ledger.prepare(makeAssignment(config, newer, repo.id, 'rca-only')), /Prior assignment/);
});
test('crash after prepared dispatch is reconciled, not automatically reset to prepared', async t => {
  const { ledger, job } = await fixture(t);
  ledger.moveJob(job.id, 'prepared', 'dispatching');
  const pending = reconcile(ledger).jobs[0];
  assert.equal(pending.state, 'dispatching'); assert.match(pending.nextAction, /never relaunch/);
});
test('provisioning uses separate clone without hardlinked objects or primary changes', async t => {
  const { config, job, repo, g } = await fixture(t);
  const before = (await g(['rev-parse', 'HEAD'])).stdout;
  const result = await provision(config, job, repo);
  assert.notEqual(result.workspace, repo.referenceCheckout);
  assert.equal((await g(['status', '--porcelain'])).stdout, '');
  assert.equal((await g(['rev-parse', 'HEAD'])).stdout, before);
  assert.equal(readFileSync(join(result.workspace, 'src', 'value.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const value = 1;\n');
  await assert.rejects(provision(config, job, repo), /already exists/);
});
test('Windows provisioned authoring checkout supports native Git long paths without changing the reference', {
  skip: process.platform !== 'win32'
}, async t => {
  const { config, job, repo } = await fixture(t);
  const { path } = await longPathFixture(repo.referenceCheckout);
  const referenceConfig = readFileSync(join(repo.referenceCheckout, '.git', 'config'), 'utf8');
  const { workspace, baseRevision } = await provision(config, job, repo);
  assert.ok(join(workspace, path).length > 260);
  assert.equal((await command('git', ['config', '--local', '--get', 'core.longpaths'],
    workspace)).stdout.trim(), 'true');
  const source = await command('git', ['show', `${baseRevision}:${path.replaceAll('\\', '/')}`],
    workspace);
  assert.equal(source.stdout, 'export const value = 1;\n');
  assert.equal(readFileSync(join(repo.referenceCheckout, '.git', 'config'), 'utf8'), referenceConfig);
});
test('repository provisioning timeout must be a positive integer', async t => {
  const { config, repo } = await fixture(t);
  repo.provisionTimeoutMs = 0;
  assert.throws(() => repoFor(config, repo.id), /provisionTimeoutMs must be a positive integer/);
  repo.provisionTimeoutMs = 900000;
  assert.equal(repoFor(config, repo.id).provisionTimeoutMs, 900000);
});
test('sparse provisioning materializes configured directories and keeps bounded listings', async t => {
  const { config, job, repo, assignment, g } = await fixture(t);
  mkdirSync(join(repo.referenceCheckout, 'unrelated'), { recursive: true });
  writeFileSync(join(repo.referenceCheckout, 'unrelated', 'large.js'), 'export const unrelated = true;\n');
  await g(['add', '.']);
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Add unrelated fixture']);
  repo.sparseCheckoutPaths = ['src'];
  const { workspace } = await provision(config, job, repo);
  assert.equal(existsSync(join(workspace, 'src', 'value.js')), true);
  assert.equal(existsSync(join(workspace, 'unrelated', 'large.js')), false);
  const tools = new WorkerTools(config, assignment, workspace);
  assert.equal((await tools.list()).includes('src/value.js'), true);
});
test('trusted qualification fetches its exact revision before isolated checkout', async t => {
  const { config, job, repo, g } = await fixture(t);
  const revision = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  let fetched = null;
  const result = await provision(config, job, repo, {
    baseRevision: revision,
    qualificationSource: 'trusted-remote'
  }, {
    fetchQualifiedRevision: async (currentConfig, workspace, currentRepo, exactRevision) => {
      fetched = { workspace, repo: currentRepo.id, exactRevision };
    }
  });
  assert.equal(fetched.repo, repo.id);
  assert.equal(fetched.exactRevision, revision);
  assert.equal((await command('git', ['rev-parse', 'HEAD'], result.workspace)).stdout.trim(), revision);
});
test('provisioning skips unrelated Git LFS smudges without mutating the controller environment', () => {
  const original = process.env.GIT_LFS_SKIP_SMUDGE;
  const env = checkoutEnvironment();
  assert.equal(env.GIT_LFS_SKIP_SMUDGE, '1');
  assert.equal(process.env.GIT_LFS_SKIP_SMUDGE, original);
});
test('worker file callbacks reject traversal, alternate streams, protected paths and links', async t => {
  const { config, job, repo, assignment, root } = await fixture(t);
  const { workspace } = await provision(config, job, repo);
  const editable = structuredClone(assignment); editable.permissions.editCode = true;
  const tools = new WorkerTools(config, editable, workspace);
  for (const path of ['..\\outside', '.git\\config', 'src\\x:stream', 'src\\..\\..\\outside', 'src\\..\\README.md']) assert.throws(() => tools.write(path, 'bad'));
  assert.throws(() => tools.write('other\\value.js', 'bad'), /edit bounds/);
  mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(workspace, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => tools.write('src\\linked\\value.js', 'bad'), /Symlink/);
  tools.write('src\\new.js', 'export const value = 2;');
  assert.ok(existsSync(join(workspace, 'src', 'new.js')));
  assert.ok(!existsSync(join(repo.referenceCheckout, 'src', 'new.js')));
  assert.match(tools.read('src\\value.js', 1, 1), /value = 1/);
  tools.replaceLines('src\\value.js', 1, 1,
    'export const value = 1;', 'export const value = 3;');
  assert.equal(tools.read('src\\value.js', 1, 1), 'export const value = 3;');
  assert.throws(() => tools.replaceLines('src\\value.js', 1, 1,
    'export const value = 1;', 'bad'), /does not match/);
  tools.repo.allowedWritePrefixes = ['src/value.js'];
  tools.replaceLines('src\\value.js', 1, 1,
    'export const value = 3;', 'export const value = 4;');
  assert.equal(tools.read('src\\value.js', 1, 1), 'export const value = 4;');
  assert.throws(() => tools.write('src\\another.js', 'bad'), /prefixes/);
  assert.equal((await tools.search('value = 1', 'src')).some(match =>
    match.includes('src/value.js')), false);
});
test('RCA-only workers cannot write and submitted workers cannot keep editing', async t => {
  const { config, assignment, job, repo } = await fixture(t);
  const { workspace } = await provision(config, job, repo);
  const tools = new WorkerTools(config, assignment, workspace);
  assert.throws(() => tools.write('src\\value.js', 'bad'), /not permitted/);
  tools.finish({ outcome: 'investigated', findings: 'Synthetic findings' });
  assert.throws(() => tools.finish({ outcome: 'investigated', findings: 'again' }), /already submitted/);
});
test('SDK configuration exposes no built-in tools and denies unrelated permissions', () => {
  const config = restrictedSession([{ name: 'pilot_read' }]);
  assert.deepEqual(config.availableTools.toArray(), ['custom:pilot_read']);
  assert.equal(config.hooks.onPreToolUse({ toolName: 'powershell' }).permissionDecision, 'deny');
  assert.equal(config.onPermissionRequest({ kind: 'shell' }).kind, 'denied-by-rules');
});
test('validation records real terminal command execution at exact fixture HEAD and forbids duplicates', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const current = { ...job, workspace: isolated.workspace };
  // Only this synthetic fixture authorizes a local test command; no product runner is qualified.
  repo.validationGates = [{ id: 'synthetic-node', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['--input-type=module', '-e',
      "import {value} from './src/value.js'; import assert from 'node:assert/strict'; assert.equal(value,1)"], timeoutMs: 10000 }];
  const result = await runValidation(config, ledger, current, repo, isolated.baseRevision);
  assert.equal(result[0].status, 'passed');
  assert.equal(result[0].sourceRevision, isolated.baseRevision);
  assert.ok(existsSync(result[0].artifactRefs[0]));
  await assert.rejects(runValidation(config, ledger, current, repo, isolated.baseRevision), /already started/);
});
test('failed validation is terminal evidence, not a success-shaped result', async t => {
  const { config, ledger, job, repo } = await fixture(t), isolated = await provision(config, job, repo);
  repo.validationGates = [{ id: 'fail', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['-e', 'process.exit(9)'], timeoutMs: 10000 }];
  const result = await runValidation(config, ledger, { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision);
  assert.equal(result[0].status, 'failed');
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.output.exitCode, 9);
});
test('validation profile errors block without entering source repair retries', async t => {
  const { config, ledger, job, repo } = await fixture(t), isolated = await provision(config, job, repo);
  config.limits.maxValidationInfrastructureRetries = 2;
  repo.validationGates = [{ id: 'profile-error', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000 }];
  let attempts = 0;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async () => {
      attempts++;
      throw Object.assign(new Error('invalid profile selection'), {
        code: 1, stdout: '', stderr: 'PILOT_VALIDATION_PROFILE_ERROR: no authored test selected'
      });
    });
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'validation-profile-error');
  assert.equal(result[0].attemptCount, 1);
  assert.equal(attempts, 1);
});
test('source mutation during validation retries in a clean checkout then blocks', async t => {
  const { config, ledger, job, repo } = await fixture(t), isolated = await provision(config, job, repo);
  config.limits.maxValidationInfrastructureRetries = 1;
  repo.validationGates = [{ id: 'mutates', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000 }];
  let attempts = 0;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async (executable, args, cwd) => {
    attempts++;
    writeFileSync(join(cwd, 'src', 'value.js'), 'changed');
    return { stdout: '', stderr: '' };
  });
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'runner-mutated-source');
  assert.equal(result[0].attemptCount, 2);
  assert.equal(result[0].artifactRefs.length, 2);
  assert.equal(attempts, 2);
  assert.equal(await command('git', ['status', '--porcelain'], isolated.workspace).then(value => value.stdout.trim()), '');
});
test('transient validation timeout retries once in a fresh checkout and can recover', async t => {
  const { config, ledger, job, repo } = await fixture(t), isolated = await provision(config, job, repo);
  config.limits.maxValidationInfrastructureRetries = 1;
  repo.validationGates = [{
    id: 'transient', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000
  }];
  let attempts = 0;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async () => {
      attempts++;
      if (attempts === 1)
        throw Object.assign(new Error('timed out'), {
          killed: true, code: null, stdout: '', stderr: 'timeout'
        });
      return { stdout: 'passed', stderr: '' };
    });
  assert.equal(result[0].status, 'passed');
  assert.equal(result[0].blockedReason, null);
  assert.equal(result[0].attemptCount, 2);
  assert.equal(result[0].artifactRefs.length, 2);
  assert.equal(JSON.parse(readFileSync(result[0].artifactRefs[0])).blockedReason, 'runner-timeout');
});
test('validation requires approved runner and never inherits credential environment values', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.validationGates = [{ id: 'unqualified', executable: process.execPath, args: [], timeoutMs: 1000 }];
  await assert.rejects(runValidation(config, ledger, job, repo, 'abc'), /approved repo-native runner/);
  process.env.PILOT_TEST_SECRET = 'not-a-real-secret';
  const localAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = 'safe-build-path';
  try {
    assert.equal(minimalEnvironment().PILOT_TEST_SECRET, undefined);
    assert.equal(minimalEnvironment().LOCALAPPDATA, 'safe-build-path');
  } finally {
    delete process.env.PILOT_TEST_SECRET;
    if (localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = localAppData;
  }
});
function packageToken(t, name = 'PILOT_FIXTURE_TOKEN', token = 'synthetic-package-token:/+=') {
  const previous = process.env[name];
  process.env[name] = token;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  return token;
}
test('opt-in package auth reaches only the selected runner and redacts successful output', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const token = packageToken(t);
  packageToken(t, 'NPM_CONFIG_USERCONFIG', 'untrusted-config');
  packageToken(t, 'PILOT_UNRELATED_TOKEN', 'unrelated-secret');
  repo.validationGates = ['authenticated', 'legacy'].map(id => ({
    id, approved: true, isolationVerified: true, executable: process.execPath,
    args: [], timeoutMs: 10000,
    ...(id === 'authenticated' ? {
      packageAuth: { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' }
    } : {})
  }));
  let calls = 0;
  const results = await runValidation(config, ledger, { ...job, workspace: isolated.workspace },
    repo, isolated.baseRevision, async (executable, args, cwd, timeout, env) => {
      assert.equal(env.YARN_NPM_AUTH_TOKEN, calls++ === 0 ? token : undefined);
      for (const name of ['PILOT_FIXTURE_TOKEN', 'PILOT_UNRELATED_TOKEN', 'NPM_CONFIG_USERCONFIG'])
        assert.equal(env[name], undefined);
      assert.equal(args.includes(token), false);
      return { stdout: calls === 1 ? token : 'legacy', stderr: calls === 1
        ? `${Buffer.from(token).toString('base64')} ${encodeURIComponent(token)}` : '' };
    });
  assert.ok(results.every(result => result.status === 'passed'));
  const artifact = readFileSync(results[0].artifactRefs[0], 'utf8');
  for (const secret of [token, Buffer.from(token).toString('base64'), encodeURIComponent(token)])
    assert.equal(artifact.includes(secret), false);
  assert.match(artifact, /\[REDACTED\]/);
  assert.equal(process.env.PILOT_FIXTURE_TOKEN, token);
  assert.equal(minimalEnvironment().YARN_NPM_AUTH_TOKEN, undefined);
});
test('authenticated runner failures redact diagnostics without losing exit status', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const token = packageToken(t);
  repo.validationGates = [{ id: 'auth-failure', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000,
    packageAuth: { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' } }];
  const results = await runValidation(config, ledger, { ...job, workspace: isolated.workspace },
    repo, isolated.baseRevision, async () => {
      throw Object.assign(new Error(token), { code: 7, stdout: token, stderr: token,
        secret: token });
    });
  assert.equal(results[0].status, 'failed');
  const artifact = readFileSync(results[0].artifactRefs[0], 'utf8');
  assert.equal(artifact.includes(token), false);
  assert.equal(JSON.parse(artifact).output.exitCode, 7);
});
test('real authenticated subprocesses receive an isolated environment and leave redacted artifacts', async t => {
  const token = packageToken(t);
  for (const exitCode of [0, 7]) {
    const { config, ledger, job, repo } = await fixture(t);
    const isolated = await provision(config, job, repo);
    repo.validationGates = [{ id: 'auth-process', approved: true, isolationVerified: true,
      executable: process.execPath, args: ['-e', `
        const assert = require('node:assert/strict');
        assert.ok(process.env.YARN_NPM_AUTH_TOKEN);
        assert.equal(process.env.PILOT_FIXTURE_TOKEN, undefined);
        console.log(process.env.YARN_NPM_AUTH_TOKEN);
        console.error(Buffer.from(process.env.YARN_NPM_AUTH_TOKEN).toString('base64'));
        process.exit(${exitCode});
      `], timeoutMs: 10000,
      packageAuth: { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' } }];
    const results = await runValidation(config, ledger,
      { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision);
    assert.equal(results[0].status, exitCode ? 'failed' : 'passed');
    const artifact = readFileSync(results[0].artifactRefs[0], 'utf8');
    assert.equal(artifact.includes(token), false);
    assert.equal(artifact.includes(Buffer.from(token).toString('base64')), false);
    assert.match(artifact, /\[REDACTED\]/);
  }
});
test('missing package auth blocks without executing or retrying the runner', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  packageToken(t, 'PILOT_FIXTURE_TOKEN', '');
  config.limits.maxValidationInfrastructureRetries = 2;
  repo.validationGates = [{ id: 'auth-missing', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000,
    packageAuth: { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' } }];
  const results = await runValidation(config, ledger, { ...job, workspace: isolated.workspace },
    repo, isolated.baseRevision, async () => assert.fail('Must not execute'));
  assert.equal(results[0].status, 'blocked');
  assert.equal(results[0].blockedReason, 'blocked-auth');
  assert.equal(results[0].attemptCount, 1);
});
test('omitted package auth preserves legacy runner error classification', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  repo.validationGates = [{ id: 'legacy-error', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000 }];
  const results = await runValidation(config, ledger, { ...job, workspace: isolated.workspace },
    repo, isolated.baseRevision, async () => { throw new PilotError('blocked-auth', 'fixture'); });
  assert.equal(results[0].blockedReason, 'runner-unavailable');
});
test('staged package auth stays out of fingerprint, policy, test and preparation receipts', async t => {
  const ctx = await stagedValidationFixture(t);
  const token = packageToken(t);
  ctx.repo.validationGates[0].packageAuth =
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' };
  const execute = async (executable, args, cwd, timeout, env) => {
    const needsAuth = ['dependencies', 'compile'].includes(env.PILOT_VALIDATION_STAGE);
    assert.equal(env.YARN_NPM_AUTH_TOKEN, needsAuth ? token : undefined);
    const output = await ctx.execute(executable, args, cwd, timeout, env);
    return needsAuth ? { stdout: token, stderr: token } : output;
  };
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, execute);
  assert.ok(prepared.staged.receiptPath, json(prepared));
  for (const path of [prepared.staged.receiptPath, prepared.staged.dependencyReceiptPath]) {
    const receipt = readFileSync(path, 'utf8');
    assert.equal(receipt.includes(token), false);
    assert.equal(JSON.parse(receipt).inputs.packageAuth.kind, 'yarn-token');
  }
  process.env.PILOT_FIXTURE_TOKEN = 'rotated-synthetic-package-token';
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.deepEqual(ctx.calls, ['fingerprint', 'dependencies', 'compile',
    'fingerprint', 'policy', 'test']);
  assert.equal(readFileSync(result[0].artifactRefs[0], 'utf8').includes(token), false);
});
test('staged dependency auth failures are redacted before telemetry and receipts', async t => {
  const ctx = await stagedValidationFixture(t);
  const token = packageToken(t);
  ctx.repo.validationGates[0].packageAuth =
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, async (...args) => {
      if (args[4].PILOT_VALIDATION_STAGE === 'dependencies')
        throw Object.assign(new Error(token), { code: 1, stdout: token, stderr: token });
      return ctx.execute(...args);
    });
  assert.equal(result[0].status, 'failed');
  const artifact = readFileSync(result[0].artifactRefs[0], 'utf8');
  assert.equal(artifact.includes(token), false);
  assert.equal(JSON.parse(artifact).output.stderr, '[REDACTED]');
});
test('missing staged package auth blocks after fingerprint without restore or retries', async t => {
  const ctx = await stagedValidationFixture(t);
  packageToken(t, 'PILOT_FIXTURE_TOKEN', '');
  ctx.repo.validationGates[0].packageAuth =
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'blocked-auth');
  assert.equal(result[0].attemptCount, 1);
  assert.deepEqual(ctx.calls, ['fingerprint']);
});
test('changing the package auth contract invalidates prepared dependencies and compile', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  packageToken(t);
  ctx.repo.validationGates[0].packageAuth =
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
async function longPathFixture(workspace) {
  const path = join('src', 'long-native-path-'.repeat(8), 'value.js');
  mkdirSync(dirname(join(workspace, path)), { recursive: true });
  writeFileSync(join(workspace, path), 'export const value = 1;\n');
  await command('git', ['-c', 'core.longpaths=true', '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', 'add', '--', path], workspace);
  await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Add long-path fixture'], workspace);
  const revision = (await command('git', ['rev-parse', 'HEAD'], workspace)).stdout.trim();
  return { path, revision };
}
test('Windows staged native Git handles long paths in new and reused validation clones', {
  skip: process.platform !== 'win32'
}, async t => {
  const ctx = await stagedValidationFixture(t);
  const authoredConfig = readFileSync(join(ctx.isolated.workspace, '.git', 'config'), 'utf8');
  const referenceConfig = readFileSync(join(ctx.repo.referenceCheckout, '.git', 'config'), 'utf8');
  const longPath = await longPathFixture(ctx.isolated.workspace);
  const execute = async (executable, args, cwd, timeout, env) => {
    if (env.PILOT_VALIDATION_STAGE !== 'fingerprint') {
      const path = join(cwd, longPath.path);
      assert.ok(path.length > 260, `Expected an actual long path, got ${path.length}`);
      const local = await command('git', ['config', '--local', '--get', 'core.longpaths'], cwd);
      assert.equal(local.stdout.trim(), 'true');
      const native = await command('git', ['hash-object', '--', path], cwd);
      assert.match(native.stdout.trim(), /^[a-f0-9]{40,64}$/);
    }
    return ctx.execute(executable, args, cwd, timeout, env);
  };
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    longPath.revision, execute);
  assert.ok(prepared.staged.receiptPath, json(prepared));
  await command('git', ['config', '--local', '--unset', 'core.longpaths'],
    prepared.staged.workspace);
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    longPath.revision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.deepEqual(ctx.calls, ['fingerprint', 'dependencies', 'compile',
    'fingerprint', 'policy', 'test']);
  assert.equal(readFileSync(join(ctx.isolated.workspace, '.git', 'config'), 'utf8'), authoredConfig);
  assert.equal(readFileSync(join(ctx.repo.referenceCheckout, '.git', 'config'), 'utf8'), referenceConfig);
});
test('Windows non-staged native Git gets clone-local long paths without editing authored config', {
  skip: process.platform !== 'win32'
}, async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const authoredConfig = readFileSync(join(isolated.workspace, '.git', 'config'), 'utf8');
  const longPath = await longPathFixture(isolated.workspace);
  repo.validationGates = [{ id: 'native-longpaths', approved: true, isolationVerified: true,
    executable: process.execPath, timeoutMs: 10000, args: ['-e', `
      const assert = require('node:assert/strict');
      const path = require('node:path').resolve(${JSON.stringify(longPath.path)});
      assert.ok(path.length > 260);
      const hash = require('node:child_process').execFileSync('git',
        ['hash-object', '--', path], {encoding: 'utf8'}).trim();
      assert.match(hash, /^[a-f0-9]{40,64}$/);
    `] }];
  const results = await runValidation(config, ledger, { ...job, workspace: isolated.workspace },
    repo, longPath.revision);
  assert.equal(results[0].status, 'passed');
  assert.equal(readFileSync(join(isolated.workspace, '.git', 'config'), 'utf8'), authoredConfig);
});
test('validation profiles are content-bound and substituted by the controller', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const profilePath = join(config.stateDirectory, 'validation-profile.ps1');
  writeFileSync(profilePath, 'Write-Output profile');
  repo.validationGates = [{
    id: 'profiled', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['-e', 'process.exit(0)', '{profile}'],
    profilePath, profileSha256: hash('Write-Output profile'), timeoutMs: 10000
  }];
  let observedArgs;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async (executable, args) => {
      observedArgs = args;
      return { stdout: '', stderr: '' };
    });
  assert.equal(result[0].status, 'passed');
  assert.notEqual(observedArgs.at(-1), profilePath);
  assert.match(observedArgs.at(-1), /validation-profiles/);
  assert.equal(existsSync(observedArgs.at(-1)), false);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.profileSha256, hash('Write-Output profile'));

  const second = await fixture(t);
  const secondIsolated = await provision(second.config, second.job, second.repo);
  second.repo.validationGates = [{
    ...repo.validationGates[0],
    profilePath,
    profileSha256: '0'.repeat(64)
  }];
  await assert.rejects(runValidation(second.config, second.ledger,
    { ...second.job, workspace: secondIsolated.workspace }, second.repo,
    secondIsolated.baseRevision), /profile hash mismatch/);
});
test('validation blocks when a content-bound private profile changes during execution', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  config.limits.maxValidationInfrastructureRetries = 1;
  const profilePath = join(config.stateDirectory, 'validation-profile.ps1');
  writeFileSync(profilePath, 'Write-Output profile');
  repo.validationGates = [{
    id: 'profile-toctou', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['{profile}'],
    profilePath, profileSha256: hash('Write-Output profile'), timeoutMs: 10000
  }];
  let attempts = 0;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async (executable, args) => {
      attempts++;
      writeFileSync(args[0], 'changed-after-verification');
      return { stdout: '', stderr: '' };
    });
  assert.equal(attempts, 1);
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'validation-profile-changed');
  assert.equal(result[0].attemptCount, 1);
});
test('validation cleanup failures still finalize blocked evidence and operations', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  repo.validationGates = [{
    id: 'cleanup', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000
  }];
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async () => ({ stdout: '', stderr: '' }),
    () => { throw new Error('synthetic cleanup failure'); });
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'validation-cleanup-failed');
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.match(artifact.output.cleanupError, /Operation failed/);
  assert.ok(artifact.output.residualPaths.length > 0);
  const operations = ledger.status().operations;
  assert.equal(operations.length, 1);
  assert.equal(operations[0].state, 'blocked');
});
test('post-run inspection failures preserve runner diagnostics in blocked evidence', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  repo.validationGates = [{
    id: 'inspection', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000
  }];
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async (executable, args, cwd) => {
      rmSync(join(cwd, '.git'), { recursive: true, force: true });
      const error = new Error('synthetic runner failure');
      error.code = 9;
      error.stdout = 'runner stdout';
      error.stderr = 'runner stderr';
      throw error;
    });
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'validation-workspace-unavailable');
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.output.exitCode, 9);
  assert.equal(artifact.output.stdout, 'runner stdout');
  assert.equal(artifact.output.stderr, 'runner stderr');
  assert.match(artifact.output.inspectionError, /Operation failed/);
});
test('test-only repair reuses dependency and compile receipts with phase telemetry', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.equal(prepared.staged.error, undefined,
    JSON.stringify(prepared.staged.error));
  const revision = await ctx.commit('test/behavior.test.js', 'repaired\n', 'Repair test only');
  const receipt = prepared.staged;
  const persisted = JSON.parse(readFileSync(receipt.receiptPath, 'utf8'));
  const { integrity, ...body } = persisted;
  assert.equal(hash(json(body)), integrity);
  assert.equal((await command('git', ['diff', '--name-only',
    receipt.inputs.sourceRevision, revision], ctx.current.workspace)).stdout.trim(),
  'test/behavior.test.js');
  assert.equal((await command('git', ['status', '--porcelain'],
    receipt.workspace)).stdout.trim(), '');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed', JSON.stringify(result[0]));
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1,
    JSON.stringify(ctx.calls));
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'policy').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'test').length, 1);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.telemetry.cache, 'hit');
  assert.equal(artifact.telemetry.preparedSourceRevision, ctx.isolated.baseRevision);
  assert.equal(artifact.telemetry.validationRevision, revision);
  assert.equal(artifact.telemetry.validationTimings.find(stage => stage.id === 'dependencies').cache, 'hit');
  assert.equal(artifact.telemetry.validationTimings.find(stage => stage.id === 'compile').cache, 'hit');
  assert.ok(artifact.telemetry.preparationTimings.every(stage =>
    stage.startedAt && stage.finishedAt));
  assert.ok(artifact.telemetry.validationTimings.every(stage =>
    stage.startedAt && stage.finishedAt));
  assert.deepEqual(artifact.telemetry.validationTimings
    .filter(stage => stage.id.startsWith('reuse-')).map(stage => stage.id), [
    'reuse-receipts', 'reuse-changed-paths', 'reuse-inputs', 'reuse-prepared-outputs'
  ]);
  assert.deepEqual(artifact.telemetry.validationTimings.find(stage =>
    stage.id === 'cleanup').subphases.map(stage => stage.id), [
    'restore-source', 'verify-prepared-outputs', 'verify-source'
  ]);
});
test('cold staged validation passes with one complete prepared pipeline', async t => {
  const ctx = await stagedValidationFixture(t);
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'passed');
  assert.deepEqual(ctx.calls, [
    'fingerprint', 'dependencies', 'compile', 'policy', 'test'
  ]);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.telemetry.cache, 'miss');
  assert.ok(artifact.telemetry.preparationDurationMs >= 0);
  assert.ok(artifact.telemetry.validationDurationMs >= 0);
});
test('cold authenticated preparation runs broker once and cache hits skip it', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.deepEqual(ctx.calls, [
    'fingerprint', 'authentication', 'dependencies', 'compile'
  ]);
  assert.equal(prepared.staged.timings.find(stage =>
    stage.id === 'authentication').cache, 'miss');
  const reloaded = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.equal(reloaded.staged.receiptPath, prepared.staged.receiptPath);
  assert.equal(ctx.calls.filter(stage => stage === 'authentication').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
});
test('authentication preflight returns a safe action before a cold dispatch', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.authenticationPreflight = 'interactive-sign-in-required';
  writeFileSync(join(ctx.repo.referenceCheckout, '.yarnrc.yml'),
    'npmRegistryServer: "https://example.invalid/wrong-revision/"\n');
  const actions = await preflightValidationAuthentication(
    ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].state, 'action-required-auth');
  assert.equal(actions[0].reason, 'interactive-sign-in-required');
  assert.equal(actions[0].requiresInstallApproval, false);
  assert.equal(actions[0].tokenRequested, false);
  assert.deepEqual(actions[0].remediation.args.slice(0, 4), [
    'run', 'setup:validation-auth', '--', '-Workspace'
  ]);
  assert.match(actions[0].remediation.args[4],
    new RegExp(`pv[\\\\/]a[\\\\/].+[\\\\/]w$`));
  const exactConfig = readFileSync(
    join(actions[0].remediation.args[4], '.yarnrc.yml'), 'utf8');
  assert.match(exactConfig, /AugmentationLoop/);
  assert.doesNotMatch(exactConfig, /wrong-revision/);
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication-check']);
});
test('trusted dependency cache hits skip authentication checks', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  ctx.calls.length = 0;
  ctx.behavior.authenticationPreflight = 'interactive-sign-in-required';
  const actions = await preflightValidationAuthentication(
    ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute);
  assert.deepEqual(actions, []);
  assert.deepEqual(ctx.calls, ['fingerprint']);
  rmSync(join(dirname(prepared.staged.dependencyReceiptPath), 'w'),
    { recursive: true, force: true });
  ctx.calls.length = 0;
  const compileOnlyActions = await preflightValidationAuthentication(
    ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute);
  assert.deepEqual(compileOnlyActions, []);
  assert.deepEqual(ctx.calls, ['fingerprint']);
  rmSync(prepared.staged.workspace, { recursive: true, force: true });
  ctx.calls.length = 0;
  const missingSnapshotActions = await preflightValidationAuthentication(
    ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute);
  assert.equal(missingSnapshotActions[0].state, 'action-required-auth');
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication-check']);
});
test('authentication preflight is singleflight and malformed evidence blocks', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.authenticationPreflight = 'provider-missing';
  ctx.behavior.authenticationCheckDelayMs = 20;
  const [left, right] = await Promise.all([
    preflightValidationAuthentication(
      ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute),
    preflightValidationAuthentication(
      ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute)
  ]);
  assert.equal(left[0].requiresInstallApproval, true);
  assert.deepEqual(right, left);
  assert.equal(ctx.calls.filter(stage => stage === 'authentication-check').length, 1);
  ctx.behavior.authenticationPreflight = 'invalid';
  await assert.rejects(preflightValidationAuthentication(
    ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute), error =>
    error.code === 'blocked-auth');
});
test('authentication failure blocks before dependency restore without retrying', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.failAuthentication = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'blocked-auth');
  assert.equal(result[0].attemptCount, 1);
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication']);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.output.exitCode, 'blocked-auth');
  assert.match(artifact.output.stderr, /Azure Artifacts credentials/);
  assert.doesNotMatch(artifact.output.stderr, /anonymous user/i);
  assert.equal(artifact.telemetry.preparationTimings.at(-1).id, 'authentication');
});
test('dependency restore authentication errors are classified as blocked-auth', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.failDependencyAuthentication = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'blocked-auth');
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication', 'dependencies']);
  assert.equal(result[0].attemptCount, 1);
});
test('auth-like test output remains a test failure rather than an auth blocker', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  ctx.behavior.failTestWithAuthenticationText = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'failed');
  assert.equal(result[0].blockedReason, null);
  assert.equal(result[0].attemptCount, 1);
});
test('staged validation profile errors block without retrying or entering source repair', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  ctx.behavior.failTestWithProfileError = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'validation-profile-error');
  assert.equal(result[0].attemptCount, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'test').length, 1);
});
test('authentication cannot modify the exact-revision source workspace', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.mutateDuringAuthentication = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'blocked-auth');
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication']);
});
test('authentication must emit controller-auditable non-secret evidence', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.invalidAuthenticationEvidence = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'blocked-auth');
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication']);
});
test('failed test-only revision repairs without repeating dependency or compile stages', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  ctx.behavior.failTest = true;
  const failedRevision = await ctx.commit('test/behavior.test.js', 'fail\n', 'Add failing test');
  const failed = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    failedRevision, ctx.execute, rmSync, prepared);
  assert.equal(failed[0].status, 'failed');
  ctx.behavior.failTest = false;
  const repairedRevision = await ctx.commit('test/behavior.test.js', 'pass\n', 'Repair test');
  const passed = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    repairedRevision, ctx.execute, rmSync, prepared);
  assert.equal(passed[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'policy').length, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'test').length, 2);
});
test('production-to-test rename cannot reuse a test-only compile receipt', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  renameSync(join(ctx.current.workspace, 'src', 'unused.js'),
    join(ctx.current.workspace, 'test', 'unused.js'));
  const gitArgs = args => command('git', ['-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', ...args], ctx.current.workspace);
  await gitArgs(['add', '--all']);
  await gitArgs(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Move production source into tests']);
  const revision = (await gitArgs(['rev-parse', 'HEAD'])).stdout.trim();
  assert.equal((await gitArgs(['diff', '--name-only',
    prepared.staged.inputs.sourceRevision, revision])).stdout.trim(), 'test/unused.js');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('production changes reuse dependencies while lockfile changes invalidate them', async t => {
  for (const [path, content, dependencyRuns] of [
    ['src/value.js', 'export const value = 2;\n', 1],
    ['fixture.lock', 'changed\n', 2]
  ]) {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    const revision = await ctx.commit(path, content, `Change ${path}`);
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, ctx.execute, rmSync, prepared);
    assert.equal(result[0].status, 'passed');
    assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, dependencyRuns);
    assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
    const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
    assert.equal(artifact.telemetry.dependencyCache,
      dependencyRuns === 1 ? 'hit' : 'miss');
  }
});
test('profile and toolchain drift invalidate prepared validation', async t => {
  for (const drift of ['profile', 'toolchain']) {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    if (drift === 'profile') {
      writeFileSync(ctx.profilePath, `${readFileSync(ctx.profilePath, 'utf8')}\n`);
      ctx.repo.validationGates[0].profileSha256 = hash(readFileSync(ctx.profilePath));
    } else ctx.behavior.toolchain = '2';
    const revision = await ctx.commit('test/behavior.test.js', `${drift}\n`, `${drift} drift`);
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, ctx.execute, rmSync, prepared);
    assert.equal(result[0].status, 'passed');
    assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
    assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
  }
});
test('corrupt prepared receipt fails closed to full preparation', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const receiptPath = prepared.staged.receiptPath;
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.inputs.lockfileSha256 = '0'.repeat(64);
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n', 'Repair after corruption');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('corrupt dependency snapshot receipt reruns install and compile', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const receiptPath = prepared.staged.dependencyReceiptPath;
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.inputs.lockfileSha256 = '0'.repeat(64);
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
    'Repair after dependency corruption');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('test-only repair reuses an intact compile snapshot when the dependency workspace is damaged',
  async t => {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    rmSync(join(dirname(prepared.staged.dependencyReceiptPath), 'w', '.git'),
      { recursive: true, force: true });
    const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
      'Repair test after dependency workspace damage');
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, ctx.execute, rmSync, prepared);
    assert.equal(result[0].status, 'passed');
    assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
    assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  });
test('cache loading reuses an intact compile snapshot without reading a damaged dependency workspace',
  async t => {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    rmSync(join(dirname(prepared.staged.dependencyReceiptPath), 'w', '.git'),
      { recursive: true, force: true });
    const reloaded = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    assert.equal(reloaded.staged.receiptPath, prepared.staged.receiptPath);
    assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
    assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  });
test('damaged dependency workspace reruns install and compile when production changes', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  rmSync(join(dirname(prepared.staged.dependencyReceiptPath), 'w', '.git'),
    { recursive: true, force: true });
  const revision = await ctx.commit('src/value.js', 'export const value = 2;\n',
    'Change production after dependency workspace damage');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('parallel prepared-output fingerprint detects cache mutation', async t => {
  const ctx = await stagedValidationFixture(t, { parallelOutputs: true });
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  writeFileSync(join(prepared.staged.workspace, '.pilot', 'output-3', 'compiled.js'),
    'mutated\n');
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
    'Repair after compiled output mutation');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('dependency file mutations invalidate a warm compile receipt', async t => {
  for (const mutation of ['modify', 'delete', 'add']) {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    const packagePath = join(prepared.staged.workspace, 'extra', 'node_modules',
      'fixture', 'package.json');
    if (mutation === 'modify') writeFileSync(packagePath, '{"version":"corrupt"}\n');
    else if (mutation === 'delete') rmSync(packagePath);
    else writeFileSync(join(dirname(packagePath), 'injected.js'), 'injected\n');
    const revision = await ctx.commit('test/behavior.test.js', `${mutation}\n`,
      `${mutation} dependency file before test-only validation`);
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, ctx.execute, rmSync, prepared);
    assert.equal(result[0].status, 'passed');
    assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
    assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
  }
});
test('changed dependency contents cannot reuse an older compile receipt', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  rmSync(dirname(prepared.staged.dependencyReceiptPath),
    { recursive: true, force: true });
  ctx.behavior.dependencyVersion = '3.0.0';
  const regenerated = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.notEqual(regenerated.staged.inputs.dependencyOutputsSha256,
    prepared.staged.inputs.dependencyOutputsSha256);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('test-only repair rejects an older compile receipt after dependency regeneration',
  async t => {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    rmSync(dirname(prepared.staged.dependencyReceiptPath),
      { recursive: true, force: true });
    ctx.behavior.dependencyVersion = '3.0.0';
    const regenerated = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    assert.notEqual(regenerated.staged.inputs.dependencyOutputsSha256,
      prepared.staged.inputs.dependencyOutputsSha256);
    const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
      'Repair test after dependency regeneration');
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, ctx.execute, rmSync, prepared);
    assert.equal(result[0].status, 'passed');
    assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
    assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 3);
  });
test('runner dependency file mutation invalidates the prepared cache', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
    'Exercise dependency mutation detection');
  const execute = async (...args) => {
    const result = await ctx.execute(...args);
    const [, , cwd, , env] = args;
    if (env.PILOT_VALIDATION_STAGE === 'test')
      writeFileSync(join(cwd, 'extra', 'node_modules', 'fixture', 'package.json'),
        '{"version":"mutated-by-runner"}\n');
    return result;
  };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'prepared-cache-corrupt');
  assert.equal(existsSync(dirname(prepared.staged.workspace)), false);
});
test('metadata-only native module changes preserve an identical prepared cache', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
    'Exercise native module metadata tolerance');
  const execute = async (...args) => {
    const result = await ctx.execute(...args);
    const [, , cwd, , env] = args;
    if (env.PILOT_VALIDATION_STAGE === 'test') {
      const nativeModule = join(cwd, 'extra', 'node_modules', 'fixture',
        'resolver.node');
      writeFileSync(nativeModule, readFileSync(nativeModule));
    }
    return result;
  };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(existsSync(prepared.staged.workspace), true);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.telemetry.validationTimings.find(stage =>
    stage.id === 'cleanup').cache, 'preserved');
});
test('metadata-only ordinary file changes preserve an identical prepared cache', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
    'Exercise ordinary file metadata tolerance');
  const execute = async (...args) => {
    const result = await ctx.execute(...args);
    const [, , cwd, , env] = args;
    if (env.PILOT_VALIDATION_STAGE === 'test') {
      const packageJson = join(cwd, 'extra', 'node_modules', 'fixture',
        'package.json');
      writeFileSync(packageJson, readFileSync(packageJson));
    }
    return result;
  };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(existsSync(prepared.staged.workspace), true);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.telemetry.validationTimings.find(stage =>
    stage.id === 'cleanup').cache, 'preserved');
});
test('same-revision infrastructure retry reuses expensive prepared stages', async t => {
  const ctx = await stagedValidationFixture(t);
  ctx.behavior.transientPolicy = true;
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(result[0].attemptCount, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'policy').length, 2);
});
test('concurrent assignments share one controller-owned preparation', async t => {
  const ctx = await stagedValidationFixture(t);
  const [first, second] = await Promise.all([
    prepareValidation(ctx.config, ctx.current, ctx.repo, ctx.isolated.baseRevision, ctx.execute),
    prepareValidation(ctx.config, ctx.current, ctx.repo, ctx.isolated.baseRevision, ctx.execute)
  ]);
  assert.equal(first.staged.receiptPath, second.staged.receiptPath);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
});
test('profiles without a valid stage plan retain full clean validation fallback', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const profilePath = join(config.stateDirectory, 'ordinary-profile.mjs');
  writeFileSync(profilePath, '// ordinary profile\n');
  repo.validationGates = [{
    id: 'ordinary', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['{profile}'],
    profilePath, profileSha256: hash(readFileSync(profilePath)), timeoutMs: 10000
  }];
  let runs = 0;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async () => { runs++; return { stdout: '', stderr: '' }; });
  assert.equal(result[0].status, 'passed');
  assert.equal(runs, 1);
});
test('staged preparation failures persist terminal validation evidence', async t => {
  const ctx = await stagedValidationFixture(t);
  ctx.behavior.failPreparation = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'failed');
  assert.equal(result[0].attemptCount, 1);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.output.exitCode, 1);
  assert.ok(artifact.telemetry.preparationTimings.some(stage =>
    stage.id === 'dependencies'));
});
for (const failingStage of ['dependencies', 'compile']) {
  test(`prestarted ${failingStage} failure is preserved without an implicit infrastructure retry`, async t => {
    const ctx = await stagedValidationFixture(t);
    ctx.config.limits.maxValidationInfrastructureRetries = 0;
    const calls = [];
    const execute = async (...args) => {
      const stage = args[4].PILOT_VALIDATION_STAGE;
      calls.push(stage);
      if (stage === failingStage)
        throw Object.assign(new Error('original native failure'), {
          code: 17, stderr: 'original native failure', stdout: 'original output'
        });
      return ctx.execute(...args);
    };
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, execute);
    assert.equal(prepared.staged.failure.output.exitCode, 17);
    const revision = await ctx.commit('test/behavior.test.js', 'new case\n', 'Add test');
    const before = [...calls];
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, execute, rmSync, JSON.parse(JSON.stringify(prepared)));
    assert.deepEqual(calls, before);
    assert.equal(calls.filter(stage => stage === failingStage).length, 1);
    assert.equal(result[0].status, 'failed');
    assert.equal(result[0].attemptCount, 1);
    assert.equal(result[0].sourceRevision, revision);
    const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
    assert.equal(artifact.output.exitCode, 17);
    assert.equal(artifact.output.stderr, 'original native failure');
    assert.equal(artifact.telemetry.preparedSourceRevision, ctx.isolated.baseRevision);
    assert.equal(artifact.telemetry.validationRevision, revision);
    assert.equal(artifact.telemetry.validationTimings.length, 0);
  });
}
test('LFS paths are exact, bounded and bound into the native validation contract', () => {
  const gate = { id: 'fixture', lfsPaths: ['fixtures/required template.xlsx'] };
  assert.deepEqual(validationLfsPaths(gate), gate.lfsPaths);
  for (const paths of [[], ['../secret'], ['fixtures/*.xlsx'], ['fixtures/a,fixtures/b'],
    ['C:\\file'], ['fixtures\\file'], ['/file'], ['a\nb'], ['a', 'a']])
    assert.throws(() => validationLfsPaths({ lfsPaths: paths }), /lfsPaths/);
  assert.notEqual(repositoryValidationContract({ validationGates: [gate] }).sha256,
    repositoryValidationContract({ validationGates: [{ id: 'fixture' }] }).sha256);
});
const gitLfsAvailable = spawnSync('git', ['lfs', 'version'], { windowsHide: true }).status === 0;
async function lfsValidationFixture(t) {
  const ctx = await stagedValidationFixture(t);
  await command('git', ['lfs', 'install', '--local', '--skip-smudge'], ctx.isolated.workspace);
  await command('git', ['config', '--local', 'lfs.storage', 'lfs'], ctx.isolated.workspace);
  mkdirSync(join(ctx.isolated.workspace, 'fixtures'));
  writeFileSync(join(ctx.isolated.workspace, '.gitattributes'),
    'fixtures/*.xlsx filter=lfs diff=lfs merge=lfs -text\n');
  const content = Buffer.from('source-bound native-build fixture\n');
  writeFileSync(join(ctx.isolated.workspace, 'fixtures', 'unrelated.xlsx'), 'unrelated LFS object\n');
  const path = 'fixtures/required template.xlsx';
  const revision = await ctx.commit(path, content, 'Add exact LFS fixtures');
  ctx.repo.remote = ctx.isolated.workspace;
  ctx.repo.validationGates[0].lfsPaths = [path];
  return { ...ctx, path, revision, content };
}
test('staged native build hydrates only approved LFS objects at the exact revision', {
  skip: !gitLfsAvailable
}, async t => {
  const ctx = await lfsValidationFixture(t);
  const execute = async (...args) => {
    const cwd = args[2], stage = args[4].PILOT_VALIDATION_STAGE;
    if (stage === 'compile' || stage === 'test') {
      assert.deepEqual(readFileSync(join(cwd, ctx.path)), ctx.content);
      assert.match(readFileSync(join(cwd, 'fixtures', 'unrelated.xlsx'), 'utf8'),
        /^version https:\/\/git-lfs.github.com\/spec\/v1/);
    }
    return ctx.execute(...args);
  };
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.revision, execute);
  assert.ok(prepared.staged.receiptPath, json(prepared));
  assert.deepEqual(prepared.staged.outputs.lfs, {
    revision: ctx.revision,
    objects: [{ path: ctx.path, oid: hash(ctx.content), size: ctx.content.length }]
  });
  const revision = await ctx.commit('test/behavior.test.js', 'changed test\n', 'Add case');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  assert.equal((await command('git', ['status', '--porcelain'], ctx.isolated.workspace)).stdout, '');
});
test('LFS fetch errors preserve sanitized native evidence and do not start the compiler', {
  skip: !gitLfsAvailable
}, async t => {
  const ctx = await lfsValidationFixture(t);
  const workspace = join(ctx.root, 'lfs-probe');
  await command('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout',
    ctx.isolated.workspace, workspace], ctx.root);
  await command('git', ['-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', ctx.revision],
    workspace, 10000, checkoutEnvironment());
  ctx.repo.remote = 'https://dev.azure.com/example/project/_git/repository';
  const token = 'fixture-private-token';
  let calls = 0;
  await assert.rejects(hydrateValidationLfs(ctx.config, ctx.repo, ctx.repo.validationGates[0],
    workspace, ctx.revision, {
      getToken: async () => token,
      executeGit: async (cwd, args, env) => {
        calls++;
        assert.equal(cwd, workspace);
        assert.ok(args.includes(`--include=/${ctx.path}`));
        assert.ok(args.includes(ctx.revision));
        assert.ok(args.includes('lfs.fetchrecentalways=false'));
        assert.ok(args.includes('lfs.transfer.maxretries=0'));
        assert.ok(!json(args).includes(token));
        assert.equal(env.GIT_CURL_VERBOSE, '');
        assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: bearer ${token}`);
        throw Object.assign(new Error(`unsafe ${token}`), {
          code: 2, stderr: `HTTP 403 ${token}`, stdout: ''
        });
      }
    }), error => {
    assert.equal(error.code, 'blocked-validation-lfs');
    assert.equal(error.nativeGitExitCode, 2);
    assert.equal(error.stderr, 'HTTP 403 [REDACTED]');
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.equal(calls, 1);
  assert.match(readFileSync(join(workspace, ctx.path), 'utf8'), /^version /);
});
test('LFS materialization rejects an unchanged pointer after a success-shaped checkout', {
  skip: !gitLfsAvailable
}, async t => {
  const ctx = await lfsValidationFixture(t);
  const workspace = join(ctx.root, 'lfs-incomplete');
  await command('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout',
    ctx.isolated.workspace, workspace], ctx.root);
  await command('git', ['-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', ctx.revision],
    workspace, 10000, checkoutEnvironment());
  await assert.rejects(hydrateValidationLfs(ctx.config, ctx.repo, ctx.repo.validationGates[0],
    workspace, ctx.revision, { executeGit: async () => '' }), /pointer OID and size/);
});
test('ADO draft provider creates only a draft and reconciles by stable source branch', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.remote = 'https://dev.azure.com/test/project/_git/fixture';
  repo.pr = { provider: 'ado', organization: 'test', project: 'project', repositoryId: 'fixture', targetRef: 'refs/heads/main' };
  const calls = [], revision = 'a'.repeat(40);
  const pr = { pullRequestId: 5, isDraft: true, status: 'active', sourceRefName: `refs/heads/pilot/${job.id}`,
    targetRefName: 'refs/heads/main', lastMergeSourceCommit: { commitId: revision } };
  const result = await createAdoDraft(config, ledger, job, repo, revision, { title: 'Fixture', description: 'Synthetic' },
    async (method, suffix, body) => { calls.push({ method, suffix, body }); return method === 'GET' ? { value: [] } : pr; });
  assert.equal(calls[1].body.isDraft, true);
  assert.equal(calls[1].body.completionOptions, undefined);
  assert.equal(result.isDraft, true);
  let writes = 0;
  await createAdoDraft(config, ledger, job, repo, revision, {}, async method => {
    if (method !== 'GET') writes++; return { value: [pr] };
  });
  assert.equal(writes, 0);
});
test('ADO draft provider accepts the configured legacy visualstudio.com repository host', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.remote = 'https://office.visualstudio.com/ISS/_git/OfficeAgent';
  repo.pr = { provider: 'ado', organization: 'office', project: 'ISS', repositoryId: 'OfficeAgent',
    targetRef: 'refs/heads/main' };
  const revision = 'b'.repeat(40);
  const draft = {
    pullRequestId: 9, isDraft: true, status: 'active', sourceRefName: `refs/heads/pilot/${job.id}`,
    targetRefName: 'refs/heads/main', lastMergeSourceCommit: { commitId: revision }
  };
  const result = await createAdoDraft(config, ledger, job, repo, revision,
    { title: 'Fixture', description: 'Synthetic' },
    async method => method === 'GET' ? { value: [draft] } : draft);
  assert.equal(result.url, 'https://office.visualstudio.com/ISS/_git/OfficeAgent/pullrequest/9');
});
test('ADO Git push uses a short-lived bearer header without persisting or exposing the token in arguments', async t => {
  const { config, repo } = await fixture(t);
  repo.remote = 'https://office.visualstudio.com/ISS/_git/OfficeAgent';
  repo.pr = { provider: 'ado', organization: 'office', project: 'ISS', repositoryId: 'OfficeAgent',
    targetRef: 'refs/heads/main' };
  const calls = [];
  const originalGitConfigValue = process.env.GIT_CONFIG_VALUE_0;
  await pushDraftBranch(config, 'C:\\synthetic-workspace', repo, 'HEAD:refs/heads/pilot/test', {
    getToken: async () => 'synthetic-sensitive-token',
    execute: async (cwd, args, env) => calls.push({ cwd, args, env })
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['push', 'origin', 'HEAD:refs/heads/pilot/test']);
  assert.doesNotMatch(json(calls[0].args), /synthetic-sensitive-token/);
  assert.equal(calls[0].env.GIT_CONFIG_KEY_0, 'http.extraHeader');
  assert.equal(calls[0].env.GIT_CONFIG_VALUE_0, 'AUTHORIZATION: bearer synthetic-sensitive-token');
  assert.equal(calls[0].env.GIT_TRACE_CURL, '0');
  assert.equal(process.env.GIT_CONFIG_VALUE_0, originalGitConfigValue);
});
test('uncertain PR creation cannot be retried and non-draft heads are rejected', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.remote = 'https://dev.azure.com/test/project/_git/fixture';
  repo.pr = { provider: 'ado', organization: 'test', project: 'project', repositoryId: 'fixture', targetRef: 'refs/heads/main' };
  ledger.operation(`${job.id}:draft`, job.id, 'draft-pr', {});
  await assert.rejects(createAdoDraft(config, ledger, job, repo, 'a'.repeat(40), {}, async () => ({ value: [] })), /already started/);
  await assert.rejects(createAdoDraft(config, ledger, job, repo, 'a'.repeat(40), {}, async () => ({ value: [{ isDraft: false }] })), /not an active draft/);
});
test('disabled schedule cannot perform any scan', async t => {
  const { config, ledger } = setup(t);
  await assert.rejects(tick(config, ledger), /disabled/);
  assert.equal(ledger.status().runs.length, 0);
});
test('unresolved changed-evidence policy blocks recurring collection', async t => {
  const { config, ledger } = setup(t); config.schedule.enabled = true;
  ledger.qualify('manual-run', { fingerprint: readinessFingerprint(config) });
  await assert.rejects(tick(config, ledger), /changed-evidence policy/);
});
test('local flight controller path: simulated adapter/model/PR, real isolated edit commit source-test and local push', async t => {
  const { config, ledger, job, repo, g, root } = await fixture(t, 'authenticated-source', 'defect-fix');
  repo.flights = { proposerExecutor: 'local' };
  config.activation.dispatch = true; config.limits.maxAiCreditsPerSession = 1;
  config.workspaceCleanup.enabled = true;
  await command('git', ['init', '--bare', '--quiet', repo.remote], root);
  const primaryHead = (await g(['rev-parse', 'HEAD'])).stdout;
  let modelCalls = 0, draftCalls = 0, authenticationReady = false;
  const dependencies = {
    agencyTransport: () => assert.fail('local flight must not submit to Agency'),
    preflightValidationAuthentication: async () => authenticationReady ? [] : [{
      state: 'action-required-auth',
      code: 'validation-authentication-required'
    }],
    runModel: async (c, l, current, assignment, investigation, toolkit) => {
      modelCalls++;
      assert.match(toolkit.read('src\\value.js'), /value = 1/);
      toolkit.write('src\\value.js', 'export const value = 2;\n');
      toolkit.finish({ outcome: 'propose-change', findings: 'Synthetic reproduction and source correction',
        title: 'Synthetic fixture correction', description: 'Simulated PR, not workplace evidence.' });
    },
    createDraft: async (c, l, current, r, revision) => {
      draftCalls++;
      const remoteHead = (await command('git', ['--git-dir', repo.remote, 'rev-parse', `refs/heads/pilot/${job.id}`], root)).stdout.trim();
      assert.equal(remoteHead, revision);
      return { url: 'https://example.invalid/synthetic-draft/1', isDraft: true, headRevision: revision };
    }
  };
  const action = await dispatch(config, ledger, job.id, dependencies);
  assert.equal(action.state, 'action-required-auth');
  assert.equal(ledger.job(job.id).state, 'prepared');
  assert.equal(modelCalls, 0);
  assert.equal(ledger.all('workerResult').length, 0);
  authenticationReady = true;
  const result = await dispatch(config, ledger, job.id, dependencies);
  assert.equal(result.outcome, 'draft-pr-validated');
  assert.equal(result.workspaceCleanup.state, 'removed', json(result.workspaceCleanup));
  assert.equal(existsSync(ledger.job(job.id).workspace), false);
  assert.equal(ledger.workspaceCleanup(job.id).sourceRevision, result.sourceRevision);
  assert.ok(result.validation[0].artifactRefs.every(existsSync));
  assert.equal(result.validation[0].sourceRevision, result.draftPR.headRevision);
  assert.equal(ledger.job(job.id).state, 'completed');
  assert.equal(ledger.all('workerResult').length, 1);
  assert.equal(modelCalls, 1); assert.equal(draftCalls, 1);
  await assert.rejects(dispatch(config, ledger, job.id), /never-dispatched/);
  assert.equal((await g(['rev-parse', 'HEAD'])).stdout, primaryHead);
  assert.equal((await g(['status', '--porcelain'])).stdout, '');
});
test('planned OA skill path creates a source-bound validated draft result through the controller', async t => {
  const ctx = setup(t), repo = repoConfig(ctx.config, ctx.root);
  repo.allowedWritePrefixes = ['test'];
  repo.skillBindings = [{
    id: 'oa-integration-test-core', capability: 'integration-test-authoring',
    skillPath: 'docs/skills/Integration-test-core/SKILL.md', enabled: true, qualification: 'qualified',
    requestedOutcomes: ['add-or-update-tests'],
    sideEffects: { commit: false, push: false, createDraftPR: false }
  }];
  repo.validationGates = [{
    id: 'oa-integration', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['--test', 'test/behavior.test.js'], timeoutMs: 10000
  }];
  mkdirSync(join(repo.referenceCheckout, 'src'), { recursive: true });
  mkdirSync(join(repo.referenceCheckout, 'docs', 'skills', 'Integration-test-core'), { recursive: true });
  writeFileSync(join(repo.referenceCheckout, 'src', 'value.js'), 'export const value = 1;\n');
  writeFileSync(join(repo.referenceCheckout, 'docs', 'skills', 'Integration-test-core', 'SKILL.md'),
    '# Synthetic OA skill\nAdd focused integration coverage and return structured metadata.\n');
  const g = args => command('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', ...args], repo.referenceCheckout);
  await g(['init', '--quiet']);
  await g(['add', '.']);
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic OA fixture']);
  const evidence = addEvidence(ctx.ledger, 'oa-1', '1', { fixture: true }, 'authenticated-source');
  const investigation = review(evidence);
  investigation.repoIds = [repo.id];
  investigation.observedBehavior = 'OA behavior lacks a focused integration regression test.';
  investigation.expectedBehavior = 'The established behavior is covered by a focused integration test.';
  ctx.ledger.put(investigation);
  const improvement = recordAreaToImprove(ctx.ledger, {
    investigationIds: [investigation.id], category: 'missing-test-coverage',
    theme: 'OA focused integration regression coverage',
    observedBehavior: investigation.observedBehavior, expectedBehavior: investigation.expectedBehavior,
    rationale: 'Synthetic source-bound OA coverage improvement.', priority: 'medium',
    repoIds: [repo.id], capabilities: ['integration-test-authoring']
  });
  const baseRevision = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  const validationContract = repositoryValidationContract(repo);
  ctx.ledger.qualify(skillQualificationId(repo.id, 'oa-integration-test-core'), {
    state: 'qualified-read-only', repoId: repo.id, bindingId: 'oa-integration-test-core',
    capability: 'integration-test-authoring', remote: repo.remote, baseRef: repo.baseRef,
    baseRevision, skillPath: 'docs/skills/Integration-test-core/SKILL.md',
    skillSha256: hash('# Synthetic OA skill\nAdd focused integration coverage and return structured metadata.\n'),
    qualificationSource: 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    sideEffects: { commit: false, push: false, createDraftPR: false }
  });
  const plan = recordTestCoveragePlan(ctx.ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: repo.id, capability: 'integration-test-authoring', sourceRevision: baseRevision,
    searchStatus: 'complete', existingTests: [], coverageGaps: ['No focused regression test exists.'],
    unknowns: [], rationale: 'Synthetic complete search confirms the gap.'
  });
  const assignment = makePlannedImprovementAssignment(ctx.config, ctx.ledger, investigation, plan.id);
  const rejected = new WorkerTools(ctx.config, assignment, repo.referenceCheckout, {
    binding: repo.skillBindings[0],
    skillPath: repo.skillBindings[0].skillPath,
    skillRevision: baseRevision
  });
  assert.throws(() => rejected.finish({
    outcome: 'propose-change', findings: 'Skill could not safely complete.',
    title: 'Must not publish', description: 'Must not publish',
    skillResult: {
      status: 'failed', classification: 'missing-coverage',
      changedFiles: ['test/behavior.test.js'], testsAddedOrUpdated: ['OA behavior'],
      behaviorCardsAddedOrUpdated: [], unknowns: ['Generation failed'], needsHumanDecision: false
    }
  }), /Only a successful repository skill result/);
  assert.equal(rejected.proposal, null);
  const needsDecision = new WorkerTools(ctx.config, assignment, repo.referenceCheckout, {
    binding: repo.skillBindings[0],
    skillPath: repo.skillBindings[0].skillPath,
    skillRevision: baseRevision
  });
  assert.throws(() => needsDecision.finish({
    outcome: 'propose-change', findings: 'Skill needs a human decision.',
    title: 'Must not publish', description: 'Must not publish',
    skillResult: {
      status: 'succeeded', classification: 'missing-coverage',
      changedFiles: ['test/behavior.test.js'], testsAddedOrUpdated: ['OA behavior'],
      behaviorCardsAddedOrUpdated: [], unknowns: [], needsHumanDecision: true
    }
  }), /Only a successful repository skill result/);
  assert.equal(needsDecision.proposal, null);
  const job = ctx.ledger.prepare(assignment);
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxAiCreditsPerSession = 1;
  await command('git', ['init', '--bare', '--quiet', repo.remote], ctx.root);
  const result = await dispatch(ctx.config, ctx.ledger, job.id, {
    runModel: async (config, ledger, current, currentAssignment, currentInvestigation, toolkit, loadedSkill) => {
      assert.match(loadedSkill.instructions, /Synthetic OA skill/);
      assert.equal(loadedSkill.skillRevision, baseRevision);
      toolkit.write('test\\behavior.test.js',
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('OA behavior', () => assert.equal(1, 1));\n");
      toolkit.finish({
        outcome: 'propose-change', findings: 'Added focused OA integration coverage.',
        title: '[Periodic Evidence Agent Canary] Add OA behavior coverage',
        description: 'Synthetic draft used to verify the source-bound OA skill pipeline.',
        skillResult: {
          status: 'succeeded', classification: 'missing-coverage',
          changedFiles: ['test/behavior.test.js'], testsAddedOrUpdated: ['OA behavior'],
          behaviorCardsAddedOrUpdated: [], unknowns: [], needsHumanDecision: false
        }
      });
    },
    createDraft: async (config, ledger, current, currentRepo, revision) => ({
      url: 'https://example.invalid/oa/draft/1', isDraft: true, headRevision: revision
    })
  });
  assert.equal(result.outcome, 'draft-pr-validated');
  assert.equal(result.skillExecution.bindingId, 'oa-integration-test-core');
  assert.deepEqual(result.skillExecution.changedFiles, ['test/behavior.test.js']);
  assert.equal(result.validation[0].sourceRevision, result.sourceRevision);
  assert.equal(result.draftPR.headRevision, result.sourceRevision);
});
test('workspace GC previews delivery, reports deletion failure and safely retries without deleting caches or evidence', async t => {
  const ctx = await deliveredWorkspace(t);
  const { config, ledger, job, repo, root, isolated, artifact, result } = ctx;
  const dependencyCache = join(config.stateDirectory, 'pv', 'd', 'fixture', 'w');
  const compileCache = join(config.stateDirectory, 'pv', 'c', 'fixture', 'w');
  for (const path of [dependencyCache, compileCache]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'preserved'), 'cache\n');
  }
  const operationsBefore = ledger.status().operations.length;
  const preview = await cleanupWorkspaces(config, ledger);
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.workspaces[0].state, 'eligible', json(preview));
  assert.equal(ledger.workspaceCleanup(job.id), null);
  assert.equal(ledger.status().operations.length, operationsBefore);
  assert.equal(existsSync(isolated.workspace), true);
  const configPath = join(root, 'cleanup-config.json');
  const cli = (...args) => spawnSync(process.execPath, [
    fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'workspace-gc',
    '--config', configPath, ...args
  ], { cwd: root, encoding: 'utf8', timeout: 120000 });
  writeFileSync(configPath, json(config));
  const cliPreview = cli();
  assert.equal(cliPreview.status, 0, cliPreview.stderr);
  assert.equal(JSON.parse(cliPreview.stdout).workspaces[0].state, 'eligible');
  assert.equal(ledger.workspaceCleanup(job.id), null);
  const originalRemote = repo.remote;
  repo.remote = join(root, 'missing-remote.git');
  await command('git', ['remote', 'set-url', 'origin', repo.remote], isolated.workspace);
  writeFileSync(configPath, json(config));
  const cliFailure = cli('--execute');
  assert.equal(cliFailure.status, 2, cliFailure.stderr);
  assert.equal(JSON.parse(cliFailure.stdout).workspaces[0].state, 'failed');
  assert.equal(existsSync(isolated.workspace), true);
  repo.remote = originalRemote;
  await command('git', ['remote', 'set-url', 'origin', repo.remote], isolated.workspace);
  const failed = await cleanupWorkspace(config, ledger, job.id, { execute: true }, {
    remove: () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }
  });
  assert.equal(failed.state, 'failed');
  assert.equal(ledger.workspaceCleanup(job.id).state, 'failed');
  assert.equal(ledger.job(job.id).state, 'completed');
  assert.equal(ledger.get('workerResult', result.id).outcome, 'draft-pr-validated');
  assert.equal(existsSync(isolated.workspace), true);
  const removed = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(removed.state, 'removed', json(removed));
  assert.equal(existsSync(isolated.workspace), false);
  assert.ok([repo.referenceCheckout, artifact, dependencyCache, compileCache].every(existsSync));
  const remoteHead = (await command('git', ['--git-dir', repo.remote, 'rev-parse',
    `refs/heads/pilot/${job.id}`], root)).stdout.trim();
  assert.equal(remoteHead, result.sourceRevision);
  const count = ledger.status().operations.length;
  const repeated = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(repeated.state, 'removed');
  assert.equal(ledger.workspaceCleanup(job.id).state, 'removed');
  assert.equal(ledger.status().operations.length, count);
  assert.throws(() => ledger.moveJob(job.id, 'completed', 'prepared'), /Cleaned workspace/);
  const reopened = new Ledger(config.stateDirectory);
  try {
    assert.equal(reopened.workspaceCleanup(job.id).state, 'removed');
  } finally { reopened.close(); }
  mkdirSync(isolated.workspace);
  writeFileSync(join(isolated.workspace, 'preserve.txt'), 'Recreated by another process\n');
  const recreated = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(recreated.state, 'skipped');
  assert.match(recreated.reason, /has been recreated/);
  assert.equal(existsSync(join(isolated.workspace, 'preserve.txt')), true);
  assert.equal(ledger.workspaceCleanup(job.id).state, 'removed');
  assert.equal((await cleanupWorkspace(config, ledger, job.id, { execute: true })).state, 'skipped');
});
test('workspace GC handles Windows short paths without bypassing primary-checkout protection',
  { skip: process.platform !== 'win32' }, async t => {
    const { config, job, repo, root, isolated, artifact } = await deliveredWorkspace(t);
    const shortRoot = (await command('powershell', ['-NoProfile', '-Command',
      '$fs = New-Object -ComObject Scripting.FileSystemObject; $fs.GetFolder($env:PILOT_TEST_ROOT).ShortPath'],
    root, 120000, { ...process.env, PILOT_TEST_ROOT: root })).stdout.trim();
    if (shortRoot === realpathSync.native(root)) {
      t.skip('Windows short-path aliases are unavailable on this volume');
      return;
    }
    config.stateDirectory = join(shortRoot, 'state');
    const workspace = join(config.stateDirectory, 'workspaces', job.session_id);
    const ledger = new Ledger(config.stateDirectory);
    try {
      ledger.db.prepare('UPDATE jobs SET workspace=? WHERE id=?').run(workspace, job.id);
      const reference = repo.referenceCheckout;
      repo.referenceCheckout = realpathSync.native(workspace);
      const retained = await cleanupWorkspace(config, ledger, job.id, { execute: true });
      assert.equal(retained.state, 'skipped', json(retained));
      assert.match(retained.reason, /overlaps a primary checkout/);
      assert.equal(existsSync(workspace), true);
      repo.referenceCheckout = reference;
      const preview = await cleanupWorkspace(config, ledger, job.id);
      assert.equal(preview.state, 'eligible', json(preview));
      const removed = await cleanupWorkspace(config, ledger, job.id, { execute: true });
      assert.equal(removed.state, 'removed', json(removed));
      assert.equal(existsSync(workspace), false);
      assert.ok([reference, artifact].every(existsSync));
    } finally { ledger.close(); }
  });
test('workspace GC retains unfinished tasks, dirty source, ignored files, local branches and missing evidence', async t => {
  const { config, ledger, job, isolated, artifact } = await deliveredWorkspace(t);
  const check = async pattern => {
    const result = await cleanupWorkspace(config, ledger, job.id, { execute: true });
    assert.equal(result.state, 'skipped', json(result));
    assert.match(result.reason, pattern);
    assert.equal(existsSync(isolated.workspace), true);
  };
  ledger.moveJob(job.id, 'completed', 'blocked');
  await check(/not completed/);
  ledger.moveJob(job.id, 'blocked', 'completed');
  writeFileSync(join(isolated.workspace, 'src', 'value.js'), 'uncommitted\n');
  await check(/uncommitted/);
  writeFileSync(join(isolated.workspace, 'src', 'value.js'), 'export const value = 1;\n');
  const untracked = join(isolated.workspace, 'private.log');
  writeFileSync(untracked, 'unpreserved evidence\n');
  await check(/untracked/);
  writeFileSync(join(isolated.workspace, '.git', 'info', 'exclude'), 'private.log\n');
  await check(/ignored files/);
  rmSync(untracked);
  await command('git', ['branch', 'extra'], isolated.workspace);
  await check(/additional local branches/);
  await command('git', ['branch', '-d', 'extra'], isolated.workspace);
  writeFileSync(join(isolated.workspace, 'src', 'value.js'), 'stashed\n');
  await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'stash', 'push', '--quiet'], isolated.workspace);
  await check(/stashed changes/);
  await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    'stash', 'pop', '--quiet'], isolated.workspace);
  writeFileSync(join(isolated.workspace, 'src', 'value.js'), 'export const value = 1;\n');
  const linkedWorktree = join(config.stateDirectory, 'linked-worktree');
  await command('git', ['worktree', 'add', '--detach', linkedWorktree], isolated.workspace);
  await check(/Other Git worktrees/);
  await command('git', ['worktree', 'remove', linkedWorktree], isolated.workspace);
  ledger.operation('pending-validation', job.id, 'validation', {});
  await check(/unfinished operation/);
  ledger.finishOperation('pending-validation', 'completed', {});
  const owner = ledger.acquire('validation');
  await check(/holds a lock/);
  ledger.release('validation', owner);
  const evidence = readFileSync(artifact);
  rmSync(artifact);
  await check(/evidence is missing/);
  writeFileSync(artifact, evidence);
  config.workspaceCleanup.retentionHours = 24;
  await check(/retention period/);
  assert.equal(ledger.status().locks.length, 0);
});
test('workspace GC refuses unpushed HEAD, a missing remote branch and primary-checkout redirection', async t => {
  const { config, ledger, job, isolated, repo, root } = await deliveredWorkspace(t);
  await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '--quiet', '-m', 'Unpushed change'], isolated.workspace);
  const unpushed = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(unpushed.state, 'skipped');
  assert.match(unpushed.reason, /HEAD differs/);
  await command('git', ['checkout', '--detach', isolated.baseRevision], isolated.workspace);
  const detached = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(detached.state, 'skipped');
  assert.match(detached.reason, /HEAD is detached/);
  assert.equal(existsSync(isolated.workspace), true);
  assert.equal(ledger.job(job.id).state, 'completed');
  await command('git', ['branch', '-f', `pilot/${job.id}`, isolated.baseRevision], isolated.workspace);
  await command('git', ['checkout', `pilot/${job.id}`], isolated.workspace);
  const remoteRevision = (await command('git', ['--git-dir', repo.remote,
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit-tree', `${isolated.baseRevision}^{tree}`, '-p', isolated.baseRevision,
    '-m', 'Remote-only change'], root)).stdout.trim();
  await command('git', ['--git-dir', repo.remote, 'update-ref',
    `refs/heads/pilot/${job.id}`, remoteRevision], root);
  const advanced = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(advanced.state, 'skipped');
  assert.match(advanced.reason, /Remote branch differs/);
  await command('git', ['--git-dir', repo.remote, 'update-ref', '-d', `refs/heads/pilot/${job.id}`], root);
  const absent = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(absent.state, 'skipped');
  assert.match(absent.reason, /remote branch is missing/);
  ledger.db.prepare('UPDATE jobs SET workspace=? WHERE id=?').run(repo.referenceCheckout, job.id);
  const redirected = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(redirected.state, 'skipped');
  assert.match(redirected.reason, /registered task path/);
  assert.equal(existsSync(repo.referenceCheckout), true);
  assert.equal(existsSync(isolated.workspace), true);
  ledger.db.prepare('UPDATE jobs SET workspace=? WHERE id=?').run(isolated.workspace, job.id);
  repo.remote = 'https://dev.azure.com/synthetic/project/_git/repo';
  await command('git', ['remote', 'set-url', 'origin', repo.remote], isolated.workspace);
  const authentication = await cleanupWorkspace(config, ledger, job.id, { execute: true }, {
    getToken: async () => { throw new PilotError('blocked-auth', 'Synthetic authentication unavailable'); }
  });
  assert.equal(authentication.state, 'failed');
  assert.equal(authentication.error.code, 'blocked-auth');
  assert.equal(existsSync(isolated.workspace), true);
});
test('workspace GC refuses linked task paths and absent clones without a deletion receipt', async t => {
  const { config, ledger, job, isolated, repo } = await deliveredWorkspace(t);
  rmSync(isolated.workspace, { recursive: true, force: true });
  const missing = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(missing.state, 'skipped');
  assert.match(missing.reason, /missing without a cleanup receipt/);
  symlinkSync(repo.referenceCheckout, isolated.workspace, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(linked.state, 'skipped');
  assert.match(linked.reason, /contains a link/);
  assert.equal(existsSync(join(repo.referenceCheckout, 'src', 'value.js')), true);
});
test('workspace GC cleans historical clones only when the copied base branch has no undelivered commits', async t => {
  const { config, ledger, job, isolated, repo } = await deliveredWorkspace(t);
  const copiedBranch = (await command('git', [
    'symbolic-ref', '--short', 'HEAD'
  ], repo.referenceCheckout)).stdout.trim();
  await command('git', ['branch', copiedBranch, isolated.baseRevision], isolated.workspace);
  const preview = await cleanupWorkspace(config, ledger, job.id);
  assert.equal(preview.state, 'eligible', json(preview));
  const unpublished = (await command('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit-tree', `${isolated.baseRevision}^{tree}`, '-p', isolated.baseRevision,
    '-m', 'Private base-branch commit'
  ], isolated.workspace)).stdout.trim();
  await command('git', ['branch', '-f', copiedBranch, unpublished], isolated.workspace);
  const retained = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(retained.state, 'skipped');
  assert.match(retained.reason, /Inherited base branch/);
  assert.equal(existsSync(isolated.workspace), true);
});
test('workspace GC retains support for historical failed-validation delivery receipts', async t => {
  const { config, ledger, job, artifact } = await deliveredWorkspace(t, { historicalFailure: true });
  const result = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(result.state, 'removed', json(result));
  assert.equal(existsSync(ledger.job(job.id).workspace), false);
  assert.equal(existsSync(artifact), true);
  assert.equal(ledger.all('workerResult')[0].outcome, 'draft-pr-validation-failed');
});
test('automatic delivery cleanup honors opt-out and retains failure metadata', async t => {
  for (const mode of ['disabled', 'absent-policy', 'failure', 'retention']) {
    await t.test(mode, async t => {
      const { config, ledger, job, repo, root } = await fixture(t, 'authenticated-source', 'defect-fix');
      config.activation.dispatch = true;
      config.limits.maxAiCreditsPerSession = 1;
      config.workspaceCleanup = { enabled: mode !== 'disabled', retentionHours: mode === 'retention' ? 24 : 0 };
      if (mode === 'absent-policy') delete config.workspaceCleanup;
      await command('git', ['init', '--bare', '--quiet', repo.remote], root);
      const result = await dispatch(config, ledger, job.id, {
        runModel: async (c, l, current, assignment, investigation, toolkit) => {
          toolkit.write('src\\value.js', 'export const value = 2;\n');
          toolkit.finish({
            outcome: 'propose-change', findings: 'Synthetic change',
            title: 'Synthetic delivery', description: 'Fixture only'
          });
        },
        createDraft: async (c, l, current, r, revision) => ({
          url: 'https://example.invalid/draft/1', isDraft: true, headRevision: revision
        }),
        workspaceCleanup: mode === 'failure' ? {
          remove: () => {
            assert.equal(ledger.status().locks.some(lock => lock.name === 'dispatch'), true);
            assert.equal(ledger.job(job.id).state, 'completed');
            assert.equal(ledger.all('workerResult').length, 1);
            throw new PilotError('cleanup-failed', 'Synthetic file lock prevents deletion');
          }
        } : undefined
      });
      assert.equal(result.outcome, 'draft-pr-validated');
      assert.equal(ledger.job(job.id).state, 'completed');
      assert.equal(existsSync(ledger.job(job.id).workspace), true);
      if (mode === 'disabled' || mode === 'absent-policy') {
        assert.equal(result.workspaceCleanup, undefined);
        assert.equal(ledger.workspaceCleanup(job.id), null);
      } else {
        assert.equal(result.workspaceCleanup.state,
          mode === 'failure' ? 'failed' : mode === 'retention' ? 'skipped' : 'removed', json(result.workspaceCleanup));
        assert.equal(ledger.workspaceCleanup(job.id).state, result.workspaceCleanup.state);
      }
    });
  }
});
test('workspace cleanup is opt-in and rejects invalid retention configuration', () => {
  assert.deepEqual(workspaceCleanupPolicy({}), { enabled: false, retentionHours: 0 });
  assert.throws(() => workspaceCleanupPolicy({
    workspaceCleanup: { enabled: true, retentionHours: -1 }
  }), /Invalid workspaceCleanupPolicy/);
  assert.throws(() => workspaceCleanupPolicy({
    workspaceCleanup: { enabled: 'yes', retentionHours: 0 }
  }), /Invalid workspaceCleanupPolicy/);
});
test('interrupted worker persists blocked result and cannot relaunch', async t => {
  const { config, ledger, job } = await fixture(t, 'authenticated-source');
  config.activation.dispatch = true; config.limits.maxAiCreditsPerSession = 1;
  await assert.rejects(dispatch(config, ledger, job.id, {
    runModel: async (currentConfig, currentLedger, current, assignment, investigation,
      toolkit) => {
      toolkit.read('src\\value.js');
      throw new PilotError('blocked-auth', 'Synthetic Copilot reauthentication required');
    }
  }), /reauthentication/);
  assert.equal(ledger.job(job.id).state, 'blocked');
  const result = ledger.all('workerResult')[0];
  assert.equal(result.outcome, 'blocked');
  assert.equal(existsSync(ledger.job(job.id).workspace), true);
  assert.equal(ledger.workspaceCleanup(job.id), null);
  assert.match(result.blocker.reason, /reauthentication/);
  assert.equal(result.toolUsage.used, 1);
  assert.deepEqual(result.toolUsage.rounds, [{
    round: 0, used: 1, cumulativeUsed: 1, status: 'failed'
  }]);
  assert.equal(result.skillExecution, null);
  await assert.rejects(dispatch(config, ledger, job.id), /never-dispatched/);
});
test('synthetic provenance cannot be dispatched through the live entrypoint', async t => {
  const { config, ledger, job } = await fixture(t);
  config.activation.dispatch = true; config.limits.maxAiCreditsPerSession = 1;
  await assert.rejects(dispatch(config, ledger, job.id), /Synthetic evidence/);
  assert.equal(ledger.job(job.id).state, 'prepared');
});
test('new unreviewed evidence prevents dispatch of an earlier prepared assignment', async t => {
  const { config, ledger, job } = await fixture(t, 'authenticated-source');
  config.activation.dispatch = true; config.limits.maxAiCreditsPerSession = 1;
  addEvidence(ledger, '1', '2', { newer: true }, 'authenticated-source');
  await assert.rejects(dispatch(config, ledger, job.id), /New source evidence/);
  assert.equal(ledger.job(job.id).state, 'prepared');
});

test('dry-run budgets are scoped and no-network preflight never touches production state', async t => {
  const { config, ledger } = setup(t);
  config.limits.maxItems = null; config.limits.maxCalls = null;
  const before = json(ledger.status());
  let calls = 0;
  const result = await dryRun(config, { adapters: { ado: async () => { calls++; } } });
  assert.equal(result.error.code, 'awaiting-auth-refresh');
  assert.equal(calls, 0);
  assert.equal(result.collectionLimits.maxItems, 2000);
  assert.equal(result.collectionLimits.maxCalls, 300);
  assert.equal(result.collectionLimits.recurringDefault, false);
  assert.equal(config.limits.maxItems, null);
  assert.equal(json(ledger.status()), before);
  assert.ok(result.stateDirectory.startsWith(join(config.stateDirectory, 'dry-runs')));
  assert.equal(JSON.parse(readFileSync(join(result.stateDirectory, 'summary.json'))).dryRunId, result.dryRunId);
  const unrefreshed = await dryRun(config, { collectRequested: true });
  assert.equal(unrefreshed.error.code, 'awaiting-auth-refresh');
});

test('dry-run executes only mocked source passes in isolated ledger and separates cohort counts', async t => {
  const { config, ledger } = setup(t);
  config.schedule.changedEvidencePolicy = 'tracked-open-and-area-changed';
  config.activation.dispatch = true; config.activation.review = true; config.schedule.enabled = true;
  config.sources.workiq.enabled = true;
  const calls = [];
  const adapters = {
    ado: async (c, window, emit, lane) => {
      assert.deepEqual(c.activation, { collect: true, review: false, dispatch: false });
      assert.equal(c.schedule.enabled, false);
      assert.equal(c.limits.maxItems, 2000); assert.equal(c.limits.maxCalls, 300);
      calls.push(`ado:${lane}`);
      const item = adoItem(lane === 'created' ? 1 : 2);
      if (lane === 'changed') item.fields['System.CreatedDate'] = '2026-09-01T00:00:00Z';
      const record = adoRecord(item, 'mocked dry run', now());
      record.source.provenance = 'synthetic';
      await emit(record, item);
      return { end: window.end };
    },
    workiq: async () => { calls.push('workiq:created'); return { coverage: 'synthetic-empty' }; }
  };
  const before = json(ledger.status());
  const result = await dryRun(config, { collectRequested: true, authRefreshed: true, adapters });
  assert.deepEqual(calls, ['ado:created', 'workiq:created', 'ado:changed']);
  assert.equal(result.report.summary.newCohortIds.length, 1);
  assert.equal(result.report.summary.changedOnlyIds.length, 1);
  assert.equal(result.report.summary.reviewedIds.length, 0);
  assert.equal(result.workerDispatches, 0); assert.equal(result.externalWrites, 0);
  assert.equal(json(ledger.status()), before);
  const isolated = new Ledger(result.stateDirectory);
  try {
    assert.equal(isolated.status().jobs.length, 0);
    assert.equal(isolated.qualification('manual-run'), null);
    assert.equal(isolated.db.prepare('SELECT COUNT(*) AS n FROM assignment_budgets').get().n, 0);
  } finally { isolated.close(); }
});

test('dry-run auth failure suppresses changed-lane retries in the same run', async t => {
  const { config } = setup(t);
  config.schedule.changedEvidencePolicy = 'tracked-open-and-area-changed';
  let calls = 0;
  const result = await dryRun(config, { collectRequested: true, authRefreshed: true,
    adapters: { ado: async () => { calls++; throw new PilotError('blocked-auth', 'Synthetic auth failure'); } } });
  assert.equal(calls, 1);
  assert.equal(result.collection.find(r => r.lane === 'created').state, 'blocked-auth');
  assert.equal(result.collection.find(r => r.lane === 'changed').state, 'blocked');
});

function channelConfig(config) {
  const seed = { id: 'synthetic-channel', kind: 'teams-channel', teamId: 'synthetic-team',
    channelId: 'synthetic-channel', url: 'https://teams.microsoft.com/synthetic', includeReplies: true };
  config.sources.workiq = { enabled: true, scopeApproved: true, seeds: [seed] };
  return seed;
}
function message(id, createdDateTime = '2026-10-08T01:00:00Z') {
  return { id, createdDateTime, lastModifiedDateTime: createdDateTime, etag: '1', body: { content: 'Synthetic' } };
}
function principal(config) {
  return { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser };
}

test('WorkIQ validates exact success envelope and rejects runtime identity mismatch before source reads', async t => {
  const { config } = setup(t); channelConfig(config);
  assert.deepEqual(unwrapWorkiq({ resultType: 'success',
    textResultForLlm: json({ results: [{ statusCode: 200, data: principal(config) }] }) }), principal(config));
  assert.throws(() => unwrapWorkiq({ resultType: 'success',
    textResultForLlm: json({ results: [{ statusCode: 403, data: {} }] }) }), e => e.code === 'blocked-auth');
  const reads = [];
  await assert.rejects(collectWorkiq(config, config.window, async () => assert.fail('No evidence expected'),
    async path => { reads.push(path); return { id: 'different', userPrincipalName: 'wrong' }; }), /principal/);
  assert.deepEqual(reads, [principalPath]);
});

test('WorkIQ exhausts root and reply pages, including new reply to old root', async t => {
  const { config } = setup(t), seed = channelConfig(config), root = channelRoot(seed), reads = [], captured = [];
  const cursor = await collectWorkiq(config, config.window, async record => captured.push(record), async path => {
    reads.push(path);
    if (path === principalPath) return principal(config);
    const url = new URL(path, 'https://scope.invalid');
    if (url.pathname === root && !url.searchParams.has('$skiptoken'))
      return { value: [message('old', '2026-10-07T00:00:00Z')], '@odata.nextLink': `${root}?$skiptoken=next` };
    if (url.pathname === `${root}/old/replies`) return { value: [message('reply')] };
    if (url.pathname === root) return { value: [message('new')] };
    if (url.pathname === `${root}/new/replies`) return { value: [] };
    assert.fail(`Unexpected synthetic path ${path}`);
  });
  assert.deepEqual(captured.map(r => r.source.recordId), ['reply', 'new']);
  assert.equal(captured[0].fields.parentContext.id, 'old');
  assert.equal(cursor.coverage[0].messagesExamined, 3);
  assert.equal(reads.length, 5);
});

test('WorkIQ paging rejects scope escape and cycles; item exhaustion preserves partial evidence and cursor', async t => {
  const { config, ledger } = setup(t), seed = channelConfig(config), root = channelRoot(seed);
  config.sources.ado.enabled = false; config.limits.maxItems = 1;
  assert.throws(() => nextWorkiqPage(config, '/teams/other/channels/other/messages?$skiptoken=x', root), /escaped/);
  assert.throws(() => nextWorkiqPage(config, 'https://unapproved.invalid/page', root), /authority/);
  const reader = async path => path === principalPath ? principal(config) :
    new URL(path, 'https://scope.invalid').pathname === root ? { value: [message('one'), message('two')] } : { value: [] };
  const results = await collect(config, ledger, { adapters: {
    workiq: (c, w, emit) => collectWorkiq(c, w, emit, reader)
  } });
  assert.equal(results.find(r => r.source === 'workiq').state, 'partial');
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(ledger.cursor('workiq:created'), null);
  config.limits.maxItems = 100;
  await assert.rejects(collectWorkiq(config, config.window, async () => {}, async path =>
    path === principalPath ? principal(config) : { value: [], '@odata.nextLink': path }), /cycle/);
});

test('one-level follow-up deduplicates links, does not recurse and leaves excess work pending', async t => {
  const { config, ledger } = setup(t);
  config.followUp = { maxDepth: 1, maxItems: 1, maxToolCalls: 2 };
  const root = addEvidence(ledger, '1', '1');
  root.links = [2, 2, 3].map(id => ({ url: `https://dev.azure.com/office/OC/_workitems/edit/${id}` }));
  let calls = 0;
  const result = await followRelated(config, ledger, [root], config.window, { ado: async (c, id, budget) => {
    calls++; budget.call(); budget.call();
    const record = adoRecord(adoItem(Number(id)), 'mocked follow-up', now());
    record.source.provenance = 'synthetic';
    record.links = [{ url: 'https://dev.azure.com/office/OC/_workitems/edit/4', relation: 'related',
      evidenceId: null, access: 'not-followed-out-of-scope' }];
    return { record, payload: { synthetic: id } };
  } });
  assert.equal(calls, 1); assert.equal(result.state, 'partial');
  assert.equal(report(ledger).summary.newCohortIds.length, 1);
  assert.equal(report(ledger).relatedEvidenceIds.length, 1);
  assert.ok(ledger.status().discoveries.some(d => d.state === 'pending' && d.url.endsWith('/3')));
  assert.ok(!ledger.status().discoveries.some(d => d.url.endsWith('/4')));
});

test('tracked scope disappearance requires reconciliation without changing cohort counts', async t => {
  const { config, ledger } = setup(t);
  config.schedule.changedEvidencePolicy = 'tracked-open-and-area-changed';
  const evidence = addEvidence(ledger); ledger.put(review(evidence));
  const result = await revisitTracked(config, ledger, { ado: async () => {
    throw new PilotError('blocked-scope', 'Synthetic item absent from approved area');
  } });
  assert.equal(result[0].state, 'complete');
  assert.equal(ledger.trackedState(evidence).state, 'reconciliation-required');
  assert.equal(report(ledger).summary.newCohortIds.length, 1);
});

test('tracked fixed revision blocks a previously prepared assignment', async t => {
  const { config, ledger, job, evidence } = await fixture(t, 'authenticated-source');
  config.schedule.changedEvidencePolicy = 'tracked-open-and-area-changed';
  await revisitTracked(config, ledger, { ado: async () => {
    const item = adoItem(1, 2); item.fields['System.State'] = 'Resolved';
    return { record: adoRecord(item, 'mocked tracked revisit', now()), payload: item };
  } });
  assert.equal(ledger.trackedState(evidence).state, 'reconciliation-required');
  config.activation.dispatch = true; config.limits.maxAiCreditsPerSession = 1;
  await assert.rejects(dispatch(config, ledger, job.id), /reconciliation|New source evidence/);
});

test('Shanghai daily wake uses 01:00 UTC and previous complete UTC cohort', () => {
  const schedule = configAt('pilot.example.json').schedule;
  assert.equal(nextDailyWake(schedule, new Date('2026-10-09T00:59:00Z')).toISOString(), '2026-10-09T01:00:00.000Z');
  assert.equal(nextDailyWake(schedule, new Date('2026-10-09T01:00:00Z')).toISOString(), '2026-10-10T01:00:00.000Z');
  assert.deepEqual(previousUtcDay(new Date('2026-10-09T01:00:00Z')), {
    start: '2026-10-08T00:00:00.000Z', end: '2026-10-09T00:00:00.000Z'
  });
});

test('daily assignment cap persists across connection restart and ignores duplicate prepares', async t => {
  const { config, ledger, repo } = await fixture(t);
  const budget = { bucket: json(config.window), maxNew: 2 };
  const prepare = (store, id) => {
    const evidence = addEvidence(store, id);
    const investigation = review(evidence); investigation.repoIds = [repo.id]; store.put(investigation);
    return store.prepare(makeAssignment(config, investigation, repo.id, 'rca-only'), budget);
  };
  const second = prepare(ledger, '2');
  assert.equal(ledger.prepare(ledger.get('assignment', second.id), budget).id, second.id);
  prepare(ledger, '3');
  const reopened = new Ledger(config.stateDirectory);
  try { assert.throws(() => prepare(reopened, '4'), /Daily new-assignment budget/); }
  finally { reopened.close(); }
});

test('WorkIQ runtime diagnostics preserve known safe failure phase and RPC code', () => {
  const raw = Object.assign(new Error('Request session.mcp.startServer failed with message: MCP server "workiq" requires authentication'), { code: -32603 });
  const error = workiqRuntimeError(raw, 'mcp-start');
  assert.equal(error.code, 'blocked-auth');
  assert.match(error.message, /mcp-start failed; RPC code -32603/);
  assert.match(error.message, /configured WorkIQ server requires authentication/);
  assert.match(error.message, /Inspect the matching host authentication context/);
});

test('WorkIQ runtime diagnostics never echo unknown authentication error content', () => {
  const error = workiqRuntimeError(new Error('Authentication failed; secret=synthetic-never-echo'), 'fetch');
  assert.equal(error.code, 'blocked-auth');
  assert.match(error.message, /fetch failed/);
  assert.doesNotMatch(error.message, /synthetic-never-echo|secret=/);
  assert.equal(workiqRuntimeError(new Error('Failed at port 4030'), 'mcp-start').code, 'blocked-runtime');
  const known = new PilotError('blocked-scope', 'Approved boundary violation');
  assert.equal(workiqRuntimeError(known, 'fetch'), known);
});

function workiqLifecycle({ status = 'connected', running = false, afterStart = 'connected', tools = ['fetch'], startError = null } = {}) {
  const calls = [];
  return { calls, session: { rpc: {
    mcp: {
      listConfigured: async () => { calls.push('status'); return { servers: [{ name: 'workiq', enabled: true, live: { status } }] }; },
      isServerRunning: async () => { calls.push('running'); return { running }; },
      startServer: async args => {
        assert.deepEqual(args, { serverName: 'workiq' });
        calls.push('start'); if (startError) throw startError; status = afterStart;
      },
      listTools: async () => { calls.push('tools/list'); return { tools: tools.map(name => ({ name })) }; }
    },
    tools: { initializeAndValidate: async () => { calls.push('initialize'); } }
  } } };
}

test('WorkIQ connected server is not started again; tools/list readiness precedes initialization', async () => {
  const { session, calls } = workiqLifecycle();
  await prepareWorkiq(session);
  assert.deepEqual(calls, ['status', 'tools/list', 'initialize']);
});
test('WorkIQ pending active transport is not raced with another start', async () => {
  const { session, calls } = workiqLifecycle({ status: 'pending', running: true });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-readiness');
  assert.deepEqual(calls, ['status', 'running']);
});
test('WorkIQ not-yet-running server starts at most once and verifies status and tools', async () => {
  const { session, calls } = workiqLifecycle({ status: 'pending' });
  await prepareWorkiq(session);
  assert.deepEqual(calls, ['status', 'running', 'start', 'status', 'tools/list', 'initialize']);
});
test('WorkIQ enabled effective registration with not_configured live state starts once by name', async () => {
  const { session, calls } = workiqLifecycle({ status: 'not_configured' });
  const diagnostics = {};
  await prepareWorkiq(session, diagnostics);
  assert.deepEqual(calls, ['status', 'running', 'start', 'status', 'tools/list', 'initialize']);
  assert.equal(diagnostics.phase, 'ready');
  assert.deepEqual(diagnostics.calls, {
    listConfigured: 2, isServerRunning: 1, startServer: 1, listTools: 1, initializeAndValidate: 1
  });
  assert.deepEqual(diagnostics.observations.map(o => [o.serverName, o.enabled, o.liveStatus]),
    [['workiq', true, 'not_configured'], ['workiq', true, 'connected']]);
});
test('WorkIQ still not_configured after one start stops without polling or discovery', async () => {
  const { session, calls } = workiqLifecycle({ status: 'not_configured', afterStart: 'not_configured' });
  const diagnostics = {};
  await assert.rejects(prepareWorkiq(session, diagnostics), e => e.code === 'blocked-readiness');
  assert.deepEqual(calls, ['status', 'running', 'start', 'status']);
  assert.equal(diagnostics.calls.startServer, 1);
  assert.equal(diagnostics.calls.listTools, 0);
});
test('WorkIQ not_configured with active transport cannot trigger another start', async () => {
  const { session, calls } = workiqLifecycle({ status: 'not_configured', running: true });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-readiness');
  assert.deepEqual(calls, ['status', 'running']);
});
test('WorkIQ missing, disabled, or differently keyed registration never triggers activation', async () => {
  for (const servers of [[], [{ name: 'workiq', enabled: false, live: { status: 'not_configured' } }],
    [{ name: 'synthetic-other-key', enabled: true, live: { status: 'not_configured' } }]]) {
    const { session, calls } = workiqLifecycle();
    session.rpc.mcp.listConfigured = async () => { calls.push('status'); return { servers }; };
    const diagnostics = {};
    await assert.rejects(prepareWorkiq(session, diagnostics), e => e.code === 'blocked-runtime');
    assert.deepEqual(calls, ['status']);
    assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-other-key/);
  }
});
test('WorkIQ diagnostics project registration without raw plugin fields, errors or tool definitions', async () => {
  const { session } = workiqLifecycle();
  session.rpc.mcp.listConfigured = async () => ({ servers: [{
    name: 'workiq', enabled: true, source: 'plugin', sourcePlugin: 'workiq',
    sourcePluginVersion: 'synthetic-secret', displayName: 'synthetic-secret',
    live: { status: 'connected', error: 'synthetic-secret' }
  }] });
  session.rpc.mcp.listTools = async () => ({ tools: [{ name: 'fetch', description: 'synthetic-secret' }] });
  const diagnostics = {};
  await prepareWorkiq(session, diagnostics);
  assert.equal(diagnostics.observations[0].pluginSourceMatches, true);
  assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-secret/);
});
test('WorkIQ post-start pending state cannot reach tool execution', async () => {
  const { session, calls } = workiqLifecycle({ status: 'pending', afterStart: 'pending' });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-readiness');
  assert.deepEqual(calls, ['status', 'running', 'start', 'status']);
});
test('WorkIQ needs-auth stops without start, discovery or retries', async () => {
  const { session, calls } = workiqLifecycle({ status: 'needs-auth' });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-auth');
  assert.deepEqual(calls, ['status']);
});
test('WorkIQ connected status without fetch discovery is not principal readiness', async () => {
  const { session, calls } = workiqLifecycle({ tools: [] });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-readiness');
  assert.deepEqual(calls, ['status', 'tools/list']);
});
test('WorkIQ start authentication failure never proceeds to tools/list or retries', async () => {
  const { session, calls } = workiqLifecycle({ status: 'pending',
    startError: Object.assign(new Error('MCP server "workiq" requires authentication'), { code: -32603 }) });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-auth' && /mcp-start.*-32603/.test(e.message));
  assert.deepEqual(calls, ['status', 'running', 'start']);
});

test('WorkIQ tools/list 401 is an OAuth challenge, not an inferred scope or principal failure', async () => {
  const { session, calls } = workiqLifecycle();
  session.rpc.mcp.listTools = async () => {
    calls.push('tools/list');
    throw Object.assign(new Error('Request session.mcp.listTools failed with message: Error: MCP OAuth challenge required (HTTP 401)'), { code: -32603 });
  };
  await assert.rejects(prepareWorkiq(session), error => {
    assert.equal(error.code, 'blocked-auth');
    assert.match(error.message, /mcp-tools-list failed; RPC code -32603/);
    assert.match(error.message, /OAuth challenge \(HTTP 401\)/);
    assert.match(error.message, /\/mcp auth workiq/);
    assert.doesNotMatch(error.message, /missing scopes|expired token|consent denied|principal mismatch/);
    return true;
  });
  assert.deepEqual(calls, ['status', 'tools/list']);
});

test('WorkIQ standalone probe only discovers tools and closes its own runtime', async () => {
  const { session, calls } = workiqLifecycle();
  session.disconnect = async () => { calls.push('disconnect'); };
  const result = await probeWorkiq({
    start: async () => { calls.push('client-start'); },
    createSession: async options => {
      assert.equal(options.mcpOAuthTokenStorage, 'persistent');
      assert.equal(options.enableConfigDiscovery, false);
      assert.deepEqual(options.pluginDirectories, ['synthetic-plugin']);
      assert.deepEqual(options.onPermissionRequest({}), { kind: 'denied-by-rules' });
      return session;
    },
    stop: async () => { calls.push('stop'); return []; }
  }, ['synthetic-plugin']);
  assert.equal(result.status, 'discovery-ready');
  assert.equal(result.phase, 'discovery-complete');
  assert.match(result.discovery, /principal and collection still unverified/);
  assert.deepEqual(calls, ['client-start', 'status', 'tools/list', 'initialize', 'disconnect', 'stop']);
});

test('WorkIQ standalone probe preserves safe start failure without retry', async () => {
  const { session, calls } = workiqLifecycle({ status: 'pending',
    startError: Object.assign(new Error('MCP server "workiq" requires authentication'), { code: -32603 }) });
  session.disconnect = async () => { calls.push('disconnect'); };
  const result = await probeWorkiq({
    start: async () => {}, createSession: async () => session,
    stop: async () => { calls.push('stop'); return []; }
  }, ['synthetic-plugin']);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'blocked-auth');
  assert.match(result.error.message, /mcp-start failed; RPC code -32603/);
  assert.deepEqual(calls, ['status', 'running', 'start', 'disconnect', 'stop']);
});

test('WorkIQ standalone dormant registration reports subsequent auth failure at its actual phase', async () => {
  const { session, calls } = workiqLifecycle({ status: 'not_configured',
    startError: Object.assign(new Error('MCP server "workiq" requires authentication'), { code: -32603 }) });
  session.disconnect = async () => { calls.push('disconnect'); };
  const result = await probeWorkiq({
    start: async () => {}, createSession: async () => session,
    stop: async () => { calls.push('stop'); return []; }
  }, ['synthetic-plugin']);
  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'mcp-start');
  assert.equal(result.error.code, 'blocked-auth');
  assert.equal(result.lifecycle.observations[0].liveStatus, 'not_configured');
  assert.equal(result.lifecycle.calls.startServer, 1);
  assert.equal(result.lifecycle.calls.listTools, 0);
  assert.match(result.error.message, /RPC code -32603/);
  assert.deepEqual(calls, ['status', 'running', 'start', 'disconnect', 'stop']);
});

test('WorkIQ standalone probe suppresses raw exception names and returned cleanup errors', async () => {
  const result = await probeWorkiq({
    start: async () => { throw Object.assign(new Error('synthetic-secret'), { name: 'synthetic-secret' }); },
    stop: async () => [new Error('synthetic-secret')]
  }, ['synthetic-plugin']);
  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'client-start');
  assert.equal(result.stopError.code, 'blocked-runtime');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
});

test('WorkIQ standalone output isolation discards raw stdout and stderr', t => {
  const root = mkdtempSync(join(tmpdir(), 'workiq-repro-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = join(root, 'synthetic-child.mjs');
  writeFileSync(child, `console.log('synthetic-secret'); console.error('synthetic-secret'); process.send({status:'not-probed'});`);
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'Workiq-Auth-Repro.mjs')).href;
  const wrapper = join(root, 'wrapper.mjs');
  writeFileSync(wrapper, `import { isolatedReport } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await isolatedReport([], ${JSON.stringify(child)})));`);
  const result = spawnSync(process.execPath, [wrapper], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'not-probed' });
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /synthetic-secret/);
});
