import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, hash } from '../src/common.js';
import { appStatus, beginApp, openApp } from '../src/app-native.js';
import { evidenceEnvelope } from '../src/sources.js';
import { prepareFilterBatches, consolidateFilterBatches } from '../src/filter-batches.js';
import { exportE2eProof, checkE2eProof } from '../src/e2e-proof.js';

const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const write = (path, value) => writeFileSync(path, bytes(value));

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'state');
  config.statePolicy.accessApproved = true;
  config.activation.collect = true;
  config.limits.maxItems = config.dryRun.limits.maxItems;
  config.limits.maxCalls = config.dryRun.limits.maxCalls;
  beginApp(config, { runId: 'source', dryRun: true, provenance: 'synthetic' });
  const { ledger } = openApp(config, 'source');
  const evidence = evidenceEnvelope('ado', 'synthetic/issues', 1, '1',
    'https://example.invalid/issues/1', 'Synthetic issue',
    '2026-10-09T01:00:00Z');
  evidence.title = 'Synthetic issue';
  const stored = ledger.evidence(evidence, {
    id: 1, rev: 1, fields: evidence.fields, relations: evidence.links
  }, 'source:ado:created');
  const pass = {
    pass: 'ado:created', state: 'complete', evidenceCount: 1,
    examinedRecords: 1, readCalls: 1, provenance: 'authenticated-source',
    execution: 'delegated-source-adapter', identityVerified: true,
    coverage: 'Synthetic current source enumeration'
  };
  ledger.db.prepare('INSERT INTO app_passes VALUES(?,?,?)')
    .run('source', 'ado:created', JSON.stringify(pass));
  const ledgerPath = join(ledger.directory, 'ledger.sqlite');
  ledger.close();
  const sources = { format: 'stage2-sources-v1',
    sources: [{ ledgerPath, runId: 'source' }] };
  const sourcesPath = join(root, 'sources.json'); write(sourcesPath, sources);
  const verificationRef = join(root, 'verified.json');
  write(verificationRef, { synthetic: true });
  config.filterBatching = {
    approved: true, mode: 'verified', model: 'synthetic', profile: 'synthetic',
    tokenizer: 'synthetic-v1', verifiedBy: 'test',
    verifiedAt: '2026-10-12T00:00:00Z', verificationRef,
    verificationSha256: hash(readFileSync(verificationRef)),
    contextTokens: 1000, maxInputTokens: 900, maxPayloadBytes: 1000000,
    maxBatches: 2,
    reserves: {
      instructions: 30, sourceAnalysis: 10, output: 10, safety: 10,
      requestOverhead: 10
    },
    counter: {
      approved: true, executable: process.execPath,
      executableSha256: hash(readFileSync(process.execPath)), args: [],
      files: [], timeoutMs: 1000
    }
  };
  const request = {
    format: 'filter-batch-request-v1', sources: sources.sources,
    instructions: 'Review the complete synthetic record.',
    groups: [{ id: 'g1', memberIds: [stored.id], contextIds: [],
      reason: 'One independent record' }],
    groupingReview: {
      reviewer: 'test', reviewedAt: '2026-10-12T00:00:00Z',
      rationale: 'One independent record'
    },
    sharing: { audience: 'synthetic', approvalRef: 'test', materials: [] }
  };
  const counter = async (_config, input) => ({
    sha256: input.sha256, model: input.model, tokenizer: input.tokenizer, tokens: 20
  });
  const corpusHashes = [
    hash(bytes(stored)), stored.capture.sha256,
    hash(request.instructions),
    hash(bytes([{ runId: 'source', coverage: [pass] }]))
  ];
  request.sharing.materials = [...new Set(corpusHashes)].map(sha256 => ({
    sha256, eligibility: 'approved', restrictions: ['synthetic-only']
  }));
  const manifestPath = join(root, 'manifest.json');
  const prepared = await prepareFilterBatches(config, request, manifestPath, counter);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const batch = manifest.batches[0];
  const payload = JSON.parse(JSON.parse(batch.payload).payload);
  const result = {
    format: 'filter-batch-result-v1', cohortId: manifest.cohortId,
    batchId: batch.id, payloadSha256: batch.analysisPayloadSha256,
    status: 'complete',
    titles: {
      format: 'filter-title-decisions-v1', indexSha256: batch.indexSha256,
      reviewer: 'test-filter', reviewedAt: '2026-10-12T00:00:00Z',
      decisions: payload.index.entries.map(entry => ({
        evidenceId: entry.evidenceId, source: entry.source,
        captureSha256: entry.captureSha256, disposition: 'needs-details',
        exclusionType: null, reason: 'Reviewed', titleQuote: null
      }))
    },
    details: payload.index.entries.map(entry => ({
      evidenceId: entry.evidenceId, recordSha256: entry.recordSha256,
      captureSha256: entry.captureSha256, status: 'reviewed',
      reason: 'Complete review'
    })),
    candidates: [{
      id: 'candidate-1', evidenceIds: [stored.id], repository: 'office-agent',
      sourceRevision: 'a'.repeat(40), layer: 'integration',
      missingAssertion: 'Plugin skills do not trigger a user-skill bypass',
      existingCoverage: ['Binary router policy unit tests'],
      harness: 'Office Agent integration harness', coverageStatus: 'gap',
      blockers: [], priority: 80, confidence: 0.9,
      rationale: 'Synthetic source-bound candidate'
    }]
  };
  const resultPath = join(root, 'result.json'); write(resultPath, result);
  const consolidated = consolidateFilterBatches(config, manifest, [result]);
  assert.equal(consolidated.state, 'complete-held');
  const workerResult = {
    recordType: 'workerResult', schemaVersion: '1.0', id: 'worker-result-1',
    assignmentId: 'assignment-1', attemptId: 'attempt-1',
    reportedAt: '2026-10-12T01:00:00Z',
    outcome: 'draft-pr-validated', findings: 'Synthetic validated change',
    evidenceIds: [stored.id], sourceRevision: 'b'.repeat(40),
    draftPR: {
      url: 'https://example.invalid/pullrequest/1', isDraft: true,
      headRevision: 'b'.repeat(40)
    },
    validation: [{
      gateId: 'test', sourceRevision: 'b'.repeat(40),
      commandOrRunUrl: 'npm test', status: 'passed',
      artifactRefs: ['synthetic:test'], owner: 'controller',
      nextCheckAt: null, attemptCount: 1, blockedReason: null
    }],
    validationAttempts: [{
      round: 0, sourceRevision: 'b'.repeat(40),
      validation: [{
        gateId: 'test', sourceRevision: 'b'.repeat(40),
        commandOrRunUrl: 'npm test', status: 'passed',
        artifactRefs: ['synthetic:test'], owner: 'controller',
        nextCheckAt: null, attemptCount: 1, blockedReason: null
      }]
    }],
    toolUsage: {
      limit: 10, used: 2, remaining: 8,
      byTool: {
        pilot_list: 1, pilot_search: 0, pilot_read: 0, pilot_write: 1,
        pilot_finish: 0
      },
      rounds: [{ round: 0, used: 2, cumulativeUsed: 2, status: 'completed' }]
    },
    skillExecution: {
      bindingId: 'oa', capability: 'integration-test-authoring',
      skillPath: '.github/skills/integration-test-authoring/SKILL.md',
      skillRevision: 'a'.repeat(64), status: 'succeeded',
      classification: 'extend existing test',
      changedFiles: ['tests/example.test.ts'],
      testsAddedOrUpdated: ['tests/example.test.ts'],
      behaviorCardsAddedOrUpdated: [], unknowns: [],
      needsHumanDecision: false
    },
    blocker: null, nextAction: 'Await review'
  };
  const controllerPath = join(root, 'controller.json');
  write(controllerPath, {
    state: 'draft-pr-validated', candidate: consolidated.selected,
    result: workerResult
  });
  beginApp(config, {
    runId: 'synthetic-e2e', dryRun: false, provenance: 'app-tool'
  });
  const { ledger: appLedger } = openApp(config, 'synthetic-e2e', false);
  appLedger.db.prepare('INSERT INTO app_workers VALUES(?,?)').run(
    workerResult.assignmentId,
    JSON.stringify({
      id: workerResult.assignmentId,
      runId: 'synthetic-e2e',
      state: 'uncertain',
      result: {
        outcome: 'draft-reported',
        evidenceRef: `sha256:${hash(readFileSync(controllerPath))}`
      }
    })
  );
  const appSummary = appStatus(appLedger, 'synthetic-e2e');
  appLedger.close();
  const proofRequest = {
    format: 'e2e-proof-request-v2', runId: 'synthetic-e2e',
    collection: { sourcesPath },
    filter: { manifestPath, resultPaths: [resultPath] },
    controller: { resultPath: controllerPath },
    appRun: {
      summaryPath: appSummary.summaryPath,
      assignmentId: workerResult.assignmentId
    }
  };
  return { config, root, proofRequest, prepared };
}

test('exports and rechecks a sanitized source-bound Draft PR proof', async t => {
  const s = await fixture(t);
  const bundle = join(s.root, 'bundle');
  const exported = exportE2eProof(s.config, s.proofRequest, bundle);
  assert.equal(exported.state, 'verified-draft-pr-e2e-proof');
  assert.equal(exported.artifactCount, 8);
  assert.doesNotMatch(readFileSync(join(bundle, '01-collection.json'), 'utf8'),
    /Synthetic issue|contentBase64|Users[\\/]/);
  assert.equal(checkE2eProof(s.config, s.proofRequest, bundle).state,
    'verified-draft-pr-e2e-proof');
});

test('retains version 1 compatibility for historical proof bundles', async t => {
  const s = await fixture(t);
  const request = structuredClone(s.proofRequest);
  request.format = 'e2e-proof-request-v1';
  delete request.appRun;
  const bundle = join(s.root, 'bundle-v1');
  assert.equal(exportE2eProof(s.config, request, bundle).state,
    'verified-draft-pr-e2e-proof');
  assert.equal(checkE2eProof(s.config, request, bundle).state,
    'verified-draft-pr-e2e-proof');
});

test('rejects changed private controller evidence after export', async t => {
  const s = await fixture(t);
  const bundle = join(s.root, 'bundle');
  exportE2eProof(s.config, s.proofRequest, bundle);
  const controller = JSON.parse(readFileSync(s.proofRequest.controller.resultPath, 'utf8'));
  controller.result.findings = 'Changed after export';
  writeFileSync(s.proofRequest.controller.resultPath, bytes(controller));
  assert.throws(() => checkE2eProof(s.config, s.proofRequest, bundle),
    /not content-bound/);
});

test('rejects an app-native summary that is not content-bound to the controller result', async t => {
  const s = await fixture(t);
  const summary = JSON.parse(readFileSync(s.proofRequest.appRun.summaryPath, 'utf8'));
  summary.workers[0].result.evidenceRef = `sha256:${'0'.repeat(64)}`;
  writeFileSync(s.proofRequest.appRun.summaryPath, bytes(summary));
  assert.throws(() => exportE2eProof(s.config, s.proofRequest, join(s.root, 'bundle')),
    /not content-bound/);
});
