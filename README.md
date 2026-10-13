# Local evidence-to-draft-PR pilot

**Internal experimental software, not an approved public release.** A local
durable ledger and deterministic helpers for independent logical agents.
The primary pilot is manually driven by authenticated Copilot app tools; no
standalone SDK authentication, listener, account or conversation is needed for
the offline demo. Live collection, review, dispatch and scheduling default off.
An explicitly configured official local WorkIQ CLI transport is also available
for authorized collection-only runs. It is not a fallback from failed app auth;
see [the CLI contract](APP-NATIVE.md#explicit-local-workiq-cli-collection).
Token-renewal and unattended qualification remain deferred.
Budget-stopped channel scans can prepare a distinct, explicitly authorized
continuation run without refetching captured pages or losing buffered rows.
Root/reply context and an opt-in modified-time lane are documented in
[the continuation contract](APP-NATIVE.md#budget-stopped-continuation). Neither
feature authorizes additional live reads, automatic schedules or a delta feed.
IcM connector receipts can be replayed **offline** into a separate audit store;
live connector execution stays blocked pending an explicit timestamp/scope
contract. [Held Stage2 handoffs](APP-NATIVE.md#held-stage2-coverage-handoff) require
the installed coverage-analysis skill and pinned reference, read source ledgers
read-only, and cannot authorize product dispatch.

## Account-free quick start

Prerequisites: **Node.js 24 LTS**, npm and Git on PATH. Windows PowerShell is
the primary supported shell. From a clean checkout of an approved private repo:

```powershell
Set-Location .\periodic-evidence-agent
npm ci --ignore-scripts
npm test
npm run demo
```

For the verified local handoff bundle, create that checkout first with
`git clone --branch master .\periodic-evidence-agent-master.bundle .\periodic-evidence-agent`.
This is a local clone, not a publication/upload. Distribute the bundle only after
the sharing decision; do not substitute a copy of the development `.git`.

No Copilot CLI, Azure CLI, WorkIQ sign-in, product checkout or credentials are
needed for these commands. Dependency download needs access to the configured
npm registry. Tests and the demo themselves make no live source/model calls.
Tests use synthetic evidence and disposable temporary Git/SQLite workspaces.
Node may print an experimental SQLite warning.
The lockfile uses canonical npm registry URLs and pinned integrity hashes. On
networks that block the public registry, configure your organization's approved
npm mirror (for example with `npm_config_registry`) before `npm ci`; do not
disable TLS verification or copy another user's npm credentials. The development
host's clean-install verification uses its approved mirror with empty user/global
npm configuration and a fresh cache; direct public-registry TLS is unavailable
on that host.

## Devbox repository setup

This optional full product-development setup is not a prerequisite for the
local controller's existing-Agency FILTER path. Account-free pilot checks above
need no product checkout. Configure product repositories only for authorized
repository work; E2E setup is separate from the integration-first milestone.

From a new clone, install locked dependencies, initialize machine-local product
checkouts, qualify repository skills, run configuration diagnostics, execute the
complete offline check and run the synthetic demo with one command:

```powershell
npm run setup
```

The top-level command runs `npm ci --ignore-scripts`, then delegates repository
initialization to `npm run setup:repos`, runs `doctor`, `npm run check` and
`npm run demo`. The repository layer uses `pilot.local.json`, which is ignored
by Git. By default it selects every configured repository that declares at
least one `skillBinding`; no OfficeAgent-specific setup code exists. Add another
repository and its skill bindings to the configuration and the same command
includes it automatically. Use repeated `--repo` values to select a subset:

```powershell
npm run setup -- --repo office-agent --repo another-repo
```

Setup reuses a valid configured checkout or discovers one from explicit and
common local roots. It does not clone implicitly. On a new devbox where a
selected repository is absent, explicitly allow cloning:

```powershell
npm run setup -- --allow-clone --clone-root D:\repos
```

For diagnostics or development, rerun only the repository layer without
reinstalling dependencies or running the full offline suite:

```powershell
npm run setup:repos -- --repo office-agent
```

The command verifies Node.js 24+, checkout origins, remote default branches,
exact base revisions, repository skill paths and skill content fingerprints.
It does not install product-repository dependencies, authenticate accounts,
enable routing/write permissions or create PRs.

The demo prints JSON with these stable results (paths/timestamps vary):

```json
{
  "result": "synthetic-demo-passed",
  "provenance": "synthetic",
  "passes": [
    { "pass": "ado:created", "state": "complete", "evidenceCount": 1 },
    { "pass": "ado:changed", "state": "complete", "evidenceCount": 1 },
    { "pass": "workiq:created", "state": "complete", "evidenceCount": 2 },
    { "pass": "icm:created", "state": "unavailable", "evidenceCount": null }
  ],
  "uniqueEvidence": 3,
  "overallCollectionState": "partial-or-blocked",
  "workers": 0,
  "scheduleEnabled": false
}
```

`synthetic-demo-passed` means fixture assertions passed, **not** a successful live
dry run. IcM deliberately stays unavailable; unknown coverage is not zero.
The demo imports a root and an in-window reply to an older root, replays a batch
without duplicates, then closes/reopens the ledger. It checks synthetic provenance,
cursor completeness and absence of dispatch. Each invocation creates only its
own disposable `.state\demo-*\` directory inside the checkout and returns that
exact directory and summary path. To clean up, remove only the specific demo
directory printed by that invocation, never the whole `.state` tree.

## Independent agents and contracts

| Procedure / project skill | Responsibility | Durable handoff |
|---|---|---|
| `evidence-collector` | Scoped reads, receipt imports, coverage and auth failures | Evidence versions, captures, runs, cursors |
| `evidence-coordinator` | All exclusions, review, explicit repo ownership and atomic claims | Investigations and assignments |
| `evidence-improvement-planner` | Aggregate eligible evidence, discover/link coverage and select a qualified repository skill | Versioned areas-to-improve and test-coverage plans |
| `evidence-1js-owner` | Claimed 1JS RCA, authorized fixes and source-bound validation | Assignment-linked results and draft PR evidence |
| `evidence-office-owner` | Claimed Office RCA, authorized fixes and source-bound validation | Assignment-linked results and draft PR evidence |
| `evidence-oa-owner` | Claimed OfficeAgent test authoring through the repo-native integration-test workflow | Skill execution, source-bound validation and draft PR evidence |

The collector/reviewer currently share configured identity
`excel-evidence-coordinator`; owners use `repo-owner:<repoId>`. These are logical
roles, not four installed daemons. Skills are procedures, **not permission or
process boundaries**. Configuration and the local ledger survive conversations.
App-native sessions are temporary isolated execution contexts, never agent IDs
or the sole state store. Same-session automation is not the target architecture.
The current upstream milestone uses a local controller/ledger with explicitly
selected existing Agency FILTER execution and the
[essential local read-only analysis policy](AGENCY-EXECUTOR.md#essential-local-read-only-filter-policy).
It does not require shared 1JS runner changes. Missing Agency task selection
blocks this route rather than invoking a local-model fallback. The endpoint is
accepted complete-cohort consolidation and the colleague's existing held
handoff, not proposer execution or a product integration-test pass.

**Observed scope:** one 15-member canary was accepted against exact
request/result/source-bound execution: 7 reviewed records, 8 title exclusions
and 5 candidate analyses (2 deferred E2E, 3 integration, including 1 unblocked
gap). The user reduced execution to that one batch; the remaining 6 batches
were not run, not failures. There is no complete 94-member cohort handoff,
product integration-test pass, periodic-readiness or collection-completeness
claim. Partial workplace-message coverage and unavailable incident coverage
remain limitations. Unknown publication effects and final checkout observations
remain unknown, not verified zero effects or a sandbox guarantee. Only this
sanitized aggregate is published; no private execution artifacts are included.

See [APP-NATIVE.md](APP-NATIVE.md) for exact command/receipt/claim/result contracts,
[the schema](scaffold/contracts.schema.json) for portable records, and
[CONTRIBUTING.md](CONTRIBUTING.md) for unassigned workstreams and acceptance criteria.
New conversations discover existing runs with `app-runs` and inspect them with
`app-status`; they do not repeat collection or relaunch uncertain assignments.
Do not use network-shared SQLite. Each colleague owns a protected local ledger.

## Configuring an authorized manual pilot

`pilot.example.json` is portable, inert and uses synthetic identity/channel
values. It does not authorize source access. Preserve an existing personal file;
otherwise copy it once:

```powershell
if (-not (Test-Path .\pilot.local.json)) {
  Copy-Item .\pilot.example.json .\pilot.local.json
}
# Resolve and approve the local configuration before these ledger operations:
npm run pilot -- app-runs --config .\pilot.local.json
npm run pilot -- app-status --run RUN_ID --config .\pilot.local.json
```

Resolve the designated delegated user/tenant/object ID, exact WorkIQ resources,
explicit UTC window, read/item budgets, protected storage approval/retention,
and enabled source scopes. Never copy another person's identity or credentials.
Source reads require separate authorization; importing a local file is not
proof of independent local authentication. Run configuration hashes are strict:
do not change an existing run's config. Use its original config to inspect it.

**Intentional product-specific selectors:** the current ADO adapter is fixed to
`office/OC`, non-Removed Bugs under
`OC\Excel\Intelligence\Copilot\Excel Agent`, including descendants. IcM export
validation is fixed to query `599514`; saved-query timestamp equivalence remains
unverified even when connector identity and team/severity mappings are qualified.
These selectors, the 1JS/Office repo URLs and the field names in
`scaffold` are integration constraints, not anonymous generic examples or access
grants. A different deployment needs a reviewed adapter/config change, not a
silent query substitution. The example's Teams IDs are fictitious.

Before code work, resolve repo owner/project binding, routing, base/target
revisions, permitted write prefixes, commit identity and approved validation
commands. Primary checkouts are references only; execution must use isolated
task workspaces. A worktree/clone is **not an OS sandbox**.

Each devbox keeps machine-specific checkout paths in an ignored `*.local.json`
file. The lower-level command can bootstrap one repository without hard-coding
a shared path:

```powershell
npm run pilot -- bootstrap-repo --repo office-agent `
  --config .\pilot.local.json
```

If `pilot.local.json` already contains a valid checkout with the configured
origin, it is reused. Otherwise the command searches explicit `--search-root`
values followed by common per-user checkout roots. If no matching checkout is
found, it clones into `--clone-root` or the user's `Repos` directory. The
command records the verified top-level path and the remote default branch in
the local file; it never enables routing, writes, validation or PR permissions.
Only filenames ending in `.local.json` are accepted, and the repository
`.gitignore` excludes those files.

Improvement work adds two durable planning records before assignment:
`areaToImprove` clusters eligible investigations into a stable, versioned theme;
`testCoveragePlan` records complete/partial/not-run coverage discovery and
distinguishes linked coverage, a confirmed coverage gap and an unresolved
search. A planned assignment pins both record versions, capability, requested
outcome and one qualified repository skill binding. Repository skills execute
from the exact isolated source revision and cannot grant themselves shell,
network, commit, push or PR authority.

For OfficeAgent, the qualified router entry is
`.github/skills/integration-test-authoring/SKILL.md`; it resolves an exact
project root, delegates to `docs/skills/Integration-test-core/workflow.md` and
auto-discovers the project shell. A read-only qualification can verify the
configured checkout, origin, base revision and skill content fingerprint before
routing or writes are enabled. Repositories configured with
`qualificationRefresh: "fetch"` fetch the trusted remote ref first instead of
assuming the local branch is current. The receipt binds that exact revision,
the skill SHA-256 and the repository validation contract version/hash:

```powershell
npm run pilot -- qualify-skill --repo office-agent `
  --capability integration-test-authoring `
  --binding oa-integration-test-core `
  --config .\pilot.local.json
```

Qualification does not approve ownership, write prefixes, validation gates,
commit identity, push or draft PR creation. Ambiguous project names remain
blocked; assignments must pin the repo-relative owner project. A changed skill
or validation profile requires a new qualification and is used only by new
assignments; an in-progress repair loop never changes contracts mid-run.

The OA skill owns validation intent and failure interpretation: it selects the
project runner, targeted tests, behavior-card checks and repair procedure. The
controller owns execution and evidence. A validation gate may bind a versioned
pipeline script using `profilePath`, `profileSha256` and the `{profile}`
argument placeholder. The controller verifies the profile hash before every
run, executes it outside the model tool surface, records the hash in the
operation artifact and returns bounded diagnostics to the next skill round.
The checked-in OneNote profile is
`scripts/validation/office-agent-onenote-bootstrap-progress.ps1`.

A content-bound profile may opt into controller-managed staged validation with
one `PILOT_VALIDATION_PLAN` JSON comment. The fixed stage contract is
`dependencies`, `compile`, `policy`, then `test`; the controller selects the
stage through `PILOT_VALIDATION_STAGE`, not through worker input. Before worker
authoring it can prepare the pinned base revision in a controller-only
workspace. Preparation has two independently auditable receipts. The
dependency receipt is keyed by the lockfile inputs, profile hash and
Node/Corepack/Yarn/platform fingerprint, not by source revision. A compile
receipt binds an exact source revision and build configuration to that
dependency receipt. Validation artifacts record dependency and compile cache
hit/miss state plus checkout, dependency materialization, preparation, policy,
test and cleanup timings. Cache-hit artifacts also separate receipt loading,
changed-path checks, input fingerprinting and prepared-output verification;
cleanup separates source restore, prepared-output verification and source
cleanliness. Yarn resolution/fetch/link subphase timings are included when
available.

Version 3 staged plans may bind an `azure-artifacts-npm` authentication
contract. Before a local worker launches, a controller-owned preflight checks
authentication only when the matching dependency receipt is absent. If the
pinned provider is missing or the current user must sign in, dispatch returns
`action-required-auth` while the assignment remains `prepared`; no workspace,
worker session or tool budget is created. The result contains a non-secret,
structured remediation command bound to a controller-owned `.yarnrc.yml`
snapshot extracted from the exact base revision. After the user approves any
required pinned provider installation and completes Microsoft sign-in/MFA, the
agent retries the original controller command once and resumes the same
assignment.

The exact-revision dependency preparation still performs a final non-interactive
authentication validation before the locked restore. It never emits a token or
passes arbitrary shell secrets to the worker, compile, policy or test stages.
Unexpected provider drift, anonymous requests, expired credentials or feed
denials after preflight become `blocked-auth` and are not treated as
infrastructure retries. Dependency and compile cache hits do not run either the
authentication check or the authentication stage.

On a new Windows machine, the agent may prepare the approved provider and
current user's feed authentication explicitly:

```powershell
npm run setup:validation-auth -- -Workspace C:\path\to\OfficeAgent

# Only when the pinned provider is absent or has the wrong version, after
# approving installation of @microsoft/artifacts-npm-credprovider@1.2.1:
npm run setup:validation-auth -- -Workspace C:\path\to\OfficeAgent -InstallProvider
```

The general `npm run setup` command intentionally remains offline with respect
to product-repository authentication. Agents must never ask users to paste
tokens; the approved setup command delegates credential acquisition to the
pinned provider and the Microsoft sign-in flow.

Receipt reuse is deterministic and fail closed. Each compile preparation starts
from a fresh exact-revision source clone and receives a controller-made copy of
the verified dependency snapshot. The controller records every ignored
`node_modules` root produced by the locked install, uses native multithreaded
copying on Windows, and rewrites every internal junction or symbolic link to the
corresponding fresh-checkout path. Dependency fingerprints bind that complete
root inventory, Yarn install state, linker state and normalized internal links.
Production
or build input changes rerun compile but reuse dependencies. A later test-only
revision may reuse both receipts. Lockfile/profile/toolchain drift, missing or
corrupt snapshots and receipts, or ambiguous paths rerun dependency preparation
and compile. A recoverable retry of the same revision reuses completed
preparation but reruns policy and test. Snapshot and prepared workspaces are
serialized per receipt and source cleanliness plus declared outputs are
rechecked before and after every run. Large output sets retain the same complete
content/link fingerprint but calculate independent output roots through a
bounded controller-owned worker pool. Test-only reuse validates the active
compile workspace and its dependency-receipt lineage; damage to an unused
dependency source workspace does not invalidate an intact compiled snapshot,
but is detected and rebuilt before any later compile. Workers and repository
skills cannot access, write or approve cache metadata.

## Safety invariants

Agent 2 FILTER owns loose, high-recall title screening. The
[offline batching flow](APP-NATIVE.md#complete-record-filter-batches)
uses complete-record batches under explicit verified or user-approved bounded
estimate budgets, preserving related
context and consolidating all source-version results locally before proposer
handoff. Ambiguous and absent titles retain details; only obvious policy
exclusions may screen out, with typed reasons and title quotes. Titles establish
neither missing coverage nor executor feasibility. Existing
[title-first helpers](APP-NATIVE.md#title-first-filter-screening) remain optional
audit/selective-export tools, not a lazy-input prerequisite. Batch preparation,
membership checks and consolidation do not launch hosted jobs. Main flow/state remain
local. E2E execution/setup is deferred independently; relevant E2E findings and
coverage facts remain in the audit/handoff rather than being excluded.

- All 14 exclusions in the schema apply to **both defect and improvement**
  handoffs. Excluded evidence is audit-only. Functional classification is not
  confirmation of a code defect. Unknown ownership stays blocked.
- Preserve source ID/revision, query/asOf/review times and provenance. Imported
  app receipts are `app-tool-reported`; directly verified adapter reads are
  `authenticated-source`; directly identity-verified local CLI reads are
  `workiq-cli-verified`; fixtures are `synthetic`; owner exports are
  `owner-provided`. Never promote fixtures or imports to authenticated access.
- Scope and budgets are enforced before reads. Created and changed ADO lanes
  stay separate. Enumerate channel roots and replies, including older threads.
  Partial/auth-failed passes retain earlier evidence and the prior committed
  cursor. Only complete passes advance it. Missing data never becomes clean zero.
  WorkIQ modified-time scans are separately selected; budget continuations need
  a new run and explicit additional-budget approval. Complete enumeration is
  not a consistent historical snapshot.
- Stop on authentication failure; no retries until supported host refresh and
  a separately authorized attempt. No Graph fallback, token transfer, credential
  cache inspection, alternate identity or new grant. App and SDK auth are distinct.
- Claim assignments atomically before launch; persist handles promptly and
  reconcile uncertain outcomes. No duplicate workers or validation launches.
  Code changes require source-bound execution evidence for every approved gate;
  queued builds or policy checks alone are not validation.
- Draft PRs only. No merges, auto-completion, incident/ticket/source writes,
  unauthorized validation retry/cancel/requeue or implicit scheduling.
  Follow-up is separately bounded to at most one level, not a paging-budget escape.

Null limits are unresolved, not unlimited. Instructions alone are not runtime
enforcement; app permissions and native validation boundaries must also be
qualified. The app helpers track external worker outcomes but do not assert
that a reported draft has passed product validation.

## Validation and sharing gate

| Evidence | Demonstrated | Not established |
|---|---|---|
| Offline tests/demo | Synthetic ledger, scope/identity guards, exclusions, cursor retention, dedupe, claims and fixture execution | Live identity, permissions or product correctness |
| Historical local ADO run | Created 47 / changed 59 (39 changed-only), both passes complete at their recorded snapshots | Another user's access or ongoing coverage |
| Historical app WorkIQ run | Identity and 20-root metadata page succeeded, then detail read returned `AuthenticationRequired` (500) | Full-day roots/replies/body coverage or auth recovery |
| Local CLI WorkIQ continuation | Fresh identity, one bounded continuation; cumulative 4,000 examined / 4,003 returned, eight cohort records, three buffered | Exhausted channel enumeration, historical snapshot, renewal or app-HTTP recovery |
| IcM | Connector context/team mapping and bounded diagnostics on the pilot host; offline receipt replay/owner-export guards | Saved-query Source Created Time equivalence, live adapter activation or complete incident coverage |
| Repo work / PR / periodic operation | Fixture tests and guarded implementation only | Product validation, real PR lifecycle or recurring qualification |

The historical live run remains **partial-or-blocked**. Zero product workers,
PRs or schedules were launched. Raw receipts, identities and runtime state are
not part of this package. Offline CI cannot promote this status to live success.

Before calling this a successfully validated live collection pilot, obtain
complete authorized source coverage within the approved caps, durable receipts
and restart/replay evidence, and confirm zero unapproved effects. The blocked
app-HTTP WorkIQ binding needs supported app-host refresh before further reads.
Separately authorized local CLI execution does not unblock that connection.
IcM must be
qualified or explicitly excluded from a separately approved reduced release
scope; do not silently waive it. Collection-only success still does not qualify
code-fix/PR automation. Sharing preparation does not itself satisfy this gate.

### Head-bound PR review receipt

The pilot includes an auditable merge-preparation receipt for GitHub PRs. The
receipt records the exact reviewed head and base SHAs, reviewer/session,
findings, validation and residual risks. It contains no source evidence and is
posted as a structured PR comment through the already authenticated GitHub CLI.

```powershell
Copy-Item .\scaffold\pr-review-receipt.example.json .\review-receipt.local.json
# Fill in the exact PR head/base SHAs and the completed review results.
npm run pilot -- pr-review-publish --repo OWNER/REPO --pr NUMBER --file .\review-receipt.local.json
npm run pilot -- pr-review-verify --repo OWNER/REPO --pr NUMBER
```

Automatic publication is limited to the signed-in user's own PR. Another
author's PR requires explicit approval plus `--approve-other-author`.
Verification fails closed when the PR head/base changed, no matching receipt
exists, blocking findings remain, or any recorded validation failed or was not
run. The ignored `*.local.json` name prevents the local receipt from entering
the package. The command complements required CI and branch protection; it does
not merge or alter the PR.

### Authorized reviewed-handoff submission

The versioned `ReviewedHandoff` receipt is an upstream review decision, not a
second review implementation. It carries explicit source-neutral fixture
provenance, reviewer/exclusion/classification decisions and the requested
repository capability. `src/reviewed-handoff.js` is the production controller
boundary: it validates the receipt, materializes linked ledger records
idempotently, invokes normal planning/routing/assignment and dispatch, and owns
all repository side effects. `submit-reviewed-handoff` is the production-named
thin CLI boundary; it does not add orchestration or model permissions. Tests
invoke this same controller API and CLI rather than a separate E2E adapter.

Prepare the handoff without launching a worker or creating repository effects:

```powershell
npm run submit:reviewed-handoff -- --file .\test\fixtures\reviewed-handoff\onenote-bootstrap-progress.reviewed-handoff.json --config .\pilot.local.json --prepare
```

An authorized operator may run the real reviewed-handoff repository path only after
setup/qualification and separate acknowledgement of synthetic input, commit,
push and Draft PR effects:

```powershell
npm run submit:reviewed-handoff -- --file .\test\fixtures\reviewed-handoff\onenote-bootstrap-progress.reviewed-handoff.json --config .\pilot.local.json --execute --authorize-synthetic --authorize-commit --authorize-push --authorize-draft-pr
```

The ordinary live `dispatch` entrypoint continues to reject synthetic evidence.
Only the controller's non-forgeable reviewed-handoff dispatch path accepts the
explicitly authorized synthetic receipt. A repository worker may follow a
repository-native skill to author changes, but neither the worker nor skill
receives shell, Git, network or PR permissions.

After each authored revision, the controller commits it and runs the fixed
approved validation gates at the exact commit. Profiles without a valid staged
plan retain the original fresh temporary checkout for every attempt. Staged
profiles use separate controller-owned dependency snapshots and exact-revision
compile workspaces with immutable receipts and exclusive access. A dependency
snapshot can serve fresh source checkouts that share its lockfile, profile and
toolchain fingerprints; only deterministic test-only revisions reuse compile
outputs. The implementation retains `clone --no-hardlinks` for source
preparation: detached worktrees or shared-object clones make a durable cache
depend on another worktree's lifetime. Detached worktrees remain suitable for
ephemeral checkout optimization, but not as the durable receipt workspace.
A runner cannot validate changes it made during
execution: changed source or HEAD is blocked, and changed declared snapshot or
prepared output invalidates the cache.
Explicitly classified infrastructure blockers may receive at most
`limits.maxValidationInfrastructureRetries` attempts; trust, profile-hash and
policy failures are never auto-approved. A failed revision remains immutable validation
evidence; when `limits.maxValidationRepairRounds` permits, the controller gives
bounded diagnostic tails to a new repository-skill repair round, commits the
repair as a new revision and validates again. This is not a retry of the same
validation operation. The final committed revision is independently validated
before push and Draft PR creation. Exhausted failed rounds may create only a
clearly marked failed Draft PR under the configured policy. Merge is always
prohibited. Offline CI injects external model/PR boundaries and performs no
network access, push or PR creation.

### Authoring workspace lifecycle

Local tasks use independent clones under
`<stateDirectory>/workspaces/<session_id>`, not shared Git worktrees. Automatic
cleanup is disabled by default, including when the configuration omits
`workspaceCleanup`. When explicitly enabled, after a Draft PR delivery receipt
is persisted, the task completes and releases its dispatch lock, the controller
attempts to remove its authoring clone. This also applies to a failed-validation
Draft PR after all repair rounds finish.
Blocked tasks and tasks without a complete delivery receipt retain their clones.
Hosted execution does not create a local clone to clean.

The optional configuration controls automatic cleanup:

```json
"workspaceCleanup": { "enabled": false, "retentionHours": 0 }
```

Complete a controlled live smoke test in the approved environment before setting
`enabled` to `true`: preview an explicitly disposable, completed delivery, verify
the intended directory and remote commit, execute cleanup with only that
candidate eligible, and confirm that the PR, evidence, primary checkout and
caches remain intact. Never enable live cleanup using unresolved example settings.

A positive `retentionHours` retains the clone until that interval has passed
since delivery; there is no background cleanup scheduler. Manual GC remains
available even when automatic cleanup is disabled. Run it for controlled
validation, delayed cleanup, historical clones or retryable deletion failures.
Preview is the default:

```powershell
npm run pilot -- workspace-gc --config .\pilot.local.json
npm run pilot -- workspace-gc --config .\pilot.local.json --execute
```

GC checks only ledger-registered task directories. It takes controller locks,
requires a completed task with no unfinished operations, checks preserved
validation artifacts, and verifies that the remote task branch still points to
the delivered commit. Missing or changed remote branches, authentication
failures, detached HEAD, modified/untracked/ignored files, stashes, additional local branches
or linked Git worktrees prevent deletion. Historical clones may retain a copied
base branch only if its commits are included in the delivered revision.
Linked directories, primary checkouts and paths outside the exact registered
task directory are never removed.

Cleanup results are recorded separately in the ledger and exposed by `status`.
A cleanup failure does not change a successful PR delivery into a failed task;
manual GC reports failures separately. An interrupted or partially deleted clone
is retained if safety checks cannot be satisfied. Remote PRs and branches,
evidence, delivery receipts, the ledger, primary checkouts and prepared
dependency/compile caches are preserved. This repository does not restore
delivered workspaces, review PRs or merge them.

### FILTER-to-proposer handoff

`submit-filter-handoff` is the production bridge from the complete-record
`filter-consolidation-v1` flow to the same planning, repository-skill,
validation, push and Draft PR controller exercised by the reviewed-handoff E2E.
It accepts only a complete held consolidation with one unblocked selected
candidate, reloads the exact manifest and result receipts, imports the original
authenticated evidence and capture bytes, and requires the selected repository
revision to match the current repository-skill qualification. It never converts
the result into synthetic fixture evidence and does not accept a caller-supplied
review, repository or source revision.

The input contains only the immutable FILTER binding and the repository
capability used for routing:

```json
{
  "format": "filter-proposer-handoff-v1",
  "filter": {
    "manifestPath": "C:\\private\\filter-batches.json",
    "resultPaths": [
      "C:\\private\\filter-result-1.json",
      "C:\\private\\filter-result-2.json"
    ]
  },
  "routing": {
    "capability": "integration-test-authoring",
    "requestedOutcome": "add-or-update-tests"
  }
}
```

Prepare without repository effects:

```powershell
npm run submit:filter-handoff -- --file .\filter-handoff.local.json --config .\pilot.local.json --prepare
```

Execution remains a separate operator decision:

```powershell
npm run submit:filter-handoff -- --file .\filter-handoff.local.json --config .\pilot.local.json --execute --authorize-commit --authorize-push --authorize-draft-pr
```

Worker calls to `pilot_list`, literal `pilot_search`, ranged/full `pilot_read`,
`pilot_write` and `pilot_finish` share one `workerMaxToolCalls` budget across
the initial authoring and every repair round. Search and ranged reads are
repository-local, read-only and bounded; they do not grant shell or network
access. Each worker result records the limit, total/remaining calls, per-tool
counts and per-round usage so operators can replace bootstrap limits with an
observed percentile plus explicit headroom.

`test/fixtures/reviewed-handoff/validation-repair-drill.json` is the deterministic
failed-to-passed fixture. Its first revision intentionally fails the repository
gate; the next skill round consumes controller diagnostics, changes only the
failing test, and is committed and validated as a distinct passing revision.

## Local package and eventual publication

This repository is prepared for **internal experimental collaboration** only.
It contains code, lockfile, synthetic tests/demo, four skills, contracts and
offline CI. There is no open-source license grant or legal/public-release approval.
Use only an approved company-managed **private** repository once the live
validation/sharing gate and organizational requirements have been resolved.

Before adding a remote or pushing:

1. Confirm approved destination, access membership, content/retention rules and
   whether experimental code sharing is authorized before live qualification.
2. Run `npm test`, `npm run demo` and `npm run check:package`. Review
   `git diff --cached`, `git ls-files` and **all history**, not just `.gitignore`.
   The package check is a targeted hygiene guard, not a general secret scanner.
3. Verify personal config, `.state`, SQLite/WAL/SHM files, captures/receipts,
   `.env*`, logs, credentials, session folders and `node_modules` are absent from
   the tracked set/history. Do not upload raw evidence or auth support artifacts.
4. Review author metadata: commits intentionally retain the configured Git
   identity and required coauthor attribution. Removing a file from HEAD does
   not remove it from history; do not publish unsuitable history or rewrite it
   without explicit authorization.

No remote is created and nothing is pushed by installation, tests, demo or CI.
Do not send the entire working directory as a zip. After review, use Git's
committed tree/export so ignored personal files cannot be included accidentally.
Colleagues must configure their own approved identity/scopes/authentication.

**Local-history caveat:** the development checkout contains app checkpoint
refs under `refs/copilot/checkpoints/` with earlier personal configuration and
documentation, even though its original `master` had no commits. These refs
are retained, not rewritten. An empty `git log` is not evidence of an empty
object history. Consequently `check:package` intentionally fails in that
original checkout when inspecting all refs. Do not mirror it, copy `.git`, or
use a local clone optimization that could copy extra objects. The sanitized
baseline's committed tree can be exported and verified separately; only the
reviewed clean branch/tree is a publication candidate. The historical-ref
failure must not be suppressed or described as a clean all-history audit.
For an authorized local handoff, `git bundle create <output.bundle> master`
includes only the reviewed branch and its ancestors; never use `--all` or
`--mirror`. Check `git bundle list-heads <output.bundle>` and `git bundle verify
<output.bundle>`, then audit a fresh clone of that bundle before distribution.
Publication must likewise select the verified branch only, not hidden refs.

## Optional legacy SDK mode

Standalone SDK source/review/worker code and offline lifecycle regressions are
retained, but **not required** for the app-receipt path or demo. App-native config
rejects legacy network/model/worker/scheduler commands unless explicitly passed
`--execution-mode standalone-sdk`; that flag does not waive source/activation
guards. `node .\src\cli.js help` lists commands; use an explicitly approved
`--config .\pilot.local.json`.

The prior headless WorkIQ OAuth investigation is stopped. Do not use the retained
`scripts\Workiq-Auth-Repro.mjs --probe` to repair app auth or as a setup step.
It requires separate authorization. No token refresh, SDK bridging or listener
is part of this package. `scripts\Register-PilotTask.ps1` is legacy opt-in only;
do not run it during onboarding. All schedules remain disabled.

## Code map

`src\app-native.js` owns receipt imports and native assignment tracking;
`ledger.js` owns immutable state and atomic ownership; `sources.js` owns scoped
collection; `coordinator.js` owns review/routing; `followup.js` and `revisit.js`
own related/tracked evidence; `improvements.js` owns durable improvement and
coverage planning; `repository-skills.js` owns qualified repo-native skill
resolution and result normalization; `workers.js` owns legacy isolated execution,
validation and ADO draft-only publication; `runtime.js` owns optional SDK
bindings. `scaffold` contains portable policy/schema inputs, not a second
runtime configuration format. No app tools are assumed callable by scripts.
