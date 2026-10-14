import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configAt, hash, json, readJson, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { reserveAgencyRequest, recordAgencySubmission, recordAgencyAnalysisCheck, recordAgencyCaptureCheck,
  reconcileAgencyResult, inspectAgencyCaptureLog, agencyFilterRunnerMetadata,
  inspectAgencySourceLog, recordAgencySourceCheck } from '../src/agency-executor.js';
import { captureVerificationProtocol, verifyFilterCaptureInput } from '../src/filter-capture-verifier.js';
import { beginApp, openApp } from '../src/app-native.js';
import { evidenceEnvelope } from '../src/sources.js';
import { loadFilterCorpus } from '../src/filter.js';
import { prepareFilterBatches, sizeFilterGroups, expandFilterSharing, expandFilterCoverage,
  validateFilterManifest, checkFilterBatchResult,
  consolidateFilterBatches, bindFilterConsolidation } from '../src/filter-batches.js';
import { prepareStage2, coverageSkillName } from '../src/stage2.js';
import { reconcileFilterExecutionCohort } from '../src/filter-execution.js';
import { acceptFilterProposerHandoff, prepareFilterProposerHandoff } from '../src/filter-handoff.js';
import {
  qualifyRepositorySkill, repositoryValidationContract, skillQualificationId
} from '../src/repository-skills.js';

const bytes = v => `${JSON.stringify(v, null, 2)}\n`;
const sha = v => hash(bytes(v));
const inputOf = b => JSON.parse(JSON.parse(b.payload).payload);
const declarativeSkillPath = '.github/skills/author-declarative-e2e-test/SKILL.md';
const declarativeInput = {
  format: 'declarative-e2e-mini-spec-batch-v1',
  items: [{
    inputItemId: 'synthetic-canary',
    title: 'Synthetic workbook contract',
    account: 'AAD',
    entryUrl: 'https://example.invalid/chat',
    preconditions: ['Use the approved dedicated test profile'],
    orderedTestSteps: ['Create a Canary worksheet with a four-row, three-column table'],
    expectedUserVisibleAndDataOutcomes: ['The workbook has the requested worksheet and table'],
    cleanup: ['Close only the test-owned tab']
  }]
};
function writeProposerSource(checkout) {
  mkdirSync(join(checkout, '.github', 'skills', 'author-declarative-e2e-test'), { recursive: true });
  mkdirSync(join(checkout, 'scenarios'));
  mkdirSync(join(checkout, 'test'));
  writeFileSync(join(checkout, declarativeSkillPath),
    '# Synthetic declarative skill\nPreserve the complete mini-spec in a scenario and register its ID.\n');
  writeFileSync(join(checkout, 'scenarios', 'baseline.json'), '{}\n');
  writeFileSync(join(checkout, 'resources.json'), '[]\n');
  writeFileSync(join(checkout, 'test', 'expected-input.json'), bytes(declarativeInput.items[0]));
  writeFileSync(join(checkout, 'test', 'scenario.test.cjs'), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));",
    "test('generated scenario preserves the reviewed mini-spec', () => {",
    "  const expected = read('test/expected-input.json');",
    "  assert.deepEqual(read('scenarios/canary.json'), expected);",
    "  assert.deepEqual(read('resources.json'), [expected.inputItemId]);",
    '});', ''
  ].join('\n'));
}
async function exerciseFilterProposer(s, ledger, checkout, git, manifest, reviewed) {
  const sourceHash = hash(readFileSync(s.ledgerPath));
  const receipts = ledger.db.prepare('SELECT kind,body FROM agency_receipts ORDER BY kind').all();
  const remote = join(s.root, 'synthetic-remote.git');
  git(['init', '--bare', '--quiet', remote]);
  git(['remote', 'add', 'origin', remote]);
  const repo = {
    id: 'synthetic', projectId: 'synthetic-project', owner: 'synthetic-owner',
    routingApproved: true, routingRules: ['Synthetic FILTER flow'],
    referenceCheckout: checkout, remote, baseRef: 'HEAD',
    sparseCheckoutPaths: ['.github', 'scenarios', 'test'],
    allowedWritePrefixes: ['scenarios'], allowedWriteFiles: ['resources.json'],
    commitIdentity: { name: 'Synthetic test', email: 'synthetic@example.invalid' },
    validationGates: [{
      id: 'synthetic-scenario', approved: true, executable: process.execPath,
      args: ['--test', 'test/scenario.test.cjs'], timeoutMs: 30000
    }],
    skillBindings: [{
      id: 'synthetic-declarative', capability: 'declarative-e2e-authoring',
      skillPath: declarativeSkillPath, inputFormat: declarativeInput.format,
      enabled: true, qualification: 'qualified', requestedOutcomes: ['add-declarative-e2e-tests'],
      sideEffects: { commit: true, push: true, createDraftPR: true }
    }]
  };
  s.config.repositories = [repo];
  s.config.stateDirectory = ledger.directory;
  Object.assign(s.config.limits, {
    maxItems: 10, workerMaxToolCalls: 20, maxAiCreditsPerSession: 1,
    maxValidationInfrastructureRetries: 0, maxValidationRepairRounds: 0
  });
  const qualification = await qualifyRepositorySkill(s.config, repo.id, 'declarative-e2e-authoring');
  assert.equal(qualification.baseRevision, reviewed.candidates[0].sourceRevision);
  ledger.qualify(skillQualificationId(repo.id, 'synthetic-declarative'), qualification);
  const resultPath = join(s.root, 'accepted-filter-result.json');
  writeFileSync(resultPath, bytes(reviewed));
  const input = {
    format: 'filter-proposer-handoff-v1',
    filter: { manifestPath: s.path, resultPaths: [resultPath] },
    routing: {
      capability: 'declarative-e2e-authoring', requestedOutcome: 'add-declarative-e2e-tests',
      skillInput: declarativeInput
    }
  };
  const options = { execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true };
  for (const permission of ['authorizeCommit', 'authorizePush', 'authorizeDraftPR']) {
    await assert.rejects(acceptFilterProposerHandoff(s.config, ledger, input,
      { ...options, [permission]: false }), /Execution requires/);
    assert.equal(ledger.all('assignment').length, 0);
  }
  await assert.rejects(acceptFilterProposerHandoff(s.config, ledger,
    { ...input, filter: { ...input.filter, resultPaths: [] } }, options), /resultPaths/);
  const prepared = prepareFilterProposerHandoff(s.config, ledger, input);
  assert.equal(prepared.assignment.execution, 'local');
  assert.deepEqual(prepared.assignment.evidenceIds, reviewed.candidates[0].evidenceIds);
  assert.deepEqual(prepared.assignment.skillInput, declarativeInput);
  const repeated = prepareFilterProposerHandoff(s.config, ledger, input);
  assert.equal(repeated.assignment.id, prepared.assignment.id);
  let modelCalls = 0, draftCalls = 0;
  const executed = await acceptFilterProposerHandoff(s.config, ledger, input, {
    ...options,
    dispatchDependencies: {
      runModel: async (_config, _ledger, current, assignment, investigation, toolkit, skill) => {
        modelCalls++;
        assert.equal(current.base_revision, qualification.baseRevision);
        assert.equal(skill.skillRevision, qualification.baseRevision);
        assert.match(skill.instructions, /Synthetic declarative skill/);
        assert.equal(investigation.review.reviewer, 'FILTER:synthetic-filter');
        assert.deepEqual(assignment.skillInput, declarativeInput);
        assert.throws(() => toolkit.write('test/scenario.test.cjs', ''), /approved edit bounds/);
        toolkit.write('scenarios/canary.json', bytes(assignment.skillInput.items[0]));
        toolkit.write('resources.json', bytes([assignment.skillInput.items[0].inputItemId]));
        toolkit.finish({
          outcome: 'propose-change', findings: 'Synthetic authoring preserves reviewed input.',
          title: 'Add synthetic declarative scenario', description: 'Offline controller fixture only.',
          skillResult: {
            status: 'succeeded', classification: 'missing-test-coverage',
            changedFiles: ['resources.json', 'scenarios/canary.json'],
            testsAddedOrUpdated: ['synthetic-canary'], behaviorCardsAddedOrUpdated: [],
            unknowns: [], needsHumanDecision: false
          }
        });
      },
      createDraft: async (_config, _ledger, current, _repo, revision) => {
        draftCalls++;
        assert.equal(git(['--git-dir', remote, 'rev-parse', `refs/heads/pilot/${current.id}`]), revision);
        return { url: 'https://example.invalid/draft/1', isDraft: true, headRevision: revision };
      }
    }
  }).catch(error => {
    const validation = ledger.all('workerResult').flatMap(result => result.validation ?? [])
      .map(({ status, blockedReason, attemptCount }) => ({ status, blockedReason, attemptCount }));
    throw new Error(`Synthetic proposer failed: ${JSON.stringify(validation)}`, { cause: error });
  });
  assert.equal(modelCalls, 1); assert.equal(draftCalls, 1);
  assert.equal(executed.state, 'draft-pr-validated');
  assert.equal(executed.assignment.id, prepared.assignment.id);
  const output = executed.result, gate = output.validation[0];
  assert.equal(gate.sourceRevision, output.sourceRevision);
  assert.equal(output.draftPR.headRevision, output.sourceRevision);
  assert.notEqual(output.sourceRevision, qualification.baseRevision);
  assert.equal(gate.status, 'passed'); assert.equal(gate.attemptCount, 1);
  const artifact = readJson(gate.artifactRefs[0]);
  assert.equal(artifact.revision, output.sourceRevision);
  assert.match(artifact.output.stdout, /generated scenario preserves the reviewed mini-spec/);
  assert.equal(ledger.job(prepared.assignment.id).state, 'completed');
  await assert.rejects(acceptFilterProposerHandoff(s.config, ledger, input, options), /never-dispatched/);
  assert.equal(modelCalls, 1); assert.equal(draftCalls, 1);
  assert.equal(git(['rev-parse', 'HEAD']), qualification.baseRevision);
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(hash(readFileSync(s.ledgerPath)), sourceHash);
  assert.deepEqual(ledger.db.prepare('SELECT kind,body FROM agency_receipts ORDER BY kind').all(), receipts);
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state,
    'complete-held');
}
const counter = async (_config, input) => ({ sha256: input.sha256, model: input.model,
  tokenizer: input.tokenizer, tokens: input.text.startsWith('{') ? JSON.parse(JSON.parse(input.text).payload).groups.length * 100 + 20 : 5 });
function setup(t, count = 3, related = false, titles = null, canonicalCapture = false,
  provenance = 'synthetic') {
  const root = mkdtempSync(join(tmpdir(), 'filter-batches-'));
  const cleanup = [];
  t.after(() => { for (const close of cleanup) close(); rmSync(root, { recursive: true, force: true }); });
  const config = configAt('pilot.example.json');
  config.stateDirectory = root; config.statePolicy.accessApproved = true;
  const sourceConfig = structuredClone(config);
  beginApp(config, { runId: 'source', dryRun: true, provenance: 'synthetic' });
  const { ledger } = openApp(config, 'source');
  const records = [];
  for (let i = 0; i < count; i++) {
    const e = evidenceEnvelope('ado', 'synthetic/issues', i + 1, '1',
      `https://example.invalid/issues/${i + 1}`, 'Synthetic query', '2026-10-09T01:00:00Z');
    e.source.provenance = provenance; e.title = titles ? titles[i] : i === 0 ? null : 'Functional issue';
    e.fields = { description: `Complete original body ${i}`, missing: null };
    if (related) e.fields.thread = { teamId: 'team', channelId: 'channel', rootId: 'root' };
    records.push(ledger.evidence(e, canonicalCapture
      ? { id: Number(e.source.recordId), rev: Number(e.source.revision), fields: e.fields, relations: e.links }
      : { completeBody: `Original capture ${i}` }, 'source:ado:created'));
  }
  const ledgerPath = join(ledger.directory, 'ledger.sqlite'); ledger.close();
  const sources = [{ ledgerPath, runId: 'source' }];
  const corpus = loadFilterCorpus(config, { format: 'stage2-sources-v1', sources });
  const verificationRef = join(root, 'verified.json');
  writeFileSync(verificationRef, '{"syntheticOnly":true}');
  config.filterBatching = { approved: true, mode: 'verified', model: 'synthetic', profile: 'synthetic', tokenizer: 'synthetic-v1',
    verifiedBy: 'test', verifiedAt: '2026-10-12T00:00:00Z', verificationRef,
    verificationSha256: hash(readFileSync(verificationRef)), contextTokens: 1000,
    maxInputTokens: 250, maxPayloadBytes: 1000000, maxBatches: 10,
    reserves: { instructions: 10, sourceAnalysis: 20, output: 100, safety: 10, requestOverhead: 5 } };
  const request = { format: 'filter-batch-request-v1', sources, instructions: 'Synthetic instructions',
    groups: records.map((r, i) => ({ id: `g${i}`, memberIds: [r.id], contextIds: [], reason: 'Independent report' })),
    groupingReview: { reviewer: 'test', reviewedAt: '2026-10-12T00:00:00Z', rationale: 'Synthetic independent reports' },
    sharing: { audience: 'synthetic', approvalRef: 'synthetic-test', materials: [] } };
  const approve = () => {
    const current = loadFilterCorpus(config, { format: 'stage2-sources-v1', sources });
    request.sharing.materials = [...new Set([...current.evidence.map(sha),
      ...current.captures.map(c => c.sha256), ...current.contexts.map(c => c.sha256),
      hash(request.instructions), sha(current.coverage.map(({ runId, coverage }) => ({ runId, coverage })))])]
      .map(sha256 => ({ sha256, eligibility: 'approved', restrictions: ['synthetic-only'] }));
  };
  approve();
  const path = join(root, 'manifest.json');
  return { config, sourceConfig, request, root, path, records, corpus, ledgerPath, approve, cleanup };
}
async function prepared(s) {
  await prepareFilterBatches(s.config, s.request, s.path, counter);
  return readJson(s.path);
}
function result(manifest, batch) {
  const payload = inputOf(batch);
  return { format: 'filter-batch-result-v1', cohortId: manifest.cohortId, batchId: batch.id,
    payloadSha256: batch.analysisPayloadSha256, status: 'complete',
    titles: { format: 'filter-title-decisions-v1', indexSha256: batch.indexSha256,
      reviewer: 'synthetic-filter', reviewedAt: '2026-10-12T00:00:00Z',
      decisions: payload.index.entries.map(e => ({ evidenceId: e.evidenceId, source: e.source,
        captureSha256: e.captureSha256, disposition: e.title ? 'needs-details' : 'no-title',
        exclusionType: null, reason: 'Full review required', titleQuote: null })) },
    details: payload.index.entries.map(e => ({ evidenceId: e.evidenceId, recordSha256: e.recordSha256,
      captureSha256: e.captureSha256, status: 'reviewed', reason: 'Synthetic complete read' })), candidates: [] };
}
function candidate(r, override = {}) {
  return { id: 'c1', evidenceIds: [r.details[0].evidenceId], repository: 'synthetic',
    sourceRevision: 'a'.repeat(40), layer: 'e2e', missingAssertion: 'Required behavior',
    existingCoverage: ['exact test assertion at source'], harness: 'qualified local harness',
    coverageStatus: 'gap', blockers: [], priority: 50, confidence: 0.8,
    rationale: 'Exact source assertion inventory supports a candidate, not confirmed defect', ...override };
}
test('exact token boundary packs complete records, reserves capacity and preserves source bytes', async t => {
  const s = setup(t), before = hash(readFileSync(s.ledgerPath)), manifest = await prepared(s);
  assert.deepEqual(manifest.batches.map(b => b.groupIds.length), [2, 1]);
  assert.equal(manifest.batches[0].tokenReceipt.tokens + 5, manifest.budget.payloadLimit);
  assert.equal(manifest.inventory.length, 3);
  assert.equal(hash(readFileSync(s.ledgerPath)), before);
  const bodies = manifest.batches.flatMap(b => inputOf(b).evidence);
  assert.deepEqual(bodies.map(e => e.id).sort(), s.records.map(e => e.id).sort());
  assert.ok(bodies.every(e => e.fields.description.startsWith('Complete original body')));
  assert.equal(validateFilterManifest(s.config, manifest).evidence.length, 3);
  const again = await prepareFilterBatches(s.config, s.request, s.path, counter);
  assert.equal(again.sha256, hash(readFileSync(s.path)));
  s.config.filterBatching.maxInputTokens--;
  const next = join(s.root, 'smaller.json');
  await prepareFilterBatches(s.config, s.request, next, counter);
  assert.deepEqual(readJson(next).batches.map(b => b.groupIds.length), [1, 1, 1]);
});
test('oversized indivisible group, unknown capacity/counts and job limits block without truncation', async t => {
  const s = setup(t);
  s.config.filterBatching.maxInputTokens = 100;
  await assert.rejects(prepareFilterBatches(s.config, s.request, s.path, counter), /exceeds verified budget/);
  assert.equal(existsSync(s.path), false);
  s.config.filterBatching.maxInputTokens = null;
  await assert.rejects(prepareFilterBatches(s.config, s.request, s.path, counter), /Unknown\/invalid/);
  s.config.filterBatching.maxInputTokens = 250; s.config.filterBatching.maxBatches = 1;
  await assert.rejects(prepareFilterBatches(s.config, s.request, s.path, counter), /job budget/);
  s.config.filterBatching.maxBatches = 10;
  await assert.rejects(prepareFilterBatches(s.config, s.request, s.path,
    async (c, i) => ({ ...await counter(c, i), sha256: '0'.repeat(64) })), /receipt does not match/);
});
test('explicit estimated mode preserves unknown provider limits and exact declared estimator bounds', async t => {
  const s = setup(t);
  Object.assign(s.config.filterBatching, { mode: 'estimated', tokenizer: null,
    contextTokens: null, maxInputTokens: null, estimation: {
      methodId: 'synthetic-estimator-v1', version: '1', description: 'Synthetic deterministic estimate',
      planningContextTokens: 1000, inputTokenCap: 250,
      approval: { decision: 'Approved estimated bounded test', authority: 'synthetic-user',
        receivedAt: '2026-10-12T00:00:00Z', scope: 'bounded-replay', maxConcurrency: 2,
        accuracy: 'estimate-not-provider-token-accuracy' }
    } });
  const manifest = await prepared(s);
  assert.equal(manifest.budget.tokenizer, null);
  assert.equal(manifest.budget.contextTokens, null);
  assert.equal(manifest.budget.maxInputTokens, null);
  assert.match(manifest.budget.uncertainty, /unknown/);
  assert.deepEqual(manifest.batches.map(b => b.groupIds.length), [2, 1]);
  assert.equal(validateFilterManifest(s.config, manifest).evidence.length, 3);
  s.config.filterBatching.estimation.approval.maxConcurrency = 3;
  await assert.rejects(prepareFilterBatches(s.config, s.request, join(s.root, 'bad.json'), counter), /bounded user approval/);
});
test('budget-free group sizing is explicit bytes only and matches exact packed payload size', async t => {
  const s = setup(t, 1);
  const measured = sizeFilterGroups(s.config, s.request);
  assert.equal(measured.providerTokensVerified, false);
  assert.equal(measured.sharingEligibilityChecked, false);
  const manifest = await prepared(s);
  assert.equal(measured.largestAtomicPayloadBytes, Buffer.byteLength(manifest.batches[0].payload));
  assert.equal(measured.groups[0].payloadSha256, manifest.batches[0].payloadSha256);
});
test('only byte-proven duplicate captures use lossless field recipes; unmatched archives stay inline', async t => {
  const s = setup(t, 1, false, null, true), manifest = await prepared(s);
  const content = inputOf(manifest.batches[0]), capture = content.captures[0], record = content.evidence[0];
  assert.equal(capture.representation, 'reconstructed-from-full-evidence');
  assert.equal(capture.contentBase64, undefined); assert.equal(capture.recipe, 'ado-fields-relations-v1');
  const rebuilt = json({ id: Number(record.source.recordId), rev: Number(record.source.revision),
    fields: record.fields, relations: record.links });
  assert.equal(hash(rebuilt), capture.sha256);
  assert.equal(Buffer.byteLength(rebuilt), capture.originalByteLength);
  assert.equal(validateFilterManifest(s.config, manifest).evidence.length, 1);
  const unmatched = setup(t, 1), other = await prepared(unmatched);
  const inline = inputOf(other.batches[0]).captures[0];
  assert.equal(inline.representation, 'inline-base64');
  assert.equal(hash(Buffer.from(inline.contentBase64, 'base64')), inline.sha256);
});
test('within-batch sharing and coverage factoring round-trips every distinct policy and source field', async t => {
  const s = setup(t, 2), { ledger } = openApp(s.sourceConfig, 'source');
  const repeated = { missingScope: 'x'.repeat(600), known: false };
  for (const pass of ['synthetic:a', 'synthetic:b'])
    ledger.db.prepare('INSERT INTO app_passes VALUES(?,?,?)').run('source', pass,
      json({ pass, state: 'partial', limitations: repeated, specific: pass }));
  ledger.close(); s.approve();
  s.request.sharing.materials[0].restrictions = ['Distinct additional restriction; original label unknown'];
  const manifest = await prepared(s), input = inputOf(manifest.batches[0]);
  assert.equal(input.sharing.policies.length, 2);
  const expanded = expandFilterSharing(input.sharing);
  assert.deepEqual(expanded.materials, s.request.sharing.materials);
  assert.deepEqual(expandFilterCoverage(input.sourceCoverage), loadFilterCorpus(s.config,
    { format: 'stage2-sources-v1', sources: s.request.sources }).coverage.map(({ runId, coverage }) => ({ runId, coverage })));
  const changed = structuredClone(input.sharing); changed.policies[0].restrictions = ['lost restriction'];
  assert.throws(() => expandFilterSharing(changed), /round-trip/);
  const coverage = structuredClone(input.sourceCoverage); coverage.shared[0].value.known = true;
  assert.throws(() => expandFilterCoverage(coverage), /round-trip/);
});
test('related thread members cannot split and complete thread context is preserved', async t => {
  const s = setup(t, 2, true), { ledger } = openApp(s.sourceConfig, 'source');
  const context = { teamId: 'team', channelId: 'channel', rootId: 'root',
    message: { body: 'Complete older related thread message' } };
  ledger.db.prepare('INSERT INTO app_thread_context VALUES(?,?,?,?)').run('source', 'workiq:created', 'ctx', json(context));
  ledger.close(); s.approve();
  await assert.rejects(prepareFilterBatches(s.config, s.request, s.path, counter), /cannot be split/);
  s.request.groups = [{ id: 'thread', memberIds: s.records.map(e => e.id), contextIds: [], reason: 'Same thread' }];
  const manifest = await prepared(s);
  assert.deepEqual(inputOf(manifest.batches[0]).threadContexts[0].content, context);
});
test('context copies are explicit, counted in exact payload and never extra review members', async t => {
  const s = setup(t); s.config.filterBatching.maxInputTokens = 249;
  s.request.groups[0].contextIds = [s.records[2].id];
  const manifest = await prepared(s), batch = manifest.batches[0], content = inputOf(batch);
  assert.deepEqual(batch.contextIds, [s.records[2].id]);
  assert.equal(content.evidence.length, 2); assert.equal(content.index.entries.length, 1);
  const r = result(manifest, batch);
  r.candidates = [candidate(r, { evidenceIds: [s.records[2].id] })];
  assert.throws(() => checkFilterBatchResult(s.config, manifest, r), /retained reviewed batch members/);
});
test('missing duplicate foreign groups and unknown sharing eligibility fail closed', async t => {
  for (const change of [
    s => s.request.groups.pop(),
    s => s.request.groups[1].memberIds.push(s.records[0].id),
    s => s.request.groups[0].memberIds.push('foreign'),
    s => { s.request.sharing.materials[0].eligibility = 'unknown'; }
  ]) {
    const s = setup(t); change(s);
    await assert.rejects(prepareFilterBatches(s.config, s.request, s.path, counter));
    assert.equal(existsSync(s.path), false);
  }
});
test('strict batch result membership rejects missing duplicate foreign and stale evidence', async t => {
  const s = setup(t), manifest = await prepared(s), valid = result(manifest, manifest.batches[0]);
  for (const change of [
    r => r.titles.decisions.pop(),
    r => r.titles.decisions.push(r.titles.decisions[0]),
    r => { r.titles.decisions[0].source.revision = 'stale'; },
    r => { r.batchId = 'foreign'; },
    r => { r.payloadSha256 = '0'.repeat(64); },
    r => r.details.pop(),
    r => r.details.push(r.details[0]),
    r => { r.details[0].recordSha256 = '0'.repeat(64); }
  ]) {
    const changed = structuredClone(valid); change(changed);
    assert.throws(() => checkFilterBatchResult(s.config, manifest, changed));
  }
  assert.equal(checkFilterBatchResult(s.config, manifest, valid).state, 'checked-not-qualified');
  const { ledger } = openApp(s.sourceConfig, 'source');
  const changed = structuredClone(s.records[0]); changed.source.revision = '2';
  ledger.evidence(changed, { revised: true }, 'source:ado:created'); ledger.close();
  assert.throws(() => checkFilterBatchResult(s.config, manifest, valid), /source snapshot changed|sharing eligibility/);
});
test('missing failed partial and conflicting batches prevent candidate selection deterministically', async t => {
  const s = setup(t), manifest = await prepared(s), all = manifest.batches.map(b => result(manifest, b));
  all[0].candidates.push(candidate(all[0]));
  assert.equal(consolidateFilterBatches(s.config, manifest, all.slice(0, 1)).selected, null);
  const partial = structuredClone(all);
  partial[1].status = 'failed'; partial[1].titles.decisions = []; partial[1].details = [];
  const failed = consolidateFilterBatches(s.config, manifest, partial);
  assert.equal(failed.state, 'partial'); assert.equal(failed.selected, null);
  assert.equal(failed.accounting[1].members[0].status, 'failed');
  partial[1].status = 'partial';
  assert.equal(consolidateFilterBatches(s.config, manifest, partial).state, 'partial');
  const conflicting = structuredClone(all[0]); conflicting.details[0].reason = 'Conflicting receipt';
  const left = consolidateFilterBatches(s.config, manifest, [...all, conflicting]);
  const right = consolidateFilterBatches(s.config, manifest, [conflicting, ...all].reverse());
  assert.deepEqual(left, right); assert.equal(left.selected, null); assert.equal(left.conflicts.length, 1);
});
test('dedup, audit ranking, E2E selection and immutable consolidation preserve one-candidate bound', async t => {
  const s = setup(t), manifest = await prepared(s), all = manifest.batches.map(b => result(manifest, b));
  for (const r of all) r.candidates.push(candidate(r));
  all[0].candidates.push(candidate(all[0], { id: 'lower', missingAssertion: 'Another invariant', priority: 20 }));
  const path = join(s.root, 'consolidated.json');
  const consolidated = consolidateFilterBatches(s.config, manifest, [...all, all[0]], path);
  assert.equal(consolidated.state, 'complete-held');
  assert.equal(consolidated.ranking.length, 2); assert.equal(consolidated.duplicates.length, 1);
  assert.equal(consolidated.selected.definition.layer, 'e2e');
  assert.equal(consolidated.selected.evidenceIds.length, 2);
  assert.equal(consolidated.dispatchAllowed, false);
  assert.deepEqual(consolidateFilterBatches(s.config, manifest, [...all, all[0]], path), consolidated);
  assert.throws(() => consolidateFilterBatches(s.config, manifest, [], path), /output conflict/);
  const changed = structuredClone(all); changed[1].candidates[0].rationale = 'Conflicting claim';
  assert.equal(consolidateFilterBatches(s.config, manifest, changed).selected, null);
});
test('integration-first deferral preserves E2E findings without selecting or excluding them', async t => {
  const s = setup(t), manifest = await prepared(s), all = manifest.batches.map(b => result(manifest, b));
  const blocker = 'Deferred: E2E capability setup is outside the integration-first milestone';
  for (const r of all) r.candidates.push(candidate(r, { priority: 100, blockers: [blocker] }));
  const before = JSON.stringify(all), deferred = consolidateFilterBatches(s.config, manifest, all);
  assert.equal(deferred.state, 'complete-held');
  assert.equal(deferred.selected, null);
  assert.equal(deferred.ranking.length, 1);
  assert.equal(deferred.ranking[0].definition.layer, 'e2e');
  assert.equal(deferred.ranking[0].definition.coverageStatus, 'gap');
  assert.deepEqual(deferred.ranking[0].definition.blockers, [blocker]);
  assert.equal(deferred.ranking[0].evidenceIds.length, 2);
  assert.equal(JSON.stringify(all), before);
  all[0].candidates.push(candidate(all[0], { id: 'integration', layer: 'integration',
    harness: 'existing supported integration suite', priority: 20 }));
  const combined = consolidateFilterBatches(s.config, manifest, all);
  assert.equal(combined.selected.definition.layer, 'integration');
  assert.equal(combined.ranking.length, 2);
  assert.deepEqual(combined.ranking[0], deferred.ranking[0]);
  assert.equal(combined.dispatchAllowed, false);
  assert.ok(all.every(r => r.titles.decisions.every(d => d.disposition !== 'screen-out')));
});
test('empty/all-excluded/no-candidate populations consolidate without inventing a candidate', async t => {
  for (const count of [0, 1]) {
    const s = setup(t, count), manifest = await prepared(s);
    const results = manifest.batches.map(b => result(manifest, b));
    assert.equal(consolidateFilterBatches(s.config, manifest, results).selected, null);
    if (count) {
      // The fixture has an absent title, which may not be excluded.
      results[0].titles.decisions[0].disposition = 'screen-out';
      assert.throws(() => checkFilterBatchResult(s.config, manifest, results[0]), /no-title/);
    }
  }
  const s = setup(t, 2), manifest = await prepared(s), r = result(manifest, manifest.batches[0]);
  r.titles.decisions.find(d => d.disposition === 'needs-details').disposition = 'screen-out';
  const excluded = r.titles.decisions.find(d => d.disposition === 'screen-out');
  Object.assign(excluded, { exclusionType: 'confirmed_non_bug', reason: 'Synthetic reviewed title audit', titleQuote: 'Functional' });
  r.details.find(d => d.evidenceId === excluded.evidenceId).status = 'excluded-title';
  assert.equal(consolidateFilterBatches(s.config, manifest, [r]).selected, null);
  const excludedOnly = setup(t, 1, false, ['Copy-only punctuation']);
  const m = await prepared(excludedOnly), allExcluded = result(m, m.batches[0]);
  Object.assign(allExcluded.titles.decisions[0], { disposition: 'screen-out', exclusionType: 'copy_text_only',
    reason: 'Explicit copy-only title', titleQuote: 'Copy-only punctuation' });
  allExcluded.details[0].status = 'excluded-title';
  const consolidated = consolidateFilterBatches(excludedOnly.config, m, [allExcluded]);
  assert.equal(consolidated.state, 'complete-held'); assert.equal(consolidated.selected, null);
  assert.equal(consolidated.accounting[0].members[0].status, 'excluded-title');
});
test('Stage2 binds consolidated selected IDs and rejects unresolved batches', async t => {
  const s = setup(t), manifest = await prepared(s), all = manifest.batches.map(b => result(manifest, b));
  all[0].candidates.push(candidate(all[0]));
  const resultPaths = all.map((r, i) => {
    const path = join(s.root, `result-${i}.json`); writeFileSync(path, bytes(r)); return path;
  });
  const binding = { manifestPath: s.path, resultPaths };
  assert.equal(bindFilterConsolidation(s.config, binding).retainedIds.length, 1);
  assert.throws(() => bindFilterConsolidation(s.config, { ...binding, resultPaths: [] }), /unresolved/);
  s.config.stage2 = { skillDirectory: join(s.root, coverageSkillName) };
  mkdirSync(join(s.config.stage2.skillDirectory, 'references'), { recursive: true });
  writeFileSync(join(s.config.stage2.skillDirectory, 'SKILL.md'),
    `name: ${coverageSkillName}\nreferences/coverage-map.md`);
  writeFileSync(join(s.config.stage2.skillDirectory, 'references', 'coverage-map.md'), 'Synthetic only');
  const output = join(s.root, 'stage2.json');
  prepareStage2(s.config, { format: 'stage2-sources-v1', sources: s.request.sources, batchReview: binding }, output);
  assert.equal(readJson(output).sources[0].evidenceRefs.length, 1);
});
test('selected FILTER evidence prepares the real proposer assignment without a fixture adapter', async t => {
  const s = setup(t, 1, false, ['Authenticated functional issue'], false, 'authenticated-source');
  const manifest = await prepared(s), reviewed = result(manifest, manifest.batches[0]);
  const sourceRevision = 'b'.repeat(40);
  reviewed.candidates.push(candidate(reviewed, {
    repository: 'target-repo', sourceRevision, layer: 'integration',
    harness: 'target integration harness'
  }));
  const resultPath = join(s.root, 'filter-result.json');
  writeFileSync(resultPath, bytes(reviewed));
  const skillPath = '.github/skills/integration-test-authoring/SKILL.md';
  s.config.stateDirectory = join(s.root, 'target-state');
  s.config.limits.maxItems = 10;
  s.config.limits.workerMaxToolCalls = 20;
  s.config.repositories = [{
    id: 'target-repo',
    projectId: 'fixture-project',
    owner: 'fixture-owner',
    routingApproved: true,
    routingRules: ['FILTER proposer handoff'],
    referenceCheckout: s.root,
    baseRef: 'HEAD',
    remote: 'https://example.invalid/target.git',
    allowedWritePrefixes: ['test'],
    commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    validationGates: [{
      id: 'fixture-test',
      approved: true,
      isolationVerified: true,
      executable: process.execPath,
      args: ['--test'],
      timeoutMs: 10000
    }],
    skillBindings: [{
      id: 'target-integration',
      capability: 'integration-test-authoring',
      skillPath,
      inputFormat: 'declarative-e2e-mini-spec-batch-v1',
      enabled: true,
      qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'],
      requiresBehaviorCard: true,
      sideEffects: { commit: true, push: true, createDraftPR: true }
    }]
  }];
  const ledger = new Ledger(s.config.stateDirectory);
  const validationContract = repositoryValidationContract(s.config.repositories[0]);
  ledger.qualify(skillQualificationId('target-repo', 'target-integration'), {
    state: 'qualified-read-only',
    repoId: 'target-repo',
    bindingId: 'target-integration',
    capability: 'integration-test-authoring',
    referenceCheckout: s.root,
    remote: 'https://example.invalid/target.git',
    baseRef: 'HEAD',
    baseRevision: sourceRevision,
    skillPath,
    skillSha256: hash('fixture skill'),
    qualificationSource: 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    sideEffects: { commit: true, push: true, createDraftPR: true }
  });
  s.cleanup.push(() => ledger.close());
  const input = {
    format: 'filter-proposer-handoff-v1',
    filter: { manifestPath: s.path, resultPaths: [resultPath] },
    routing: {
      capability: 'integration-test-authoring',
      skillInput: {
        format: 'declarative-e2e-mini-spec-batch-v1',
        items: [{
          inputItemId: 'filter-authored-canary',
          title: 'Author a reviewed FILTER canary',
          account: 'AAD',
          entryUrl: 'https://example.invalid/chat',
          preconditions: ['Use the qualified signed-in profile'],
          orderedTestSteps: ['Open the entry URL', 'Perform the reviewed workflow'],
          expectedUserVisibleAndDataOutcomes: ['The reviewed outcome is visible'],
          cleanup: ['Close only the test-owned tab']
        }]
      }
    }
  };
  const preparedHandoff = prepareFilterProposerHandoff(s.config, ledger, input);
  assert.equal(preparedHandoff.candidate.definition.repository, 'target-repo');
  assert.equal(preparedHandoff.evidence[0].source.provenance, 'authenticated-source');
  assert.equal(preparedHandoff.investigation.review.reviewer, 'FILTER:synthetic-filter');
  assert.equal(preparedHandoff.testCoveragePlan.sourceRevision, sourceRevision);
  assert.deepEqual(preparedHandoff.testCoveragePlan.skillInput, input.routing.skillInput);
  assert.deepEqual(preparedHandoff.assignment.skillInput, input.routing.skillInput);
  assert.equal(preparedHandoff.assignment.skillBindingId, 'target-integration');
  assert.equal(preparedHandoff.job.state, 'prepared');
  const replay = prepareFilterProposerHandoff(s.config, ledger, input);
  assert.equal(replay.assignment.id, preparedHandoff.assignment.id);
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(ledger.all('investigation').length, 1);
  const configPath = join(s.root, 'target-config.json');
  const inputPath = join(s.root, 'filter-handoff.json');
  writeFileSync(configPath, bytes(s.config));
  writeFileSync(inputPath, bytes(input));
  const cli = spawnSync(process.execPath, [
    'src\\cli.js', 'submit-filter-handoff',
    '--file', inputPath, '--config', configPath, '--prepare'
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).assignment.id, preparedHandoff.assignment.id);
  assert.throws(() => prepareFilterProposerHandoff(
    s.config, ledger, input, { intent: 'defect-fix' }),
  /test-only and cannot become a defect-fix/);
  ledger.qualify(skillQualificationId('target-repo', 'target-integration'), {
    ...ledger.qualification(skillQualificationId('target-repo', 'target-integration')),
    baseRevision: 'c'.repeat(40)
  });
  assert.throws(() => prepareFilterProposerHandoff(s.config, ledger, input),
    /different source revisions/);
});
test('offline CLI uses pinned tokenizer command and does not create a main writable ledger', async t => {
  const s = setup(t, 1), tokenizer = join(s.root, 'counter.cjs');
  writeFileSync(tokenizer, "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{let i=JSON.parse(s);console.log(JSON.stringify({sha256:i.sha256,model:i.model,tokenizer:i.tokenizer,tokens:i.text.length}));});");
  Object.assign(s.config.filterBatching, { contextTokens: 1000000, maxInputTokens: 100000,
    counter: { approved: true, executable: process.execPath, executableSha256: hash(readFileSync(process.execPath)),
      args: [tokenizer], files: [{ path: tokenizer, sha256: hash(readFileSync(tokenizer)) }], timeoutMs: 10000 } });
  s.config.filterBatching.reserves.instructions = 100;
  s.config.stateDirectory = join(s.root, 'must-not-create');
  const configPath = join(s.root, 'pilot.local.json'), inputPath = join(s.root, 'request.json');
  writeFileSync(configPath, bytes(s.config)); writeFileSync(inputPath, bytes(s.request));
  const run = spawnSync(process.execPath, ['src/cli.js', 'filter-batches', '--file', inputPath,
    '--output', s.path, '--config', configPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.equal(existsSync(s.config.stateDirectory), false);
  const manifest = readJson(s.path), resultPath = join(s.root, 'result.json'), paths = join(s.root, 'paths.json');
  writeFileSync(resultPath, bytes(result(manifest, manifest.batches[0]))); writeFileSync(paths, bytes([resultPath]));
  for (const args of [
    ['filter-batch-check', '--file', resultPath, '--manifest', s.path],
    ['filter-consolidate', '--file', paths, '--manifest', s.path, '--output', join(s.root, 'out.json')]
  ]) {
    const child = spawnSync(process.execPath, ['src/cli.js', ...args, '--config', configPath], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  }
  assert.equal(existsSync(s.config.stateDirectory), false);
});
for (const mode of ['local-policy', 'missing', 'valid', 'partial-cohort', 'delivered-module', 'changed-module',
  'digest-valid', 'digest-publication-unknown', 'digest-wrong-hash',
  'digest-wrong-byte-length', 'digest-wrong-stdout-hash', 'digest-unqualified',
  'digest-source-missing', 'digest-source-dirty', 'digest-source-revision',
  'digest-source-build', 'digest-source-preflight', 'digest-source-failed',
  'wrong-job', 'wrong-input', 'wrong-verifier', 'failed',
  'wrong-step', 'wrong-definition', 'wrong-build', 'model-prose', 'wrong-serialization',
  'wrong-pipeline-source', 'wrong-bootstrap', 'invalid-execution-id',
  'wrong-source', 'wrong-length', 'missing-capture', 'all-excluded'])
test(`integrated FILTER worker capture execution gate: ${mode}`, async t => {
  const count = mode === 'partial-cohort' ? 3 : 1;
  // Authenticated-shaped fixtures exercise the production handoff without live sources.
  const s = setup(t, count, false, Array(count).fill('Telemetry only'), true,
    mode === 'local-policy' ? 'authenticated-source' : 'synthetic');
  const manifest = await prepared(s), batch = manifest.batches[0];
  let verifierPath = resolve('src/filter-capture-verifier.js');
  const verifierSha256 = hash(readFileSync(verifierPath));
  if (['delivered-module', 'changed-module'].includes(mode)) {
    const content = readFileSync(verifierPath);
    verifierPath = join(s.root, 'filter-capture-verifier.mjs');
    writeFileSync(verifierPath, mode === 'changed-module' ? Buffer.concat([content, Buffer.from('\n')]) : content);
  }
  const checkout = join(s.root, 'synthetic-checkout'); mkdirSync(checkout);
  const git = args => {
    const child = spawnSync('git', ['-C', checkout, '-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false', ...args], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); return child.stdout.trim();
  };
  git(['init', '--quiet']);
  if (mode === 'local-policy') {
    writeProposerSource(checkout);
    git(['add', '.']);
  }
  git(['-c', 'user.name=Synthetic test', '-c', 'user.email=synthetic@example.invalid',
    '-c', 'core.hooksPath=missing-hooks', 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic verifier source']);
  const sourceRevision = git(['rev-parse', 'HEAD']);
  const r = result(manifest, batch);
  if (['local-policy', 'valid', 'digest-valid'].includes(mode))
    r.candidates.push(candidate(r, { sourceRevision }));
  if (mode === 'all-excluded') {
    Object.assign(r.titles.decisions[0], { disposition: 'screen-out', exclusionType: 'telemetry_only',
      titleQuote: 'Telemetry', reason: 'Explicit telemetry-only title' });
    r.details[0].status = 'excluded-title';
  }
  const resultBytes = bytes(r);
  const ledger = new Ledger(join(s.root, 'isolated-executor'));
  s.cleanup.push(() => ledger.close());
  s.config.activation.dispatch = true; s.config.limits.maxWorkers = 2;
  const profile = { organization: 'synthetic', project: 'synthetic', repository: 'synthetic', initMode: 'lite' };
  const caseContract = { cases: [], scenarios: [], commands: [] };
  const selection = { taskId: batch.id, repoId: 'synthetic', role: 'filter', suiteId: 'source-analysis',
    profileId: 'synthetic', qualificationId: 'synthetic-qualification', qualificationSha256: '',
    sourceRevision, targetRef: 'refs/heads/main', payloadSha256: batch.payloadSha256,
    analysisPayloadSha256: batch.analysisPayloadSha256, instructionsSha256: hash(s.request.instructions),
    resultKind: 'analysis', allowPush: false, dispatchAllowed: true, maxExecutionSeconds: 600,
    allowedPaths: [], forbiddenPaths: [], caseContract };
  const q = { status: 'qualified', binding: {
    repoId: selection.repoId, role: selection.role, suiteId: selection.suiteId, profileId: selection.profileId,
    profileSha256: hash(json(profile)), sourceRevision, targetRef: selection.targetRef,
    instructionsSha256: selection.instructionsSha256, caseContractSha256: hash(json(caseContract))
  }, runtime: { modelId: s.config.filterBatching.model, tokenizerId: s.config.filterBatching.tokenizer,
    contextTokens: 1000000, maxOutputTokens: 10000 },
  expiresAt: new Date(Date.now() + 3600000).toISOString(), evidenceRef: 'synthetic:offline-only' };
  selection.captureVerification = { protocol: captureVerificationProtocol, verifierSha256,
    pipelineDefinitionId: 'synthetic-definition', stepName: 'SyntheticCaptureGate',
    pipelineSourceRevision: sourceRevision, bootstrapSha256: hash('synthetic bootstrap') };
  if (mode.startsWith('digest-') && mode !== 'digest-unqualified') {
    selection.captureVerification.inputEvidenceKind = 'source-bound-stdin-digest-v1';
    selection.captureVerification.agentProfileSha256 = hash('synthetic reader profile');
    selection.captureVerification.sourceAttestationStepName = 'AgencyFilterSourceAttestation';
  }
  q.binding.captureVerification = selection.captureVerification;
  const localPolicy = { id: 'local-readonly-filter-v1', approvedBy: 'synthetic-user',
    approvedAt: now(), approvalRef: 'synthetic:explicit-policy-approval' };
  if (mode === 'local-policy') {
    delete selection.captureVerification;
    delete q.binding.captureVerification;
    selection.analysisPolicy = localPolicy;
    q.binding.analysisPolicy = localPolicy;
  }
  selection.qualificationSha256 = hash(json(q)); ledger.qualify(selection.qualificationId, q);
  s.config.agency = { profiles: { synthetic: profile }, selections: [selection], budgetId: 'synthetic-filter-run',
    maxRequests: 1, maxConcurrent: 2, maxDraftPullRequests: 0, maxExecutionSeconds: 600,
    preflightMaxAgeSeconds: 300, monitorOwner: 'synthetic-owner', monitorCadenceSeconds: 60 };
  const wire = { organization: profile.organization, project: profile.project, repository: profile.repository,
    targetBranch: 'main', prompt: batch.payload,
    options: { allowPush: false, pullRequest: { create: false, publish: false } }, metadata: { initMode: 'lite' } };
  if (mode === 'local-policy') wire.options.branch = { createSourceBranch: false };
  if (selection.captureVerification?.inputEvidenceKind) {
    Object.assign(wire, { sourceBranch: 'refs/heads/main', targetBranch: 'refs/heads/main',
      agent: { name: 'filter-evidence-reader', type: 'Repo' }, metadata: agencyFilterRunnerMetadata(selection) });
    wire.options.branch = { createSourceBranch: false };
  }
  const request = json(wire);
  const reservation = { request, requestSha256: hash(request),
    preflight: { repoId: selection.repoId, targetRef: selection.targetRef, sourceRevision,
      observedAt: now(), requestSha256: hash(request) },
    tokenBudget: { payloadSha256: batch.payloadSha256, modelId: q.runtime.modelId,
      tokenizerId: q.runtime.tokenizerId, inputTokens: batch.tokenReceipt.tokens } };
  if (mode === 'local-policy') {
    const missingSelection = structuredClone(s.config); missingSelection.agency.selections = [];
    assert.throws(() => reserveAgencyRequest(missingSelection, ledger, batch.id, reservation, manifest),
      /no explicit Agency selection/);
    for (const value of [undefined, true]) {
      const altered = JSON.parse(request);
      if (value === undefined) delete altered.options.branch;
      else altered.options.branch.createSourceBranch = value;
      const invalid = { ...reservation, request: json(altered), requestSha256: hash(json(altered)) };
      assert.throws(() => reserveAgencyRequest(s.config, ledger, batch.id, invalid, manifest),
        /shape|disable source branch/);
    }
    assert.throws(() => reserveAgencyRequest(s.config, ledger, batch.id, reservation), /Invalid batch manifest/);
    const changed = structuredClone(manifest); changed.batches[0].payload += ' ';
    assert.throws(() => reserveAgencyRequest(s.config, ledger, batch.id, reservation, changed), /payload/);
  }
  reserveAgencyRequest(s.config, ledger, batch.id, reservation, manifest);
  recordAgencySubmission(ledger, batch.id, { operation: 'jobs-create', state: 'accepted',
    requestSha256: hash(request), jobId: 'synthetic-job', httpStatus: 202, observedAt: now() });
  const validate = data => {
    const checked = checkFilterBatchResult(s.config, manifest, JSON.parse(data));
    return Object.fromEntries(['state', 'payloadSha256', 'resultSha256', 'validator'].map(k => [k, checked[k]]));
  };
  const partial = structuredClone(r); partial.status = 'partial';
  assert.throws(() => recordAgencyAnalysisCheck(ledger, batch.id, bytes(partial), validate), /complete result/);
  if (['local-policy', 'valid', 'digest-valid'].includes(mode)) {
    for (const changed of [{ sourceRevision: 'b'.repeat(40) }, { repository: 'uninspected-repository' }]) {
      const invalid = structuredClone(r); Object.assign(invalid.candidates[0], changed);
      assert.equal(checkFilterBatchResult(s.config, manifest, invalid).state, 'checked-not-qualified');
      assert.throws(() => recordAgencyAnalysisCheck(ledger, batch.id, bytes(invalid), validate),
        /execution repository and source revision/);
      assert.equal(ledger.db.prepare(
        "SELECT body FROM agency_receipts WHERE task_id=? AND kind='analysis-check'").get(batch.id), undefined);
    }
  }
  const check = recordAgencyAnalysisCheck(ledger, batch.id, resultBytes, validate);
  assert.equal(check.payloadSha256, batch.analysisPayloadSha256);
  const refs = [{ ref: 'job-local:synthetic-job:derived-receipt', sha256: hash('synthetic proof') }];
  if (!['missing', 'all-excluded', 'local-policy'].includes(mode)) {
    const inspect = ({ input }) => {
      if (mode === 'valid') {
        const noncanonical = spawnSync(globalThis.process.execPath, [verifierPath, checkout], {
          input: bytes(input), encoding: 'utf8', maxBuffer: 1024 * 1024
        });
        assert.equal(noncanonical.status, 1);
        assert.equal(noncanonical.stdout, '');
        assert.match(noncanonical.stderr, /exact json-stringify-v1 serialization/);
      }
      const process = spawnSync(globalThis.process.execPath, [verifierPath, checkout], {
        input: json(input), encoding: 'utf8', maxBuffer: 1024 * 1024
      });
      if (mode === 'changed-module') {
        assert.equal(process.status, 1);
        assert.equal(process.stdout, '');
        assert.match(process.stderr, /Executed verifier bytes differ/);
        throw new Error('Observed standalone helper failed its pinned executable hash check');
      }
      assert.equal(process.status, 0, process.stderr);
      const actual = JSON.parse(process.stdout);
      assert.deepEqual(actual, verifyFilterCaptureInput(input, actual.source));
      const execution = { executionKind: 'pipeline-step', jobId: 'synthetic-job',
        executionId: '11111111-2222-4333-8444-555555555555',
        pipeline: { buildId: 'synthetic-build', definitionId: 'synthetic-definition', stepName: 'SyntheticCaptureGate',
          sourceRevision, bootstrapSha256: hash('synthetic bootstrap'),
          state: 'completed', result: 'succeeded', log: { id: 'synthetic-log', sha256: hash(process.stdout) } },
        verifierSha256, inputSerialization: 'json-stringify-v1', stdin: json(input),
        inputSha256: hash(json(input)), exitCode: process.status, stdout: process.stdout, evidenceRefs: refs };
      if (mode === 'wrong-job') execution.jobId = 'other-job';
      if (mode === 'invalid-execution-id') execution.executionId = 'model-tool-call-id';
      if (mode === 'wrong-input') execution.inputSha256 = '0'.repeat(64);
      if (mode === 'wrong-verifier') execution.verifierSha256 = '0'.repeat(64);
      if (mode === 'failed') execution.exitCode = 1;
      if (mode === 'wrong-step') execution.pipeline.stepName = 'OtherStep';
      if (mode === 'wrong-definition') execution.pipeline.definitionId = 'other-definition';
      if (mode === 'wrong-pipeline-source') execution.pipeline.sourceRevision = 'b'.repeat(40);
      if (mode === 'wrong-bootstrap') execution.pipeline.bootstrapSha256 = '0'.repeat(64);
      if (mode === 'wrong-build') execution.pipeline.buildId = 'other-build';
      if (mode === 'model-prose') execution.executionKind = 'model-final-response';
      if (mode === 'wrong-serialization') {
        execution.stdin = bytes(input); execution.inputSha256 = hash(execution.stdin);
      }
      if (mode === 'wrong-source') actual.source.finalRevision = 'b'.repeat(40);
      if (mode === 'wrong-length') actual.captures[0].byteLength++;
      if (mode === 'missing-capture') actual.captures = [];
      if (['wrong-source', 'wrong-length', 'missing-capture'].includes(mode)) execution.stdout = bytes(actual);
      if (mode.startsWith('digest-')) {
        const envelope = { format: 'agency-filter-capture-execution-v1', jobId: execution.jobId,
          executionKind: execution.executionKind, executionId: execution.executionId,
          pipeline: { buildId: execution.pipeline.buildId, definitionId: execution.pipeline.definitionId,
            sourceRevision, bootstrapSha256: execution.pipeline.bootstrapSha256, stepName: execution.pipeline.stepName },
          verifierSha256, inputSerialization: execution.inputSerialization, inputSha256: execution.inputSha256,
          inputEvidenceKind: 'source-bound-stdin-digest-v1',
          stdinByteLength: Buffer.byteLength(json(input), 'utf8'), exitCode: execution.exitCode, stdout: execution.stdout };
        if (mode === 'digest-wrong-hash') envelope.inputSha256 = '0'.repeat(64);
        if (mode === 'digest-wrong-byte-length') envelope.stdinByteLength++;
        if (mode === 'digest-wrong-stdout-hash') {
          actual.inputSha256 = '0'.repeat(64); envelope.stdout = bytes(actual);
        }
        return inspectAgencyCaptureLog({
          jobId: execution.jobId,
          pipeline: { buildId: execution.pipeline.buildId, definitionId: execution.pipeline.definitionId, sourceRevision },
          step: { executionId: execution.executionId, stepName: execution.pipeline.stepName,
            state: 'completed', result: 'succeeded', logId: 'synthetic-log' },
          logText: `AGENCY_FILTER_CAPTURE_RECEIPT_V1 ${json(envelope)}\n`, evidenceRefs: refs
        });
      }
      return execution;
    };
    if (['valid', 'partial-cohort', 'delivered-module', 'digest-valid', 'digest-publication-unknown', 'wrong-build'].includes(mode) ||
      mode.startsWith('digest-source-')) {
      const captureCheck = recordAgencyCaptureCheck(ledger, batch.id, inspect);
      assert.equal(captureCheck.captures.length, batch.memberIds.length);
      assert.equal(captureCheck.semanticReadingProven, false);
      if (mode === 'digest-valid') {
        assert.equal(captureCheck.inputEvidenceKind, 'source-bound-stdin-digest-v1');
        assert.equal(Object.hasOwn(captureCheck, 'stdin'), false);
      }
      assert.deepEqual(recordAgencyCaptureCheck(ledger, batch.id, inspect), captureCheck);
    } else assert.throws(() => recordAgencyCaptureCheck(ledger, batch.id, inspect),
      mode === 'changed-module' ? /Observed standalone helper failed its pinned executable hash check/ : undefined);
  }
  if (selection.captureVerification?.inputEvidenceKind && mode !== 'digest-source-missing') {
    const sourceEnvelope = { format: 'agency-filter-source-execution-v1', jobId: 'synthetic-job',
      executionKind: 'pipeline-step', executionId: '11111111-2222-4333-8444-666666666666',
      pipeline: { buildId: mode === 'digest-source-build' ? 'other-build' : 'synthetic-build',
        definitionId: 'synthetic-definition', sourceRevision, bootstrapSha256: hash('synthetic bootstrap'),
        stepName: mode === 'digest-source-preflight' ? 'SyntheticCaptureGate' : 'AgencyFilterSourceAttestation' },
      source: { repoId: selection.repoId, targetRef: selection.targetRef, revision: sourceRevision, status: '' } };
    if (mode === 'digest-source-dirty') sourceEnvelope.source.status = '?? unexpected.txt\n';
    if (mode === 'digest-source-revision') sourceEnvelope.source.revision = 'b'.repeat(40);
    const observed = { jobId: sourceEnvelope.jobId,
      pipeline: { buildId: sourceEnvelope.pipeline.buildId, definitionId: 'synthetic-definition', sourceRevision },
      step: { executionId: sourceEnvelope.executionId, stepName: sourceEnvelope.pipeline.stepName,
        state: 'completed', result: mode === 'digest-source-failed' ? 'failed' : 'succeeded', logId: 'source-log' },
      logText: `AGENCY_FILTER_SOURCE_RECEIPT_V1 ${json(sourceEnvelope)}\n`, evidenceRefs: refs };
    const inspect = () => inspectAgencySourceLog(observed);
    if (['digest-source-dirty', 'digest-source-revision', 'digest-source-preflight', 'digest-source-failed'].includes(mode))
      assert.throws(() => recordAgencySourceCheck(ledger, batch.id, inspect), /Post-analysis source|Observed worker pipeline|does not match/);
    else {
      const sourceCheck = recordAgencySourceCheck(ledger, batch.id, inspect);
      assert.deepEqual(recordAgencySourceCheck(ledger, batch.id, inspect), sourceCheck);
    }
  }
  const terminalInput = { requestSha256: hash(request),
    jobId: 'synthetic-job', observedAt: now(), provider: { state: 'Completed', result: 'Success' },
    pipeline: { id: 'synthetic-build', state: 'completed', result: 'succeeded' },
    runtime: { profileId: selection.profileId, instructionsSha256: selection.instructionsSha256,
      modelId: q.runtime.modelId, tokenizerId: q.runtime.tokenizerId },
    source: { repoId: selection.repoId, targetRef: selection.targetRef, baseRevision: sourceRevision,
      checkoutRevision: sourceRevision, outputRevision: sourceRevision, testedRevision: null,
      commitParents: [], changedPaths: [], unchangedDuringValidation: null, evidenceRefs: refs },
    inspection: { approved: true, evidenceRefs: refs },
    publication: ['digest-publication-unknown', 'local-policy'].includes(mode)
      ? { pushPerformed: null, createdPullRequests: null, otherPullRequestsModified: null, merged: null, pullRequest: null }
      : { pushPerformed: false, createdPullRequests: 0, otherPullRequestsModified: false, merged: false, pullRequest: null },
    validation: null,
    analysis: { payloadSha256: batch.analysisPayloadSha256, resultSha256: hash(resultBytes),
      validator: check.validator, membershipValidated: true, evidenceRefs: refs } };
  if (mode === 'local-policy') {
    terminalInput.source.outputRevision = null;
    terminalInput.source.changedPaths = null;
    terminalInput.source.commitParents = null;
  }
  const verdict = reconcileAgencyResult(ledger, batch.id, terminalInput);
  const success = ['local-policy', 'valid', 'partial-cohort', 'delivered-module', 'digest-valid', 'all-excluded'].includes(mode);
  assert.equal(verdict.state, success ? 'completed' : 'blocked');
  assert.equal(verdict.analysisPassed, success || mode === 'digest-publication-unknown' || mode.startsWith('digest-source-'));
  if (mode === 'digest-publication-unknown') {
    assert.equal(verdict.publicationPassed, false);
    assert.ok(verdict.reasons.some(r => r.includes('publication effects are unknown')));
  } else if (mode.startsWith('digest-source-'))
    assert.ok(verdict.reasons.some(r => r.includes('inspected post-analysis source proof')));
  else if (!success) assert.ok(verdict.reasons.some(r => r.includes('inspected worker capture-verifier execution')));
  assert.equal(verdict.validationQualified, false);
  if (['missing', 'local-policy'].includes(mode)) {
    const { evaluateFilterExecution, recordFilterExecutionEvaluation } = await import('../src/filter-execution.js');
    const original = ledger.db.prepare("SELECT body FROM agency_receipts WHERE task_id=? AND kind='terminal'").get(batch.id).body;
    const prospectiveInput = structuredClone(terminalInput);
    prospectiveInput.publication = null;
    const evaluation = recordFilterExecutionEvaluation(s.config, ledger, manifest, batch.id,
      resultBytes, prospectiveInput, localPolicy);
    assert.equal(evaluation.verdict.state, 'completed');
    assert.equal(evaluation.verdict.publicationPassed, null);
    assert.equal(evaluation.verdict.publicationPolicyPassed, true);
    assert.equal(evaluation.historicalCompliance, false);
    assert.ok(evaluation.verdict.assuranceLimitations.length);
    assert.deepEqual(recordFilterExecutionEvaluation(s.config, ledger, manifest, batch.id,
      resultBytes, prospectiveInput, localPolicy), evaluation);
    assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [resultBytes], localPolicy).state,
      'complete-held');
    assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [], localPolicy).state, 'blocked');
    for (const changed of [{ sourceRevision: 'b'.repeat(40) }, { repository: 'uninspected-repository' }]) {
      const invalid = structuredClone(r); Object.assign(invalid.candidates[0] ??= candidate(r), changed);
      assert.throws(() => evaluateFilterExecution(s.config, ledger, manifest, batch.id,
        bytes(invalid), prospectiveInput, localPolicy), /Candidate repository or source revision/);
    }
    for (const mutate of [
      i => { i.provider.result = 'Failure'; },
      i => { i.pipeline.result = 'failed'; },
      i => { i.source.checkoutRevision = 'b'.repeat(40); },
      i => { i.source.outputRevision = 'b'.repeat(40); },
      i => { i.source.changedPaths = ['test/changed.js']; },
      i => { i.analysis = null; },
      i => { i.analysis.resultSha256 = 'b'.repeat(64); },
      i => { i.publication = { pushPerformed: true, pullRequest: null,
        createdPullRequests: null, otherPullRequestsModified: null, merged: null }; },
      i => { i.publication = { pushPerformed: null, pullRequest: null,
        createdPullRequests: null, otherPullRequestsModified: null, merged: null, sourceBranchCreated: true }; }
    ]) {
      const invalid = structuredClone(prospectiveInput); mutate(invalid);
      assert.equal(evaluateFilterExecution(s.config, ledger, manifest, batch.id,
        resultBytes, invalid, localPolicy).verdict.state, 'blocked');
    }
    for (const mutate of [
      i => { i.jobId = 'other-job'; },
      i => { i.requestSha256 = 'b'.repeat(64); },
      i => { i.source.evidenceRefs = []; }
    ]) {
      const invalid = structuredClone(prospectiveInput); mutate(invalid);
      assert.throws(() => evaluateFilterExecution(s.config, ledger, manifest, batch.id,
        resultBytes, invalid, localPolicy));
    }
    const missing = structuredClone(r); missing.details = [];
    assert.throws(() => evaluateFilterExecution(s.config, ledger, manifest, batch.id,
      bytes(missing), prospectiveInput, localPolicy));
    const wrong = structuredClone(r); wrong.payloadSha256 = 'b'.repeat(64);
    assert.throws(() => evaluateFilterExecution(s.config, ledger, manifest, batch.id,
      bytes(wrong), prospectiveInput, localPolicy));
    assert.throws(() => evaluateFilterExecution(s.config, ledger, manifest, batch.id,
      json(r), prospectiveInput, localPolicy), /exact original/);
    assert.equal(ledger.db.prepare("SELECT body FROM agency_receipts WHERE task_id=? AND kind='terminal'").get(batch.id).body,
      original);
  }
  assert.equal(consolidateFilterBatches(s.config, manifest, [r]).state,
    mode === 'partial-cohort' ? 'partial' : 'complete-held');
  ledger.db.exec('PRAGMA query_only=ON');
  try {
    const cohort = reconcileFilterExecutionCohort(s.config, ledger, manifest, [resultBytes]);
    const complete = success && mode !== 'partial-cohort';
    assert.equal(cohort.state, complete ? 'complete-held' : 'blocked');
    assert.equal(cohort.dispatchAllowed, false);
    assert.equal(cohort.sourceCoverageComplete, null);
    if (complete) assert.equal(cohort.consolidation.format, 'filter-consolidation-v1');
    else assert.equal(cohort.consolidation, null);
    if (mode === 'valid') {
      assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, []).state, 'blocked');
      const changedConfig = structuredClone(s.config);
      changedConfig.agency.selections[0].sourceRevision = 'b'.repeat(40);
      assert.equal(reconcileFilterExecutionCohort(changedConfig, ledger, manifest, [resultBytes]).state, 'blocked');
      assert.throws(() => reconcileFilterExecutionCohort(s.config, ledger, manifest, [json(r)]),
        /canonical membership check/);
    }
  } finally {
    ledger.db.exec('PRAGMA query_only=OFF');
  }
  if (mode === 'local-policy')
    await t.test('accepted FILTER analysis reaches source-bound declarative proposer execution offline',
      () => exerciseFilterProposer(s, ledger, checkout, git, manifest, r));
  if (mode === 'valid') {
    for (const [name, changed] of [
      ['source', { sourceRevision: 'b'.repeat(40) }],
      ['repository', { repository: 'uninspected-repository' }]
    ]) {
      const invalid = structuredClone(r); Object.assign(invalid.candidates[0], changed);
      const invalidBytes = bytes(invalid), invalidHash = hash(invalidBytes);
      const historical = new Ledger(join(s.root, `historical-${name}`));
      s.cleanup.push(() => historical.close());
      historical.qualify(selection.qualificationId, q);
      reserveAgencyRequest(s.config, historical, batch.id, reservation, manifest);
      for (const row of ledger.db.prepare('SELECT kind,body FROM agency_receipts WHERE task_id=?').all(batch.id)) {
        const receipt = JSON.parse(row.body);
        if (['analysis-check', 'capture-requirements'].includes(row.kind)) receipt.resultSha256 = invalidHash;
        if (row.kind === 'terminal') receipt.receipt.analysis.resultSha256 = invalidHash;
        historical.db.prepare('INSERT INTO agency_receipts VALUES(?,?,?)').run(batch.id, row.kind, json(receipt));
      }
      historical.db.exec('PRAGMA query_only=ON');
      const before = historical.db.prepare('SELECT kind,body FROM agency_receipts ORDER BY kind').all();
      const blocked = reconcileFilterExecutionCohort(s.config, historical, manifest, [invalidBytes]);
      assert.equal(blocked.state, 'blocked');
      assert.equal(blocked.consolidation, null);
      assert.match(blocked.batches[0].reasons[0], /Candidate repository or source revision/);
      assert.deepEqual(historical.db.prepare('SELECT kind,body FROM agency_receipts ORDER BY kind').all(), before);
    }
    const config = structuredClone(s.config);
    config.stateDirectory = join(s.root, 'must-not-initialize');
    const configPath = join(s.root, 'cli-config.json'), resultPath = join(s.root, 'cli-result.json');
    const pathsPath = join(s.root, 'cli-results.json');
    writeFileSync(configPath, bytes(config));
    writeFileSync(resultPath, resultBytes);
    writeFileSync(pathsPath, bytes([resultPath]));
    const ledgerPath = join(ledger.directory, 'ledger.sqlite');
    const before = ledger.db.prepare('SELECT kind,body FROM agency_receipts ORDER BY kind').all();
    const check = path => spawnSync(globalThis.process.execPath, ['src/cli.js', 'filter-execution-check',
      '--config', configPath, '--file', pathsPath, '--manifest', s.path, '--ledger', path], { encoding: 'utf8' });
    const complete = check(ledgerPath);
    assert.equal(complete.status, 0, complete.stderr);
    assert.equal(JSON.parse(complete.stdout).state, 'complete-held');
    writeFileSync(pathsPath, '[]');
    const incomplete = check(ledgerPath);
    assert.equal(incomplete.status, 2);
    assert.equal(JSON.parse(incomplete.stdout).state, 'blocked');
    const missingLedger = join(s.root, 'missing-ledger.sqlite');
    assert.equal(check(missingLedger).status, 1);
    assert.equal(existsSync(missingLedger), false);
    assert.equal(existsSync(config.stateDirectory), false);
    assert.deepEqual(ledger.db.prepare('SELECT kind,body FROM agency_receipts ORDER BY kind').all(), before);
  }
  assert.throws(() => reserveAgencyRequest(s.config, ledger, batch.id, reservation, manifest), /already reserved/);
});

test('source-bound cohort inspection does not initialize Agency tables in an unstarted ledger', async t => {
  const s = setup(t), manifest = await prepared(s), ledger = new Ledger(join(s.root, 'empty-executor'));
  s.cleanup.push(() => ledger.close());
  ledger.db.exec('PRAGMA query_only=ON');
  const before = ledger.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'agency_%'").get().n;
  const cohort = reconcileFilterExecutionCohort(s.config, ledger, manifest, []);
  assert.equal(cohort.state, 'blocked');
  assert.equal(cohort.consolidation, null);
  assert.equal(ledger.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'agency_%'").get().n, before);
});
