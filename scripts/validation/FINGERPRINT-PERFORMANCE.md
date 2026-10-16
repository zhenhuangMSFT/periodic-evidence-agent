# Initial fingerprint investigation and explicit local benchmark

## Scope and evidence (October 16, 2026)

This change optimizes controller fingerprint planning and worker granularity.
It does not change the receipt schema, exact-revision/source-cleanliness checks,
profile/toolchain binding, ordinary-file SHA-256 coverage, source-mutation
detection or controller-only authority. The five-minute dispatched-task timeout
is unchanged. Initial baseline capture and the second complete verification
after watcher installation are both retained. Unknown filenames, rename,
watcher failure and unstable settlement still fail closed.

The preceding real OfficeAgent log reported 1,904.645 seconds for initial
verification of 200 output roots. The first task monitor appeared about
109 seconds after the start with zero tasks complete and eight just dispatched.
Its 122,177 cumulative tasks include two full passes and settlement; they are
not the task count of one scan. The log has no CPU or physical I/O accounting.
Its longest completed task was about 127 seconds. These observations do not
prove that hashing, the disk, antivirus or queueing caused the full 31.7 minutes.
The real 103-116 ms cleanup measurements had zero events and remain evidence
only for the no-intentional-change path, not the historical event-heavy workload.

Code inspection identified bounded recursive pre-scans calling `lstat` for
every visited entry and repeating traversal at split ancestors. A wide
dependency directory then became thousands of single-file worker messages.
Each dependency-entry worker call also resolved the same physical workspace.
Small fixtures reproduced those operations before changing code.

## Controlled small-fixture comparison

An ABBAAB run compared exact master
`3c5df009dfb183b3f009d93a519ac6d0120a15ea` (A) with the implementation (B)
against the **same** generated fixture: 4,096 files in a wide dependency and
4,096 files below three nested directories. Each variant has three samples.
The Windows host is shared; no other load from this task ran during this probe.
Separate initial before/after runs were noisier, so their wall times must not
be substituted for this controlled comparison.

| Measurement | Before (A) | After (B) |
|---|---|---|
| Worker tasks per full captured pass | 8,192 | 4 |
| Planner/main-thread `lstat` calls | 16,394 | 2 |
| Planner directory reads | 12 | 12 |
| Measured parent metadata-call wall time | 1,503 / 1,159 / 1,021 ms | 19 / 18 / 15 ms |
| Time to first dispatch | 1,713 / 1,300 / 1,161 ms | 149 / 125 / 112 ms |
| Full pass wall time | 4,828 / 3,877 / 3,554 ms | 2,594 / 1,946 / 1,876 ms |
| Process CPU (includes worker threads) | 12,625 / 11,968 / 11,438 ms | 5,688 / 5,406 / 5,547 ms |
| Captured entries | 8,197 | 8,197 |

Every pass produced SHA-256
`10a2e3aae0ad57aa6fea1e5f9682a12ca3a356707e4c8c9665e0c3ae6d69f978`.
A separate 32-file regression checks that one batch resolves the physical
workspace once, versus 32 resolutions through the individual entry API, with
identical values and captured entries.

This proves reduced metadata/task/CPU overhead and better wall time **for this
fixture**, not a new real OfficeAgent initial-verification duration. Do not
extrapolate the percentage to 31.7 minutes or claim stable p50/p95.

### Implementation and residual costs

The planner uses directory-entry types only to estimate bounded work.
Workers still perform actual `lstat`, content reads/hashes and link containment
checks. Sibling dependency entries share batches estimated at at most 2,048
entries; oversized directories are split and reconstructed in the original
sorted manifest order. One physical-root resolution is shared within a batch.
Captured entries and public fingerprint schemas are unchanged. Capture failure
does not retry the same recursive scan through a non-capturing fallback.

Planning is still synchronous and may repeat bounded directory enumeration at
split ancestors. Large ordinary output roots remain recursive path tasks, and
a single large/slow file can still dominate a task. This is not a solution to
every filesystem or serialization bottleneck.

`outputFingerprint` accepts an optional telemetry object. Initial
`verifyPreparedOutputs` returns separate baseline and verification telemetry;
cleanup artifacts retain it when a full scan occurs. Fields distinguish
planning, task/worker counts, dispatch queue sum/max, task round-trip sum/max,
worker compute sum/max, worker JSON serialization, serialized bytes, captured
entries, captured file hashes, total wall time and process CPU. Non-capturing
file counts are `null`, not an invented zero. Reconstructed directory entries
are not worker-captured entries, so these counts need not match total entries.

Process CPU includes fingerprint threads and concurrent work in that process,
but not child Git/profile processes. Worker compute includes synchronous
filesystem wait and CPU; round-trip includes startup, scheduling, transport and
structured clone. Worker JSON timing excludes the structured clone of captured
entries. Queue sums overlap across workers and cannot be added to wall time.
**Physical I/O wait, device throughput and antivirus attribution remain
unmeasured.** No size/mtime fast path replaces complete content hashes.

## Explicit local benchmark

```powershell
npm run benchmark:fingerprint -- --output D:\benchmark-results\fingerprint.json --samples 3 --files 512
```

`--output` must be a new absolute file outside `e2e-evidence`; no existing output
is overwritten. Defaults are three samples and 4,096 synthetic dependency
files. Bounds are 1-20 samples and 1-32,768 files. Use 512 files for a smaller
controller fixture; 8,192-file batching/schema boundary coverage also exists
in the ordinary regression tests.

This opt-in command creates its own temporary source Git repository, a pinned
local Node validation profile, a warm controller state and a separate
full-fresh controller state. Actual controller APIs own the receipts. The
fixture profile generates dependencies and compiled output locally without
installing packages. Nothing is read from a retained product workspace, and
no model, live source, authentication, network transport, push or PR is used.
Only its own disposable fixture is removed. JSON results, incremental stages
and failures persist at the explicitly selected output path.

Measured scenarios:

- Initial two-pass verification and no-intentional-change warm settlement.
- Up to 256 same-content file rewrites, yielding after each eight writes;
  separate workload duration and settlement duration are reported. Success
  requires observed events and hash coverage of every rewritten fixture file.
- Actual failing test, repeated failure, and a Git-committed test-only repair
  which passes with dependency and compile receipt hits. Repeated validation
  uses separate synthetic jobs so the ledger never bypasses operation identity.
- Fresh dependency creation and compile in independent controller state at the
  **same repaired revision**. Complete output hashes, all entry hashes,
  profile/toolchain binding, test output/status and clean source are compared.
- A separate unpaced file burst. Windows may report a null filename (observed
  with 256 writes here). This must invalidate warm trust, not be hidden or
  counted as a successful fast warm sample. Rejection requires a new full
  verification and its baseline telemetry before the benchmark can pass.

The paced workload is not proof of unbounded burst performance. A no-event
warm result is not substituted for either event scenario. Dirty guards report
current observed events rather than the preceding quiet settlement's telemetry.
Results contain raw samples/ranges/means, not stable percentile claims. Fixture
equivalence is not a full-fresh real OfficeAgent compile-output equivalence
proof or a complete controller-assignment E2E.

### Three-sample controller fixture evidence

A 512-file synthetic run recorded the following (milliseconds, rounded;
all samples retained, no percentile claim):

| Scenario | Sample 1 | Sample 2 | Sample 3 |
|---|---:|---:|---:|
| Initial two-pass output verification | 855 | 796 | 1,047 |
| No-intentional-change warm settlement | 109 | 110 | 106 |
| Paced 256-file rewrite workload (not settlement) | 2,194 | 2,044 | 2,500 |
| Event-heavy settlement after workload/drain | 521 | 457 | 395 |
| Observed events / hashed files / worker tasks | 512 / 256 / 256 | 512 / 256 / 256 | 512 / 256 / 256 |

The 200 ms explicit event-drain wait is also outside settlement time; these
numbers are not end-to-end workload latency. Every unpaced 256-file burst
returned `node_modules:change:unknown` with one recorded null-filename event.
All three new full-verification recoveries passed. The burst is a successful
**fail-closed/fallback check**, not a warm performance success.

All three samples reproduced failure twice, passed the test-only repair with
dependency/compile hits, and independently recreated dependency/compile state
with misses for the same repaired revision. The full captured entry maps,
output SHA-256, profile/toolchain binding and test outcomes matched. Raw local
artifacts are `fixture-alternating.json` and `benchmark-final-512.json`, with
earlier failed/uncontrolled probes preserved separately; no raw product or
private machine artifacts are checked into this package.

The skill is only an explicit local entrypoint. Neither the command nor the
skill is wired into setup, the periodic agent, default blocking CI or automatic
execution on another machine. Ordinary tests cover argument/summary contracts,
not execution of the benchmark command.

## Cross-process guardian decision: defer implementation

A service could amortize full scans across CLI process lifetimes, but this
fixture does not establish the remaining real-product cost or justify adding
another trust boundary now. No guardian, daemon, persisted validity bit or
cross-process cache authority is added by this change.

A future implementation must satisfy all of the following before it can
replace any full verification:

| Area | Required controller-owned contract |
|---|---|
| Lifecycle | Explicit start/status/stop only. Instance generation, controller code identity, process lifetime and continuous watcher coverage must be bound. Restart, exit, suspend/observation uncertainty or missed generation requires a new full verification. |
| Authority and identity | Only a controller-owned service may maintain trusted state. Bind workspace physical identity, exact revision, clean source, receipt integrity, complete outputs, policy, profile and toolchain. Skills/workers can request operations, never approve reuse or write trusted metadata. |
| Endpoint/permissions | A private local authenticated endpoint with user/service identity and restrictive ACLs; reject another user, untrusted worker, wrong workspace or controller generation. A listening PID or persisted `valid: true` alone is not evidence. |
| Watcher loss | Null filenames, rename, error/overflow, replaced roots or ambiguous events invalidate the generation immediately. Report why, then require complete content verification; do not resume trust from the last persisted snapshot. |
| Concurrency | Serialize settlement and validation/source restoration for each workspace and generation, pin active state against eviction, reject stale replies and bind results to the requesting controller operation. No validation races with cleanup. |
| Recovery/corruption | Fail closed on partial IPC, timeout, malformed state, corrupt receipt, binary/profile/toolchain drift or lost service ownership. Restart/recovery must establish a new complete baseline under observation. |
| Cleanup | Explicit ownership and active-lease checks; never kill unrelated processes, remove authoring workspaces or delete retained receipts to force a new trust decision. Service stop invalidates continuity. |

These are design gates, not implemented guarantees. Future qualification needs
process-death/restart, watcher-loss, spoofed IPC, concurrent settlement/cleanup,
permissions and corrupted-state tests, followed by source-bound real-product
measurements. A skill may expose lifecycle/status only; it cannot manufacture
the service's proof of continuous observation.

## Cold checkout: no change

A controller-owned mirror with locked detached worktrees remains lower
priority. Before implementation, demonstrate object retention during fetch/GC,
independent authoring isolation, concurrent leases, crash/lock recovery and
bounded cleanup of only owned inactive paths. Do not claim zero risk or reuse
another task's worktree. This change does not alter checkout/materialization.
