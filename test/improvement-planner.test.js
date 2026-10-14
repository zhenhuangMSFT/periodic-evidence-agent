import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { configAt, hash, json, now } from '../src/common.js';
import { evidenceEnvelope } from '../src/sources.js';
import { recordAreaToImprove, recordTestCoveragePlan } from '../src/improvements.js';
import { makePlannedImprovementAssignment, requireCurrentAssignment } from '../src/workers.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'improvement-planner-'));
  const ledger = new Ledger(join(root, 'state'));
  const config = configAt('pilot.example.json');
  config.limits = { ...config.limits, maxItems: 100, workerMaxToolCalls: 20 };
  config.repositories = [{
    id: 'office-src', projectId: 'oa-project', owner: 'oa-owner', routingApproved: true,
    routingRules: ['Office Agent integration tests'], referenceCheckout: join(root, 'oa-reference'),
    baseRef: 'main', remote: 'https://dev.azure.com/example/project/_git/OfficeAgent',
    allowedWritePrefixes: ['test'], commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    validationGates: [{ id: 'oa-test', approved: true, executable: process.execPath, args: [], timeoutMs: 1000 }],
    skillBindings: [{
      id: 'oa-integration-test-core', capability: 'integration-test-authoring',
      skillPath: 'docs/skills/Integration-test-core/SKILL.md', enabled: true, qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'], requiresBehaviorCard: true,
      sideEffects: { commit: false, push: false, createDraftPR: false }
    }]
  }];
  const evidence = evidenceEnvelope('ado', 'office/OC', '42', '1',
    'https://example.invalid/ado/42', 'fixture', now());
  evidence.source.provenance = 'authenticated-source';
  evidence.capture = { artifactRef: null, sha256: null, unavailableReason: 'Fixture' };
  evidence.id = `ev-${hash(json(['fixture', 42]))}`;
  ledger.put(evidence);
  const investigation = {
    recordType: 'investigation', schemaVersion: '1.0',
    id: `investigation-${hash(json([evidence.source.namespace, evidence.source.recordId]))}`, version: 1,
    evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'An established OA behavior lacks regression coverage.',
    expectedBehavior: 'The established behavior remains covered by an integration test.',
    hypotheses: [], counterEvidence: [], classification: 'functional', defectConfirmation: 'unconfirmed',
    reportEligibility: 'included', handoffEligibility: 'eligible', exclusionReasons: [],
    rationale: 'The evidence describes existing behavior and a test coverage improvement.', confidence: 0.9,
    review: { method: 'human-review', reviewer: 'fixture', reviewedAt: now() },
    repoIds: ['office-src'], existingFixes: [], nextAction: 'Add or link focused integration coverage.'
  };
  ledger.put(investigation);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, ledger, config, evidence, investigation };
}

function improvementInput(investigation) {
  return {
    investigationIds: [investigation.id], category: 'missing-test-coverage',
    theme: 'OA established behavior integration coverage',
    observedBehavior: investigation.observedBehavior, expectedBehavior: investigation.expectedBehavior,
    rationale: 'Multiple reports of this behavior should resolve to one durable improvement.',
    priority: 'medium', repoIds: ['office-src'], capabilities: ['integration-test-authoring']
  };
}

test('area-to-improve aggregation is stable, idempotent and versions material changes', t => {
  const { ledger, investigation, evidence } = setup(t);
  const first = recordAreaToImprove(ledger, improvementInput(investigation));
  const replay = recordAreaToImprove(ledger, improvementInput(investigation));
  assert.deepEqual(replay, first);
  assert.equal(ledger.all('areaToImprove').length, 1);
  const updated = recordAreaToImprove(ledger, {
    ...improvementInput(investigation), evidenceIds: [evidence.id],
    rationale: 'New review confirms the same durable improvement with stronger evidence.', priority: 'high'
  });
  assert.equal(updated.id, first.id);
  assert.equal(updated.version, 2);
  assert.equal(ledger.all('areaToImprove').length, 2);
});

test('coverage planning treats incomplete empty search as unknown, not a confirmed gap', t => {
  const { ledger, investigation } = setup(t);
  const improvement = recordAreaToImprove(ledger, improvementInput(investigation));
  const unknown = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: null, searchStatus: 'partial', existingTests: [], coverageGaps: [], unknowns: [],
    rationale: 'The OA repository search was not complete.'
  });
  assert.equal(unknown.disposition, 'unknown');
  assert.match(unknown.unknowns[0], /not completely established/);
  assert.throws(() => recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: null, searchStatus: 'complete', existingTests: [],
    coverageGaps: ['A claimed gap without a source revision.'], unknowns: [],
    rationale: 'This complete result is not source-bound.'
  }), /bound to a repository commit/);
  const gap = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: 'a'.repeat(40), searchStatus: 'complete', existingTests: [],
    coverageGaps: ['No integration test exercises the observed behavior.'], unknowns: [],
    rationale: 'A complete source-bound search found no matching test.'
  });
  assert.equal(gap.disposition, 'coverage-gap');
  assert.equal(gap.version, 2);
});

test('existing test links are deduplicated and take precedence over proposed gaps', t => {
  const { ledger, investigation } = setup(t);
  const improvement = recordAreaToImprove(ledger, improvementInput(investigation));
  const plan = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: 'b'.repeat(40), searchStatus: 'complete',
    existingTests: [
      { path: 'test/behavior.test.js', identifier: 'preserves established behavior' },
      { path: 'test/behavior.test.js', identifier: 'preserves established behavior' }
    ],
    coverageGaps: ['Stale tentative gap'], unknowns: [], rationale: 'Existing source-bound coverage was found.'
  });
  assert.equal(plan.disposition, 'linked');
  assert.equal(plan.existingTests.length, 1);
});

test('planned OA assignment pins improvement, plan and qualified repository skill binding', t => {
  const { ledger, config, investigation } = setup(t);
  const improvement = recordAreaToImprove(ledger, improvementInput(investigation));
  const plan = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: 'c'.repeat(40), searchStatus: 'complete', existingTests: [],
    coverageGaps: ['Missing focused integration coverage.'], unknowns: [],
    rationale: 'Create an OA integration-test assignment.'
  });
  const validationContract = repositoryValidationContract(config.repositories[0]);
  ledger.qualify(skillQualificationId('office-src', 'oa-integration-test-core'), {
    state: 'qualified-read-only', repoId: 'office-src', bindingId: 'oa-integration-test-core',
    capability: 'integration-test-authoring', remote: config.repositories[0].remote,
    baseRef: 'main', baseRevision: plan.sourceRevision,
    skillPath: 'docs/skills/Integration-test-core/SKILL.md', skillSha256: 'd'.repeat(64),
    qualificationSource: 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    sideEffects: { commit: false, push: false, createDraftPR: false }
  });
  const assignment = makePlannedImprovementAssignment(config, ledger, investigation, plan.id);
  assert.equal(assignment.intent, 'improvement');
  assert.equal(assignment.improvementId, improvement.id);
  assert.equal(assignment.testCoveragePlanId, plan.id);
  assert.equal(assignment.skillBindingId, 'oa-integration-test-core');
  assert.equal(assignment.skillQualification.baseRevision, plan.sourceRevision);
  assert.ok(assignment.requiredCapabilities.includes('repository-skill:oa-integration-test-core'));
  const superseded = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: plan.sourceRevision, searchStatus: 'complete', existingTests: [],
    coverageGaps: ['Missing focused integration coverage.'], unknowns: [],
    rationale: 'A later source-bound review supersedes the prepared plan.'
  });
  assert.equal(superseded.id, plan.id);
  assert.equal(superseded.version, plan.version + 1);
  assert.throws(() => requireCurrentAssignment(config, ledger, investigation, assignment), /superseded/);
  config.repositories[0].skillBindings[0].qualification = 'unqualified';
  assert.throws(() => makePlannedImprovementAssignment(config, ledger, investigation, plan.id), /unqualified/);
});

test('planned assignment rejects incomplete coverage without a pinned source revision', t => {
  const { ledger, config, investigation } = setup(t);
  const improvement = recordAreaToImprove(ledger, improvementInput(investigation));
  const plan = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: null, searchStatus: 'partial', existingTests: [], coverageGaps: [], unknowns: [],
    rationale: 'Repository coverage is not source-bound yet.'
  });
  assert.throws(() => makePlannedImprovementAssignment(config, ledger, investigation, plan.id),
    /source-bound coverage revision/);
});
