import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  hash, json, now, readJson, requireThat, validateRecord
} from './common.js';
import { loadFilterCorpus } from './filter.js';
import { bindFilterConsolidation } from './filter-batches.js';

const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
const sha = value => hash(pretty(value));
const hex = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);

function writeNew(path, value) {
  writeFileSync(path, typeof value === 'string' ? value : pretty(value), {
    flag: 'wx', mode: 0o600
  });
}

function privateArtifact(path) {
  const absolute = resolve(path);
  requireThat(existsSync(absolute), `Private proof artifact is missing: ${basename(path)}`,
    'unavailable');
  return { path: absolute, bytes: readFileSync(absolute), value: readJson(absolute) };
}

function commonWindow(corpus) {
  const windows = corpus.index.sources.map(source => source.window);
  requireThat(windows.length > 0 &&
    windows.every(window => json(window) === json(windows[0])),
  'E2E proof requires one exact collection window', 'blocked-reconciliation');
  return {
    start: windows[0].start,
    endExclusive: windows[0].end ?? windows[0].endExclusive
  };
}

function publicCoverage(corpus) {
  return corpus.coverage.flatMap(source => source.coverage.map(pass => ({
    runId: source.runId,
    pass: pass.pass,
    state: pass.state,
    evidenceCount: pass.evidenceCount ?? null,
    examinedRecords: pass.examinedRecords ?? null,
    readCalls: pass.readCalls ?? null,
    provenance: pass.provenance ?? null,
    execution: pass.execution ?? null,
    identityVerified: pass.identityVerified ?? null,
    coverage: pass.coverage ?? null
  })));
}

function safeValidation(gate) {
  const command = gate.commandOrRunUrl;
  requireThat(typeof command === 'string' &&
    !/[A-Z]:[\\/]+Users[\\/]+|\/(?:home|Users)\//i.test(command) &&
    !/@microsoft\.com\b/i.test(command),
  'Validation command contains a private local path or identity',
  'blocked-sharing');
  return {
    gateId: gate.gateId,
    sourceRevision: gate.sourceRevision,
    commandOrRunUrl: command,
    status: gate.status,
    artifactRefsSha256: sha(gate.artifactRefs),
    attemptCount: gate.attemptCount,
    blockedReason: gate.blockedReason
  };
}

function publicController(privateResult, selected) {
  requireThat(privateResult?.state === 'draft-pr-validated' &&
    privateResult.result, 'Controller result is not a validated Draft PR',
  'blocked-reconciliation');
  const result = validateRecord(structuredClone(privateResult.result), 'workerResult');
  requireThat(privateResult.candidate &&
    sha(privateResult.candidate) === sha(selected),
  'Controller result is not bound to the selected FILTER candidate',
  'blocked-reconciliation');
  requireThat(result.outcome === 'draft-pr-validated' && result.draftPR?.isDraft === true,
    'Worker result is not a validated Draft PR', 'blocked-reconciliation');
  requireThat(result.sourceRevision === result.draftPR.headRevision &&
    result.validation.every(gate => gate.status === 'passed' &&
      gate.sourceRevision === result.sourceRevision),
  'Draft PR head and passing validation are not bound to one source revision',
  'blocked-reconciliation');
  requireThat(hex(result.sourceRevision), 'Worker result source revision is invalid',
    'invalid-record');
  const selectedIds = [...selected.evidenceIds].sort();
  requireThat(json([...result.evidenceIds].sort()) === json(selectedIds),
    'Worker result evidence differs from the selected FILTER candidate',
    'blocked-reconciliation');
  return {
    result,
    authoring: {
      format: 'e2e-proof-authoring-v1',
      assignmentId: result.assignmentId,
      attemptId: result.attemptId,
      outcome: result.outcome,
      sourceRevision: result.sourceRevision,
      evidenceSetSha256: sha(selectedIds),
      skillExecution: result.skillExecution && {
        bindingId: result.skillExecution.bindingId,
        capability: result.skillExecution.capability,
        skillPath: result.skillExecution.skillPath,
        skillRevision: result.skillExecution.skillRevision,
        status: result.skillExecution.status,
        classification: result.skillExecution.classification,
        changedFiles: result.skillExecution.changedFiles,
        testsAddedOrUpdated: result.skillExecution.testsAddedOrUpdated,
        behaviorCardsAddedOrUpdated:
          result.skillExecution.behaviorCardsAddedOrUpdated,
        unknownCount: result.skillExecution.unknowns.length,
        needsHumanDecision: result.skillExecution.needsHumanDecision
      },
      toolUsage: result.toolUsage
    },
    validation: {
      format: 'e2e-proof-validation-v1',
      sourceRevision: result.sourceRevision,
      gates: result.validation.map(safeValidation),
      attempts: result.validationAttempts.map(attempt => ({
        round: attempt.round,
        sourceRevision: attempt.sourceRevision,
        gates: attempt.validation.map(safeValidation)
      }))
    },
    draftPR: {
      format: 'e2e-proof-draft-pr-v1',
      url: result.draftPR.url,
      isDraft: result.draftPR.isDraft,
      headRevision: result.draftPR.headRevision,
      outcome: result.outcome,
      reportedAt: result.reportedAt
    }
  };
}

function bindAppRun(input, controllerArtifact) {
  if (input.format === 'e2e-proof-request-v1') return null;
  const summaryArtifact = privateArtifact(input.appRun.summaryPath);
  const summary = summaryArtifact.value;
  requireThat(summary?.executionMode === 'app-native' &&
    summary.runId === input.runId && summary.dryRun === false &&
    Array.isArray(summary.workers),
  'E2E proof app run is not the declared production app-native run',
  'blocked-reconciliation');
  const workers = summary.workers.filter(worker =>
    worker.id === input.appRun.assignmentId && worker.runId === input.runId);
  requireThat(workers.length === 1,
    'E2E proof app run does not contain exactly one declared assignment',
    'blocked-reconciliation');
  const worker = workers[0];
  requireThat(worker.result?.outcome === 'draft-reported' &&
    worker.result.evidenceRef === `sha256:${hash(controllerArtifact.bytes)}`,
  'E2E proof controller result is not content-bound to the app-native assignment',
  'blocked-reconciliation');
  return {
    artifact: summaryArtifact,
    assignmentId: worker.id
  };
}

function verifyNoPrivateContent(value) {
  const text = JSON.stringify(value);
  const forbidden = [
    /[A-Z]:[\\/]+Users[\\/]+/i,
    /\/(?:home|Users)\/[A-Z0-9._-]+\//i,
    /@microsoft\.com\b/i,
    /"fields"\s*:/,
    /"contentBase64"\s*:/,
    /dev\.azure\.com\/office\/OC\/_workitems\/edit\//i
  ];
  requireThat(!forbidden.some(pattern => pattern.test(text)),
    'Sanitized E2E proof contains private source content or local paths',
    'blocked-sharing');
}

function checksums(directory, names) {
  return names.map(name => `${hash(readFileSync(join(directory, name)))}  ${name}`).join('\n') + '\n';
}

export function exportE2eProof(config, input, outputDirectory) {
  validateRecord(structuredClone(input), 'e2eProofRequest');
  const directory = resolve(outputDirectory);
  requireThat(!existsSync(directory),
    'E2E proof output already exists; use a new immutable run directory',
    'invalid-record');

  const sourceArtifact = privateArtifact(input.collection.sourcesPath);
  const corpus = loadFilterCorpus(config, sourceArtifact.value);
  const window = commonWindow(corpus);
  const binding = bindFilterConsolidation(config, input.filter);
  requireThat(json(binding.sources) === json(sourceArtifact.value.sources),
    'FILTER manifest is not bound to the declared collection sources',
    'blocked-reconciliation');
  requireThat(binding.selected, 'FILTER consolidation has no selected candidate',
    'blocked-reconciliation');
  const controllerArtifact = privateArtifact(input.controller.resultPath);
  const appRun = bindAppRun(input, controllerArtifact);
  const controller = publicController(controllerArtifact.value, binding.selected);

  const collection = {
    format: 'e2e-proof-collection-v1',
    window,
    sourceRuns: corpus.index.sources.map(source => ({
      runId: source.runId,
      snapshotSha256: source.snapshotSha256
    })),
    passes: publicCoverage(corpus),
    uniqueEvidence: corpus.evidence.length,
    evidenceInventorySha256: sha(corpus.evidence.map(record => ({
      id: record.id,
      source: record.source,
      captureSha256: record.capture.sha256
    }))),
    sourcesManifestSha256: hash(sourceArtifact.bytes)
  };
  const memberStatuses = binding.reviews.flatMap(review =>
    readJson(review.path).details.map(detail => detail.status));
  const filter = {
    format: 'e2e-proof-filter-v1',
    cohortId: binding.cohortId,
    manifestSha256: binding.manifestSha256,
    resultSha256: binding.resultHashes,
    batchCount: binding.reviews.length,
    memberCount: memberStatuses.length,
    accounting: Object.fromEntries([...new Set(memberStatuses)].sort().map(status =>
      [status, memberStatuses.filter(value => value === status).length])),
    selected: {
      candidateSha256: sha(binding.selected),
      repository: binding.selected.definition.repository,
      sourceRevision: binding.selected.definition.sourceRevision,
      layer: binding.selected.definition.layer,
      coverageStatus: binding.selected.definition.coverageStatus,
      blockers: binding.selected.definition.blockers.length,
      retainedEvidenceCount: binding.selected.evidenceIds.length,
      missingAssertionSha256: hash(binding.selected.definition.missingAssertion),
      rationaleSha256: hash(binding.selected.definition.rationale)
    }
  };
  const coverage = {
    format: 'e2e-proof-coverage-selection-v1',
    mechanism: 'complete-record-filter-consolidation',
    cohortId: binding.cohortId,
    selectedCandidateSha256: sha(binding.selected),
    repository: binding.selected.definition.repository,
    inspectedSourceRevision: binding.selected.definition.sourceRevision,
    layer: binding.selected.definition.layer,
    existingCoverageCount: binding.selected.definition.existingCoverage.length,
    coverageStatus: binding.selected.definition.coverageStatus,
    blockerCount: binding.selected.definition.blockers.length,
    priority: binding.selected.definition.priority,
    confidence: binding.selected.definition.confidence
  };
  const safety = {
    format: 'e2e-proof-safety-v1',
    draftOnly: controller.draftPR.isDraft === true,
    merged: false,
    mergeAuthorization: 'not-granted',
    sourceWindowChanged: false,
    sourceWrites: 'unsupported-by-controller-path',
    activation: {
      collect: config.activation.collect,
      review: config.activation.review,
      dispatch: config.activation.dispatch
    },
    limitations: [
      'This bundle proves the declared ADO collection passes and selected proposer lineage, not unavailable or unstarted source coverage.',
      'No claim is made that the source snapshot reconstructs the historical source state at the window boundary.',
      'The bundle omits raw source bodies, identities, captures, local paths and private execution logs.'
    ]
  };

  const artifacts = {
    '01-collection.json': collection,
    '02-filter.json': filter,
    '03-coverage-handoff.json': coverage,
    '04-oa-authoring.json': controller.authoring,
    '05-validation.json': controller.validation,
    '06-draft-pr.json': controller.draftPR,
    '07-safety-invariants.json': safety
  };
  Object.values(artifacts).forEach(verifyNoPrivateContent);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  for (const [name, value] of Object.entries(artifacts)) writeNew(join(directory, name), value);

  const readme = `# Evidence-to-Draft-PR E2E proof\n\n` +
    `This directory contains a sanitized, hash-bound proof bundle for \`${input.runId}\`.\n` +
    `Raw source evidence and private execution artifacts are intentionally excluded.\n` +
    `Run \`npm run pilot -- e2e-proof-check --file <private-request> --bundle ${input.runId} --config <private-config>\` ` +
    `from an authorized checkout to re-open the private artifacts and verify the lineage.\n`;
  writeNew(join(directory, 'README.md'), readme);
  const publicNames = [...Object.keys(artifacts), 'README.md'];
  const manifest = {
    format: input.format === 'e2e-proof-request-v2'
      ? 'e2e-proof-manifest-v2' : 'e2e-proof-manifest-v1',
    runId: input.runId,
    generatedAt: now(),
    state: 'draft-pr-validated',
    window,
    artifacts: publicNames.sort().map(name => ({
      name,
      sha256: hash(readFileSync(join(directory, name)))
    })),
    privateBindings: {
      collectionSourcesSha256: hash(sourceArtifact.bytes),
      filterManifestSha256: binding.manifestSha256,
      filterResultSha256: binding.resultHashes,
      controllerResultSha256: hash(controllerArtifact.bytes),
      ...(appRun && {
        appRunSummarySha256: hash(appRun.artifact.bytes),
        appRunAssignmentId: appRun.assignmentId
      })
    }
  };
  verifyNoPrivateContent(manifest);
  writeNew(join(directory, 'run-manifest.json'), manifest);
  const checksumNames = [...publicNames, 'run-manifest.json'].sort();
  writeNew(join(directory, 'SHA256SUMS'), checksums(directory, checksumNames));
  return checkE2eProof(config, input, directory);
}

export function checkE2eProof(config, input, bundleDirectory) {
  validateRecord(structuredClone(input), 'e2eProofRequest');
  const directory = resolve(bundleDirectory);
  requireThat(existsSync(directory), 'E2E proof bundle is missing', 'unavailable');
  const manifest = readJson(join(directory, 'run-manifest.json'));
  const expectedFormat = input.format === 'e2e-proof-request-v2'
    ? 'e2e-proof-manifest-v2' : 'e2e-proof-manifest-v1';
  requireThat(manifest.format === expectedFormat &&
    manifest.runId === input.runId && manifest.state === 'draft-pr-validated',
  'E2E proof manifest is invalid', 'invalid-record');
  const expectedNames = manifest.artifacts.map(artifact => artifact.name).sort();
  const actualNames = readdirSync(directory).filter(name =>
    !['SHA256SUMS', 'run-manifest.json'].includes(name)).sort();
  requireThat(json(expectedNames) === json(actualNames),
    'E2E proof bundle contains missing or unexpected artifacts', 'invalid-record');
  for (const artifact of manifest.artifacts) {
    requireThat(hash(readFileSync(join(directory, artifact.name))) === artifact.sha256,
      `E2E proof artifact changed: ${artifact.name}`, 'blocked-reconciliation');
  }
  const checksumNames = [...expectedNames, 'run-manifest.json'].sort();
  requireThat(readFileSync(join(directory, 'SHA256SUMS'), 'utf8') ===
    checksums(directory, checksumNames),
  'E2E proof checksum file changed', 'blocked-reconciliation');

  const sourceArtifact = privateArtifact(input.collection.sourcesPath);
  const corpus = loadFilterCorpus(config, sourceArtifact.value);
  const binding = bindFilterConsolidation(config, input.filter);
  const controllerArtifact = privateArtifact(input.controller.resultPath);
  const appRun = bindAppRun(input, controllerArtifact);
  const controller = publicController(controllerArtifact.value, binding.selected);
  requireThat(manifest.privateBindings.collectionSourcesSha256 === hash(sourceArtifact.bytes) &&
    manifest.privateBindings.filterManifestSha256 === binding.manifestSha256 &&
    json(manifest.privateBindings.filterResultSha256) === json(binding.resultHashes) &&
    manifest.privateBindings.controllerResultSha256 === hash(controllerArtifact.bytes) &&
    (!appRun || (
      manifest.privateBindings.appRunSummarySha256 === hash(appRun.artifact.bytes) &&
      manifest.privateBindings.appRunAssignmentId === appRun.assignmentId
    )),
  'Private E2E proof bindings changed', 'blocked-reconciliation');
  requireThat(json(manifest.window) === json(commonWindow(corpus)),
  'E2E proof source window changed',
  'blocked-reconciliation');
  return {
    state: 'verified-draft-pr-e2e-proof',
    runId: input.runId,
    bundlePath: directory,
    manifestSha256: hash(readFileSync(join(directory, 'run-manifest.json'))),
    artifactCount: manifest.artifacts.length,
    sourceRevision: controller.result.sourceRevision,
    draftPR: controller.result.draftPR
  };
}
