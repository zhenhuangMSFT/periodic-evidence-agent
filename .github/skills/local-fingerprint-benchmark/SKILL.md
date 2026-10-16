---
name: local-fingerprint-benchmark
description: >-
  Run the local synthetic exact-revision fingerprint/controller benchmark only
  when the user explicitly requests it. Not for setup, periodic agents,
  automatic CI, source collection or cache approval.
---

# Explicit local fingerprint benchmark

Run only after an explicit user request. From this repository's selected task
checkout, use an absolute, new output file outside `e2e-evidence`:

```powershell
npm run benchmark:fingerprint -- --output D:\benchmark-results\fingerprint.json --samples 3 --files 4096
```

This creates disposable synthetic Git checkouts, runs controller-owned
preparation/validation with an actual local Node profile, and cleans up only
its own generated fixture. No product checkout, source connector, install,
authentication, remote push, PR or guardian is involved. The profile creates
synthetic dependencies without a package manager; it is not real product E2E.
Never redirect a retained product probe or manually edit a receipt to run it.

Report raw samples and measured event/task/entry counts. No-change warm and
event-heavy warm are separate scenarios. The command refuses to claim
event-heavy success without observed events and rehash coverage. It checks
failure, repeat failure, test-only repair with dependency/compile hits, and
independent full-fresh preparation at the same repaired revision. Compare
complete content hashes, all captured entries, status, test output, profile
and toolchain binding. Do not turn small samples into stable p50/p95 claims.

CPU is controller-process CPU (including fingerprint threads), not child
Git/profile CPU. Worker compute includes synchronous filesystem latency;
round-trip also includes startup and transport. Neither proves physical disk
I/O or antivirus cost. Keep fixture results separate from real product logs.
Read the runtime investigation in `scripts/validation/FINGERPRINT-PERFORMANCE.md`.

This skill cannot approve cache reuse, write trusted metadata, waive compile
or provide cross-process continuity. Restart, watcher loss, permission
uncertainty or corrupt state must require full controller verification.
Never add this command to setup, the periodic agent, default blocking CI or
automatic execution on another machine.
