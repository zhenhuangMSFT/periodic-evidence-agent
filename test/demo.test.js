import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('account-free demo exercises FILTER and proposer gates without promoting synthetic collection', t => {
  const root = mkdtempSync(join(tmpdir(), 'pilot-demo-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/demo.mjs', import.meta.url))],
    { cwd: root, encoding: 'utf8', timeout: 180000,
      // PowerShell needs PATHEXT to execute native .exe commands rather than silently doing nothing.
      env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '',
        PATHEXT: process.env.PATHEXT ?? '', TEMP: root, TMP: root,
        HOME: root, USERPROFILE: root, COPILOT_HOME: root, AZURE_CONFIG_DIR: root } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.result, 'synthetic-demo-passed');
  assert.equal(output.provenance, 'synthetic');
  assert.equal(output.uniqueEvidence, 3);
  assert.equal(output.overallCollectionState, 'partial-or-blocked');
  assert.equal(output.collectionWorkers, 0);
  assert.equal(output.scheduleEnabled, false);
  assert.deepEqual(readdirSync(root), ['.state']);
  assert.equal(readdirSync(join(root, '.state')).length, 1);
  assert.ok(output.stateDirectory.startsWith(join(root, '.state', 'demo-')));
  assert.equal(JSON.parse(readFileSync(output.summaryPath, 'utf8')).provenance, 'synthetic');
  const workflow = output.workflow;
  assert.equal(workflow.sourceLedgerUnchanged, true);
  assert.deepEqual(JSON.parse(readFileSync(workflow.artifactPath, 'utf8')),
    Object.fromEntries(Object.entries(workflow).filter(([key]) => key !== 'artifactPath')));
  assert.equal(workflow.filter.state, 'complete-held');
  assert.equal(workflow.filter.batches, 2);
  assert.equal(workflow.filter.reviewedEvidence, 3);
  assert.equal(workflow.filter.rankedCandidates, 2);
  for (const guard of ['missingBatchBlocked', 'partialBatchBlocked', 'conflictingResultBlocked',
    'stalePayloadRejected', 'incompleteDetailRejected', 'duplicateResultDeduplicated',
    'missingSharingRejected', 'budgetOverflowRejected', 'noCandidateWithoutDispatch'])
    assert.equal(workflow.filter[guard], true, guard);
  assert.equal(workflow.filter.sourceCoverageComplete, false);
  assert.equal(workflow.filter.executionQualified, false);
  assert.equal(workflow.filter.semanticAnalysisVerifiedByHelper, false);
  const manifest = JSON.parse(readFileSync(workflow.filter.manifestPath, 'utf8'));
  const consolidation = JSON.parse(readFileSync(workflow.filter.consolidationPath, 'utf8'));
  assert.equal(manifest.batches.length, 2);
  assert.equal(consolidation.selected.evidenceIds.length, 3);
  assert.equal(consolidation.selected.definition.missingAssertion, workflow.filter.selectedInvariant);
  assert.equal(workflow.proposer.mode, 'synthetic-reviewed-handoff');
  assert.equal(workflow.proposer.publication, 'simulated');
  assert.equal(workflow.proposer.directSyntheticHandoffRejected, true);
  assert.equal(workflow.proposer.permissionGatesEnforced, true);
  assert.equal(workflow.proposer.realModelCalls, 0);
  assert.equal(workflow.proposer.realPushes, 0);
  assert.equal(workflow.proposer.realDraftPRs, 0);
  assert.deepEqual(workflow.proposer.scenarios.map(s => [s.scenario, s.outcome]), [
    ['failed-validation', 'blocked'], ['stale-head', 'blocked'], ['success', 'draft-pr-validated']
  ]);
  for (const scenario of workflow.proposer.scenarios) {
    assert.equal(scenario.counts.authoring, 1);
    assert.equal(scenario.counts.simulatedPush, scenario.scenario === 'success' ? 1 : 0);
    assert.equal(scenario.counts.simulatedDraft, scenario.scenario === 'success' ? 1 : 0);
    assert.equal(scenario.duplicateDispatchRejected, true);
    assert.deepEqual(scenario.validation.map(gate => gate.gateId).sort(), ['behavior', 'syntax']);
    for (const gate of scenario.validation) {
      assert.equal(gate.attemptCount, 1);
      const artifact = JSON.parse(readFileSync(gate.artifactRefs[0], 'utf8'));
      assert.equal(artifact.revision, scenario.sourceRevision);
      if (scenario.scenario === 'stale-head') assert.notEqual(gate.sourceRevision, scenario.sourceRevision);
      else assert.equal(gate.sourceRevision, scenario.sourceRevision);
      if (gate.gateId === 'behavior') {
        assert.equal(gate.status, scenario.scenario === 'failed-validation' ? 'failed' : 'passed');
        assert.match(artifact.output.stdout, /Active items retain source order/);
        assert.match(artifact.output.stdout, /^# tests 2\r?$/m);
        assert.match(artifact.output.stdout, /^# skipped 0\r?$/m);
      }
    }
  }
  const success = workflow.proposer.scenarios.at(-1);
  assert.equal(success.draftPR.headRevision, success.sourceRevision);
  assert.ok(success.validation.every(gate => gate.status === 'passed'));
  const savedConfig = JSON.parse(readFileSync(output.configPath, 'utf8'));
  assert.deepEqual(savedConfig.activation, { collect: false, review: false, dispatch: false });
});

test('Windows demo rejects an environment that can silently skip native validation',
  { skip: process.platform !== 'win32' }, t => {
    const root = mkdtempSync(join(tmpdir(), 'pilot-demo-env-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const result = spawnSync(process.execPath,
      [fileURLToPath(new URL('../scripts/demo.mjs', import.meta.url))],
      { cwd: root, encoding: 'utf8', timeout: 30000,
        env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', PATHEXT: '' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires PATHEXT including .EXE/);
    assert.doesNotMatch(result.stdout, /synthetic-demo-passed/);
    assert.deepEqual(readdirSync(root), []);
  });
