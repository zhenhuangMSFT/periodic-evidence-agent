# Bounded one-shot coordinator controls

These opt-in controls add aggregate reservations, safe resumption and a stricter
accepted-cohort release gate to the existing local ledger and helpers. The
coordinating Copilot session/host still orchestrates the work. They are **not a
new service, scheduler or working unattended end-to-end runner**.

| Boundary | What the helper does | What the authorized host must supply |
| --- | --- | --- |
| Collection | Runs the existing local ADO and explicitly selected WorkIQ CLI collectors, sequentially | Approved identity, scope, window, finite budgets and working authentication |
| FILTER preparation | Checks full captured corpus, reserves the entire cohort's task/time/token capacity before any task reservation | Explicit grouping/sharing decisions, verified tokenizer and qualified source/task/runtime bindings |
| FILTER reservation | Calls the existing `reserveAgencyRequest`, preserving its concurrency, uncertainty and qualification guards | Exact original request bytes, fresh source preflight and token receipt |
| FILTER execution | **No submission, observation or polling client is provided** | Existing approved external executor and inspected, immutable submission/result receipts |
| Held release | Reproduces complete source and execution acceptance; selects at most the existing top candidate | Separately authorized local proposer configuration and qualified repository skill |
| Proposer | Calls the existing local dispatcher once; reads its persisted results on resume | Existing model, repository, native test and publication bindings |

No approval is inferred from calculated hashes, a role name, a green pipeline,
structural result validation or saved replay. Live IcM remains unqualified.
Browser E2E qualification is separate from integration-first proposer work.
Missing sources, permissions, authentication, execution evidence or budgets
remain actionable holds. These controls do not modify legacy selected-case,
saved-evidence/review replay or validation-continuation behavior.

## Collection

Keep the original collection configuration separate from the proposer/execution
configuration. Use approved private paths and keep these files out of Git.
Scheduling must be disabled. The following values are **synthetic contract
examples, not a live authorization**:

```json
{
  "format": "one-shot-collection-v1",
  "runId": "example-one-shot",
  "owner": "approved-coordinator",
  "dryRun": true,
  "passes": ["ado:created", "ado:changed", "workiq:created"],
  "authorization": {
    "approvedBy": "authorizing-user",
    "approvedAt": "2026-10-14T00:00:00Z",
    "approvalRef": "private:explicit-collection-decision",
    "deadlineAt": "2026-10-14T01:00:00Z",
    "maxItems": 6000,
    "maxCalls": 900
  }
}
```

Each selected pass reserves its **full configured** `maxItems`/`maxCalls` cap
before any reads, including identity calls within the read budget. The totals
must fit the explicit aggregate approval; unused capacity is not recycled.
Reservations remain charged after incomplete or uncertain operations. All
enabled source kinds must have their created pass selected; no implicit source
exclusion or changed pass is added. These are examination/read limits, not a
claim that all returned records fit or that findings equal daily totals.

```powershell
npm run pilot -- agent collector one-shot-begin --file collection.local.json --config collector.local.json
npm run pilot -- agent collector one-shot-collect --run example-one-shot --collect --config collector.local.json
npm run pilot -- agent collector one-shot-status --run example-one-shot --config collector.local.json
npm run pilot -- agent collector one-shot-stop --run example-one-shot --config collector.local.json
# Only a cooperative stop, not an auth/partial/uncertain failure, may resume new passes.
npm run pilot -- agent collector one-shot-collect --run example-one-shot --collect --resume --config collector.local.json
```

`begin` records immutable authorization/configuration and a unique app-run
identity; it does not collect. `collect` executes only the selected existing
adapters. A stop takes effect between passes, not by cancelling an in-flight
source request. `deadlineAt` is the last permitted **start** time for another
pass; existing per-request timeouts and per-pass budgets still apply.

Fresh collection requires unused isolated app storage. Existing imports,
continuation runs and shared production collection ledgers cannot be adopted
as a fresh one-shot. WorkIQ retains its supported collection-only/dry-run
namespace. That storage flag is **not synthetic or replay provenance**:
identity-verified reads retain `workiq-cli-verified` and may support the separate
authorized handoff. No review or worker is launched in the collection ledger.
The stricter path accepts only its own complete direct-adapter passes; app
receipt imports remain available through their existing, separately labeled path.

Complete selected coverage produces `held-awaiting-filter` and a collection
receipt SHA. The receipt pins run configuration, exact corpus/captures, pass
results, transport, events and helper operations. This means the selected
enumeration completed, not historical reconstruction or a semantic review.
Partial collection never advances that pass's cursor or unlocks proposer work.
Already completed pass cursors retain their existing semantics.

On restart, the helper reads the journal before acting. Started operations are
reconciled from stored transport only. For ADO's crash window after receipt
acceptance, it checks that the accepted event contains the exact transport
calls before finalizing the operation; it does not import those calls under a
new event ID. An uncertain dispatch with no recorded helper outcome stays
blocked. Locks are never stolen; use the existing exact-owner recovery
procedure only after verifying the recorded process is gone.

## Reserve FILTER before the external executor acts

Use existing `filter-batches` preparation with explicit full grouping and
material-sharing approval. Every record remains in the manifest. This path
requires verified tokenizer accounting: the existing estimated **bounded-replay**
exception is not silently expanded to fresh execution.

Prepare a private handoff request after collection/batch preparation but
**before any FILTER task reservation**:

```json
{
  "format": "one-shot-handoff-v1",
  "owner": "approved-coordinator",
  "collection": {
    "stateDirectory": "C:\\private\\collector-state",
    "runId": "example-one-shot",
    "receiptSha256": "<exact collection receipt SHA256>"
  },
  "filter": {
    "manifestPath": "C:\\private\\manifest.json",
    "manifestSha256": "<exact file SHA256>",
    "executionLedgerPath": "C:\\private\\filter-state\\ledger.sqlite",
    "resultPaths": ["C:\\private\\batch-one-result.json"]
  },
  "routing": { "capability": "integration-test-authoring" },
  "authorization": {
    "approvedBy": "authorizing-user",
    "approvedAt": "2026-10-14T00:10:00Z",
    "approvalRef": "private:explicit-filter-and-proposer-decision",
    "deadlineAt": "2026-10-14T01:00:00Z",
    "maxFilterRequests": 1,
    "maxFilterExecutionSeconds": 600,
    "maxFilterReservedTokens": 20000,
    "maxProposers": 1,
    "maxProposerAiCredits": 3,
    "authorizeCommit": true,
    "authorizePush": true,
    "authorizeDraftPR": true
  }
}
```

Supply one future result path per batch. The same exact request and normalized
proposer configuration are used for reservation, checking and release. Source
collection keeps its original configuration. The execution ledger must already
contain the approved per-task qualifications. Its dedicated `agency.budgetId`
must be unused by other requests/cohorts, and `agency.maxRequests` must fit this
authorization.

```powershell
npm run pilot -- agent filter one-shot-filter-prepare --file handoff.local.json --config proposer.local.json
npm run pilot -- agent filter one-shot-filter-reserve --file handoff.local.json --task BATCH_ID --request exact-reservation.local.json --config proposer.local.json
```

The first command reserves the sum of every selected task's duration and
verified input plus qualified output-token capacity. `maxFilterReservedTokens`
is that capacity accounting, **not measured total model usage or an external
provider's billing ceiling**. The qualified external executor must enforce its
own model/tool/runtime contract; this helper cannot attest private executor
behavior. Proposer credits conservatively reserve the configured per-session
ceiling for the initial model session and every permitted repair round.

The second command accepts the unchanged `reserveAgencyRequest` input
(`request`, `requestSha256`, `preflight`, `tokenBudget`), not an invented provider
schema. It journals intent but makes no HTTP request. Do not call it again for
an existing task: observe/reconcile the original immutable request instead.
Shared concurrency and rejected/uncertain-request stops remain authoritative.
See [AGENCY-EXECUTOR.md](AGENCY-EXECUTOR.md) for approved external submission,
inspection and result recording. No fallback client or model is installed by
these commands. The coordinating host retains ownership while that binding is
missing or awaiting observations.

## Check and release the held cohort

```powershell
npm run pilot -- agent proposer one-shot-handoff --check --file handoff.local.json --config proposer.local.json
# Separate explicit execution authorization:
npm run pilot -- agent proposer one-shot-handoff --execute --authorize-commit --authorize-push --authorize-draft-pr --file handoff.local.json --config proposer.local.json
```

The checker rereads immutable collection pins and reproduces
`reconcileFilterExecutionCohort` using original terminal receipts. Every batch
must match the pre-execution aggregate reservation, original request, selected
source and exact result bytes. Prospective historical policy evaluations cannot
be substituted. Missing, failed, conflicting or changed batches stay blocked;
partial coverage is never a successful empty candidate set.

A complete accepted cohort with no eligible candidate ends
`complete-no-candidate`, with no assignment/model/PR. Otherwise `--check` records
`complete-held`, without preparing a product worker. `--execute` requires the
same input/configuration, unexpired authorization, qualified skill side effects
and existing finite worker/tool/time/credit limits. It prepares at most one
local assignment and persists dispatch intent before the existing dispatcher.
The worker retains its source/skill/write bounds, authentication broker,
trusted cache reuse, exact-clean-HEAD pass-only publication and opt-in cleanup.

Resume reads the same attempt and results; it never automatically relaunches a
worker, retries validation, resets a sealed attempt or creates a replacement PR.
A completed result must retain the original attempt and every exact-head passing
gate. An uncertain or partial publication remains blocked for external
reconciliation.

The sole explicit retry is a positively returned **pre-dispatch**
`action-required-auth`. The original local assignment must still be `prepared`
with the same pins, no workspace/base revision, no worker result and no recorded
worker/provider operation or cleanup. Follow the existing auth remediation
instructions: obtain installation approval if required, run only the exact
remediation from its declared working directory, never copy/capture tokens, and
complete sign-in/MFA outside this helper. Then add `--resume-auth` to the
authorized `--execute` command **once**. Changed eligibility, ambiguous errors,
an interrupted dispatch or a second auth failure do not permit another retry.
Trusted dependency-cache hits are not invalidated to force authentication.

The module APIs mirror the CLI: `beginOneShotCollection`,
`advanceOneShotCollection`, `stopOneShotCollection`, `oneShotCollectionStatus`,
`prepareOneShotFilterBudget`, `reserveOneShotFilterRequest` and
`advanceOneShotHandoff`. They are callable by the existing coordinating host;
they do not automatically schedule that host's next turn.
