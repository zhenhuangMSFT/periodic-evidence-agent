import { readFileSync } from 'node:fs';
import {
  exclusions, hash, json, readJson, requireThat, utc, validateRecord
} from './common.js';
import { persistReviewedInvestigation } from './coordinator.js';
import { bindFilterConsolidation } from './filter-batches.js';
import { loadFilterCorpus } from './filter.js';
import { planImprovement } from './improvements.js';
import {
  requireCompleteExclusionReview, requireEligibleImprovementInvestigation
} from './review-decisions.js';
import { resolveSkillBinding, skillQualificationId } from './repository-skills.js';
import { dispatch, makeAssignment, makePlannedImprovementAssignment } from './workers.js';

function priority(value) {
  if (value >= 90) return 'critical';
  if (value >= 70) return 'high';
  if (value >= 40) return 'medium';
  return 'low';
}

function capturePayload(capture) {
  requireThat(capture && typeof capture.contentBase64 === 'string',
    'Selected FILTER evidence requires lossless captured source bytes', 'blocked-reconciliation');
  const bytes = Buffer.from(capture.contentBase64, 'base64');
  requireThat(hash(bytes) === capture.sha256,
    'Selected FILTER evidence capture changed', 'blocked-reconciliation');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    requireThat(false, 'Selected FILTER evidence capture is not canonical JSON',
      'blocked-reconciliation');
  }
}

export function importCapturedEvidence(ledger, binding, corpus, sourcePrefix = 'filter-proposer') {
  const selected = new Set(binding.retainedIds);
  const records = corpus.evidence.filter(record => selected.has(record.id));
  requireThat(records.length === selected.size,
    'Selected FILTER evidence is missing from the bound source corpus', 'blocked-reconciliation');
  requireThat(records.every(record => record.source.provenance !== 'synthetic'),
    'FILTER proposer handoff requires authenticated non-synthetic evidence', 'blocked-scope');
  const captures = new Map(corpus.captures.map(capture => [capture.sha256, capture]));
  const missing = records.filter(record => !ledger.get('evidence', record.id));
  if (!missing.length) {
    records.forEach(record => requireThat(json(ledger.get('evidence', record.id)) === json(record),
      'Imported FILTER evidence conflicts with local immutable evidence', 'blocked-reconciliation'));
    return records;
  }
  const windows = corpus.index.sources.map(source => source.window);
  requireThat(windows.length > 0 && windows.every(window => json(window) === json(windows[0])),
    'FILTER proposer evidence must use one exact collection window', 'blocked-reconciliation');
  const runId = ledger.startRun(`${sourcePrefix}:${binding.cohortId}`, windows[0]);
  for (const record of records) {
    const existing = ledger.get('evidence', record.id);
    if (existing) {
      requireThat(json(existing) === json(record),
        'Imported FILTER evidence conflicts with local immutable evidence', 'blocked-reconciliation');
      continue;
    }
    const capture = captures.get(record.capture.sha256);
    const stored = ledger.evidence(structuredClone(record), capturePayload(capture), runId);
    requireThat(stored.id === record.id && json(stored) === json(record),
      'FILTER evidence identity changed during import', 'blocked-reconciliation');
  }
  ledger.finishRun(runId, 'complete');
  return records;
}

function investigation(ledger, candidate, evidence, reviewedAt, reviewer, intent) {
  const primary = evidence[0];
  const id = `investigation-${hash(json([
    primary.source.namespace, primary.source.recordId
  ]))}`;
  const record = {
    recordType: 'investigation',
    schemaVersion: '1.0',
    id,
    version: 1,
    evidenceIds: evidence.map(record => record.id),
    state: 'triaged',
    observedBehavior: candidate.definition.rationale,
    expectedBehavior: `${candidate.definition.layer} coverage should assert: ${candidate.definition.missingAssertion}`,
    hypotheses: [
      `The existing ${candidate.definition.harness} can cover the selected invariant.`
    ],
    counterEvidence: candidate.definition.existingCoverage,
    classification: 'functional',
    defectConfirmation: 'unconfirmed',
    reportEligibility: 'included',
    handoffEligibility: 'eligible',
    exclusionReasons: [],
    rationale: candidate.definition.rationale,
    confidence: candidate.definition.confidence,
    review: { method: 'agent-evidence-review', reviewer, reviewedAt },
    repoIds: [candidate.definition.repository],
    existingFixes: [],
    nextAction: intent === 'defect-fix'
      ? `Inspect ${candidate.definition.harness} at ${candidate.definition.sourceRevision}, reproduce and fix the production behavior, and add or update ${candidate.definition.layer} coverage for: ${candidate.definition.missingAssertion}`
      : `Inspect ${candidate.definition.harness} at ${candidate.definition.sourceRevision} and add or update ${candidate.definition.layer} coverage for: ${candidate.definition.missingAssertion}`
  };
  const previous = ledger.get('investigation', id);
  if (!previous) return record;
  record.version = previous.version;
  if (json(record) === json(previous)) return record;
  record.version++;
  return record;
}

export function validateFilterProposerHandoff(config, input) {
  validateRecord(structuredClone(input), 'filterProposerHandoff');
  const binding = bindFilterConsolidation(config, input.filter);
  requireThat(binding.selected, 'FILTER consolidation has no selectable proposer candidate',
    'blocked-reconciliation');
  const candidate = binding.selected;
  requireThat(candidate.definition.coverageStatus === 'gap' &&
    candidate.definition.blockers.length === 0,
  'FILTER candidate is not an unblocked coverage gap', 'blocked-reconciliation');
  const relevantReviews = binding.reviews.filter(review =>
    candidate.batchIds.includes(review.batchId));
  requireThat(relevantReviews.length === candidate.batchIds.length,
    'Selected FILTER candidate review receipts are incomplete', 'blocked-reconciliation');
  const reviewedAt = relevantReviews.map(review => utc(review.reviewedAt))
    .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  requireThat(Date.parse(reviewedAt) <= Date.now(),
    'FILTER review timestamp cannot be in the future', 'blocked-reconciliation');
  const reviewers = [...new Set(relevantReviews.map(review => review.reviewer))].sort();
  const { binding: skill } = resolveSkillBinding(config, candidate.definition.repository,
    input.routing.capability);
  const requestedOutcome = input.routing.requestedOutcome ?? 'add-or-update-tests';
  requireThat(skill.requestedOutcomes.includes(requestedOutcome),
    `Repository skill binding ${skill.id} does not support ${requestedOutcome}`, 'blocked-scope');
  return {
    input, binding, candidate, reviewedAt,
    reviewer: `FILTER:${reviewers.join(',')}`, requestedOutcome, skill
  };
}

export function prepareFilterProposerHandoff(config, ledger, input, {
  intent = 'improvement'
} = {}) {
  requireThat(config.statePolicy.accessApproved === true,
    'FILTER proposer handoff requires approved local state storage', 'blocked-config');
  requireThat(['improvement', 'defect-fix'].includes(intent),
    'FILTER proposer handoff intent must be improvement or defect-fix', 'blocked-scope');
  const validated = validateFilterProposerHandoff(config, input);
  const { binding, candidate, reviewedAt, reviewer, requestedOutcome, skill } = validated;
  const qualification = ledger.qualification(skillQualificationId(
    candidate.definition.repository, skill.id));
  requireThat(qualification?.baseRevision === candidate.definition.sourceRevision,
    'FILTER candidate and repository skill qualification use different source revisions',
    'blocked-reconciliation');
  const manifest = readJson(binding.manifestPath);
  requireThat(hash(readFileSync(binding.manifestPath)) === binding.manifestSha256,
    'FILTER manifest changed after binding', 'blocked-reconciliation');
  const corpus = loadFilterCorpus(config, {
    format: 'stage2-sources-v1',
    sources: manifest.request.sources
  });
  return ledger.transaction(() => {
    const evidence = importCapturedEvidence(ledger, binding, corpus);
    const proposedInvestigation = investigation(
      ledger, candidate, evidence, reviewedAt, reviewer, intent);
    requireCompleteExclusionReview(exclusions);
    requireEligibleImprovementInvestigation(proposedInvestigation);
    const persistedInvestigation = persistReviewedInvestigation(config, ledger, {
      investigation: proposedInvestigation,
      exclusionsChecked: exclusions
    }, {
      requireReviewActivation: false,
      allowImportedInitialVersion: true,
      allowIdempotentReplay: true
    });
    const planned = planImprovement(ledger, {
      improvement: {
        investigationIds: [persistedInvestigation.id],
        evidenceIds: persistedInvestigation.evidenceIds,
        category: 'missing-test-coverage',
        theme: candidate.definition.missingAssertion,
        observedBehavior: persistedInvestigation.observedBehavior,
        expectedBehavior: persistedInvestigation.expectedBehavior,
        rationale: candidate.definition.rationale,
        priority: priority(candidate.definition.priority),
        repoIds: [candidate.definition.repository],
        capabilities: [input.routing.capability]
      },
      testCoverage: {
        repoId: candidate.definition.repository,
        capability: input.routing.capability,
        sourceRevision: candidate.definition.sourceRevision,
        searchStatus: 'complete',
        existingTests: [],
        coverageGaps: [candidate.definition.missingAssertion],
        unknowns: [],
        rationale: `${candidate.definition.rationale} Existing coverage: ${candidate.definition.existingCoverage.join('; ')}`,
        ...(input.routing.skillInput
          ? { skillInput: input.routing.skillInput }
          : {})
      }
    });
    const assignment = intent === 'defect-fix'
      ? makeAssignment(config, persistedInvestigation,
        candidate.definition.repository, 'defect-fix')
      : makePlannedImprovementAssignment(config, ledger,
        persistedInvestigation, planned.testCoveragePlan.id, requestedOutcome);
    const job = ledger.job(assignment.id) ?? ledger.prepare(assignment);
    return {
      handoff: input, filter: binding, candidate,
      evidence, investigation: persistedInvestigation, ...planned, assignment, job
    };
  });
}

export async function acceptFilterProposerHandoff(config, ledger, input, {
  intent = 'improvement',
  execute = false,
  authorizeCommit = false,
  authorizePush = false,
  authorizeDraftPR = false,
  dispatchDependencies = {}
} = {}) {
  if (execute) {
    const validated = validateFilterProposerHandoff(config, input);
    requireThat(authorizeCommit === true,
      'Execution requires --authorize-commit', 'blocked-config');
    requireThat(authorizePush === true,
      'Execution requires --authorize-push', 'blocked-config');
    requireThat(authorizeDraftPR === true,
      'Execution requires --authorize-draft-pr', 'blocked-config');
    requireThat(validated.skill.sideEffects.commit === true &&
      validated.skill.sideEffects.push === true &&
      validated.skill.sideEffects.createDraftPR === true,
    'Repository skill binding is not authorized for commit, push and Draft PR side effects',
    'blocked-config');
  }
  const prepared = prepareFilterProposerHandoff(config, ledger, input, { intent });
  if (!execute) return { state: 'prepared', ...prepared };
  const result = await dispatch(config, ledger, prepared.assignment.id, dispatchDependencies);
  return { state: result.outcome, ...prepared, result };
}
