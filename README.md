# Local evidence-to-draft-PR pilot

**Experimental controller; live execution requires separate authorization.** A local
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

[Bounded one-shot controls](ONE-SHOT.md) add coordinator-callable aggregate
collection/FILTER reservations, offline recovery and complete accepted-cohort
release to the existing helpers. They preserve authenticated WorkIQ provenance
in collection-only storage and keep saved replay distinct. The coordinating host
still supplies the authorized external FILTER executor; this is not a standalone
service or qualified unattended end-to-end run.

## Account-free quick start

Prerequisites: **Node.js 24 LTS**, npm and Git on PATH. Windows PowerShell is
the primary supported shell. From a clean checkout of the selected public branch:

```powershell
Set-Location .\periodic-evidence-agent
npm ci --ignore-scripts
npm test
npm run demo
```

Use a normal clone of this repository, select the intended published revision,
and record `git rev-parse HEAD`. Public `master` is not evidence that a feature
branch has landed. Never copy a development `.git` directory or private runtime.
See the [execution guide](EXECUTION-GUIDE.md) for the separately gated live path.

No Copilot CLI, Azure CLI, WorkIQ sign-in, product checkout or credentials are
needed for these commands. Dependency download needs access to the configured
npm registry. Tests and the demo themselves make no live source/model calls.
Tests use synthetic evidence and disposable temporary Git/SQLite workspaces.
Node may print an experimental SQLite warning.
The lockfile uses canonical npm registry URLs and pinned integrity hashes. On
networks that block the public registry, configure your organization's approved
npm mirror (for example with `npm_config_registry`) before `npm ci`; do not
disable TLS verification or copy another user's npm credentials.

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

### Offline demo coverage

The demo prints JSON with these stable collection fields (excerpt; paths,
timestamps and generated fixture commits vary):

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
  "collectionWorkers": 0,
  "scheduleEnabled": false
}
```

`synthetic-demo-passed` means fixture assertions passed, **not** a successful live
dry run. IcM deliberately stays unavailable; unknown coverage is not zero.
The demo imports a root and an in-window reply to an older root, replays a batch
without duplicates, then closes/reopens the ledger. It checks synthetic provenance,
cursor completeness and absence of dispatch **from that incomplete collection**.
It then exercises FILTER and a separately authorized synthetic proposer fixture:

| Stage | Required assertions before the demo can pass |
|---|---|
| FILTER | Pack all three records into two complete-context batches; reject missing sharing approval and insufficient batch budget; validate exact payload and detail membership; consolidate duplicate candidates across batches and select the higher-ranked gap. |
| FILTER negative cases | Missing, partial or conflicting results cannot select a candidate; stale payloads and omitted details are rejected; complete no-candidate results remain unselected. No provider execution or semantic-analysis qualification is claimed. |
| Synthetic handoff | Direct production handoff of synthetic collection evidence is rejected. A new, explicitly synthetic `reviewed-handoff-v1` fixture pins the selected candidate and original manifest/result hashes without changing the collection ledger. Missing synthetic/commit/push/draft authorization is rejected before preparing a job. |
| Local proposer | Load a qualified skill from a disposable Git repository, enforce edit bounds, deterministically author a test of the fixture's real selection function, commit locally and execute real behavior and syntax gates in isolated validation checkouts. |
| Publication guards and recovery | An intentionally failing assertion and a separately injected stale-head result must both block before publication. Only the passing exact-head case reaches mocked push/draft callbacks. Reopening each ledger must still reject duplicate dispatch. |

`workflow.filter` reports the held structural result, not a qualified fresh
execution cohort: the original source coverage remains incomplete.
`workflow.proposer` reports three isolated fixture attempts (failed validation,
stale head, success), their real gate artifacts and simulated publication counts.
The successful controller outcome is `draft-pr-validated`, but its draft URL is
`example.invalid`: **no model, source service, product repository, real push or
real PR is used**. Deterministic FILTER analysis/token counting and model authoring
are fixtures; existing controller, ledger, skill, Git and validation APIs run.
This is not unattended live E2E qualification or a bypass of the fresh-cohort guard.

Each invocation writes only its own disposable `.state\demo-*\` directory inside
the checkout, including the original collection summary, FILTER artifacts,
fixture checkouts and `workflow-summary.json`. The example and saved collection
config remain inert; synthetic dispatch is enabled only in an in-memory fixture
configuration. Node.js 24+, Git and (on Windows) PowerShell 7.3+ are required.
Windows must retain `PATHEXT` including `.EXE`; the demo rejects its absence and
also requires actual behavior-test output, not merely a zero process exit.
The production Windows native runner likewise fails closed on missing/empty or
unusable `PATHEXT`, requires application resolution and a process exit code,
and preserves legitimate silent successful commands. It does not invent
environment defaults or treat nonempty output as proof of success.
To clean up, remove only the specific demo directory printed by that invocation,
never the whole `.state` tree.

## Independent agents and contracts

The three top-level entrypoints are `evidence-collector`, `evidence-filter` and
`evidence-proposer`. FILTER delegates to the coordinator/planner procedures;
Proposer selects the configured repository-owner procedure. These packages do
not create additional agents, daemons, permissions or execution budgets.

```powershell
npm run pilot -- agents
npm run pilot -- agent collector help
npm run pilot -- agent filter help
npm run pilot -- agent proposer help
npm run pilot -- agent collector app-status --run RUN_ID --config pilot.local.json
```

`agent ROLE EXISTING_COMMAND` is a thin operation adapter: it dispatches the
existing helper with unchanged arguments, input schemas, defaults and guards.
Discovery returns versioned definitions with skill/procedure hashes, input and
output expectations, supported operations and resumption policy. Unknown roles
or cross-role operations fail before configuration/state access.
All three roles can inspect the same app-native run with `app-runs` and
`app-status --run RUN_ID`; the legacy `reconcile` helper inspects the standalone
SDK ledger, not an app-native run.

Accepted invocations return an `agent-operation-result-v1` envelope containing
`role`, `operation`, `kind` and the original `result` or safe `error`. The result
marker `acceptance: not-inferred` is intentional: helper completion does not
establish complete collection/cohort acceptance, a qualified assignment, passed
validation or publication. Consumers must inspect the original durable contract.
Existing commands without `agent ROLE` retain their output and exit behavior.

The facade does not implement a new scheduler or automatically advance between
roles. App-native hosts still execute the skills and drive existing durable
operations; the controlled proposer uses the same worker and pass-only,
exact-clean-HEAD publication guard. A blocked/uncertain attempt is preserved,
never reset or blindly redispatched. Source/provider transports, held review,
dispatch permissions and continuation authorization remain separate gates.

For an already-authored candidate, the roles can consume genuine saved evidence
and decisions before a separately authorized validation-only continuation:
`agent collector replay-evidence`, `agent filter replay-review`, then
`agent proposer continue-local-validation --prepare|--execute`.
The first two operations are explicitly import/replay, not new collection or
review. Their held, content-bound receipt is required by continuation preparation;
help/status output cannot substitute. See
[recorded-source role handoff](APP-NATIVE.md#recorded-source-role-handoff).

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

Downstream proposers can independently select local or Agency execution using
each repository's `flights.proposerExecutor` (`"local"` or `"agency"`).
The example defaults to local; OA can opt into Agency without rerouting 1JS E2E
or FILTER. Flights neither activate dispatch nor qualify a runtime, and never
fail over or migrate an existing assignment. See the
[executor flight contract](AGENCY-EXECUTOR.md#per-repository-executor-flight)
for qualification, legacy configuration and private transport requirements.

**Historical FILTER scope:** one 15-member canary was accepted against exact
request/result/source-bound execution: 7 reviewed records, 8 title exclusions
and 5 candidate analyses (2 deferred E2E, 3 integration, including 1 unblocked
gap). The user reduced execution to that one batch; the remaining 6 batches
were not run, not failures. There is no complete 94-member cohort handoff,
product integration-test pass, periodic-readiness or collection-completeness
claim. Partial workplace-message coverage and unavailable incident coverage
remain limitations. Unknown publication effects and final checkout observations
remain unknown, not verified zero effects or a sandbox guarantee. Only this
sanitized aggregate is published; no private execution artifacts are included.

**Demonstrated bounded local flow:** at a prior private controller revision, one
selected regression-coverage case completed genuine saved-input Collector/FILTER
CLI replay, native-skill model authoring, both required source-head native test
legs, and automatic push plus one draft PR. Both final case executions passed
once with 26 assertions each; emitted runtime import/mocks order was checked
before push. The native wrapper's default summary was unavailable, so acceptance
used explicit raw output-file results. No actual CI builds were observed in the
complete push-through-PR window; draft policy rows were not builds.

That result is not incident RCA, fresh collection/review, full-cohort acceptance,
unattended first-attempt reliability, hosted Agency qualification, browser E2E,
or target-merge/latest-vendor validation. Failed predecessors remain failures.
This reconciled public version is offline-validated only, not a new live replay
of that private revision. Product PR identities, source heads and raw evidence
are deliberately excluded.

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
revisions, permitted write prefixes or exact files, commit identity and approved validation
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

Local wrappers that spawn the proposer CLI must use
`localProposerEnvironment()` from `src/workers.js`, not the native runner's
`minimalEnvironment()`. The former preserves only the documented
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` model-authentication variables
in addition to the minimal OS environment. The SDK inherits that environment;
`useLoggedInUser: true` cannot restore credentials omitted by the launcher.
Do not log values, copy credential caches or infer authentication from variable
presence. Native validation still uses the credential-free minimal environment,
with package authentication added separately only through its approved contract.
A launcher correction never authorizes replay of an exhausted assignment.
The existing `continue-local-authoring --prepare` request may instead include
`credentialAdmissionPredecessor: { configPath, assignmentId, terminalReport,
authDiagnosis }`, with absolute paths and `{ path, sha256 }` artifact references.
This narrowly permits one separately reserved successor of the first diagnosed
authoring attempt only when its sealed SDK events show the exact missing-token
query rejection, routine shutdown and zero reported usage, with no tools,
source edits, native cases or publication. It rechecks the original role and
diagnostic lineage, requires the corrected launcher and an unchanged scope/config
apart from private placement, and preserves both consumed reservations. An
invalid credential, unknown usage, additional event or another failed successor
is not eligible. Execute still accepts only `{ assignmentId }`; neither the
diagnosis nor variable presence counts as live authentication or validation.

A separately authorized `continue-local-validation` request with authorization
kind `native-wrapper-separator` handles only a later, sealed native
`missing_command` refusal after this author's exact first leg passed all 26
assertions. It retains the model-authored revision and both required native legs,
requires actual child-argv/native-parser evidence, and permits only quoting the
single PowerShell `--` separator in a new content-bound profile. The original
profile and exhausted attempts are not edited. This path invokes no model or
commit and still requires a fresh native cache, executed runtime-import proof
and all gates passed at the preserved revision before publication. Other native
failures and repeated continuations remain blocked.

Windows native validation and diagnostics require PowerShell 7.3+ and run inside a private
Windows Job Object established before the native command starts. The supervisor
owns the job's only handle, so normal exit, the existing stage timeout, or output
overflow also terminates its descendants; killing only the immediate shell is
not sufficient. Containment failure blocks launch without an uncontained
fallback. Arguments, output, the filtered environment and stage limits remain
unchanged. No global process, account, policy or configuration changes are made.

The existing diagnostic CLI also accepts a separately hash-bound
`native-launcher-timeout-diagnostic` after a sealed, fully drained zero-model
native-wrapper timeout. It preserves the failed reservation and changed source,
materializes verified native outputs in a new private workspace, and runs only
the unchanged first-leg prefix for at most 60 seconds. A preload records
bounded module/dispatch/filesystem-error progress without an inspector and is removed from descendant
environments. Source, case assertions and the case timeout do not change.
The ledger records the method before launch. Its receipt never grants validation
acceptance or publication and cannot replay the diagnostic.

Fresh native `TEMP`/`TMP`/`TMPDIR` use the short private `nt/<24-hex-key>`
layout and are capped at 180 characters on Windows. Node 24.19.0 can stall in
`module.enableCompileCache()` at some intermediate long TEMP lengths before
Corepack loads its library. Short placement preserves the normal compile cache,
fresh Jest cache and unchanged assertions rather than disabling caching or
extending a timeout. Oversized state placement fails explicitly before launch.
The unchanged validation-continuation CLI permits one separately bound
`native-launcher-cache-path` successor only after the drained wrapper timeout,
sealed layer diagnostic and isolated Node threshold proof. It retains the
original proposal, role/source lineage and exact profile, starts no model and
requires both native legs plus emitted-import/fresh-cache proof before the
existing pass-only publisher.

The OA skill owns validation intent and failure interpretation: it selects the
project runner, targeted tests, behavior-card checks and repair procedure. The
controller owns execution and evidence. A validation gate may bind a versioned
pipeline script using `profilePath`, `profileSha256` and the `{profile}`
argument placeholder. The controller verifies the profile hash before every
run, executes it outside the model tool surface, records the hash in the
operation artifact and returns bounded diagnostics to the next skill round.
Prestarted dependency or compile failures are terminal for that attempt, not a
cache miss. The controller preserves the original sanitized output, exit code,
timings and preparation revision without implicitly repeating preparation for
the authored revision. A separately recorded continuation is required; a blocked
runner is not evidence that source content drifted.

Checkouts skip broad Git LFS smudging. If native validation requires LFS files,
the approved gate must list them in `lfsPaths` as exact repository-relative paths
(no globs). This list is part of skill qualification and the compile-cache
contract. The controller uses installed Git LFS to fetch only those paths at the
exact revision from the configured repository, with clone-local object storage
and memory-only same-user ADO authentication. It verifies each source pointer's
SHA-256 and size and clean tracked source before native compilation or testing.
Unrelated LFS files remain pointers. No global LFS setup, filter bypass, implicit
retry, or credential-bearing configuration is performed. Missing Git LFS,
unavailable objects, authentication failure or object mismatch blocks validation
with the original sanitized native failure, never a successful preparation receipt.

The checked-in OneNote profile is
`scripts/validation/office-agent-onenote-bootstrap-progress.ps1`.
Its version 3 plan retains the controller-owned Azure Artifacts authentication
broker and explicit interactive recovery described under
[staged validation receipts](#staged-validation-receipts). A missing provider or
sign-in requirement returns `action-required-auth` before worker launch; follow
the exact returned remediation command and retry the original command once.
It restores the locked dependency graph using already configured feed credentials
and suppresses the repository's automatic credential refresh/provider installation.
Missing or expired feed access remains a setup blocker; validation does not sign in
or change authentication state.
Git access or an Azure CLI account alone does not configure Yarn registry access.
By default the validation runner does not inherit package-token or custom
Yarn/npm configuration environment variables. Its native auth helper can rewrite
project Yarn configuration and install a global credential provider, so invoking
that helper is a separately approved setup action, not an automatic validation
retry. Approved feed provisioning must work in isolated checkouts without changing
pinned tracked configuration or copying credential-bearing files into source or
validation receipts. An executor flight does not supply those credentials.

For a separately approved legacy local Yarn runner, a gate can explicitly opt into a single
broker-provided token from the controller's environment:

```json
"packageAuth": {
  "kind": "yarn-token",
  "tokenEnvironmentVariable": "PILOT_OA_PACKAGE_TOKEN"
}
```

The variable name must match `PILOT_*_TOKEN`; put only its name in configuration,
never its value. Complete supported same-user provisioning **before** launching
the controller. An explicitly installed, trusted setup launcher can acquire a
token through Microsoft's credential provider, assign the named environment
variable in memory and launch the controller in that process tree, without
rewriting `.yarnrc.yml`. Its documented standalone JSON interface must have stdout
captured in memory, **not** displayed or redirected to a file; stderr carries any
sign-in instructions. Check the installed tool's interface before relying on it:
the npm provider's v1.2.1 ESM `getToken` export fails to import under Node 24 with
`Dynamic require of "path" is not supported`, before any authentication occurs.
Do not patch the package or treat that tooling failure as missing feed permission.
Do not print the token, save it to a script/receipt, pass it on a command line,
or run interactive setup inside a validation gate. Provider installation,
sign-in and account consent are separate, explicit setup operations. The
controller's `npm run setup` does not perform them.

For example, in a dedicated PowerShell process after approved private provider
installation, capture the documented standalone response without displaying it:

```powershell
$provider = Read-Host 'Path to the privately installed CredentialProvider.Microsoft.exe'
$registry = Read-Host 'Approved Azure Artifacts registry URL from the pinned source'
# Replace doctor with the explicitly authorized flow command; doctor itself runs no validation.
$controllerArgs = @('doctor', '--config', '.\pilot.local.json')
try {
    $tokenJson = & $provider -U $registry -I true -C true -N false -V minimal -F json
    if ($LASTEXITCODE -ne 0) { throw 'Credential setup failed; resolve sign-in before continuing.' }
    try { $credential = ($tokenJson -join "`n") | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Invalid provider response; do not log credential-bearing stdout.' }
    if ([string]::IsNullOrWhiteSpace($credential.Password)) { throw 'Provider returned no credential.' }
    $env:PILOT_OA_PACKAGE_TOKEN = $credential.Password
    & node .\src\cli.js @controllerArgs
    if ($LASTEXITCODE -ne 0) { throw 'Controller command failed; inspect its secret-safe evidence.' }
}
finally {
    Remove-Item Env:PILOT_OA_PACKAGE_TOKEN -ErrorAction SilentlyContinue
    $credential = $null
    $tokenJson = $null
}
```

This is setup, not a validation profile. Do not print `$credential`, enable shell
tracing, or redirect the provider response to a log. Verify that the acquired
identity is the designated user and that **both** the default registry and scoped
registry permit reads. An account listing or token acquisition alone is not that
proof. A metadata probe must request the package endpoint and inspect its locked
version, not append a version to the endpoint; Azure Artifacts can return 404 for
that unsupported route even with a valid token. Keep probes and restore bound to
the same source, lockfile and registry configuration, with a cold private cache.

Only the selected gate receives `YARN_NPM_AUTH_TOKEN`. Staged profiles receive it
only during dependency restore and compile, not fingerprinting, policy checks or
tests. Non-staged runners receive it for their whole command. No custom npm/Yarn
configuration or unrelated environment values are forwarded. The selected
native runner and pinned registries must be trusted to consume the credential;
this is not a sandbox for untrusted scripts. Successful and failed command
diagnostics redact the token and its base64/URI representations before telemetry
or artifact capture. Missing/empty tokens block without automatic retries; token
presence is not proof of feed authorization. Real locked restore must establish
that. The value-free auth option is part of skill qualification and preparation
cache identity, so changing it requires requalification. Token rotation alone
does not invalidate reusable dependencies. The OneNote profile keeps its Yarn
cache beside the controller's private profile, not in a shared machine path.
On Windows, the controller sets `core.longpaths=true` in each newly provisioned
authoring clone's **local** Git configuration before skill attestation and checkout.
It also sets this in validation clones, including reused prepared clones, before
native validation commands run: skill attestation and native build tools spawn Git
without the controller's per-command `-c` settings. Validation does not change the
authoring clone's configuration. Reference checkouts and global or system Git
configuration are not changed; the fingerprint-only stage stays read-only.
Native Git attestation failures are reported as `blocked-repository-git`, with the
operation, exit status and a safe diagnostic category, rather than being treated
as proof that skill content changed.

`prepareLocalPreModelContinuation` in `src/local-continuation.js` is an explicit
operator API, not an automatic retry. It accepts only a reconciled blocked local
skill-attestation attempt with zero model rounds/tools, no validation or
publication operations, and a clean unchanged workspace. A one-attempt user
authorization must pin the prior attempt, source revision, controller revision
and fresh configuration hash. The configuration may change only its state
directory, except that a runtime credit-ceiling correction requires separate
explicit authorization of both the old and new finite ceiling, bound to that
configuration hash. The controller never silently raises a ceiling to satisfy a
CLI minimum. Other budgets, permissions and source pins must remain unchanged.
The API requalifies the skill, reserves a one-shot audit operation,
imports the original evidence/review/plan into a separate empty ledger and
prepares a new session for the same logical assignment. It never launches the
model, resets the old job, edits its receipts, retries validation or republishes.
An interrupted reservation or a second continuation requires reconciliation.

For a completed model proposal blocked by native-build LFS provisioning,
`prepareLocalValidationContinuation` accepts the previous config/ledger/assignment,
a separate empty next config/ledger, the preserved model proposal and an explicit
source/config/controller/proposal-bound future-local authorization. It requires a
successful source-bound materialization proof, an unchanged single authored commit,
the original completed native-skill result, no publication or uncertain operations,
failure before native tests executed, and zero repairs/infrastructure retries.
Only state-directory and explicitly pinned
`lfsPaths` additions may change; source, profile, assertions and permissions cannot.
It reserves one linked audit operation without resetting the previous job/result.

Execute only through `dispatchLocalValidationContinuation`, never ordinary
`dispatch` for a continuation assignment. This explicit entrypoint rechecks the
prior immutable result, job and operation snapshot, restores the same authored
revision in a new isolated checkout, and delegates to canonical native validation
and pass-only publication. It does not call the model, edit product files or create
a replacement commit. Its result reports zero new model tools/rounds and retains
the original skill result; the linked audit preserves the actual authoring lineage.
A second execution or changed prior state fails closed.

A failed zero-model continuation whose native command executed but found no test
bodies may receive one separately recorded `discovery-placement` correction.
This narrow authorization requires the exact native discovery failure, a pinned
read-only matcher diagnosis and a clean source-bound non-dot placement proof.
Only the separate state location may change; the proposal, source, native
profile, assertions, permissions and zero-retry limits remain unchanged. The
old test invocation remains failed, not relabeled as a preparation failure.
Both predecessor snapshots and original model authoring are rechecked before
dispatch. General post-test failures and repeated placement corrections remain
ineligible. Keep private execution artifacts beneath ignored `private-runtime/`
when a Windows dot-directory ancestor prevents native test discovery.

Separately authorized timeout diagnostics use
`agent proposer diagnose-local-validation` (see `APP-NATIVE.md`). These retain
failed acceptance records and use a fresh transform cache with logging-only
disposable test/harness instrumentation; they never create worker results or
publication eligibility. The diagnostic profile forwards the non-secret
`OAGENT_ADO_ARTIFACTS_AUTHENTICATED=1` auth-hook suppression marker to Yarn.
This marker prevents implicit setup; it is not authentication or feed-access
proof. A stopped owner may be reconciled with
`reconcileInterruptedLocalDiagnostic` only before its recorded case phase and
with no case artifacts. A fresh request can bind that immutable interruption
using `authorization.previousDiagnostic`; it cannot reset or resume it.

A completed cold-load diagnostic can separately authorize
`agent proposer continue-local-authoring`. This creates one fresh model-backed
assignment from the preserved proposal revision using the original captured
evidence, recorded role lineage, native skill and validation contract. It does
not reopen the failed worker or grant another validation-only attempt. The
current correction permits only a module-level real ExcelAgent import after
mock registration and an optional existing-card update. The complete behavioral
suite must remain unchanged; the controller checks this before committing.
One diagnostic may reserve only one successor, with zero in-attempt repairs.
Diagnostic receipts remain ineligible for acceptance or publication; the normal
dispatcher must validate the new revision before publishing its draft.
The successor's native test process uses a new private temporary directory for
its default Jest cache, with no change to the approved profile or test timeout.
Before publication, the controller also checks the actual emitted native test
code for an executable SUT import after mock registration and before the suite.

### 1JS declarative E2E authoring

The optional `1js-declarative-e2e-authoring` binding targets
`.github/skills/author-declarative-e2e-test/SKILL.md`. It is disabled and
unqualified in `pilot.example.json`; configuring a checkout or qualifying the
skill does not enable routing, writes, validation, push or Draft PR creation.
The binding accepts only `declarative-e2e-mini-spec-batch-v1`. Reviewed and
FILTER handoffs must provide every batch item before assignment:

```json
{
  "format": "declarative-e2e-mini-spec-batch-v1",
  "items": [{
    "inputItemId": "bizchat-create-canary-excel",
    "title": "Create a Canary Excel workbook from BizChat",
    "account": "AAD",
    "entryUrl": "https://copilot.cloud.microsoft/chat",
    "preconditions": ["Use the qualified signed-in AAD profile."],
    "orderedTestSteps": ["Open BizChat.", "Create and open the workbook."],
    "expectedUserVisibleAndDataOutcomes": ["A real .xlsx workbook opens and satisfies the declared table contract."],
    "cleanup": ["Restore changed flight values and close only the test-owned tab."]
  }]
}
```

Missing, malformed, differently versioned or duplicate-ID input blocks before
the worker starts. The validated object is content-bound into the coverage plan
and assignment and is shown to the repository skill as
`repositorySkillInput`; the skill may inspect the exact source revision but may
not invent omitted authoring requirements.

1JS authoring uses directory prefixes only for scenario directories and exact
`allowedWriteFiles` for shared declarative composites, UI maps and resource
registries. This intentionally excludes runner, loader and verifier code.
Harness repairs such as workbook-identity resolution require a separate,
explicitly authorized change/PR rather than broadening an authoring assignment.

The bounded model worker has file tools, not browser or process execution.
Native pre-authoring exploration and validation therefore require a separately
authorized executor and source-bound evidence. File edits alone are unvalidated
proposals, not completed native-skill execution; this boundary does not block OA
in-process integration validation.

Static validation and scenario discovery are necessary but do not prove the
signed-in product flow. Local live evidence must come from the qualified
profile with retries disabled; CI evidence must identify Pipeline 36540 runs
for the same final commit. Repeated attempts inside one build are not distinct
successful builds. If the repository skill requires five consecutive local
runs and five consecutive builds, fewer successes must be reported as partial
qualification rather than a completed authoring result.
### Staged validation receipts

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
| Bounded local saved-source proposer | One selected regression-coverage case, real native-skill authoring, two passing native legs, automatic push and one draft PR at a prior private revision | This reconciled revision live, browser E2E, hosted execution, full-cohort or recurring qualification |

The historical collection-only run remains **partial-or-blocked** and launched
no workers, PRs or schedules. The separately demonstrated bounded proposer above
does not complete that collection scope. Raw receipts, identities and runtime
state are not part of this package. Offline CI cannot promote either result
into broader live qualification.

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
Fingerprint workers share the SHA-256 helper without loading the controller's
schema validator; parallel output verification and cache mutation checks remain
enabled.
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
before push and Draft PR creation. Exhausted failed rounds remain blocked
locally; they cannot create a failed Draft PR. Merge is always
prohibited. Offline CI injects external model/PR boundaries and performs no
network access or live PR creation. Git push checks use temporary local bare
repositories only.

### Authoring workspace lifecycle

Local tasks use independent clones under
`<stateDirectory>/workspaces/<session_id>`, not shared Git worktrees. Automatic
cleanup is disabled by default, including when the configuration omits
`workspaceCleanup`. When explicitly enabled, after a Draft PR delivery receipt
is persisted, the task completes and releases its dispatch lock, the controller
attempts to remove its authoring clone. GC also understands historical
failed-validation draft delivery receipts; new dispatch is pass-only.
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

Before submission, run the read-only
[`filter-execution-check`](AGENCY-EXECUTOR.md#source-bound-cohort-and-colleague-handoff)
against the original execution ledger and exact manifest/results. This remains
an operator prerequisite: the proposer adapter checks structural consolidation
and source/skill pins, but does not itself load or regrade Agency execution
receipts. Its acceptance is not proof of accepted FILTER execution, and downstream
authorization flags do not replace that check.

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

The connected regression in `test/filter-batches.test.js` follows an accepted
source-bound FILTER result through declarative mini-spec planning, pinned skill
loading, bounded authoring, exact-revision validation and a local-bare Git push.
Source/provider receipts, the repository skill, model output and draft receipt
are synthetic; the validation command checks the generated fixture contract,
not a browser. This proves controller wiring, not native skill qualification,
product coverage or live E2E success. Real E2E still requires an approved identity,
reachable dedicated browser endpoint and successful repository-native execution.

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
Before push or draft creation, every required gate must pass at the exact clean
current revision. Exhausted repair rounds, missing or stale gate results, and
post-validation source changes remain blocked locally; failed drafts are not
published.

## Public package boundary

This public repository contains reusable controller code, a lockfile, synthetic
tests/demo, role skills, contracts and offline CI. Publication does not establish
live qualification or grant access to product repositories or workplace data.
Private evidence, product source/tests/cards, runtime configuration, identities,
credentials and execution artifacts must remain outside the published history.
No license grant is implied beyond the repository's explicit licensing terms.

Before adding a remote or pushing:

1. Confirm approved destination, access membership, content/retention rules and
   whether experimental code sharing is authorized before live qualification.
2. Run `npm test`, `npm run demo` and `npm run check:package`. Review
   `git diff --cached`, `git ls-files` and **all history**, not just `.gitignore`.
   The package check is a targeted hygiene guard, not a general secret scanner.
3. Verify personal config, `.state`, SQLite/WAL/SHM files, captures/receipts,
   `.env*`, logs, credentials, session folders and `node_modules` are absent from
   the tracked set/history. Do not upload raw evidence or auth support artifacts.
4. Review author metadata as published content. Select an appropriate Git
   identity, such as the account's GitHub noreply address, and retain required
   coauthor attribution; do not accidentally publish a configured workplace
   email. Removing a file from HEAD does not remove it from history; do not
   publish unsuitable history or rewrite it without explicit authorization.

No live publication remote is created and nothing is pushed to a live remote by
installation, tests, demo or CI. The demo uses disposable local Git checkouts and
mocked publication; some controller tests push only to temporary local bare repos.
Do not send the entire working directory as a zip. After review, use Git's
committed tree/export so ignored personal files cannot be included accidentally.
Colleagues must configure their own approved identity/scopes/authentication.

When integrating private development, start from the freshly fetched public
baseline and reconcile only approved reusable changes. Do not merge or
cherry-pick private history wholesale, even when its final tree looks clean.
After committing, audit every outgoing commit and reachable new blob against
that baseline, including commit messages and metadata, then push only the
reviewed branch with an explicit refspec. Never use `--all` or `--mirror`.
`check:package` inspects the staged tree and HEAD ancestry, not every local ref;
it does not certify unrelated checkpoint refs or private branches. Keep those
local and preserve their original owners.

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
