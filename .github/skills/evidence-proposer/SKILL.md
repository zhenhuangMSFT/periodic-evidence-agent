---
name: evidence-proposer
description: >-
  Execute the Proposer role of periodic-evidence-agent for an authorized durable
  repository assignment, selecting its existing repo-owner skill and returning
  source-bound results. Not for new evidence collection, FILTER review or
  unassigned product development.
---

# Proposer agent entrypoint

This is the repository execution role, not another scheduler or publisher.
Use the existing assignment, claim and selected executor; do not launch a
parallel worker. A session or hosted job is an execution handle, not ownership.

## Input

Receive the selected configuration and a durable, authorized assignment with
its exact investigation/evidence versions, qualified repository skill/source,
write bounds, validation gates and permissions. For app-native work retain the
configured coordinator identity, claim and bound execution handle.

Use `npm run pilot -- agent proposer help` to discover the versioned descriptor.
Facade commands delegate to existing helpers without relaxing their guards:

```powershell
npm run pilot -- agent proposer app-worker --run RUN_ID --production --operation result --file result.json --config pilot.local.json
```

A role selection, prepared assignment or `--production` flag is not permission
to execute. Synthetic reviewed-handoff support cannot substitute for real
source ingestion or an accepted real FILTER handoff.

For a fresh bounded cohort, use
[`one-shot-handoff --check|--execute`](../../../ONE-SHOT.md) instead of
inferring acceptance from structural consolidation alone. It requires the exact
complete collection receipt, pre-reserved cohort budgets and accepted immutable
FILTER executions. Real authenticated collection-only WorkIQ captures keep
their provenance through the separately authorized handoff. No-candidate ends
without dispatch; partial coverage never counts as no-candidate success.

## Repository procedure

Select only the configured assignment's owner procedure:

| Repository | Procedure |
|---|---|
| `1js` | [1JS owner](../evidence-1js-owner/SKILL.md) |
| `office-src` | [Office owner](../evidence-office-owner/SKILL.md) |
| `office-agent` | [OfficeAgent owner](../evidence-oa-owner/SKILL.md) |

An unknown repository or missing qualification is blocked, not guessed.
These are internal implementations of Proposer, not additional top-level roles.
Follow the selected procedure and source-pinned native skill in the isolated
workspace. Never execute in the reference checkout.

Keep the existing backend in charge. The restricted SDK model submits through
`pilot_finish`; the controller owns validation and publication. App-native work
uses its existing host permissions and claim/bind/result protocol. Do not create
an alternate worker, publisher, validation runner or local/hosted failover path.

## Output and resumption

Return the assignment-linked durable worker result, evidence references,
changed source revision, per-gate native results, and verified draft identity
when authorized and actually published. Otherwise return an explicit blocked,
held or uncertain state with owner and unblock condition.

A helper returning a result does not establish validation or publication
success. Every gate must pass at the exact clean publication HEAD; prior
qualification on another source revision is not changed-case validation.

Preserve failed and pre-model blocked attempts. Resume only through the existing
reconciliation path and concrete continuation authorization. Never reset the
ledger or blindly redispatch because no model call was recorded.
The one-shot path permits one explicit `--resume-auth` only after a positively
recorded pre-dispatch authentication block and supported remediation, while the
same local assignment has no workspace, result or worker/provider operation.
Unknown dispatch outcomes or a second auth failure remain blocked.

For an already-authored candidate, use
`agent proposer continue-local-validation --prepare|--execute` only under the
[recorded handoff contract](../../../APP-NATIVE.md#recorded-source-role-handoff)
and its separately authorized validation-only continuation. The actual Collector
and FILTER replay receipts must match the original worker ledger. Keep the
original model proposal and source revision; this operation must not invoke a
new authoring model or create another candidate commit.

## Authority

No new evidence collection, reinterpretation of FILTER acceptance, permission
expansion, uncontrolled retries, duplicate workers, merge or deployment.
Respect the configured budgets and source/publication gates. Skills are
procedures, not OS sandboxes.
