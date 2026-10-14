import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exclusions, hash, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { loadFilterCorpus } from '../src/filter.js';
import {
  prepareFilterBatches, checkFilterBatchResult, consolidateFilterBatches
} from '../src/filter-batches.js';
import { prepareFilterProposerHandoff } from '../src/filter-handoff.js';
import { prepareReviewedHandoff, acceptReviewedHandoff } from '../src/reviewed-handoff.js';
import { qualifyRepositorySkill, skillQualificationId } from '../src/repository-skills.js';
import { command, runValidation } from '../src/workers.js';

const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const sha = value => hash(bytes(value));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const invariant = 'Active items retain source order and respect the requested limit';
const skillPath = '.github/skills/demo-integration/SKILL.md';
const testPath = 'test/selection.test.cjs';

async function fixtureRepository(config, root) {
  const reference = join(root, 'fixture-repository');
  mkdirSync(join(reference, '.github', 'skills', 'demo-integration'), { recursive: true });
  mkdirSync(join(reference, 'src'));
  mkdirSync(join(reference, 'test'));
  writeFileSync(join(reference, skillPath),
    '# Synthetic demo skill\nAdd focused coverage without modifying implementation or existing tests.\n');
  writeFileSync(join(reference, 'src', 'selection.cjs'),
    'exports.select = (items, limit) => items.filter(item => item.active).slice(0, limit);\n');
  writeFileSync(join(reference, 'test', 'baseline.test.cjs'), [
    "const { test } = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { select } = require('../src/selection.cjs');",
    "test('empty input', () => assert.deepEqual(select([], 2), []));", ''
  ].join('\n'));
  const git = async args => (await command('git', args, reference)).stdout.trim();
  await git(['init', '--quiet']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Synthetic demo', '-c', 'user.email=demo@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic demo source',
    '-m', 'Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>']);
  // No remote is created or contacted. This path cannot lead to a live host.
  const remote = join(root, 'publication-disabled.git');
  await git(['remote', 'add', 'origin', remote]);
  const repo = {
    id: 'demo', projectId: 'synthetic', owner: 'synthetic-demo',
    routingApproved: true, routingRules: ['Synthetic demo only'],
    referenceCheckout: reference, remote, baseRef: 'HEAD', qualificationRefresh: 'local',
    allowedWritePrefixes: ['test'], allowedWriteFiles: [],
    commitIdentity: { name: 'Synthetic demo', email: 'demo@example.invalid' },
    validationGates: [
      { id: 'behavior', approved: true, executable: process.execPath,
        args: ['--test', '--test-reporter=tap', join('test', 'baseline.test.cjs'),
          join('test', 'selection.test.cjs')], timeoutMs: 30000 },
      { id: 'syntax', approved: true, executable: process.execPath,
        args: ['--check', join('test', 'selection.test.cjs')], timeoutMs: 30000 }
    ],
    skillBindings: [{
      id: 'demo-integration', capability: 'integration-test-authoring', skillPath,
      enabled: true, qualification: 'qualified', requestedOutcomes: ['add-or-update-tests'],
      sideEffects: { commit: true, push: true, createDraftPR: true }
    }]
  };
  config.repositories = [repo];
  const qualification = await qualifyRepositorySkill(config, repo.id, 'integration-test-authoring');
  return { repo, qualification, git };
}

async function filterStage(config, sources, root, sourceRevision) {
  const corpus = loadFilterCorpus(config, { format: 'stage2-sources-v1', sources });
  assert.equal(corpus.evidence.length, 3);
  assert.ok(corpus.evidence.every(record => record.source.provenance === 'synthetic'));
  const sourceCoverageComplete = corpus.coverage.every(source =>
    source.coverage.every(pass => pass.state === 'complete'));
  assert.equal(sourceCoverageComplete, false);
  const verificationRef = join(root, 'synthetic-token-budget.json');
  writeFileSync(verificationRef, bytes({ syntheticOnly: true,
    method: '100 units per fixture group plus 20 per payload; not provider token accuracy' }));
  config.filterBatching = {
    approved: true, mode: 'verified', model: 'synthetic', profile: 'synthetic',
    tokenizer: 'synthetic-group-counter', verifiedBy: 'synthetic-demo', verifiedAt: now(),
    verificationRef, verificationSha256: hash(readFileSync(verificationRef)),
    contextTokens: 1000, maxInputTokens: 150, maxPayloadBytes: 1000000, maxBatches: 2,
    reserves: { instructions: 10, sourceAnalysis: 20, output: 100, safety: 10, requestOverhead: 5 }
  };
  const request = {
    format: 'filter-batch-request-v1', sources,
    instructions: 'Synthetic fixture review only; preserve full records and report source-bound coverage gaps.',
    groups: ['ado', 'workiq'].map(kind => ({
      id: kind, memberIds: corpus.evidence.filter(e => e.source.kind === kind).map(e => e.id),
      contextIds: [], reason: `Keep all synthetic ${kind} context together`
    })),
    groupingReview: { reviewer: 'synthetic-demo', reviewedAt: now(), rationale: 'Two intact source groups' },
    sharing: { audience: 'offline-synthetic-demo', approvalRef: 'synthetic-only', materials: [] }
  };
  request.sharing.materials = [...new Set([
    ...corpus.evidence.map(sha), ...corpus.captures.map(c => c.sha256),
    ...corpus.contexts.map(c => c.sha256), hash(request.instructions),
    sha(corpus.coverage.map(({ runId, coverage }) => ({ runId, coverage })))
  ])].map(sha256 => ({ sha256, eligibility: 'approved', restrictions: ['synthetic-only-no-submission'] }));
  const counter = async (_config, input) => ({
    sha256: input.sha256, model: input.model, tokenizer: input.tokenizer,
    tokens: input.text.startsWith('{') ? JSON.parse(JSON.parse(input.text).payload).groups.length * 100 + 20 : 5
  });
  const manifestPath = join(root, 'filter-manifest.json');
  await assert.rejects(prepareFilterBatches(config,
    { ...request, sharing: { ...request.sharing, materials: [] } },
    manifestPath, counter), { code: 'blocked-sharing' });
  const limited = structuredClone(config);
  limited.filterBatching.maxBatches = 1;
  await assert.rejects(prepareFilterBatches(limited, request, manifestPath, counter), { code: 'blocked-budget' });
  await prepareFilterBatches(config, request, manifestPath, counter);
  const manifest = read(manifestPath);
  assert.equal(manifest.batches.length, 2);
  assert.equal(manifest.inventory.length, 3);
  assert.deepEqual(manifest.batches.flatMap(b => b.memberIds).sort(), corpus.evidence.map(e => e.id).sort());
  const results = manifest.batches.map(batch => {
    const payload = JSON.parse(JSON.parse(batch.payload).payload);
    return {
      format: 'filter-batch-result-v1', cohortId: manifest.cohortId, batchId: batch.id,
      payloadSha256: batch.analysisPayloadSha256, status: 'complete',
      titles: {
        format: 'filter-title-decisions-v1', indexSha256: batch.indexSha256,
        reviewer: 'synthetic-demo', reviewedAt: now(),
        decisions: payload.index.entries.map(e => ({
          evidenceId: e.evidenceId, source: e.source, captureSha256: e.captureSha256,
          disposition: e.title ? 'needs-details' : 'no-title', exclusionType: null,
          reason: 'Fixture full-record review', titleQuote: null
        }))
      },
      details: payload.index.entries.map(e => ({
        evidenceId: e.evidenceId, recordSha256: e.recordSha256, captureSha256: e.captureSha256,
        status: 'reviewed', reason: 'Deterministic fixture analysis, not model semantic attestation'
      })),
      candidates: [80, 40].map(priority => ({
        id: `candidate-${priority}`, evidenceIds: batch.memberIds, repository: 'demo', sourceRevision,
        layer: 'integration', missingAssertion: priority === 80 ? invariant : 'An empty limit returns no items',
        existingCoverage: ['test/baseline.test.cjs asserts empty input only'],
        harness: 'node:test against src/selection.cjs', coverageStatus: 'gap', blockers: [],
        priority, confidence: 0.9, rationale: 'Synthetic fixture source has only an empty-input assertion'
      }))
    };
  });
  for (const result of results) {
    assert.equal(checkFilterBatchResult(config, manifest, result).state, 'checked-not-qualified');
    const omitted = structuredClone(result);
    omitted.details.pop();
    assert.throws(() => checkFilterBatchResult(config, manifest, omitted), /Missing detail accounting/);
    assert.throws(() => checkFilterBatchResult(config, manifest,
      { ...result, payloadSha256: '0'.repeat(64) }), /Foreign\/stale batch result/);
  }
  const missing = consolidateFilterBatches(config, manifest, results.slice(0, 1));
  assert.equal(missing.state, 'partial'); assert.equal(missing.selected, null);
  const partialResults = structuredClone(results);
  partialResults[0].status = 'partial';
  assert.equal(consolidateFilterBatches(config, manifest, partialResults).selected, null);
  const changed = structuredClone(results[0]);
  changed.details[0].reason = 'Conflicting recorded analysis';
  const conflict = consolidateFilterBatches(config, manifest, [...results, changed]);
  assert.equal(conflict.state, 'partial'); assert.equal(conflict.selected, null);
  const noCandidate = consolidateFilterBatches(config, manifest, results.map(r => ({ ...r, candidates: [] })));
  assert.equal(noCandidate.state, 'complete-held'); assert.equal(noCandidate.selected, null);
  const consolidationPath = join(root, 'filter-consolidation.json');
  const consolidated = consolidateFilterBatches(config, manifest, [...results, results[0]], consolidationPath);
  assert.equal(consolidated.state, 'complete-held');
  assert.equal(consolidated.duplicates.length, 1);
  assert.equal(consolidated.ranking.length, 2);
  assert.equal(consolidated.selected.definition.missingAssertion, invariant);
  assert.equal(consolidated.selected.definition.priority, 80);
  assert.equal(consolidated.selected.evidenceIds.length, 3);
  assert.equal(consolidated.dispatchAllowed, false);
  assert.equal(consolidated.semanticAnalysisVerifiedByHelper, false);
  const resultPaths = results.map((result, i) => {
    const path = join(root, `filter-result-${i}.json`);
    writeFileSync(path, bytes(result)); return path;
  });
  return {
    selected: consolidated.selected, manifestPath, resultPaths,
    summary: {
      state: consolidated.state, batches: results.length, reviewedEvidence: manifest.inventory.length,
      rankedCandidates: consolidated.ranking.length, selectedInvariant: invariant,
      missingBatchBlocked: true, partialBatchBlocked: true, conflictingResultBlocked: true,
      stalePayloadRejected: true, incompleteDetailRejected: true, duplicateResultDeduplicated: true,
      missingSharingRejected: true, budgetOverflowRejected: true, noCandidateWithoutDispatch: true,
      sourceCoverageComplete, executionQualified: false, semanticAnalysisVerifiedByHelper: false,
      manifestPath, resultPaths, consolidationPath
    }
  };
}

function reviewedFixture(filter, scenario) {
  const candidate = filter.selected.definition;
  const id = `demo-${scenario}`;
  return {
    format: 'reviewed-handoff-v1', id, version: 1, reviewedAt: now(),
    source: { kind: 'fixture', provenance: 'synthetic', namespace: 'reviewed-handoff/demo',
      recordId: id, revision: '1' },
    evidence: {
      title: candidate.missingAssertion,
      summary: 'Explicit source-neutral fixture bridge; not release of the partial synthetic collection.',
      fields: {
        scenario, sourceEvidenceIds: filter.selected.evidenceIds,
        manifestSha256: hash(readFileSync(filter.manifestPath)),
        resultSha256: filter.resultPaths.map(path => hash(readFileSync(path))),
        candidate: filter.selected, publication: 'simulated-only'
      }
    },
    review: {
      method: 'agent-evidence-review', reviewer: 'synthetic-demo',
      observedBehavior: candidate.rationale, expectedBehavior: candidate.missingAssertion,
      hypotheses: ['The synthetic repository needs a focused behavior assertion'],
      counterEvidence: candidate.existingCoverage,
      classification: 'functional', defectConfirmation: 'unconfirmed',
      reportEligibility: 'included', handoffEligibility: 'eligible', exclusionsChecked: exclusions,
      exclusionReasons: [], rationale: candidate.rationale, confidence: candidate.confidence,
      repoIds: [candidate.repository], existingFixes: [],
      nextAction: `Add focused fixture coverage for: ${candidate.missingAssertion}`
    },
    planning: {
      improvement: { category: 'missing-test-coverage', theme: candidate.missingAssertion,
        rationale: candidate.rationale, priority: 'high',
        repoIds: [candidate.repository], capabilities: ['integration-test-authoring'] },
      testCoverage: { repoId: candidate.repository, capability: 'integration-test-authoring',
        sourceRevision: 'qualified-base', searchStatus: 'complete', existingTests: [],
        coverageGaps: [candidate.missingAssertion], unknowns: [], rationale: candidate.rationale },
      requestedOutcome: 'add-or-update-tests'
    }
  };
}

async function proposerScenario(config, fixture, filter, root, scenario) {
  config = structuredClone(config);
  config.stateDirectory = join(root, 'proposer', scenario);
  config.activation.dispatch = true;
  Object.assign(config.limits, {
    maxItems: 10, maxCalls: 10, maxWorkers: 1, maxAssignments: 1,
    workerMinutes: 1, workerMaxToolCalls: 10, maxAiCreditsPerSession: 1,
    maxValidationRepairRounds: 0, maxValidationInfrastructureRetries: 0
  });
  let ledger = new Ledger(config.stateDirectory);
  const counts = { authoring: 0, simulatedPush: 0, simulatedDraft: 0 };
  try {
    ledger.qualify(skillQualificationId('demo', 'demo-integration'), fixture.qualification);
    assert.throws(() => prepareFilterProposerHandoff(config, ledger, {
      format: 'filter-proposer-handoff-v1',
      filter: { manifestPath: filter.manifestPath, resultPaths: filter.resultPaths },
      routing: { capability: 'integration-test-authoring' }
    }), /authenticated non-synthetic evidence/);
    assert.equal(ledger.all('evidence').length, 0);
    assert.equal(ledger.status().jobs.length, 0);
    const receipt = reviewedFixture(filter, scenario);
    const options = { execute: true, authorizeSynthetic: true, authorizeCommit: true,
      authorizePush: true, authorizeDraftPR: true };
    for (const permission of ['authorizeSynthetic', 'authorizeCommit', 'authorizePush', 'authorizeDraftPR']) {
      await assert.rejects(acceptReviewedHandoff(config, ledger, receipt,
        { ...options, [permission]: false }), /Execution requires/);
      assert.equal(ledger.status().jobs.length, 0);
    }
    const prepared = prepareReviewedHandoff(config, ledger, receipt, { source: 'synthetic-demo' });
    assert.equal(prepared.assignment.skillQualification.baseRevision, filter.selected.definition.sourceRevision);
    assert.equal(prepared.testCoveragePlan.coverageGaps[0], filter.selected.definition.missingAssertion);
    assert.equal(prepareReviewedHandoff(config, ledger, receipt, { source: 'synthetic-demo' }).assignment.id,
      prepared.assignment.id);
    options.source = 'synthetic-demo';
    options.dispatchDependencies = {
      runModel: async (_config, _ledger, current, assignment, investigation, toolkit, skill) => {
        counts.authoring++;
        assert.equal(counts.authoring, 1);
        assert.equal(current.base_revision, fixture.qualification.baseRevision);
        assert.equal(skill.skillRevision, fixture.qualification.baseRevision);
        assert.match(skill.instructions, /Synthetic demo skill/);
        assert.equal(investigation.expectedBehavior, filter.selected.definition.missingAssertion);
        assert.equal(assignment.testCoveragePlanId, prepared.testCoveragePlan.id);
        assert.throws(() => toolkit.write('src/selection.cjs', ''), /approved edit bounds/);
        toolkit.write(testPath, [
          "const { test } = require('node:test');",
          "const assert = require('node:assert/strict');",
          "const { select } = require('../src/selection.cjs');",
          `test(${JSON.stringify(invariant)}, () => {`,
          '  const items = [{id: 1, active: false}, {id: 2, active: true}, {id: 3, active: true}];',
          `  assert.deepEqual(select(items, 1).map(item => item.id), [${scenario === 'failed-validation' ? 1 : 2}]);`,
          '  assert.deepEqual(select(items, 2).map(item => item.id), [2, 3]);',
          '  assert.deepEqual(select(items, 0), []);',
          '});', ''
        ].join('\n'));
        toolkit.finish({
          outcome: 'propose-change', findings: 'Deterministic fixture authoring; no model invoked.',
          title: 'Add synthetic selection coverage', description: 'Offline demo; publication is simulated.',
          skillResult: { status: 'succeeded', classification: 'missing-test-coverage',
            changedFiles: [testPath], testsAddedOrUpdated: [invariant], behaviorCardsAddedOrUpdated: [],
            unknowns: [], needsHumanDecision: false }
        });
      },
      runValidation: async (...args) => {
        const gates = await runValidation(...args);
        const behavior = gates.find(gate => gate.gateId === 'behavior');
        assert.ok(behavior, 'The behavior gate must actually execute');
        const artifact = read(behavior.artifactRefs[0]);
        assert.equal(behavior.status, scenario === 'failed-validation' ? 'failed' : 'passed',
          bytes(artifact.output));
        assert.match(artifact.output.stdout, /Active items retain source order/);
        assert.match(artifact.output.stdout, /^# tests 2\r?$/m);
        assert.match(artifact.output.stdout, /^# skipped 0\r?$/m);
        assert.match(artifact.output.stdout, scenario === 'failed-validation'
          ? /^# fail 1\r?$/m : /^# fail 0\r?$/m);
        // Fault injection after real execution: a passing result for another head must not publish.
        return scenario === 'stale-head'
          ? gates.map(gate => ({ ...gate, sourceRevision: fixture.qualification.baseRevision })) : gates;
      },
      pushBranch: async (_config, workspace, repo, refspec) => {
        counts.simulatedPush++;
        assert.equal(scenario, 'success');
        assert.equal(repo.remote, fixture.repo.remote);
        assert.equal(workspace, ledger.job(prepared.assignment.id).workspace);
        assert.equal(refspec, `HEAD:refs/heads/pilot/${prepared.assignment.id}`);
      },
      createDraft: async (_config, _ledger, current, _repo, revision) => {
        counts.simulatedDraft++;
        assert.equal(counts.simulatedPush, 1);
        assert.equal(scenario, 'success');
        assert.equal(ledger.all('workerResult').length, 0);
        assert.equal((await command('git', ['rev-parse', 'HEAD'], current.workspace)).stdout.trim(), revision);
        return { url: 'https://example.invalid/simulated-draft/demo', isDraft: true, headRevision: revision };
      }
    };
    if (scenario === 'success') {
      const executed = await acceptReviewedHandoff(config, ledger, receipt, options);
      assert.equal(executed.state, 'draft-pr-validated');
    } else {
      await assert.rejects(acceptReviewedHandoff(config, ledger, receipt, options),
        /Every required gate must pass at the clean current revision; no push permitted/);
    }
    const result = ledger.all('workerResult')[0];
    assert.equal(ledger.all('workerResult').length, 1);
    assert.equal(result.validation.length, 2);
    assert.equal(result.validationAttempts.length, 1);
    assert.ok(result.validation.every(gate => gate.attemptCount === 1));
    assert.notEqual(result.sourceRevision, fixture.qualification.baseRevision);
    const behavior = result.validation.find(gate => gate.gateId === 'behavior');
    assert.equal(behavior.status, scenario === 'failed-validation' ? 'failed' : 'passed');
    const artifact = read(behavior.artifactRefs[0]);
    assert.equal(artifact.revision, result.sourceRevision);
    assert.match(artifact.output.stdout, /Active items retain source order/);
    if (scenario === 'success') {
      assert.ok(result.validation.every(gate => gate.status === 'passed' && gate.sourceRevision === result.sourceRevision));
      assert.equal(result.draftPR.headRevision, result.sourceRevision);
    } else {
      assert.equal(result.outcome, 'blocked'); assert.equal(result.draftPR, null);
    }
    assert.deepEqual(counts, { authoring: 1,
      simulatedPush: scenario === 'success' ? 1 : 0, simulatedDraft: scenario === 'success' ? 1 : 0 });
    const jobId = prepared.assignment.id;
    ledger.close();
    ledger = new Ledger(config.stateDirectory);
    assert.equal(ledger.job(jobId).state, scenario === 'success' ? 'completed' : 'blocked');
    await assert.rejects(acceptReviewedHandoff(config, ledger, receipt, options), /never-dispatched/);
    assert.equal(counts.authoring, 1);
    assert.equal(ledger.all('workerResult').length, 1);
    return { scenario, outcome: result.outcome, assignmentId: jobId, attemptId: result.attemptId,
      sourceRevision: result.sourceRevision, draftPR: result.draftPR,
      validation: result.validation, counts, duplicateDispatchRejected: true,
      ledgerPath: join(ledger.directory, 'ledger.sqlite') };
  } finally {
    ledger.close();
  }
}

export async function runDemoStages(collectionConfig, sources) {
  const config = structuredClone(collectionConfig), root = config.stateDirectory;
  const before = sources.map(source => hash(readFileSync(source.ledgerPath)));
  const fixture = await fixtureRepository(config, root);
  const filter = await filterStage(config, sources, root, fixture.qualification.baseRevision);
  const scenarios = [];
  for (const scenario of ['failed-validation', 'stale-head', 'success'])
    scenarios.push(await proposerScenario(config, fixture, filter, root, scenario));
  assert.equal(await fixture.git(['rev-parse', 'HEAD']), fixture.qualification.baseRevision);
  assert.equal(await fixture.git(['status', '--porcelain']), '');
  assert.deepEqual(sources.map(source => hash(readFileSync(source.ledgerPath))), before);
  assert.equal(collectionConfig.activation.dispatch, false);
  const summary = {
    filter: filter.summary,
    proposer: { mode: 'synthetic-reviewed-handoff', publication: 'simulated',
      directSyntheticHandoffRejected: true, permissionGatesEnforced: true,
      scenarios, realModelCalls: 0, realPushes: 0, realDraftPRs: 0 },
    sourceLedgerUnchanged: true
  };
  const artifactPath = join(root, 'workflow-summary.json');
  writeFileSync(artifactPath, bytes(summary));
  return { ...summary, artifactPath };
}
