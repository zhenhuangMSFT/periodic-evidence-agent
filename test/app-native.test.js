import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configAt, hash, json, now, exclusions } from '../src/common.js';
import { beginApp, openApp, appendApp, blockApp, unavailableApp, appStatus, appReview, appWorker, appPlanImprovement, collectAppAdo, listAppRuns } from '../src/app-native.js';
import { principalPath, channelRoot } from '../src/runtime.js';
import { wiql, area, adoRecord } from '../src/sources.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';

function setup(t, { dry = true, provenance = 'synthetic', configure = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'app-pilot-'));
  const config = configAt('pilot.example.json'); config.stateDirectory = root;
  config.statePolicy.accessApproved = true;
  config.sources.ado = { enabled: true, scopeApproved: true };
  config.sources.workiq.enabled = true; config.sources.workiq.scopeApproved = true;
  config.activation = { collect: !dry, review: !dry, dispatch: !dry };
  config.limits = { ...config.limits, maxItems: 2000, maxCalls: 300, workerMaxToolCalls: 100 };
  config.repositories = [{ id: 'fixture', projectId: 'test-project', owner: 'test-owner', routingApproved: true,
    referenceCheckout: join(root, 'reference'), remote: 'https://example.invalid/test.git', baseRef: 'HEAD',
    allowedWritePrefixes: ['src'], validationGates: [] }];
  configure(config);
  beginApp(config, { runId: 'test-run', executorSessionId: 'test-session', dryRun: dry, provenance });
  const { ledger } = openApp(config, 'test-run', dry);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { config, ledger, root, runId: 'test-run' };
}
function call(id, path, data) {
  return { id, observedAt: '2026-10-09T09:00:00Z', tool: 'workiq-fetch',
    request: { entityUrls: [path] }, response: { results: [{ statusCode: 200, data }] } };
}
function identityCall(config) { return call('me', principalPath, { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser }); }
function rootPath(config) {
  return `${channelRoot(config.sources.workiq.seeds[0])}?$select=id,createdDateTime,lastModifiedDateTime,webUrl&$top=50`;
}
function message(id = 'root', date = '2026-10-08T09:00:00Z') {
  return { id, createdDateTime: date, lastModifiedDateTime: date, webUrl: 'https://teams.microsoft.com/l/message/test' };
}
const event = calls => ({ eventId: calls.at(-1).id, pass: 'workiq:created', calls });

test('app native run is isolated and keeps unstarted counts unknown', t => {
  const { config, ledger, root } = setup(t);
  const status = appStatus(ledger, 'test-run');
  assert.equal(status.executionMode, 'app-native'); assert.equal(status.productionLedgerTouched, false);
  assert.ok(status.collection.every(p => p.evidenceCount === null));
  assert.equal(existsSync(join(root, 'ledger.sqlite')), false);
  assert.equal(existsSync(status.summaryPath), true);
  assert.throws(() => beginApp(config, { runId: '../escape', dryRun: true, provenance: 'app-tool' }));
});
test('app imports full metadata page before pending replies, replays idempotently and resumes to completeness', async t => {
  const { config, ledger } = setup(t);
  const batch = event([identityCall(config), call('page', rootPath(config), { value: [message('old', '2026-10-07T09:00:00Z'), message()] })]);
  let status = await appendApp(config, ledger, 'test-run', batch);
  let pass = status.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'partial'); assert.equal(pass.evidenceCount, 1); assert.equal(pass.examinedRecords, 2);
  assert.match(pass.nextRequest.entityUrls[0], /old\/replies/);
  assert.equal(ledger.cursor('app:workiq:created'), null);
  const evidenceId = pass.evidenceIds[0];
  assert.ok(ledger.get('evidence', evidenceId).missingFields.includes('body'));
  await appendApp(config, ledger, 'test-run', batch);
  assert.equal(ledger.all('evidence').length, 1);
  status = await appendApp(config, ledger, 'test-run', event([call('old-replies', pass.nextRequest.entityUrls[0], { value: [message('reply')] })]));
  pass = status.collection.find(p => p.pass === 'workiq:created');
  status = await appendApp(config, ledger, 'test-run', event([call('root-replies', pass.nextRequest.entityUrls[0], { value: [] })]));
  pass = status.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'complete'); assert.equal(pass.evidenceCount, 2);
  assert.ok(ledger.cursor('app:workiq:created'));
  assert.equal(status.report.summary.newCohortIds.length, 2);
});
test('app external auth failure overrides continuation and preserves earlier real-source-shaped metadata', async t => {
  const { config, ledger } = setup(t);
  await appendApp(config, ledger, 'test-run', event([identityCall(config), call('page', rootPath(config), { value: [message()] })]));
  const failed = call('detail-failed', `${channelRoot(config.sources.workiq.seeds[0])}/root?$select=id,createdDateTime,body,webUrl`, {});
  delete failed.response;
  failed.failure = { code: 'blocked-auth', statusCode: 500, errorCode: 'AuthenticationRequired', recoveryAction: 'Reauthenticate' };
  const blocked = { eventId: 'auth-block', pass: 'workiq:created', call: failed };
  let result = blockApp(config, ledger, 'test-run', blocked);
  blockApp(config, ledger, 'test-run', blocked);
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'blocked-auth'); assert.equal(pass.readCalls, 3);
  assert.equal(pass.evidenceCount, 1); assert.equal(pass.nextRequest, null); assert.equal(pass.cursor, null);
  await assert.rejects(appendApp(config, ledger, 'test-run', event([identityCall(config)])), /terminal/);
});
test('app records failed native me without inventing identity or clean empty collection', async t => {
  const { config, ledger } = setup(t);
  const failed = identityCall(config); delete failed.response; failed.failure = { code: 'blocked-auth', statusCode: 500 };
  const result = await appendApp(config, ledger, 'test-run', event([failed]));
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.identityVerified, false); assert.equal(pass.state, 'blocked-auth');
  assert.equal(result.report.issues.length, 0); assert.equal(pass.nextRequest, null);
});
test('app receipt scope, credentials, query ordering and immutable event conflicts fail closed', async t => {
  const { config, ledger } = setup(t);
  await assert.rejects(appendApp(config, ledger, 'test-run', event([call('wrong', '/me/messages?$select=id', { value: [] })])), /First WorkIQ/);
  const secret = identityCall(config); secret.response.headers = { authorization: 'secret' };
  await assert.rejects(appendApp(config, ledger, 'test-run', event([secret])), /credentials/);
  await appendApp(config, ledger, 'test-run', event([identityCall(config)]));
  const changed = identityCall(config); changed.response.results[0].data.id = 'different-user';
  await assert.rejects(appendApp(config, ledger, 'test-run', event([changed])), /different content/);
  await assert.rejects(appendApp(config, ledger, 'test-run', event([call('escape',
    '/teams/other/channels/other/messages?$select=id,createdDateTime&$top=50', { value: [] })])), /outside/);
});
test('app accepts backend smaller nextLink page cap without broadening channel or claiming completeness', async t => {
  const { config, ledger } = setup(t);
  const path = rootPath(config);
  const next = path.replace('$top=50', '$top=20') + '&$skiptoken=opaque';
  let result = await appendApp(config, ledger, 'test-run', event([identityCall(config), call('page', path,
    { value: [], '@odata.nextLink': `https://graph.microsoft.com/v1.0${next}` })]));
  let pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'partial');
  assert.equal(new URL(pass.nextRequest.entityUrls[0], 'https://scope.invalid').searchParams.get('$top'), '20');
  result = await appendApp(config, ledger, 'test-run', event([call('last', pass.nextRequest.entityUrls[0], { value: [] })]));
  assert.equal(result.collection.find(p => p.pass === 'workiq:created').state, 'complete');
});
async function adoBatch(config, ledger, lane = 'created', id = 'ado-event') {
  const date = '2026-10-09T00:00:00Z', pass = `ado:${lane}`;
  const principal = { objectId: config.identity.objectId, tenantId: config.identity.tenantId,
    userPrincipalName: config.identity.designatedUser, verifiedAt: date, toolCallId: 'test-ado-identity' };
  const query0 = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'OC' AND [System.Id] = 0";
  const calls = [
    { endpoint: 'wiql', body: { query: query0 }, response: { asOf: date, workItems: [] } },
    { endpoint: 'wiql', body: { query: wiql(config.window, lane, date) }, response: { asOf: date, workItems: [{ id: 1 }] } },
    { endpoint: 'workitemsbatch', body: { ids: [1], asOf: date, errorPolicy: 'Fail', $expand: 'Relations' },
      response: { value: [{ id: 1, rev: 1, fields: { 'System.WorkItemType': 'Bug', 'System.AreaPath': area,
        'System.Title': 'Synthetic test', 'System.State': 'Active',
        'System.CreatedDate': '2026-10-08T01:00:00Z', 'System.ChangedDate': '2026-10-08T02:00:00Z' } }] } }
  ].map((c, index) => ({ id: `${id}-${index}`, tool: 'ado-delegated-read', observedAt: date,
    request: { endpoint: c.endpoint, body: c.body }, response: c.response }));
  return appendApp(config, ledger, 'test-run', { eventId: id, pass, principal, calls });
}
test('app ADO created/changed replay deduplicates revision and separates new cohort counts', async t => {
  const { config, ledger } = setup(t);
  await adoBatch(config, ledger);
  const result = await adoBatch(config, ledger, 'changed', 'changed');
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(result.report.summary.newCohortIds.length, 1);
  assert.equal(result.collection.find(p => p.pass === 'ado:changed').evidenceCount, 1);
  unavailableApp(ledger, 'test-run', { pass: 'icm:created', reason: 'no-approved-connector' });
  assert.equal(appStatus(ledger, 'test-run').collection.find(p => p.pass === 'icm:created').evidenceCount, null);
});
test('app dry run rejects reviews/native workers and ignores historic SDK auth blocks', t => {
  const { config, ledger } = setup(t);
  ledger.blockSource('auth:workiq', { code: 'blocked-auth', message: 'Historical SDK failure' });
  assert.throws(() => appReview(config, ledger, 'test-run', {}), /Collection-only/);
  assert.throws(() => appWorker(config, ledger, 'test-run', 'prepare', {}), /disabled/);
  assert.match(appStatus(ledger, 'test-run').sdkWorkiqGate, /not-applicable/);
});
test('app native assignment claim/bind/result is idempotent and cannot use primary checkout', async t => {
  const { config, ledger, root } = setup(t, { dry: false, provenance: 'app-tool' });
  await adoBatch(config, ledger);
  const evidence = ledger.all('evidence')[0];
  const investigation = {
    recordType: 'investigation', schemaVersion: '1.0', id: `investigation-${hash(json([evidence.source.namespace, evidence.source.recordId]))}`,
    version: 1, evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'Synthetic fixture only',
    expectedBehavior: 'Expected', hypotheses: [], counterEvidence: [], classification: 'functional',
    defectConfirmation: 'unconfirmed', reportEligibility: 'included', handoffEligibility: 'eligible',
    exclusionReasons: [], rationale: 'Test all guards', confidence: 0.8,
    review: { method: config.reviewMethod, reviewer: 'fixture', reviewedAt: now() },
    repoIds: ['fixture'], existingFixes: [], nextAction: 'Investigate'
  };
  appReview(config, ledger, 'test-run', { investigation, exclusionsChecked: exclusions });
  const job = appWorker(config, ledger, 'test-run', 'prepare', { investigationId: investigation.id, repoId: 'fixture', intent: 'rca-only' });
  const claim = { assignmentId: job.id, claimId: 'claim-one', coordinatorAgentId: config.agent.id };
  appWorker(config, ledger, 'test-run', 'claim', claim);
  appWorker(config, ledger, 'test-run', 'claim', claim);
  assert.throws(() => appWorker(config, ledger, 'test-run', 'claim', { ...claim, claimId: 'claim-two' }), /already claimed/);
  const binding = { assignmentId: job.id, claimId: 'claim-one', sessionId: 'native-session', projectId: 'test-project',
    workspace: config.repositories[0].referenceCheckout, baseRevision: 'a'.repeat(40) };
  assert.throws(() => appWorker(config, ledger, 'test-run', 'bind', binding), /primary checkout/);
  binding.workspace = join(root, 'worktree');
  appWorker(config, ledger, 'test-run', 'bind', binding);
  appWorker(config, ledger, 'test-run', 'bind', binding);
  const result = { assignmentId: job.id, claimId: 'claim-one', sessionId: 'native-session',
    outcome: 'rca-complete', evidenceRef: 'local-test-artifact' };
  assert.equal(appWorker(config, ledger, 'test-run', 'result', result).state, 'completed');
  assert.equal(appWorker(config, ledger, 'test-run', 'result', result).state, 'completed');
  assert.equal(ledger.job(job.id).session_id, 'native-session');
});

test('app status includes only workers owned by the requested run', t => {
  const { config, ledger } = setup(t, { dry: false, provenance: 'app-tool' });
  beginApp(config, { runId: 'other-run', dryRun: false, provenance: 'app-tool' });
  ledger.db.prepare('INSERT INTO app_workers VALUES(?,?)').run(
    'worker-one', JSON.stringify({ id: 'worker-one', runId: 'test-run' }));
  ledger.db.prepare('INSERT INTO app_workers VALUES(?,?)').run(
    'worker-two', JSON.stringify({ id: 'worker-two', runId: 'other-run' }));
  assert.deepEqual(appStatus(ledger, 'test-run').workers.map(worker => worker.id),
    ['worker-one']);
  assert.deepEqual(appStatus(ledger, 'other-run').workers.map(worker => worker.id),
    ['worker-two']);
});

test('app native OA planning pins durable improvement, coverage plan and skill binding before claim', async t => {
  const { root, config, ledger } = setup(t, { dry: false, provenance: 'app-tool', configure: config => {
    config.repositories[0].validationGates = [{ id: 'oa-integration', approved: true,
      executable: process.execPath, args: [], timeoutMs: 1000 }];
    config.repositories[0].skillBindings = [{
      id: 'oa-integration-test-core', capability: 'integration-test-authoring',
      skillPath: 'docs/skills/Integration-test-core/SKILL.md', enabled: true, qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['src'], requiresBehaviorCard: true,
      sideEffects: { commit: false, push: false, createDraftPR: false }
    }];
  } });
  const workspace = join(root, 'oa-worktree');
  const skillText = '# Synthetic OA integration skill\n';
  mkdirSync(join(workspace, 'docs', 'skills', 'Integration-test-core'), { recursive: true });
  writeFileSync(join(workspace, 'docs', 'skills', 'Integration-test-core', 'SKILL.md'), skillText);
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', ...args], { cwd: workspace, windowsHide: true, encoding: 'utf8' }).trim();
  git(['init', '--quiet']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic OA skill workspace']);
  git(['remote', 'add', 'origin', config.repositories[0].remote]);
  const baseRevision = git(['rev-parse', 'HEAD']);
  const validationContract = repositoryValidationContract(config.repositories[0]);
  ledger.qualify(skillQualificationId('fixture', 'oa-integration-test-core'), {
    state: 'qualified-read-only', repoId: 'fixture', bindingId: 'oa-integration-test-core',
    capability: 'integration-test-authoring', remote: config.repositories[0].remote,
    baseRef: config.repositories[0].baseRef, baseRevision,
    skillPath: 'docs/skills/Integration-test-core/SKILL.md', skillSha256: hash(skillText),
    qualificationSource: 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    sideEffects: { commit: false, push: false, createDraftPR: false }
  });
  await adoBatch(config, ledger);
  const evidence = ledger.all('evidence')[0];
  const investigation = {
    recordType: 'investigation', schemaVersion: '1.0',
    id: `investigation-${hash(json([evidence.source.namespace, evidence.source.recordId]))}`, version: 1,
    evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'OA behavior lacks integration coverage.',
    expectedBehavior: 'The behavior is protected by a focused integration test.', hypotheses: [], counterEvidence: [],
    classification: 'functional', defectConfirmation: 'unconfirmed', reportEligibility: 'included',
    handoffEligibility: 'eligible', exclusionReasons: [], rationale: 'Test-coverage improvement fixture.',
    confidence: 0.8, review: { method: config.reviewMethod, reviewer: 'fixture', reviewedAt: now() },
    repoIds: ['fixture'], existingFixes: [], nextAction: 'Add focused OA integration coverage.'
  };
  appReview(config, ledger, 'test-run', { investigation, exclusionsChecked: exclusions });
  const planned = appPlanImprovement(config, ledger, 'test-run', {
    improvement: {
      investigationIds: [investigation.id], category: 'missing-test-coverage',
      theme: 'OA focused integration coverage', observedBehavior: investigation.observedBehavior,
      expectedBehavior: investigation.expectedBehavior, rationale: 'Create one durable OA improvement.',
      priority: 'medium', repoIds: ['fixture'], capabilities: ['integration-test-authoring']
    },
    testCoverage: {
      repoId: 'fixture', capability: 'integration-test-authoring', sourceRevision: baseRevision,
      searchStatus: 'complete', existingTests: [], coverageGaps: ['No matching integration test.'],
      unknowns: [], rationale: 'Source-bound search confirmed the coverage gap.'
    }
  });
  const worker = appWorker(config, ledger, 'test-run', 'prepare', {
    investigationId: investigation.id, repoId: 'fixture', intent: 'improvement',
    testCoveragePlanId: planned.testCoveragePlan.id, requestedOutcome: 'add-or-update-tests'
  });
  assert.equal(worker.assignment.improvementId, planned.improvement.id);
  assert.equal(worker.assignment.testCoveragePlanId, planned.testCoveragePlan.id);
  assert.equal(worker.assignment.skillBindingId, 'oa-integration-test-core');
  assert.equal(ledger.all('areaToImprove').length, 1);
  assert.equal(ledger.all('testCoveragePlan').length, 1);
  const claimId = 'oa-claim';
  appWorker(config, ledger, 'test-run', 'claim', {
    assignmentId: worker.id, claimId, coordinatorAgentId: worker.coordinatorAgentId
  });
  assert.throws(() => appWorker(config, ledger, 'test-run', 'bind', {
    assignmentId: worker.id, claimId, sessionId: 'oa-session', projectId: worker.projectId,
    workspace: join(root, 'missing-workspace'), baseRevision
  }), /readable Git checkout/);
  const bound = appWorker(config, ledger, 'test-run', 'bind', {
    assignmentId: worker.id, claimId, sessionId: 'oa-session', projectId: worker.projectId,
    workspace, baseRevision
  });
  assert.equal(bound.baseRevision, baseRevision);
});

test('app successful run A cursor survives blocked run B in the shared live ledger', async t => {
  const { config, ledger } = setup(t, { dry: false, provenance: 'app-tool' });
  await appendApp(config, ledger, 'test-run', event([identityCall(config), call('empty-page', rootPath(config), { value: [] })]));
  const cursor = ledger.cursor('app:workiq:created');
  assert.ok(cursor);
  beginApp(config, { runId: 'run-B', dryRun: false, provenance: 'app-tool' });
  const failed = identityCall(config); failed.id = 'B-failed';
  delete failed.response; failed.failure = { code: 'blocked-auth', statusCode: 500 };
  blockApp(config, ledger, 'run-B', { eventId: 'B-auth-failure', pass: 'workiq:created', call: failed });
  assert.deepEqual(ledger.cursor('app:workiq:created'), cursor);
  const summary = appStatus(ledger, 'run-B');
  assert.equal(summary.collection.find(p => p.pass === 'workiq:created').nextRequest, null);
  assert.equal(listAppRuns(config).runs.length, 2);
});

test('app receipts persist app-tool-reported provenance rather than local authenticated-source', async t => {
  const { config, ledger } = setup(t, { provenance: 'app-tool' });
  await appendApp(config, ledger, 'test-run', event([identityCall(config), call('page', rootPath(config), { value: [message()] })]));
  await adoBatch(config, ledger);
  assert.ok(ledger.all('evidence').every(e => e.source.provenance === 'app-tool-reported'));
  assert.equal(appStatus(ledger, 'test-run').collection.find(p => p.pass === 'ado:created').identityVerification,
    'validated-app-reported-principal');
});

test('app first ADO source error remains failed-source rather than invented authentication failure', async t => {
  const { config, ledger } = setup(t, { provenance: 'app-tool' });
  let requests = 0;
  const result = await collectAppAdo(config, ledger, 'test-run', 'ado:created', async () => async () => {
    requests++; throw Object.assign(new Error('synthetic service unavailable'), { code: 'failed-source' });
  });
  const pass = result.collection.find(p => p.pass === 'ado:created');
  assert.equal(pass.state, 'failed-source');
  assert.equal(pass.identityVerified, false);
  assert.equal(requests, 1);
  await assert.rejects(collectAppAdo(config, ledger, 'test-run', 'ado:created'), /already recorded/);
});

test('app ADO authentication failure suppresses changed pass without another factory/request', async t => {
  const { config, ledger } = setup(t, { provenance: 'app-tool' });
  await collectAppAdo(config, ledger, 'test-run', 'ado:created', async () => async () => {
    throw Object.assign(new Error('synthetic auth failure'), { code: 'blocked-auth' });
  });
  await assert.rejects(collectAppAdo(config, ledger, 'test-run', 'ado:changed', async () => {
    assert.fail('Must not acquire another client'); }), /cross-pass retry/);
});

test('source links with whitespace are URI normalized while original receipt bytes are unchanged', () => {
  const item = { id: 1, rev: 2, fields: { 'System.WorkItemType': 'Bug', 'System.AreaPath': area, 'System.State': 'Active' },
    relations: [{ rel: 'Hyperlink', url: 'https://example.invalid/path with space' }] };
  const record = adoRecord(item, 'synthetic query', '2026-10-09T00:00:00Z');
  assert.equal(record.links[0].url, 'https://example.invalid/path%20with%20space');
  assert.equal(item.relations[0].url, 'https://example.invalid/path with space');
});

test('nested ledger evidence operations roll back atomically with app event failures', t => {
  const { ledger } = setup(t);
  assert.throws(() => ledger.transaction(() => {
    ledger.db.prepare('INSERT INTO captures VALUES(?,?)').run('test-digest', Buffer.from('test'));
    ledger.transaction(() => ledger.db.prepare('INSERT INTO captures VALUES(?,?)').run('nested-digest', Buffer.from('nested')));
    throw new Error('synthetic failure');
  }));
  assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM captures').get().n, 0);
});

test('app item budget retains permitted evidence and reports excess returned records unexamined', async t => {
  const { config, ledger } = setup(t);
  const saved = JSON.parse(ledger.db.prepare('SELECT body FROM app_runs WHERE id=?').get('test-run').body);
  saved.limits.maxItems = 1;
  ledger.db.prepare('UPDATE app_runs SET body=? WHERE id=?').run(json(saved), 'test-run');
  const result = await appendApp(config, ledger, 'test-run', event([identityCall(config),
    call('limited-page', rootPath(config), { value: [message('one'), message('two')] })]));
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'partial'); assert.equal(pass.examinedRecords, 1);
  assert.equal(pass.returnedRecords, 2); assert.equal(pass.unexaminedReturnedRecords, 1);
  assert.equal(pass.evidenceCount, 1); assert.equal(pass.nextRequest, null);
  assert.equal(ledger.cursor('app:workiq:created'), null);
});

test('app read-call exhaustion remains visible partial without an executable continuation', async t => {
  const { config, ledger } = setup(t);
  const saved = JSON.parse(ledger.db.prepare('SELECT body FROM app_runs WHERE id=?').get('test-run').body);
  saved.limits.maxCalls = 1;
  ledger.db.prepare('UPDATE app_runs SET body=? WHERE id=?').run(json(saved), 'test-run');
  const result = await appendApp(config, ledger, 'test-run', event([identityCall(config)]));
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'partial'); assert.equal(pass.readCalls, 1); assert.equal(pass.nextRequest, null);
  assert.match(pass.error.message, /budget/);
});
