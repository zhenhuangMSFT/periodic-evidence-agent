# End-to-end execution guide

This guide covers the gated path from devbox setup to a source-bound draft PR:

```text
Setup and authentication
    -> scoped collection
    -> complete-record FILTER analysis
    -> complete-cohort consolidation and held coverage review
    -> one authorized repository proposer
    -> native validation
    -> draft PR
```

**This reconciled public version is offline-validated, not live-qualified.** Setup
and the offline demo do not establish package-feed access, hosted execution,
product-test success or complete source coverage. Live OA execution must remain
blocked until the selected authentication path and native execution prerequisites
are verified. Browser E2E is a separate workstream, not a prerequisite for OA
in-process integration tests.

A prior private controller revision completed one bounded saved-input
Collector/FILTER CLI replay, native-skill model authoring, both required
source-head native legs and automatic push plus one draft PR. Both final case
executions passed once with 26 assertions each. Emitted runtime import/mocks
order was verified before push; explicit raw output-file results supplied
acceptance because the wrapper's default summary was unavailable. No actual CI
builds were observed in that complete publication window. This selected
regression-coverage case did not qualify incident RCA, fresh collection/review,
full-cohort acceptance, unattended first-attempt reliability, hosted Agency,
browser E2E or target-merge/latest-vendor behavior. Its private artifacts and
product PR identity are not part of this publication.

Run commands step by step and stop on a nonzero exit or unresolved gate. The
examples do not authorize source reads, authentication setup, model jobs,
repository mutations or scheduling. Use only an approved distribution of this
repository and keep private evidence out of Git.

The thin role facade exposes discovery through
`npm run pilot -- agents` and `npm run pilot -- agent ROLE help`, where `ROLE`
is `collector`, `filter` or `proposer`. Role commands delegate to the existing
helpers and their permission gates; they do not automatically advance stages.
An operation-result envelope is not proof of role completion, complete-cohort
acceptance or native validation. See [README.md](./README.md) for the interface.

For the stricter fresh-cohort path, use the
[bounded one-shot controls](ONE-SHOT.md). They coordinate the existing local
collectors, reserve whole-cohort FILTER budgets before task reservation and
gate one proposer on complete source plus accepted execution evidence. The
existing Copilot session/host remains the orchestrator; external FILTER
submission/observation, approvals and runtime qualification remain its
responsibility. Legacy selected-case replay below keeps its original scope.

## 1. Clone and initialize the devbox

Prerequisites are **Node.js 24+, npm and Git**. Windows native validation and
diagnostics also require **PowerShell 7.3+ (`pwsh`)** for Job Object containment.
Live OA validation
also needs the selected profile's native toolchain, including Corepack and the
repository-pinned Yarn version.

```powershell
# Replace with the approved published branch or tag containing these interfaces.
$ControllerRef = 'REPLACE_WITH_APPROVED_PUBLIC_REF'
git clone --branch $ControllerRef --single-branch `
  https://github.com/zhenhuangMSFT/periodic-evidence-agent.git `
  periodic-evidence-agent

Set-Location .\periodic-evidence-agent
git rev-parse HEAD
node --version

# Select OA for the integration-first setup.
npm run setup -- --repo office-agent
```

Record the actual controller revision. Do not assume that local development
commits or configuration options are available from the remote branch.

If setup reports that the selected product repository is absent, and cloning
is approved, rerun:

```powershell
npm run setup -- --repo office-agent --allow-clone
```

Setup installs the controller's locked dependencies, initializes the selected
product checkout, performs read-only skill qualification, runs diagnostics,
executes the offline checks and runs the synthetic demo. Omit the `--repo`
selection only when setup of every configured skill-backed repository is intended.

**Setup does not authenticate product feeds, install product dependencies,
enable production dispatch or create PRs.** `synthetic-demo-passed` means fixture
assertions passed, not a live integration-test pass. The demo now includes real
FILTER validation/consolidation and isolated local proposer fixture execution,
with real Node test gates and failed-validation/stale-head/duplicate-dispatch
checks. Model authoring and push/draft publication are deterministic mocks.
The original partial synthetic collection is never promoted; proposer execution
uses the existing explicitly authorized synthetic reviewed-handoff interface.
See the [demo stage assertions](README.md#offline-demo-coverage) for the exact
scope and output artifacts.

Use `npm run setup:repos -- --repo office-agent` only when intentionally
rerunning the repository layer without repeating dependency installation and
all controller checks.

## 2. Resolve the private configuration

Setup uses the ignored `pilot.local.json`. Preserve an existing file; otherwise
start from the inert example:

```powershell
if (-not (Test-Path .\pilot.local.json)) {
    Copy-Item .\pilot.example.json .\pilot.local.json
}

npm run pilot -- doctor --config .\pilot.local.json
```

Resolve these fields with the responsible owner before live execution:

| Area | Required decisions |
| --- | --- |
| Collection | Executing user's identity, approved resources, explicit UTC window, source scopes and read/item budgets |
| Storage | Protected local state directory, access approval and retention |
| Repository routing | Owner/project binding, reference checkout, approved source/base ref and PR target |
| Authoring | Enabled native skill binding, permitted write paths and bounded worker/repair budgets |
| Validation | Approved executable, arguments, timeout, isolation and content-bound profile |
| Publication | Commit identity and separately approved commit, push and draft-PR permissions |

The example contains synthetic identities and unresolved limits. It is not a
ready-to-run production configuration. `doctor` reports configuration; it does
not prove authentication or runtime readiness.

Keep collection, review, dispatch and schedules disabled until their respective
authorization is established. Do not copy another user's credentials,
qualification receipts or execution budget. Do not use network-shared SQLite.
Protect `*.local.json`, `.state`, captures and raw validation artifacts, and
never commit them.

An existing run's configuration is immutable. Inspect or resume it with its
original configuration; use a separately configured new run for changed scope.

## 3. Establish authentication before live validation

These are independent access requirements:

| Access | What it enables |
| --- | --- |
| Git/ADO repository access | Fetch product source; push and create drafts only when separately authorized |
| Azure Artifacts authentication | Read every required default and scoped package feed |
| Copilot worker authentication | Run the selected local model-backed proposer |
| WorkIQ/ADO collection authentication | Read approved evidence as the configured executing user |

An Azure CLI account or token-expiry result does not prove package-feed read
permission. Verify both the default registry and any scoped registry used by
the selected OA source. A successful ordinary-checkout install also does not
prove that credentials reach an isolated controller validation process.
Compare source, lockfile, Yarn version, configuration and cache conditions;
a warm cache can hide missing authentication.

The intended local boundary is:

```text
Separately approved credential provisioning
    -> supported same-user authentication
    -> explicit, restricted credential handoff
    -> isolated controller validation
```

The checked-in OneNote version 3 profile uses the controller-owned authentication
broker. A cold dispatch checks the pinned `artifacts-npm-credprovider` 1.2.1
against an exact-source `.yarnrc.yml` snapshot before creating a worker. On
`action-required-auth`, keep the assignment `prepared` and follow its returned
`remediation` command from its declared `cwd`. If `requiresInstallApproval` is
true, obtain approval before installation; otherwise complete the Microsoft
sign-in/MFA. Do not request, display or persist provider credentials/diagnostics.
After successful remediation, retry the original command once. Declined/failed
remediation or a second auth-required result remains blocked, not a retry loop.

Trusted dependency-cache hits skip authentication preflight. Never delete a
receipt to force sign-in. The final dependency stage validates authentication
non-interactively; it must not refresh credentials or change pinned source.
The validation environment does not inherit arbitrary package-token or custom
package-manager configuration variables. The separate value-free
`packageAuth: {kind: "yarn-token", tokenEnvironmentVariable: "PILOT_OA_PACKAGE_TOKEN"}`
contract is available only for explicitly approved legacy runners and a supported
same-user setup launcher; it is not an automatic fallback from the broker.

Do not run OA's `ado-artifacts-auth.js` helper as a harmless diagnostic. It can
write Yarn configuration or trigger a global credential-provider installation.
Likewise, the product repository's full setup is not equivalent to this
controller's bounded `npm run setup`. Account consent and authentication setup
must be explicit, outside validation, and must not alter pinned tracked
configuration or place credentials in arguments, source, logs or receipts.

**Stop before live OA execution if this gate is unresolved.** Do not run a
blind install retry, broaden environment inheritance or switch executors to
work around missing authentication.

## 4. Qualify the selected source and native skill

After configuration points to the intended product source:

```powershell
npm run pilot -- qualify-skill `
  --repo office-agent `
  --capability integration-test-authoring `
  --binding oa-integration-test-core `
  --config .\pilot.local.json
```

The source revision, native skill and validation profile must agree. The
checked-in OneNote profile targets a particular contract; it is not a general
runner for arbitrary candidates. Do not assume the product's default branch
contains the required contract.

Skill qualification is read-only preparation, not proof that dependency
restoration, compilation or tests work. Profile or validation-contract changes,
including authentication-contract changes, require requalification before
preparing new assignments. Do not change an in-progress assignment's contract.

### Reusable Windows launcher/profile requirements

The private successful case profile, product test/card and receipts are not
distributed. A new approved profile must select its own source-bound cases and
required legs. It must not refer to another operator's runtime paths. Preserve
these reusable corrections when authoring that profile:

- Use a short private non-dot state root when the native test matcher rejects
  hidden-directory ancestors. Clones persist `core.longpaths=true` locally.
  Required LFS files belong in the gate's exact `lfsPaths` list, never broad smudging.
- Native processes run under the controller's Windows kill-on-close Job Object.
  Do not replace this with an uncontained shell or increase timeouts to mask
  leftover descendants. Model launchers use `localProposerEnvironment()`; native
  runners use their narrow environment and separate approved package auth.
- Preserve the host's `PATHEXT` including `.EXE`. Missing, empty or unusable
  values fail before native launch with `blocked-native-environment`; the runner
  does not synthesize defaults. The supervisor resolves an application and
  requires its process exit code, without requiring output from silent commands.
  Restore the host environment and follow the existing explicit reconciliation
  or continuation procedure; do not reset an attempted validation or retry it
  just because the environment was corrected.
- When invoking the native wrapper through a PowerShell function, pass the
  separator as the literal string `'--'`. Launch the wrapper with the pinned
  root Yarn tool environment, not plain `node`, so child root tools resolve:

```powershell
# Template only: replace package/path selection with the qualified native contract.
$corepack = (Get-Command corepack.cmd -ErrorAction Stop).Source
Invoke-Checked $corepack yarn node `
    'docs\skills\Integration-test-core\scripts\run-integration-tests.mjs' '--' `
    $corepack yarn workspace 'SYNTHETIC_PACKAGE' check:integration `
    --runTestsByPath 'tests/integration/synthetic-case.test.ts' --runInBand
```

`Invoke-Checked` must forward `[Parameter(ValueFromRemainingArguments = $true)]
[string[]]$Arguments` with `& $Executable @Arguments` and fail on nonzero exit.
The checked-in OneNote profile illustrates that helper but selects its own
different contract; it is not the private successful two-leg profile.

Fresh native TEMP/cache placement must stay at most 180 characters on Windows.
The historical successor APIs provide `nativeTemporaryDirectory()` automatically
for their source-bound test stage. Ordinary profiles do not implicitly become
historical successors. A new profile requiring a fresh cache can allocate its
own unique, protected profile-local test TEMP before either required leg:

```powershell
$nativeTemp = Join-Path $PSScriptRoot ('nt-' + [Guid]::NewGuid().ToString('N'))
if ($nativeTemp.Length -gt 180 -or (Test-Path -LiteralPath $nativeTemp)) {
    throw 'Use a shorter private state root and a fresh native TEMP directory.'
}
New-Item -ItemType Directory -Path $nativeTemp -ErrorAction Stop | Out-Null
$env:TEMP = $nativeTemp
$env:TMP = $nativeTemp
$env:TMPDIR = $nativeTemp
```

Run this only in the test stage of the content-bound profile, never during
fingerprinting. Preserve raw results and any required emitted-code proof before
explicit cleanup. A successful wrapper exit or unavailable default summary is
not case acceptance: parse the explicit raw output files, require each selected
case exactly once with its expected assertions, and reject missing/extra cases.
The generic offline argv/environment tests do not qualify any live product profile.

## 5. Collect evidence and run FILTER

For an explicitly selected already-collected and reviewed source, use
`agent collector replay-evidence` and `agent filter replay-review` under the
[recorded-source contract](APP-NATIVE.md#recorded-source-role-handoff) instead of
collecting/reviewing again. Those commands import exact pinned original records
into a held audit ledger. They are not a new full-cohort execution and do not
authorize an automatic transition to Proposer. The steps below describe the
separate fresh-collection and complete-cohort route.

### Collect within an approved scope

Open the controller checkout in a skills-capable Copilot host. A suitable
instruction is:

> Use evidence-collector with my approved pilot.local.json. Inspect existing
> runs first. Collect only the approved sources, UTC window and budgets.
> Persist original receipts, source versions and coverage. Stop on
> authentication failure; do not review or dispatch workers.

The collector uses the [begin and receipt contracts](APP-NATIVE.md#entry-points)
to create or resume the appropriate run. Inspect its persisted state:

```powershell
npm run pilot -- app-runs --config .\pilot.local.json

# Set $RunId to the existing run ID returned by the collector.
npm run pilot -- app-status --run $RunId --config .\pilot.local.json
```

For a production run, use its original configuration and add `--production`
to status inspection. A dry run cannot be promoted by adding that flag.
Missing bodies, incomplete paging and unavailable sources remain explicit;
unknown coverage is not zero.

### Prepare, execute and reconcile complete-record batches

Use `evidence-coordinator` to prepare the private source-ledger manifest,
complete context groups, sharing approvals and approved token budget under the
[batch contract](APP-NATIVE.md#complete-record-filter-batches). The input files
below are operator-produced private artifacts, not files supplied by setup.

```powershell
npm run pilot -- filter-batches `
  --file .\filter-batch-request.local.json `
  --output .\filter-batches.local.json `
  --config .\pilot.local.json
```

FILTER inspects titles and identity first, but each batch retains full captured
records and required context. Titles alone establish neither a defect nor a
missing test. Do not truncate an oversized context group.

**Hosted submission is a separate private integration.** The public repository
does not ship authenticated Agency submit/observe CLI commands. An approved
execution owner must provide the transport, exact task/source/profile selection,
request budget and monitoring. Batch preparation does not authorize a job.
Use the [Agency request and grading contract](AGENCY-EXECUTOR.md); the stronger
capture-verification policy is optional, not a prerequisite for the explicitly
approved local read-only FILTER policy.

After real results arrive, run this check for **each** result file:

```powershell
npm run pilot -- filter-batch-check `
  --file .\filter-result-1.local.json `
  --manifest .\filter-batches.local.json `
  --config .\pilot.local.json
```

Create `filter-results.local.json` as a JSON array of the exact result-file
paths for the complete original cohort. Replace the example ledger path below
with the approved original execution ledger:

```powershell
npm run pilot -- filter-execution-check `
  --file .\filter-results.local.json `
  --manifest .\filter-batches.local.json `
  --ledger C:\private\pilot\execution.sqlite `
  --config .\pilot.local.json

npm run pilot -- filter-consolidate `
  --file .\filter-results.local.json `
  --manifest .\filter-batches.local.json `
  --output .\filter-consolidation.local.json `
  --config .\pilot.local.json
```

Require both accepted execution and complete-cohort consolidation. One accepted
batch is not completion of the original cohort. Structural consolidation alone
does not regrade Agency execution. Cohort completeness also does not erase
limitations in the underlying collection.

## 6. Review coverage and prepare one repository handoff

Keep the output held while reviewing exclusions, ownership, existing tests,
coverage gaps and source compatibility. Follow the
[held Stage2 procedure](APP-NATIVE.md#held-stage2-coverage-handoff), including
the installed coverage-analysis skill and pinned reference. Missing skill or
reference inputs remain blocked; do not reconstruct a review from summaries.

Select one unblocked candidate bound to the intended repository and source.
Do not relabel a candidate from another repository, or present existing runtime
controls as newly discovered coverage.

Prepare `filter-handoff.local.json`:

```json
{
  "format": "filter-proposer-handoff-v1",
  "filter": {
    "manifestPath": "C:\\private\\pilot\\filter-batches.local.json",
    "resultPaths": [
      "C:\\private\\pilot\\filter-result-1.local.json"
    ]
  },
  "routing": {
    "capability": "integration-test-authoring",
    "requestedOutcome": "add-or-update-tests"
  }
}
```

Replace the illustrative paths with the actual manifest and **all** results in
the original cohort. The selected candidate's repository revision must match
the current skill qualification.

```powershell
npm run submit:filter-handoff -- `
  --file .\filter-handoff.local.json `
  --config .\pilot.local.json `
  --prepare
```

`--prepare` persists controller records and an assignment. It does not launch
the product worker and is not execution authorization.

## 7. Execute the authorized proposer

Only after authentication, routing, source/profile qualification and mutation
permissions are ready:

```powershell
npm run submit:filter-handoff -- `
  --file .\filter-handoff.local.json `
  --config .\pilot.local.json `
  --execute `
  --authorize-commit `
  --authorize-push `
  --authorize-draft-pr
```

This command can author code, commit, run native validation, push and create a
draft PR. It is **not a diagnostic command**. The flags acknowledge authorized
effects; they do not override unresolved configuration or qualification gates.

The controller owns execution and evidence:

```text
Isolated authoring
    -> committed revision
    -> locked dependency restoration
    -> scoped compile
    -> layout/card policy checks
    -> selected native tests
    -> explicitly bounded repair rounds, if authorized
    -> final source-bound validation
    -> push and draft PR
```

The bounded model worker has file tools, not general shell, browser, Git or
publication authority. Native validation and publication remain controller or
separately authorized executor responsibilities. A failed revision remains
immutable evidence; a repair is a new revision, not an erased failure.

Push and draft creation require every mandatory gate to pass at the exact clean
current HEAD. Missing, stale or duplicate gate results, post-validation source
changes and exhausted unsuccessful repair rounds must block publication.

A pre-model failure is not permission to reset a job or blindly dispatch it
again. A supported continuation preserves the blocked attempt and binds explicit
authorization to its successor configuration and controller revision. Check the
selected runtime's accepted budget limits before launch; do not silently raise a
ceiling to meet a runtime minimum.

The existing proposer role also exposes
`continue-local-validation`, `diagnose-local-validation` and
`continue-local-authoring`, each with explicit `--prepare` or `--execute` and
source/config/controller-bound input. Their narrow historical failure contracts
consume caller-supplied original receipts, preserve immutable predecessors and
reserve at most the specifically authorized successor. Missing historical
evidence fails closed. Do not manufacture receipts, broaden these guards into
a generic retry mechanism, or make new runs depend on a private predecessor.
Diagnostics never satisfy acceptance. This role facade is not an unattended
full-cohort scheduler.

### Optional synthetic reviewed-handoff smoke path

To exercise the downstream controller without claiming real collected evidence,
use the reviewed-handoff fixture after the same configuration and qualification
prerequisites:

```powershell
npm run submit:reviewed-handoff -- `
  --file .\test\fixtures\reviewed-handoff\onenote-bootstrap-progress.reviewed-handoff.json `
  --config .\pilot.local.json `
  --prepare
```

Its separately authorized execution form is:

```powershell
npm run submit:reviewed-handoff -- `
  --file .\test\fixtures\reviewed-handoff\onenote-bootstrap-progress.reviewed-handoff.json `
  --config .\pilot.local.json `
  --execute `
  --authorize-synthetic `
  --authorize-commit `
  --authorize-push `
  --authorize-draft-pr
```

Synthetic input remains synthetic even when real repository operations execute.
This path does not prove source collection, complete FILTER execution or a new
coverage gap. The native skill must still inspect the selected source rather
than assume the fixture's historical gap remains open.

## 8. Reconcile terminal evidence

Require the exact final source/profile identity, actual command exits, expected
case population and terminal results. For the existing two-case OneNote runtime
control, both cases must actually execute. Do not apply that fixed count to a
different suite.

A green pipeline, idle agent, draft PR or successful `--prepare` is insufficient.
Missing cases are not-run or unknown, not passed. Preserve first-attempt and
repair outcomes separately. Keep raw native outputs private; return only the
approved derived evidence with artifact hashes and source provenance.

Assign one monitoring owner and a bounded cadence to each external run. Persist
the request hash, returned handle/build, source/profile/case pins and submission
outcome. An uncertain submission must be reconciled, not blindly resent.
At terminal status, seal the evidence and stop the finite monitor. An unresolved
gate remains blocked; do not merge, enable schedules or create another run
without the required authorization.

## Executor selection and further references

`repositories[].flights.proposerExecutor` selects `"local"` or `"agency"` for
new work. Follow the [Agency executor contract](AGENCY-EXECUTOR.md)
and qualify the selected runtime before dispatch.

A flight supplies neither credentials nor runtime qualification. Missing Agency
selection blocks instead of silently falling back. Existing or uncertain
assignments retain their original binding; switching backends is not a retry
mechanism. Qualified OA integration execution does not qualify browser E2E.

- [README](README.md): setup behavior, repository skills and validation profiles.
- [App-native contracts](APP-NATIVE.md): collection receipts, batching and held review.
- [Agency contracts](AGENCY-EXECUTOR.md): private execution, budgets and grading.
- [Record schemas](scaffold/contracts.schema.json): exact accepted input shapes.
