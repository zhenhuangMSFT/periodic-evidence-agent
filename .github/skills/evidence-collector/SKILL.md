---
name: evidence-collector
description: >-
  Collect or import scoped WorkIQ and ADO evidence for the periodic-evidence-agent
  pilot, resume a recorded collection pass, or report source coverage. Use for
  evidence collection only, not finding review, code changes, or worker dispatch.
---

# Evidence collector

You perform the collector role of an independent logical agent. A conversation
is a temporary executor, not the agent's identity or state store. Do not spawn
agents merely because this skill was selected.

This is the top-level Collector entrypoint, alongside `evidence-filter` and
`evidence-proposer`. `npm run pilot -- agent collector help` describes its
inputs, outputs and supported helper operations. Invoke an existing helper as
`npm run pilot -- agent collector app-status --run RUN_ID --config pilot.local.json`.
The facade preserves its existing arguments, schemas and permission gates;
its result envelope is not a new authorization or completeness assertion.

For an explicitly selected saved-source handoff, `agent collector replay-evidence`
imports pinned original records/captures into a held audit ledger with collection
and dispatch disabled. Label it saved-evidence import, not a fresh source read.
Follow the [recorded handoff contract](../../../APP-NATIVE.md#recorded-source-role-handoff);
the receipt preserves original provenance and never establishes full coverage.

For an explicitly authorized fresh bounded cohort, use the
[one-shot controls](../../../ONE-SHOT.md): `one-shot-begin`, `one-shot-collect`,
`one-shot-status` and `one-shot-stop`. These call the existing collectors with
aggregate full-pass reservations. Resume uncertain work through durable offline
reconciliation, never another read. A cooperative stop may resume only pending
passes within the original approval. The host still drives subsequent stages;
complete collection ends held, not dispatched.

## Inputs and durable state

Read [the app-native contract](../../../APP-NATIVE.md), the selected pilot
configuration, and current run status before acting. Use the configuration's
stable agent ID; do not change it or the configuration of an existing run.
The collector and reviewer skills currently share that durable coordinator
identity. They are separate procedures, not separately provisioned services.

Run helpers from the pilot project root, not a product checkout. Use the same
explicit `--config <path>` on every command when a non-default config is chosen.

```powershell
npm run pilot -- app-runs
npm run pilot -- app-status --run RUN_ID
```

If there is no appropriate run, create a begin JSON using the contract and use
`app-begin --file <file>`. Do not invent authorization for a new live scan.
An approved dry run stays collection-only in its isolated namespace.

## Procedure

1. Check the approved window, exact source scopes, local evidence-storage
   approval, budgets and existing source blockers. Distinguish an incomplete
   run from an unstarted run. Never repeat a journaled source operation merely
   because the executor changed.
2. For WorkIQ, use the executing app host's native WorkIQ tools and the WorkIQ
   skill when available. Verify that host's exact `/me` ID and UPN against the
   designated identity before collection. Another session's identity receipt
   is evidence of its execution only, not authorization proof for this host.
   Do not use standalone SDK WorkIQ, copy tokens or substitute Graph.
   An explicitly authorized local WorkIQ CLI run may instead use the binding in
   APP-NATIVE.md, with its own identity check and distinct `workiq-cli-verified`
   provenance. Never switch to it automatically after an app auth failure.
   Preserve earlier blocked runs. Renewal qualification is separately deferred;
   no auth probe or scheduled retry follows from collection authorization.
3. Persist exact permitted call responses incrementally with
   `app-append --run RUN_ID --file <receipt-batch>`. Preserve request path,
   tool-call identity, UTC observation time, revisions, asOf and nextLink.
   Never include transport headers, cookies, credentials or a model-generated
   replacement for the response. Imported evidence remains
   `app-tool-reported`; synthetic evidence remains `synthetic`.
4. Follow only the validated next request. Exhaust roots and replies, including
   replies to older roots, before claiming channel completeness. Metadata-only
   reads leave bodies/revisions unknown. Keep examined-item and read-call counts
   separate from in-window findings. Stop at the approved cap, with pending
   work visible; never use follow-up allowances to extend initial enumeration.
   A budget stop can only continue in a distinct run after explicit additional
   budget authorization: use `app-workiq-continue --from-run OLD --run NEW
   --pass workiq:created --authorize-additional-budget` with the same config.
   Preparation is offline, reserves one child, and preserves buffered page rows.
   Source execution is a separate explicitly authorized `app-workiq-cli --collect`
   command; the old run stays exhausted. Never continue auth/uncertain failures,
   retry expired nextLinks or restart from the head silently.
   Use `app-thread-context` for retained examined roots/replies and provenance;
   out-of-window context is not an eligible finding. `workiq:changed` is a
   separately authorized full enumeration requiring modified timestamps, not
   an implicit second pass. No WorkIQ delta contract is established. Root
   timestamps do not justify skipping reply chains. Exhaustion is not a
   historical snapshot or proof that concurrent edits/deletions were captured.
5. For an authorized ADO pass, use `app-ado --run RUN_ID --pass ado:created
   --collect`, then the separately approved `ado:changed` pass. The adapter
   verifies delegated identity and scopes queries. A parser failure after
   receipt persistence calls for offline `app-ado-reconcile`, not another
   network collection. Do not merge changed-only counts into new-cohort counts.
6. Record unavailable IcM with `app-unavailable`; absence of an approved
   connector is unknown coverage, not zero incidents. Do not follow related
   evidence outside the approved depth/items/calls/scope. These helpers do not
   automatically perform related-evidence collection. Connector identity success
   and team/severity mapping do not establish saved-query timestamp equivalence.
   `icm-replay` accepts already captured connector receipts **offline**, in a
   separate audit namespace, under the contract in APP-NATIVE.md. It never
   launches a connector, advances a source cursor or replaces Source Created
   Time with incident `createdDate`. Preserve a scope blocker separately from
   authentication failures.
7. End by reading `app-status` and handing off its durable summary path and
   run ID. No handoff depends solely on this chat or temporary session files.

## Failure and success criteria

On explicit authentication failure, persist the expected-call failure or use
`app-block` for an in-scope terminal authentication failure. Stop all WorkIQ
reads; do not retry until supported host refresh and a new authorized attempt.
Do not infer missing scopes, wrong identity or token expiry from a generic error.
Retain successful partial evidence and prior committed cursors.

Success means the permitted evidence/receipts and truthful per-pass coverage
are persisted. Only exhausted passes are complete; partial, blocked,
unavailable and no-records-complete are different outcomes. Report identity
verification method, source counts/IDs, missing coverage and summary path.
Collection success is not eligibility, defect confirmation or pilot qualification.

## Authority

No model classification, review submission, repository edits, worker creation,
PRs, source writes, validation runs or scheduling. Do not change activation,
identity, scope or budget settings to make a command pass.
