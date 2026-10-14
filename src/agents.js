import { readFileSync } from 'node:fs';
import { hash, requireThat } from './common.js';

const statusOperations = ['app-runs', 'app-status'];
const definitions = {
  collector: {
    skill: 'evidence-collector',
    procedures: [],
    inputs: ['Approved configuration and run/window', 'Source receipts or explicitly authorized source operation'],
    outputs: ['Evidence versions and capture references', 'Run status, cursors and truthful coverage'],
    authority: 'Collection only; no review, repository changes or worker dispatch.',
    operations: [
      'app-begin', 'app-append', 'app-import-parent', 'replay-evidence',
      'app-unavailable', 'app-block', 'app-ado', 'app-ado-reconcile',
      'app-workiq-cli', 'app-workiq-cli-reconcile', 'app-workiq-continue',
      'app-thread-context', 'icm-replay', 'collect',
      'one-shot-begin', 'one-shot-collect', 'one-shot-status', 'one-shot-stop'
    ]
  },
  filter: {
    skill: 'evidence-filter',
    procedures: ['evidence-coordinator', 'evidence-improvement-planner'],
    inputs: ['Exact source-ledger/capture inventory and versions', 'Configured exclusions, review method and coverage skill pins'],
    outputs: ['Source-bound review and analysis results', 'Explicit batch/cohort acceptance, held proposals and blockers'],
    authority: 'Review and planning only; no new source collection, worker execution or publication.',
    operations: [
      'filter-title-index', 'filter-title-materialize', 'filter-batches', 'filter-batch-size',
      'filter-batch-check', 'filter-consolidate', 'filter-execution-check',
      'stage2-handoff', 'stage2-proposal-check', 'app-review', 'app-plan-improvement',
      'review', 'review-pending', 'plan-improvement', 'report', 'replay-review',
      'one-shot-filter-prepare', 'one-shot-filter-reserve'
    ]
  },
  proposer: {
    skill: 'evidence-proposer',
    procedures: ['evidence-1js-owner', 'evidence-office-owner', 'evidence-oa-owner'],
    inputs: ['Authorized durable assignment and exact investigation/evidence versions',
      'Qualified repository skill, source, write bounds and validation gates'],
    outputs: ['Assignment-linked worker results and source-bound validation',
      'Verified draft identity or durable blocked/uncertain state',
      'Separately authorized diagnostic receipts, never validation acceptance'],
    authority: 'Only the assigned repository scope; existing claims, execution and publication guards remain authoritative.',
    operations: [
      'app-worker', 'qualify-skill', 'submit-filter-handoff', 'submit-reviewed-handoff',
      'dispatch', 'reconcile', 'continue-local-validation', 'diagnose-local-validation',
      'continue-local-authoring', 'one-shot-handoff'
    ]
  }
};

function definition(role) {
  requireThat(typeof role === 'string' && Object.hasOwn(definitions, role),
    'Unknown agent role; expected collector, filter or proposer', 'blocked-agent');
  return definitions[role];
}
function skillReference(name) {
  const path = `.github/skills/${name}/SKILL.md`;
  return { name, path, sha256: hash(readFileSync(new URL(`../${path}`, import.meta.url))) };
}
export function describeAgent(role) {
  const value = definition(role);
  return {
    format: 'agent-definition-v1', role,
    skill: skillReference(value.skill),
    procedures: value.procedures.map(skillReference),
    inputs: [...value.inputs], outputs: [...value.outputs],
    operations: [...statusOperations, ...value.operations],
    authority: value.authority,
    inputContract: 'Existing helper arguments and JSON schemas; configuration is not modified by the facade.',
    resultContract: 'agent-operation-result-v1 wraps the unchanged helper result; it does not attest role completion or acceptance.',
    stateOwner: 'Existing local ledger and immutable artifacts, not the executing conversation.',
    resumePolicy: 'Read persisted state; preserve blocked/uncertain attempts and authorization. Never reset, retry or redispatch implicitly.'
  };
}
export function describeAgents() {
  return Object.keys(definitions).map(describeAgent);
}
export function agentInvocation(role, operation) {
  const value = definition(role);
  requireThat(operation === 'help' || statusOperations.includes(operation) || value.operations.includes(operation),
    'Operation is not available for this agent role', 'blocked-agent');
  return { role, operation };
}
export function agentOperationResult(invocation, result) {
  return {
    format: 'agent-operation-result-v1', ...agentInvocation(invocation?.role, invocation?.operation),
    kind: 'result', acceptance: 'not-inferred', result
  };
}
export function agentOperationError(invocation, error) {
  return { format: 'agent-operation-result-v1',
    ...agentInvocation(invocation?.role, invocation?.operation), kind: 'error', error };
}
