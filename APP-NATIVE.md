# Independent agents: manual app-hosted pilot

## Project skills

There are exactly three top-level role entrypoints: `evidence-collector`,
`evidence-filter` and `evidence-proposer`. The procedures below implement these
roles; they are not additional workers to launch.

`npm run pilot -- agents` returns their versioned descriptors and pinned skill
references. `npm run pilot -- agent ROLE EXISTING_COMMAND ...` delegates an
allowed operation to the same helper documented below, preserving its arguments,
source/permission checks, ledger ownership and exit behavior. Use
`agent ROLE help` for the role's operation list.

The facade wraps accepted invocations as `agent-operation-result-v1` with the
original result or safe error. It does not infer role success or acceptance from
helper completion: retain all exact-source references, explicit partial/held/
blocked/uncertain states and the underlying batch/cohort/assignment contract.
No live source read, provider submission, dispatch or continuation is authorized
by the facade itself. It never invokes a second worker/publisher implementation.

Role procedures live in `.github\skills` and can be shared with this repository:

| Skill | Role |
|---|---|
| `evidence-collector` | Scoped source reads, receipt import, paging and coverage |
| `evidence-coordinator` | Exclusion review, ownership, atomic assignment and reconciliation |
| `evidence-improvement-planner` | Area aggregation, test discovery/linking and qualified capability selection |
| `evidence-1js-owner` | Claimed 1JS RCA/fix/validation work |
| `evidence-office-owner` | Claimed Office src RCA/fix/validation work |
| `evidence-oa-owner` | Claimed OfficeAgent integration-test work through its repo-native skill |

Ask a skills-capable Copilot host to use the named skill for the corresponding
task, for example: "Use evidence-collector to inspect the existing run's status;
do not make source calls." Reload/reopen the project if the host has not yet
discovered newly added project skills. No global installation was performed.
Product project sessions do not automatically inherit this project's skill
files; supply the selected procedure and durable assignment when handing off.

`send-teams-notification` is a separate reusable utility for explicitly
authorized channel messages from any task/session. It uses the configured Flow
bot sender, optional verified user mentions and shared durable delivery
receipts. It is not a fourth role, a scheduler, or a new `agent ROLE` operation.
See [its procedure](.github/skills/send-teams-notification/SKILL.md) and
[sender setup](README.md#explicit-teams-notifications). Another project can
load the utility by adding this notification checkout as an allowed directory;
the executing identity still needs its own approved configuration and Azure
permissions. No role-specific publication restriction is overridden.

Skills separate procedures, not operating-system permissions or running agents.
They neither launch sessions nor authorize scans just by being installed.
The collector and reviewer currently share the configured durable coordinator
identity; the two repo owners retain their distinct logical IDs. This change
does not create separate daemons, enable automation, change approved scopes or
remove activation gates. The shared repo-owner reference avoids diverging
validation and draft-only policies.

## Recorded-source role handoff

These role operations connect a selected, genuine saved source and its original
decisions to an already-authored candidate. They do not collect new data, run a
new review model, accept an entire FILTER cohort, or authorize execution.

```powershell
npm run pilot -- agent collector replay-evidence --file captured-inputs.json --config held-replay.local.json
npm run pilot -- agent filter replay-review --file recorded-review.json --config held-replay.local.json
npm run pilot -- agent proposer continue-local-validation --prepare --file continuation.json --config next.local.json
npm run pilot -- agent proposer continue-local-validation --execute --file execution.json --config next.local.json
```

Collector and FILTER use a separate approved audit ledger, with collection and
dispatch disabled. Review activation and the original configured review method
remain required. All artifact references are `{path, sha256}` pairs with absolute
paths and exact file-byte hashes. Outputs retain the outer role envelope;
the underlying `recordedRoleHandoff` identifies a persisted receipt by
`stateDirectory`, `operationId` and canonical receipt SHA256.

Collector input is `recorded-evidence-replay-v1` with an explicit nonempty
`evidence` array of `{record, capture}` artifact references, bounded by the
configured `limits.maxItems`. It validates and
imports exact source records and canonical capture bytes through the existing
evidence importer. Original identities, provenance and observation times remain
unchanged; the new receipt records import time, controller/skill pins and source
references, never fresh-source coverage.

FILTER input is `recorded-review-replay-v1` with `collectorReceipt` plus pinned
`review` (investigation and full `exclusionsChecked`), `improvement`,
`testCoveragePlan`, `planningInput` and original `assignment` artifacts.
`inputProvenance.mode` must be `captured-inputs` or
`recovered-input-projection`; recovery additionally requires pinned `sources`
such as the original review notebook and assembly script. Recovery artifacts are
read as data, never executed. Replaying inputs must reproduce the exact original
decision records, versions and timestamps. Output remains held, with no new
review or full-cohort acceptance.

Proposer retains the standalone-execution mode guard and requires exactly one
of `--prepare` or `--execute`. Preparation input
contains `previousConfigPath`, `previousAssignmentId`, `authorization`,
`preservedProposal` and `recordedRoleHandoff` from FILTER. The adapter checks the
entire imported evidence/review/plan/capture chain against the prior worker
ledger before calling the guarded validation-continuation helper. The successor
worker ledger remains separate and initially empty. Execution input is
`{assignmentId}` from preparation; it uses the canonical validation-only
dispatcher and publisher, not another model run or commit.

A separately authorized `authorization.kind: discovery-placement` follow-on keeps
`previousConfigPath` and `previousAssignmentId` bound to the immediately failed
continuation. The core must validate its immutable original-model lineage before
the adapter opens the original authoring ledger read-only to verify the saved
Collector/FILTER receipts. Preparation pins that origin separately; execution
rechecks both identities. This does not replay collection/review or convert a
zero-test invocation into successful validation. The new private runtime root
must be ignored before use and avoid the diagnosed Windows hidden-ancestor path
problem. General test failures remain ineligible for this narrow correction.

A measured `native-workspace-bin-path` successor is limited to a sealed
`native-launcher-cache-path` attempt whose targeted case passed and whose required
native wrapper then failed to resolve the declared root `gulp` tool before case
execution. An offline synthetic comparison must establish the exact correction:
launch that same wrapper through `corepack yarn node`, retaining its quoted
separator, child command and assertions byte-for-byte. No global tool install,
shared PATH change, dependency substitution or product edit is allowed. The
original separator/cache evidence is rechecked at dispatch and publication;
both native legs, fresh-cache emitted-import proof and pass-only publication
remain mandatory. Execution still uses the same zero-model CLI and a fresh,
one-shot reservation, never a reset or retry of the failed attempt.

Authorization must bind the actual controller/configuration, preserved proposal
and candidate, prior attempt and approved preparation changes. Previous failures
remain unchanged. Missing, conflicting or superseded records block continuation.
Preparation, import and a successful result envelope are not native test or
publication evidence; require terminal source-bound results and verified draft
identity from execution.

## Diagnostic-only local follow-on

An actual case failure does not qualify for the zero-body discovery correction.
A separately authorized diagnostic can measure that failure without resetting
the attempt or treating diagnostic output as validation:

```powershell
npm run pilot -- agent proposer diagnose-local-validation --prepare --file diagnostic-request.json --config diagnostic.local.json
npm run pilot -- agent proposer diagnose-local-validation --execute --file diagnostic-execution.json --config diagnostic.local.json
```

Both commands require explicit `--file`, `--config` and exactly one mode, and
retain the standalone-execution guard. Preparation passes the unchanged request
to `prepareLocalValidationDiagnostic(config, ledger, input)`. Its input contains
`previousConfigPath`, `previousAssignmentId`, `authorization`, `sealed`
(`terminalReport`, `rawCase`, `nativeArtifact`, `preparedReceipt`),
`instrumentation`, `test` (`path`, `name`, `packageName`) and
`recordedRoleHandoff`. The core owns all authorization, sealed-artifact,
original-role lineage and instrumentation checks; the facade grants none.

The diagnostic config may change only `stateDirectory` and disable collection,
review and dispatch. Keep its new private runtime ignored and avoid Windows
hidden-ancestor discovery failures. The predecessor ledger is read-only.
Snapshot reuse must fail closed rather than silently reinstalling dependencies.
Disposable instrumentation leaves the original candidate, assertions and
timeout unchanged.

Execution accepts only `{diagnosticId}` from preparation and calls
`dispatchLocalValidationDiagnostic(config, ledger, diagnosticId)` without
injected dependencies. Its diagnostic receipt is returned unchanged inside the
usual role envelope with `acceptance: not-inferred`, never as a `workerResult`
or validation acceptance. Its explicit `acceptanceEvidence` and
`publicationEligible` flags remain false. A returned `diagnostic-failed` receipt
is still printed in full with exit code 2; rejected operations use the existing
safe error envelope and exit code 1. The operation does not author, commit, push
or create a PR. Keep the prior failure and any unexecuted native legs in the
reconciliation;
even a passing diagnostic cannot satisfy publication gates.

## Model-backed local authoring successor

A measured setup-time failure can support a separately authorized, bounded
authoring successor. This is a new model-backed attempt, not a zero-model
validation continuation or an automatic retry of an exhausted assignment:

```powershell
npm run pilot -- agent proposer continue-local-authoring --prepare --file authoring-request.json --config successor.local.json
npm run pilot -- agent proposer continue-local-authoring --execute --file authoring-execution.json --config successor.local.json
```

The CLI requires explicit `--file`, `--config` and exactly one mode, and retains
the standalone-execution guard. It forwards preparation input unchanged to
`prepareLocalAuthoringSuccessor(config, ledger, input)`. The core owns the
one-shot reservation, user authority, original recorded-role provenance,
sealed failed attempt and diagnostic lineage, source/write bounds and model
budget. A diagnostic result cannot itself grant that authority.

Preparation input contains exactly `diagnosticConfigPath`, `diagnosticReceipt`,
`diagnosticReport`, `sourceReview`, `userAuthorization` and `authorization`.
The four artifact references are absolute `{path, sha256}` pairs. Authorization
requires `approved: true`, `authorizedBy: user`,
`kind: diagnosed-suite-module-loading`, `maxModelAttempts: 1`, `recordedAt`,
`sourceRevision`, `controllerRevision`, `nextConfigSha256` and `inputsSha256`.
The latter hashes the UTF-8 `JSON.stringify` of an object whose keys are inserted
in this order: `diagnosticConfigPath`, `diagnosticReceipt`, `diagnosticReport`,
`sourceReview`, `userAuthorization`. `nextConfigSha256` binds the resolved config,
not raw config-file bytes. Preparation returns `{assignment, job, audit}`.

Execution accepts only `{assignmentId}` from preparation and delegates to
`dispatchLocalAuthoringSuccessor(config, ledger, assignmentId)` without injected
dependencies. Real planning, skill selection, model execution, native gates and
publication stay with the canonical core. The failed candidate, exhausted
attempt and diagnostic records remain immutable; the facade must not reset them
or provide a second runner or publisher.

Preparation and canonical worker results are wrapped unchanged with
`acceptance: not-inferred`. A new candidate still requires all source-bound
native gates and verified exact-head draft identity. Neither setup diagnostics
nor wrapper completion substitute for that evidence.

This bounded successor permits only a suite-level real SUT import after the
existing mocks, before the otherwise unchanged behavioral suite, and an
optional update to its existing behavior card. The core retains the timeout,
assertions and native profile; it provides fresh private native temporary
storage and verifies the actual transformed test's runtime import order before
publication. Shared-harness, product-source and Jest-configuration edits are
outside this successor.

## Ownership and safety

`pilot.example.json` selects `executionMode: app-native` and durable
`agent.id: excel-evidence-coordinator`. Repo-owner agent IDs are
`repo-owner:<repoId>`. The project configuration and SQLite ledger are their
durable state. Conversations may execute work but are not agent identities.
Session IDs in receipts are provenance; a native worker session ID is an
optional execution handle. A new conversation can use `app-runs` and
`app-status` without reading the original session's files/history.

WorkIQ is read through the executing app host's `workiq-fetch`, after verifying
that host's `/me?$select=id,userPrincipalName` against the configured identity.
Another session's success is not proof for this host. On explicit auth failure,
stop: no retry, alternate client, Graph substitute, token transfer or automated
sign-in. The app records successful reads and the latest failure locally.
The standalone SDK's historical auth result is irrelevant to this mode.

Helpers import/validate/report local receipts; they do not call app tools.
`app-ado --collect` performs network reads, using delegated Azure CLI and
verifying tenant/object ID before every ADO query. Its UPN is the configured
directory-ID binding, not a separately returned UPN.
The separately authorized local CLI path below is another explicit execution
binding, never an automatic fallback from the app's blocked HTTP connection.

Dry runs cannot review, prepare/claim workers, qualify validation, consume
production assignment budget or schedule anything. Source writes are absent.
Future automation belongs to the independent agents and remains **disabled**:
same-session automation is neither implemented nor the target architecture.

## Entry points

Run from the cloned project root. Commands accept `--config <path>`; otherwise
they use the disabled synthetic `pilot.example.json`. For real or previously
recorded pilot work, supply `--config .\pilot.local.json` on every command.
Create that ignored file from the example only if it does not already exist.
Resolve identity, scope and storage approval before any receipt import.

```powershell
npm run pilot -- app-runs
npm run pilot -- app-begin --file begin.json
npm run pilot -- app-append --run RUN_ID --file receipt-batch.json
npm run pilot -- app-block --run RUN_ID --file authentication-failure.json
npm run pilot -- app-unavailable --run RUN_ID --file unavailable.json
npm run pilot -- app-status --run RUN_ID
```

Inputs are UTF-8 JSON. Identifiers are 1-128 ASCII letters/digits/dot/dash/
underscore, starting with a letter/digit. All times must be explicit UTC.
Object keys are checked; unknown fields are rejected unless within permitted
source response data. Never include headers, cookies, bearer tokens, OAuth
objects, credential stores or logs. The importer rejects credential-shaped
fields/strings but is not a general secret-redaction service: the collector
must save only permitted source data.

### Begin schema

```json
{
  "runId": "example-run",
  "executorSessionId": "optional-app-session-id",
  "dryRun": true,
  "provenance": "app-tool"
}
```

`executorSessionId` is optional provenance. `provenance` is `app-tool` for
actual app receipts or `synthetic` for tests. Run ID reuse is idempotent only
with identical inputs/configuration. The disabled example uses a fixed October
8 UTC fixture window and limits of 2,000 examined items / 300 calls **per pass**.
These are not permission to collect or approved recurring defaults. Real users
must approve their window and limits. Identity calls count against read limits.
Root metadata pages and replies share the Teams pass budget.

Storage is `.state\app-native\dry-runs\<runId>\ledger.sqlite`, with a
`<runId>-summary.json` snapshot. Production is separate:
`.state\app-native\live\ledger.sqlite`, requires activation and
`dryRun:false` at begin plus `--production` on later commands.

### Receipt-batch schema

```json
{
  "eventId": "unique-event-id",
  "pass": "workiq:created",
  "calls": [{
    "id": "actual-tool-call-id",
    "actorSessionId": "optional-executing-app-session-id",
    "completionEventId": "optional-host-completion-event-id",
    "requestedAt": "2026-10-09T01:00:00Z",
    "observedAt": "2026-10-09T01:00:01Z",
    "tool": "workiq-fetch",
    "request": { "entityUrls": ["/me?$select=id,userPrincipalName"] },
    "response": { "results": [{
      "statusCode": 200,
      "data": {
        "id": "22222222-2222-4222-8222-222222222222",
        "userPrincipalName": "collector@example.invalid"
      }
    }] }
  }]
}
```

The identity and timestamps above are synthetic contract examples, not receipts.
`requestedAt`, `actorSessionId` and `completionEventId` are optional; other
call keys above are required. A call has exactly one `response` or `failure`.
Success envelope allows `results`, optional `requestId` and string `note`;
one result with `statusCode:200` and `data`. Preserve actual source envelope,
message IDs/revisions and returned `@odata.nextLink`, not a model summary.
The importer records event IDs, receipts, capture hashes and immutable evidence.
Submitting the same event again does not double-count; changed content for the
same event ID fails.

First WorkIQ receipt must be the exact `/me` read. Later receipts must match
the reported `nextRequest` path, scope and continuation, with only approved
message projections. Metadata-only projection is allowed if it includes `id`
and `createdDateTime`; absence of body/etag remains explicit. Backend page caps
of 20 are accepted within the maximum 50. Raw and URL-encoded channel IDs are
normalized for comparison, not broadened.

All root metadata in a returned page is accepted before traversing replies.
Replies to older roots must be enumerated too. An unconsumed next root page or
reply request means **partial**, never full-day completeness. `evidenceCount`
is the observed in-window subset, not a daily total until complete.
`examinedRecords` includes out-of-window roots. No model classification occurs.
No related-link follow-up runs implicitly; approved follow-up budgets remain
separate and no out-of-scope link is fetched.

Durable imported evidence is `source.provenance: app-tool-reported`, not
independently authenticated by the local importer. Synthetic imports stay
`synthetic`. Direct ADO adapter evidence is `authenticated-source`.
The local trust boundary is the app-owned receipt file; receipts are not
cryptographically attested remote executions.

### Failure and terminal blocker schema

For a failed expected call, replace `response` with:

```json
{
  "code": "blocked-auth",
  "statusCode": 500,
  "errorCode": "AuthenticationRequired",
  "recoveryAction": "Reauthenticate",
  "requestId": "actual-request-id"
}
```

Only `code` is mandatory; allowed codes are `blocked-auth`, `unavailable`,
`failed-source`. Record only observed status/error IDs, not invented causes.
No error's arbitrary raw text is required.

If an in-scope detail read fails outside the traversal's immediate next page,
use `app-block` with `{eventId, pass:"workiq:created", call:<failed receipt>}`.
It accepts a terminal auth failure, retains already imported metadata,
increments attempt counts, and clears **continuation eligibility**, not
previously committed source cursors. It never converts partial evidence to
empty success. A blocked/budget-exhausted run cannot accept more traversal
receipts; reauthentication and a separately authorized new run are needed.

IcM unavailable input:
`{"pass":"icm:created","reason":"no-approved-connector"}`.
Unstarted/unavailable counts are null, not clean zero.

### ADO collection and offline recovery

```powershell
npm run pilot -- app-ado --run RUN_ID --pass ado:created --collect
npm run pilot -- app-ado --run RUN_ID --pass ado:changed --collect
```

Both preserve the approved area, Bug/non-Removed filters and explicit UTC
window. Changed observations do not inflate new-cohort counts.
Each pass establishes an asOf snapshot, then queries and batches by it.
Native identity validation precedes service reads. Auth failure in one pass
blocks the other; operations are journaled before reads to prevent duplicate
launches after a crash.

Raw permitted transport receipts persist incrementally. If parsing/import
fails after reads, fix the local parser and use:

```powershell
npm run pilot -- app-ado-reconcile --run RUN_ID --pass ado:changed
```

This replays **already persisted transport data**, not another live scan.
The observed changed pass used this path for a source relation URL containing
spaces: evidence URLs are now URI-normalized; raw source receipts remain intact.

ADO app receipt imports use `pass: ado:created|ado:changed`, `tool:
ado-delegated-read`, `request:{endpoint:"wiql"|"workitemsbatch",body:<actual>}`
and the actual JSON response. Query/batch order must exactly match the
deterministic scoped collector. The batch also requires
`principal:{objectId,tenantId,userPrincipalName,verifiedAt,toolCallId}`.
Imported principal receipts are app-reported, not independent local auth.
Complete passes alone advance `app:<pass>` cursors; failures retain prior
committed cursors. Revisions and captures deduplicate across created/changed.

### Importing an external app receipt bundle

```powershell
npm run pilot -- app-import-parent --run RUN_ID --file .\receipts\parent-receipts.json --config .\pilot.local.json
```

Accepts `parent-app-source-receipts-v1`: `appSessionId`, matching
`sourceWindow`, and ordered `receipts` carrying `provenance:app-tool-reported`,
`appSessionId`, `toolName:workiq-fetch`, `toolCallId`, `requestPath`,
`requestedAt`, `observedAt`, `completionEventId`, `envelope`.
The complete credential-free original bundle is copied into SQLite captures;
later resumes do not need the original session directory. The final auth
failure overrides continuation despite prior successful identity/page reads.

## Explicit local WorkIQ CLI collection

This optional binding uses the official `@microsoft/workiq` **1.0.1** native
executable over stdio MCP, not the Copilot SDK or app HTTP connection. Installation
and official account sign-in are owner-managed prerequisites; the helper neither
installs packages nor logs in, changes grants/broker settings, inspects caches or
copies tokens. Configure `runtime.workiqCli` in a **new ignored local config**:
`enabled:true`, an absolute `executable` path to the approved installed binary,
`packageVersion:"1.0.1"` and a positive `timeoutMs`. The package version is an
operator binding, not a claim derived from MCP's serverInfo version. No global
MCP configuration changes are made.

Keep the exact authorized identity, channel, UTC window and dry-run limits.
Choose an approved projection including `body`, for example
`sources.workiq.projection:"id,createdDateTime,lastModifiedDateTime,body,webUrl"`.
The original config and failed run must remain unchanged; begin a distinct
collection-only run with `provenance:"app-tool"` (the envelope's existing real
execution marker). Actual pass/evidence provenance is **`workiq-cli-verified`**
and execution is `local-workiq-cli-stdio`, not imported app receipt or SDK success.
Source/receipt timestamps are current observations, not historical creation times.

```powershell
npm run pilot -- app-begin --file .\receipts\cli-begin.json --config .\pilot.cli.local.json
npm run pilot -- app-workiq-cli --run CLI_RUN_ID --collect --config .\pilot.cli.local.json
npm run pilot -- app-status --run CLI_RUN_ID --config .\pilot.cli.local.json
```

The helper starts `EXE --account CONFIGURED_UPN mcp`, negotiates MCP and discovers
`fetch`. Only that read tool is callable; server-initiated client actions are
rejected. Its first read is the exact `/me` ID/UPN check. All later reads come
from deterministic channel traversal, including replies to older roots. Identity
counts against the read cap; returned excess items remain visibly unexamined.
Raw permitted MCP responses live in SQLite captures, with request intent persisted
before each read, UTC start/completion times and incremental evidence imports.
Unstructured stderr and unknown RPC diagnostic text are suppressed.

Auth failures, policy denials, unknown envelopes, scope escapes and exhausted
caps stop without retries or another client. Coverage stays partial/blocked,
previous committed cursors remain intact and `pendingRequest` on a terminal
failure is audit-only, not authorization to continue. A repeated collection
command cannot launch an already journaled operation. After a process crash,
inspect/recover its recorded lock only when the process is absent, then
`app-workiq-cli-reconcile` imports already received receipts **offline** and
marks any unfinished request uncertain; it never retries the source read.
If all journaled responses were received and replay reaches a budget stop,
offline reconciliation retains that budget checkpoint instead of marking a
completed read uncertain.

### Budget-stopped continuation

An exhausted run stays exhausted. After **separate authorization for another
bounded tranche**, prepare a distinct collection-only dry run offline:

```powershell
npm run pilot -- app-workiq-continue --from-run OLD_RUN --run NEW_RUN --pass workiq:created --authorize-additional-budget --config .\pilot.cli.local.json
# Only after authorization for the new source reads:
npm run pilot -- app-workiq-cli --run NEW_RUN --pass workiq:created --collect --config .\pilot.cli.local.json
```

Preparation reserves exactly one child per parent/pass, records explicit
additional-budget approval, and copies the immutable successful receipt prefix
into the new ledger with source-run provenance and a content hash. Both runs use
the same unchanged config/window/scope and configured per-run caps. Preparation
does not call WorkIQ, raise the parent's limits or advance its cursor. Repeating
the same preparation is idempotent; a competing child is rejected. If preparation
was interrupted, the same command can finish its recorded reservation offline
only while the parent checkpoint is unchanged. Missing/conflicting reservation
data stops for inspection; it is never discarded or silently replaced.

The new executor verifies its own `/me` before processing cached records.
Deterministic receipt replay reconstructs pending roots, reply queues, both
nextLinks and the exact examination offset inside the last returned page.
Cached source pages are **not fetched again**. Returned-but-unexamined rows
consume the new item budget before later source pages are requested. The fresh
identity check consumes a new read; inherited source reads do not. Every returned
row, including duplicate versions, consumes examination budget. Exact duplicate
versions do not create duplicate evidence; different payload versions are retained.
Inherited evidence retains its original observation timestamps and trust level,
including when a CLI child continues imported app receipts. The inherited page
projection is preserved; continuation does not silently upgrade metadata to bodies.

Status separates this tranche's `readCalls`, `returnedRecords` and
`examinedRecords` from `inheritedReadCalls`, `inheritedExaminedRecords`,
`inheritedBufferedRecords`, `cumulativeReturnedRecords` and
`cumulativeExaminedRecords`. `evidenceCount`/`evidenceIds` cover the cumulative
receipt chain in the new ledger; they are not counts of newly reported defects.
`unexaminedReturnedRecords` is the remaining buffered tail. A checkpoint is a
local receipt-replay position, **not a delta token or historical snapshot**.
`cumulativeTraversal` distinguishes root/reply versions and fully examined,
exhausted threads; receiving a terminal reply page alone does not exhaust a
thread when that page still contains unexamined rows.
Replay cost/storage grow with the retained receipt chain; this is a local pilot,
not a large-volume incremental sync engine.

Only reconstructed **budget** stops qualify. Authentication failures, failed or
uncertain reads, pagination cycles, incomplete reconciliation and scope errors
cannot be converted into continuation permission. A source nextLink may expire;
its failure stays visible with no restart-from-head fallback or automatic retry.

### Channel context and edits

The collector retains an `app_thread_context` index for **all examined** roots
and replies, including out-of-window context that is not an eligible finding.
Entries identify team/channel/root/message, content-version hash, source call,
original run, observation time, request path and parent observation. Full page
receipts also retain any still-unexamined rows. Evidence includes the parent
snapshot and corresponding provenance, and flags modifications after the cohort
end. A reply's supplied `replyToId` must agree with the traversed root.

```powershell
npm run pilot -- app-thread-context --run RUN_ID --pass workiq:created --config .\pilot.cli.local.json
```

Context output contains private source bodies; use only approved local storage.
Existing ledgers are not silently backfilled or reclassified by this feature.
For older captures, use their immutable source receipts and recorded limitations.
Status lists `threadContext.indexedPasses`; an absent pass is not evidence of
zero source messages.
Analysis executors should open SQLite read-only, not run mutating collection or
migration commands against a ledger being collected.

An explicitly authorized `--pass workiq:changed` uses `lastModifiedDateTime`
instead of `createdDateTime` for cohort selection, with separate counters,
observations and cursor. Its projection must include `lastModifiedDateTime`;
a missing returned timestamp fails rather than silently omitting edits. It still
enumerates every root and reply, including older roots. This lane is opt-in and
is never launched automatically alongside `workiq:created`. It supports the same
explicit continuation command with `--pass workiq:changed`.

**Supported semantics and limits:** the verified WorkIQ transport provides
scoped `fetch` and observed nextLinks, not a qualified delta/change feed.
A separate bounded CLI diagnostic also confirmed that the advertised channel
`messages/delta()` route can return a current root-message page through
`call_function`, using a single `{data,statusCode}` envelope. That diagnostic
stopped with a nextLink, not a terminal deltaLink. Reply-only changes, reply
delta, removals, checkpoint reuse and expiry remain unqualified. No shared delta
collector is implemented or enabled; the resumable traversal remains in use.
Microsoft's [channel listing documentation](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0)
describes ordering by modification of the **entire reply chain**, not the root's
creation timestamp. Its listing and [reply listing](https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies?view=graph-rest-1.0)
do not document date filtering; those Graph contracts are context, not proof
of additional WorkIQ capabilities. No Graph source client, `$filter`, undocumented
delta endpoint, notification subscription or root-age cutoff is used here.
Each new authorized scan starts a full bounded enumeration; each continuation
finishes the recorded one.

Enumeration can move while pages are read. A completed cursor means observed
pages/replies were exhausted, not a transactionally consistent snapshot or a
guarantee that concurrent changes were captured. A previously traversed thread
is not revisited during the same scan; a later authorized full scan is needed
to observe later activity. Modified timestamps are not necessarily body edits.
Only returned tombstones can indicate deletion; absence cannot. Current edited
bodies do not reconstruct what existed at the cohort end, nor intermediate
versions that the source no longer returns.

**Renewal qualification is deferred.** Fresh-process success does not establish
token-expiry, logout/reboot, Conditional Access or unattended readiness.
No renewal probes, scheduler, review, repo worker or source writes are enabled.
Historical HTTP auth blocks retain their original meaning. IcM connector
discovery and approved query mapping are independent; do not run that source
merely because a connector can initialize.

## Offline IcM connector receipts

```powershell
npm run pilot -- icm-replay --file .\private\icm-receipts.json --config .\pilot.local.json
```

This command makes **no connector calls** and rejects `--collect`. It validates
captured `get_my_icm_context` / `search_incidents` receipts and writes a separate
`.state\icm-replays\<id>\ledger.sqlite` audit store plus `coverage.json`, never
an existing source run, production evidence or source cursor. An ID is immutable:
the same input replays idempotently; changed input requires a distinct ID.
Partial valid versions and the entire supplied credential-free receipt bundle
(including unexamined page tails) remain captured with hashes. Malformed/failed
source envelopes report errors, not empty successful pages.

Bundle shape (all identity/team values below are synthetic):

```json
{
  "format": "icm-receipts-v1",
  "id": "example-icm-audit",
  "provenance": "app-tool-reported",
  "window": { "start": "2026-10-08T00:00:00Z", "end": "2026-10-09T00:00:00Z" },
  "limits": { "maxItems": 2000, "maxCalls": 300 },
  "mapping": {
    "owningTeamId": 123,
    "teamVerified": true,
    "severity": [1, 2, 25],
    "severityVerified": true,
    "top": 50,
    "timestampContract": null
  },
  "calls": []
}
```

Each call has `id`, `tool`, `arguments`, `requestedAt`, `observedAt`, and exactly
one of raw MCP `response` or `failure:{code}`. Failures allow `blocked-auth`,
`failed-source`, `unavailable`. MCP envelopes must expose `structuredContent` or
one JSON text-content block. The initial identity response must contain the
configured user's exact active `contact.alias` / `contact.emailAddress`.
Imported identity remains app-reported, not authentication by this helper.
Missing original identity payload cannot be replaced by an invented response.

Search arguments are exactly `incidentAdvancedSearchRequest` with verified
`owningTeamId`, `severity:[1,2,25]`, `dateRange:{createdAfter,createdBefore}`, `top`
and `sortBy:[{field:"CreatedDate",direction:"Descending"}]`. Only a returned MCP
`nextPageToken` may be added on the next page; no partner OData token, offset,
expanded dates, implicit query ID, retry or head restart is substituted.
Successful pages contain `success:true`, `value`, optional nonnegative
`@odata.count` and optional `nextPageToken`. Identity/read and examination limits,
request equality, returned team/severity/date bounds and token cycles are checked.
Every row costs an examination, including duplicate versions; changed payloads
for the same ID remain distinct hashed versions.

`enumeration` is complete/partial/blocked **for the recorded incident-created
request only**. `state` remains blocked when `timestampContract:null`, even if
that diagnostic enumeration exhausted pages. `cohortCoverage` and
`liveActivation` remain blocked in this offline adapter. An explicit
`timestampContract:"incident-created"` labels diagnostics, not saved-query
equivalence or live authorization. Source Created Time has no verified input
mapping and is rejected as a substituted contract. Returned `sourceCreateTime`
presence is recorded separately; omitted values are not asserted to be null at
source. `remainingSourceRecords` is unknown until observed exhaustion; a reported
total is not a stable snapshot. Counts describe the replayed prefix;
`suppliedReadReceipts` / `unprocessedReadReceipts` identify retained trailing
receipts after a stop. No automatic continuation is implemented for this adapter.
Actual saved-query scope, timestamp agreement and separately authorized live
execution remain prerequisites, not facts established by synthetic tests.

## Title-first FILTER screening

Agent 2 FILTER, not the collector or proposer, owns the relevance decision.
The default hosted input path is complete-record token-budgeted batching
described below. Title-first is a loose, high-recall reasoning order, not a
requirement to withhold bodies. The implemented helpers in this section remain
an optional offline audit/selective-export path. To use that path, start with an
existing `stage2-sources-v1` source-ledger manifest:

```powershell
npm run pilot -- filter-title-index --file .\private\sources.json --output .\private\titles.json --config .\pilot.local.json
```

The immutable `filter-title-index-v1` artifact contains all deduplicated evidence
IDs, titles, source kind/namespace/record ID/revision/version basis, provenance,
capture hashes/references, source snapshot fingerprints and the 14-exclusion
policy. It does not include descriptions, RCA, full bodies or capture content.
Titles and identity are projected from read-only SQLite; original records and
cursors are untouched. Missing or whitespace-only titles remain explicit.

An agent or human then writes `filter-title-decisions-v1`; the schema is
`scaffold/contracts.schema.json#/$defs/filterTitleDecisions`. Required envelope:
`format`, `indexSha256` (SHA-256 of exact index file bytes), `reviewer`,
`reviewedAt` (UTC), and `decisions`. Each row contains:

| Field | Contract |
|---|---|
| `evidenceId`, `source`, `captureSha256` | Exact indexed ID, full indexed source identity/version object and capture hash |
| `disposition` | `likely-relevant`, `needs-details`, `no-title`, or `screen-out` |
| `exclusionType` | Existing exclusion enum for screen-out; otherwise null |
| `reason` | Nonempty decision rationale |
| `titleQuote` | Exact nonempty title substring supporting screen-out; otherwise null |

Screen **every** indexed ID exactly once. Screen out only obviously excluded
titles under the existing policy. Ambiguous titles and absent titles retain full
evidence; absent/blank titles must use `no-title`. Do not infer defect confirmation
or missing coverage or executor feasibility from titles. There is no keyword classifier: words such as
reliability, security, performance and Voice Access are not automatic exclusions.
Typed reasons and quotes are auditable decisions, not proof of semantic correctness.

```powershell
npm run pilot -- filter-title-materialize --file .\private\decisions.json --index .\private\titles.json --output .\private\details.json --config .\pilot.local.json
```

The helper validates the entire decision set and current title/source snapshot
before reading retained full records. It rejects unknown, duplicate or missing
IDs, mismatched source versions/hashes, missing reasons, unsupported exclusion
types and invalid quotes. The immutable `filter-details-v1` output contains only
retained full evidence and its byte-preserved captures (`contentBase64`, SHA-256,
artifact reference), plus the complete title/decision audit including screened-out
rows. All retained provenance, fields, missing fields and parent context remain
intact; bodies may contain necessary context from related messages. All-excluded
and empty inputs produce explicit empty detail sets. Conflicting output paths
are rejected rather than overwritten.

Materialization **does not attest that an agent read the bodies**: title audit
rows start `detailsRead:false`. The FILTER must read retained bodies before
RCA, unit/integration/E2E inventory, feasibility and exact coverage-contract review.
Later exclusions and all source/skill/ownership/dispatch gates still apply.
This does not grant collection, hosted sharing, product edits or PR authority.

To bind title decisions into the existing held handoff and proposal checker, add
`"titleScreen":{"indexPath":"<private titles path>","decisionsPath":"<private decisions path>"}`
to the **same** `stage2-sources-v1` manifest. `stage2-handoff` revalidates the
screen and includes only retained evidence refs; `stage2-proposal-check` rejects
screened-out refs and changed decisions. Existing unscreened handoffs remain
supported; using complete-record batches does not require selective materialization.
The optional `titleScreen` binding still requires one validated complete decision
set, not an individual partial batch response.

These commands are local, offline exports. They do not implement hosted deferred
reads, automatically deliver skills, enforce sensitivity policy or verify
semantic title judgments. Sending all bodies inline is not context reduction from
title screening. No private examples or fixed corpus counts are production rules.

### Complete-record FILTER batches

These helpers prepare and check private offline packets; they are **not a provider
launcher or submission authorization**. Keep exactly
collector -> filter -> proposer. Scheduling, durable state, batch accounting and
handoffs remain local. The local main flow prepares complete-record batches for
qualified hosted FILTER analysis through independent initial inputs. Do not make
deferred reads, keep-alive or selective-body export a prerequisite. No model,
numeric token limit, concurrency or job count is selected here.

```powershell
npm run pilot -- filter-batches --file .\private\batch-request.json --output .\private\batches.json --config .\pilot.local.json
npm run pilot -- filter-batch-size --file .\private\batch-request.json --output .\private\group-sizes.json --config .\pilot.local.json
npm run pilot -- filter-batch-check --file .\private\batch-result.json --manifest .\private\batches.json --config .\pilot.local.json
npm run pilot -- filter-consolidate --file .\private\result-paths.json --manifest .\private\batches.json --output .\private\consolidation.json --config .\pilot.local.json
```

`filter-batch-request-v1` is defined by `$defs.filterBatchRequest` in
`scaffold/contracts.schema.json`. It contains `sources` (the existing read-only
ledger/run refs), complete `instructions`, `groups`, `groupingReview` and `sharing`.
Each group has `id`, `memberIds`, `contextIds` and `reason`. Every cohort version
must be a member of exactly one group; optional context-only copies are explicit.
`groupingReview` records `reviewer`, UTC `reviewedAt` and `rationale`. Same-source
versions, known thread members and explicit links matching cohort report URLs
cannot be split. The reviewer must preserve other related-report dependencies;
the helper does not infer semantic relationships.

`sharing` has `audience`, `approvalRef` and `materials` with `sha256`,
`eligibility:approved|unknown|denied` and `restrictions`. Every normalized record,
capture, included thread-context record, instructions and coverage projection
needs approved eligibility; unknown/denied material blocks preparation.
Record/coverage hashes use `JSON.stringify(value,null,2)` plus a trailing newline;
captures retain their original byte hashes; persisted thread-context hashes use
the ledger's canonical compact JSON. These are operator-approved local receipts,
not independently attested access or sensitivity decisions.

Each batch provides complete captured records, required provenance and related
report/thread context from the start, subject to approved sharing/access/retention.
Missing source fields stay explicitly missing; "complete" does not invent absent
evidence or mean complete live collection. Keep required related context together
as an indivisible packing group. If a complete group cannot fit, mark it blocked
for an explicit handling decision; never drop records, cut bodies or silently
substitute summaries. This is not authority for new collection.

Packaging removes only provably redundant representations within each standalone
batch. A capture is `reconstructed-from-full-evidence` only when its original
bytes and SHA-256 both equal compact `JSON.stringify` of the declared recipe:
`ado-fields-relations-v1` uses `{id:Number(source.recordId),rev:Number(source.revision),fields,relations:links}`;
`workiq-message-parent-v1` uses `{message:fields.message,parentContext:fields.parentContext}`.
Its `evidenceId`, `sha256`, `artifactRef` and `originalByteLength` remain explicit.
Otherwise the original `contentBase64` remains inline. No original capture is
rewritten, and no full normalized evidence field is removed.

`sharing.representation:shared-material-policies-v1` stores exact
`{eligibility,restrictions}` policies once, with each material retaining its SHA-256
and `policyId`. `sourceCoverage` optionally uses
`representation:shared-pass-values-v1`, a `shared:[{id,value}]` table and the
original `sources` structure with identical pass fields replaced by
`{$coverageValue:id}`. Only exact repeated values of at least 128 compact UTF-8
bytes are considered; coverage factoring is used only if it reduces serialized
size. Reserved-marker collisions retain inline coverage. Neither form collapses
distinct values, source limitations or unknown sensitivity. Expansion helpers
verify `expandedSha256` against the original pretty JSON plus newline, and packing
also verifies exact round-trip content. Every job still receives its own complete
instructions, necessary context and metadata; all representation overhead is
counted. Execution-bound repo/ref/commit and duration instructions must likewise
be included in the counted input, not left in inaccessible executor metadata.

Local lossless packing proves representation fidelity, not execution in a worker.
New Agency FILTER requests explicitly select the
[local read-only policy](AGENCY-EXECUTOR.md#essential-local-read-only-filter-policy)
or the optional stronger
[worker capture policy](AGENCY-EXECUTOR.md#enforced-worker-capture-verification).
The local policy requires local lossless validation, exact execution bindings and
explicit assurance limits; it does not require a deployed verifier. Under the
stronger policy, the terminal gate joins actual pipeline-step proof to retained
final-result IDs. Missing required worker proof cannot be replaced with prose or
a local preflight. Neither policy rewrites existing manifests or sealed receipts.

Verify the actual selected model/profile's context and input limits, supported
token accounting method/version and request overhead. Reserve instruction,
source/code-analysis, output and required safety capacity before computing the
evidence allowance; distinguish input limits from total context capacity and
transport byte limits. Count the exact serialized payload, including repeated
context, with the verified method. Unknown limits or unverifiable accounting block verified-mode readiness.
A record-count cap, character heuristic or advertised model family capacity is
not a verified input-token budget. An explicitly approved bounded estimate-mode
exception is supported below, without promoting estimates to provider facts.

Configure `filterBatching` in a **new private configuration**: `approved:true`,
`mode:verified`,
actual `model`, explicit `profile` (null is allowed for a verified default),
`tokenizer`, `verifiedBy`, UTC `verifiedAt`, absolute `verificationRef` and its
`verificationSha256`; positive integers `contextTokens`, `maxInputTokens`,
`maxPayloadBytes`, `maxBatches`; and nonnegative integer `reserves` for
`instructions`, `sourceAnalysis`, `output`, `safety`, `requestOverhead`.
Instructions/source-analysis/output reserves must be positive. Missing values
block rather than default. The verification receipt must substantiate the actual
tier/tokenizer/limits; setting `approved` is not evidence of provider capability.

For an explicitly user-approved bounded trial only, `mode:estimated` instead
requires actual `tokenizer`, `contextTokens` and `maxInputTokens` to be null.
Record `estimation:{methodId,version,description,planningContextTokens,inputTokenCap,
approval}`. Its approval includes the exact `decision`, `authority`, UTC
`receivedAt`, `scope:bounded-replay`, `maxConcurrency:2` and
`accuracy:estimate-not-provider-token-accuracy`. The pinned verification artifact
then records approval/method/uncertainty, **not** exact tokenizer qualification.
Planning caps are positive declared estimate-unit limits, never advertised
inherent capacity relabeled as an observed tier limit. All reserves, byte limits
and total batch caps remain explicit. The manifest retains mode, method, approval,
null actual limits and uncertainty. Dispatch concurrency is enforced by the
separate executor; this offline helper does not launch workers.
In estimated mode the measured prompt already contains embedded instructions.
All five reserves are **additional external/runtime capacity**: the payload limit
is the smaller of `inputTokenCap` and `planningContextTokens` minus their sum.
The embedded instruction count is recorded, not compared to the additional
external instruction reserve. This keeps the approved planning envelope distinct
from verified-mode provider accounting.

The approved local `counter` contains `approved:true`, absolute `executable`,
`executableSha256`, fixed `args`, pinned `files:[{path,sha256}]` and `timeoutMs`.
It receives one stdin JSON object `{text,sha256,model,tokenizer}` and must return
only `{sha256,model,tokenizer,tokens}` matching that exact input. In estimated mode
the legacy protocol field `tokenizer` carries `estimation.methodId`, not an actual
tokenizer identity; the manifest's actual `tokenizer` stays null. Pin all adapter
code/tokenizer assets in `files`. No shell, login or package installation is
performed. The helper suppresses raw counter diagnostics and reports failures.
Use an approved local tokenizer/estimator adapter, not a network model invocation.

Packing measures the exact UTF-8 OUTER JSON prompt, pretty-printed with trailing
newline: `{payloadSha256:<inner hash>,payload:<exact inner JSON text string>}`.
The inner string contains complete input including `batchId`, bodies, captures,
repeated context, instructions and index. Its hash is supplied literally so the
model never needs to compute an impossible prompt self-hash or read hidden runtime
metadata. The manifest's `payloadSha256` hashes the outer actual request prompt;
`analysisPayloadSha256` hashes the exact inner string. Both must remain unchanged.
Escaping and envelope overhead are included in the measured outer bytes/units.
In verified mode it also reserves unused instruction allowance, source-analysis and request
overhead within the input limit, and output/safety within total context.
Groups are packed in stable ID order; byte and token ceilings are both enforced,
then the authorized total batch cap. The immutable manifest records exact payload
strings/hashes and count receipts. Identical reruns produce the same artifact;
changed inputs require a new output, never overwrite. Counts are local adapter
receipts, not remote metering attestations.

`filter-batch-size` measures exact outer UTF-8 bytes for each indivisible group
and for all groups, without selecting a model, applying token limits, approving
sharing or submitting. It supports cap planning but cannot qualify a provider.

Within each batch FILTER inspects every title/identity first, screening out only
obvious existing policy exclusions with typed reason and title quote. No local
historical-preview preselection. Likely, ambiguous and untitled records retain
full review before RCA, coverage inventory or feasibility claims. Existing
`filter-title-decisions-v1` stays unchanged inside each result's `titles`, with
batch metadata outside. `indexSha256` binds the exact pretty-printed per-batch
`filter-batch-index-v1` object plus newline, not the whole-ledger title index.
`filter-batch-check` is the separate membership validator; it reconstructs the
source corpus and exact groups/payload before checking results. The optional
`validateTitleScreen` remains whole-ledger based. Do not alter original ledgers
to make subsets appear to be complete source runs.

The batch/result contract retains these bindings:

| Boundary | Required accounting |
|---|---|
| Cohort | Immutable cohort/manifest ID and exact-byte SHA-256; complete source-version inventory, source snapshot/capture hashes, provenance and completeness limits |
| Batch input | Stable batch ID bound to cohort and ordered member inventory; exact input/payload hash, instruction/policy hashes, model/profile and verified budget/method/reserve receipt |
| Members and context | Each evidence ID with full source identity/version, record-content hash and capture hash; context-group ID, related-context hashes and approved sharing scope; distinguish review members from repeated context-only copies |
| Batch result | Exact batch/input hash, reviewer and review time, result hash; one disposition per review member, title exclusion audit, explicit detail-review status, source-bound candidate references and blockers |
| Local consolidation | Every cohort member accounted for as reviewed, screened-out with audit, pending or blocked; batch/result references, duplicate/context-copy map, source-version conflicts and unresolved candidates; no silent omissions |

`filter-batch-result-v1` (`$defs.filterBatchResult`) requires `cohortId`,
`batchId`, `payloadSha256` (the delivered INNER hash),
`status:complete|partial|failed|blocked`, `titles`,
`details` and `candidates`. Detail rows bind `evidenceId`, `recordSha256`,
`captureSha256`, `status:reviewed|excluded-title|pending|blocked` and `reason`.
Complete results require every member's title decision and detail accounting.
Partial/failed/blocked results may report only observed decisions; unreported
members remain unresolved, without invented title judgments.

Candidates bind exact reviewed member IDs, repository/source revision, test layer,
existing assertion inventory, missing assertion, harness, coverage status,
blockers, priority/confidence and ranking rationale. E2E is a supported layer,
not an exclusion. A structurally checked result is `checked-not-qualified`,
not proof of semantic review or positive provider completion. Real hosted
acceptance additionally requires the executor's source/payload-bound positive
terminal receipt; a green outer pipeline is insufficient.

`result-paths.json` is an array of private result file paths. Consolidation rejects
foreign/stale members, reports missing/failed/partial/conflicting batches, and
deduplicates identical result receipts. Candidate dedup uses exact repository,
source revision, layer and missing-assertion text; it does not merge similar
symptoms. Disagreement on other candidate claims blocks final selection.
Ranking is priority descending, confidence descending, then the exact key;
the original ranking rationale and evidence/batch references remain auditable.
Only unblocked `coverageStatus:gap` entries may become the single held selection.

The `filter-consolidation-v1` object contains `state:complete-held|partial`,
`dispatchAllowed:false`, `cohortId`, `manifestSha256`, `accounting`, `duplicates`,
`conflicts`, `ranking`, `rankingPolicy`, `selected`, `semanticAnalysisVerifiedByHelper`
and `nextGate`. Each accounting row binds a batch/result hash and every member's
status. Ranking entries retain the exact candidate `definition`, dedup `key`,
`evidenceIds`, `batchIds` and `candidateIds`; `selected` is one such entry or null.
Full source identity/version, record/capture hashes, provenance and source
coverage remain in the pinned manifest and its source ledgers, not duplicated as
raw evidence in this object. Result hashes use canonical pretty JSON plus newline.
Consumers must revalidate these pins rather than accepting an unbound summary.

Structural `complete-held` alone is not execution acceptance. Run the read-only
[`filter-execution-check`](AGENCY-EXECUTOR.md#source-bound-cohort-and-colleague-handoff)
against the entire original manifest and exact canonical result bytes. It
regrades immutable request/job/source/result receipts and exposes consolidation
only for a complete accepted cohort. One accepted batch cannot release a
multi-batch cohort. A no-candidate outcome is valid only with the same complete
accounting; collection completeness remains unknown.

For a held Stage2 handoff, add
`"batchReview":{"manifestPath":"<batches.json>","resultPaths":["<result.json>"]}`
to the original source manifest, instead of `titleScreen`. All batches must be
complete and conflict-free. Stage2 pins the manifest/results/selection and accepts
only the selected evidence IDs; no candidate means no permitted proposal.
A selected proposal must carry `filterCandidateKey` and match the selected
repository, source revision and missing assertion. Existing skill/target checks
still apply. Changed result files require a new handoff.

Keep immutable batch identities across retries/restarts; a changed payload needs
a distinct binding, not overwrite. This does not authorize retries. Reject
unknown members, changed source hashes and duplicate review-member decisions;
intentional repeated context is labeled and not counted as an extra reviewed
record. Merge exact source versions locally inside FILTER, retaining cross-source
links without conflating similar reports. Conflicting decisions or missing batch
results remain unresolved; never choose the first answer silently or report a
partial cohort as fully reviewed. Material availability/export is not evidence
that details were actually read. A batch may return zero or more source-bound
candidates; it does not independently dispatch a proposer. Account for all batches
before final selection within FILTER. These helpers stop at the accepted
FILTER consolidation and held handoff. Proposer execution and draft-PR production
require the separate downstream authorization described below.
Pending/blocked members remain disclosed, not silently treated as irrelevant.

Relevance/exclusions are separate from test-layer and executor routing. E2E
remains eligible through a qualified local/repository harness and its existing
validation infrastructure. Agency may handle selected qualified integration
authoring/validation or supported analysis, not every suite or live-account E2E.
Hosted inability is a local-routing constraint or blocker, never an exclusion.
Source/skill/coverage-contract, permissions and draft-only gates remain unchanged.
No product execution or public publication is authorized by these offline helpers.

### Integration-first milestone

Run the existing supported integration path before adding E2E capabilities.
This is execution eligibility, not a relevance filter or a new result schema.
For newly authorized FILTER inputs, record E2E findings with `layer:"e2e"`,
their actual coverage status and a `blockers` entry such as
`"Deferred: E2E capability setup is outside the integration-first milestone"`.
Keep their source versions, assertion inventory, harness and rationale.
Do not turn deferral into `screen-out`, `covered`, or a missing candidate.
Consolidation preserves these entries in `ranking` but does not select blocked
candidates. If no integration candidate qualifies, report no eligible selection;
do not invent an integration substitute or silently select a unit/E2E candidate.
Retain any other out-of-milestone layer with an explicit execution blocker.

An integration candidate still needs an exact inspected source revision,
existing supported suite/harness and assertion inventory, a supported missing
assertion, and no unresolved execution blockers. Source/skill qualification and
actual source-bound integration results remain required before claiming execution.
Synthetic pilot tests prove the adapter/contract, not product integration success.
Changing milestone instructions requires a new instruction hash, sharing approval,
manifest/payload binding and execution qualification; never edit sealed inputs or
old results to add deferral retroactively.

Essential for the first live milestone: explicitly qualify the existing Agency
FILTER route under the approved local read-only analysis policy, validate local
lossless captures and exact job/payload/result/source bindings, require successful
execution and no observed mutations, authorize the exact request budget, complete every captured-cohort batch,
and release only the accepted existing handoff. Current source-collection gaps
remain disclosed; captured-cohort completion does not prove collection completeness.
Neither this milestone nor these helpers authorize fresh collection, jobs or
proposer execution. Later periodic completeness additionally requires qualified
renewal/continuation and overlap handling; E2E requires separately qualified
repository harnesses, identities, environments and source-bound execution.
Shared runner deployment, repeated worker hashing and dedicated final-worktree
attestation are not prerequisites under this policy. Unknown exhaustive
publication effects remain explicit limitations, never verified zero effects.

### Downstream reconciliation boundary

The integrated [`submit-filter-handoff`](README.md#filter-to-proposer-handoff)
adapter binds the original manifest/results, selected candidate and inspected
source revision to downstream planning and repository-skill execution. It uses
the ordinary dispatcher; `submit-reviewed-handoff` remains a separate,
explicitly authorized synthetic-fixture path. Do not rename, cast or copy
consolidation into a reviewed handoff and treat that as authorization.

The read-only execution-cohort check above remains a separate operator gate;
the proposer adapter does not regrade the original Agency receipts. Preparation
does not dispatch. Execution requires explicit commit, push and draft-PR
authorization and the matching repository binding permissions. Neither path
authorizes merging or bypasses repository skill/source qualification.

Shared producers and consumers in `src/workers.js`, `src/cli.js` and
`scaffold/contracts.schema.json` carry the selected source and optional structured
skill input through the coverage plan and assignment. Declarative E2E input
preserves the mini-spec contract; it is not browser execution evidence.
The connected offline regression exercises these interfaces with synthetic
fixtures and a temporary local Git remote. Real repository skills, identities,
browser prerequisites and validation remain independently qualified.

## Held Stage2 coverage handoff

Stage2 proposals are private sidecars, **not production investigations or
assignments**. No source ledger is opened writable. Use explicit source paths:

```json
{
  "format": "stage2-sources-v1",
  "sources": [{ "ledgerPath": "C:\\private\\run\\ledger.sqlite", "runId": "RUN_ID" }]
}
```

```powershell
npm run pilot -- stage2-handoff --file .\private\sources.json --output .\private\handoff.json --config .\pilot.local.json
npm run pilot -- stage2-proposal-check --file .\private\proposal.json --handoff .\private\handoff.json --config .\pilot.local.json
```

The analysis executor must have `analyze-excel-agent-test-coverage` installed.
Default lookup is its user `.copilot\skills` directory; an explicit
`stage2.skillDirectory` in a **new local configuration** can bind another
supported installation. Shared code contains no personal absolute path.
The user-skill link may point at its canonical KB installation. The helper
resolves and pins `SKILL.md` plus `references\coverage-map.md`, and includes
explicit invoke/read instructions in the handoff. Missing/changed skill or
reference is `blocked-skill`, never generic or session-history fallback.
Presence and matching hashes alone do not prove the executor ran the procedure.

The private proposal has `schemaVersion:1`, `proposalId`,
`status:"held-not-dispatched"`, `dispatchAllowed:false`, the handoff's `skill`
pins, `examinedScope`, `replay` and `candidates`. `replay` includes
`cohort.window:{start,endExclusive}`, `verifiedIndexRef`, and `baselines` with
`repository`, exact 40-64 hex `ref` and `approval:"inspected-not-approved"`.
Each candidate has `id`, `dispatchAllowed:false`, a skill classification
(`already covered`, `extend existing test`, `new integration/E2E scenario`,
`configuration/execution gap`, `unknown`), and:

- `evidenceRefs`: exact `{evidenceId,recordId,revision,artifactRef,sha256}`.
- `behavior` with explicit `runtimeReproduced` boolean; `existingCoverage`,
  `missingAssertion`, `harnessReuse`, `ownership`, `confidence`, `blockers`,
  `proposedValidation` (structured explanations or text; blocked holds say why).
- `target:{repository,inspectedRef,approvedTarget}` matching a baseline.
  `approvedTarget` starts null. A user-approved direction may instead contain
  `{repository,baseRef,layer,inspectedBaseline,implementationCommit:null,
  freshTargetReconciliationRequired:true}`, with matching repository/baseline
  and `layer` of `integration` or `e2e`. `target.approvalProvenance` records
  `decision`, `authority`, `relayedBySession`, offset-qualified `receivedAt`,
  nonempty `contract` controls, `target`, and `excludedAuthorization` containing
  product edits, test edits, fixes, CI, PRs and dispatch. Direction approval
  is candidate-specific, not approval of an exact future execution commit.

The checker reopens explicit source ledgers read-only, verifies each capture
hash/version and unchanged logical source snapshot, validates skill pins and held
gates, and returns an offline result. It does not establish semantic correctness,
approve a target, ingest reviews, launch analysis/product sessions, run tests,
queue CI or bypass exclusions. A non-defect intended-behavior test contract may
be proposed as held work; it cannot become an automatic defect/improvement
dispatch. Product implementation stays gated on contract/target agreement and
the existing worker permissions. A recorded contract/target approval removes
only that candidate's agreement gate: implementation authorization and fresh
exact-ref reconciliation remain separate. `candidateGates` in the checker result
reports this distinction; every candidate remains held with dispatch disabled.

## Native repo-agent tracking (not activated in this pilot)

`app-review --run ID --production --file review.json` reuses the existing
investigation schema and **all 14 exclusionsChecked**. All exclusions govern
both defect and improvement intents. Unknown ownership remains blocked;
functional does not mean confirmed code defect.

Supply `{ "investigation": <record>, "exclusionsChecked": <all 14 names> }`.
The investigation ID is `investigation-` followed by SHA-256 of the UTF-8 JSON
array `[primaryEvidence.source.namespace, primaryEvidence.source.recordId]`.
The first version is 1; subsequent reviews increment it by one. Use exact
persisted evidence IDs. Recorded app reviews are `external-app-agent` actions,
not SDK model execution.

Before `prepare`, `app-plan-improvement --run ID --production --file plan.json`
can persist a versioned `areaToImprove` and source-bound `testCoveragePlan`.
Incomplete or empty discovery is `unknown`, not a confirmed gap. Existing test
links take precedence over proposed additions. A coverage-backed prepare pins
the exact improvement and plan versions, capability, requested outcome and
qualified repository skill binding into the assignment.

`qualify-skill` is a read-only repository preflight. It may run while routing
and the binding remain disabled/unqualified; it verifies the configured
reference checkout, origin, base revision and skill path and records the exact
skill content fingerprint. It does not enable the binding or approve source
writes. OfficeAgent uses the repo-wide
`.github/skills/integration-test-authoring/SKILL.md` router, which then resolves
an exact project and project-local integration shell from the isolated checkout.

`app-worker --run ID --production --operation OP --file action.json`:

The selected repository's `flights.proposerExecutor` chooses `"local"` app
sessions or `"agency"` tasks at preparation. It does not change an existing run
or bypass claims/qualification. Agency requires its explicit task selection and
the [private executor/receipt contract](AGENCY-EXECUTOR.md#per-repository-executor-flight);
an unavailable hosted path never falls back to `create_session`.

| OP | JSON fields |
|---|---|
| `prepare` | `investigationId`, `repoId`, `intent` (`rca-only`, `defect-fix`, `improvement`) |
| `claim` | `assignmentId`, caller-generated `claimId`, durable `coordinatorAgentId` |
| `bind` | `assignmentId`, same `claimId`, actual `sessionId`, configured `projectId`, isolated `workspace`, 40-64 hex `baseRevision` |
| `result` | `assignmentId`, same `claimId`, bound `sessionId`, `outcome`, local durable `evidenceRef` |
| `uncertain` | `assignmentId`, same `claimId` |

Prepare enforces reviewed evidence, exclusions, ownership, write/validation
bounds and the two-new-assignment budget. Claim is atomic and enforces one
active worker; a crash/uncertain launch retains ownership, never auto-relaunches.
Only after claiming may the approved app executor call native `create_session`
with the configured project and isolated worktree, then bind the returned
handle/source revision. No helper launches sessions or mutates repositories.
If creation is uncertain, inspect existing app sessions and bind the accepted
one; do not repeat creation.

Result outcomes: `rca-complete` for RCA-only work, `blocked`, `draft-reported`.
The latter two stay uncertain/visible; a report of a draft never qualifies
source validation. This narrow pilot records handles/results, not a replacement
for app permission enforcement or product validation. Native sessions are not
OS sandboxes and instructions alone are not enforcement. Repo-specific routing,
tool permissions and validation are unresolved, so activation remains off.
No merges, auto-completion, source writes or duplicate validation are authorized.

## Demonstrated live pilot (not release qualification)

An October 2026 local pilot recorded ADO created 47, ADO changed 59 (39 changed-only),
each complete for the query at its recorded snapshot using three reads.
WorkIQ: 20 examined root metadata records, one in-window root, no bodies or
replies; parent identity + page succeeded, then a detail read returned
`AuthenticationRequired` (500). Three attempts including identity.
IcM unavailable. The overall result is **partial-or-blocked**, with zero
reviews, classifications, worker claims/launches, PRs, source writes or schedule
activation. These aggregate observations are not inferred from classification.
The underlying personal configuration, receipt IDs and raw source evidence are
excluded from the sharing package. This historical outcome is not reproducible
proof of a colleague's access. No end-to-end qualification is claimed.
Separately, a bounded local saved-input Collector/FILTER replay and native-skill
proposer did complete one regression-coverage case through native validation,
automatic push and one draft PR at a prior private revision. Both required final
native legs passed once with 26 assertions each, using explicit raw output-file
results rather than the unavailable wrapper summary. Emitted import/mocks order
was verified before push. No actual CI builds were observed during that full
publication window; policy rows were not builds. The reconciled public controller
is offline-validated only. This is not a new collection/review, incident RCA,
full-cohort, hosted, browser E2E, unattended or latest-target qualification.
See [the sharing gate](README.md#validation-and-sharing-gate).
