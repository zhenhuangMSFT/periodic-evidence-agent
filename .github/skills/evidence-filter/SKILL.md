---
name: evidence-filter
description: >-
  Execute the FILTER role of periodic-evidence-agent: review pinned evidence,
  apply exclusions, consolidate complete-record analyses and prepare held
  coverage proposals. Not for source collection, proposer execution or publication.
---

# FILTER agent entrypoint

This is one of the three top-level roles: Collector, FILTER and Proposer.
The coordinator and improvement-planner procedures are internal procedures of
this role, not additional agents to spawn. A session is an executor; the local
ledger and immutable artifacts are durable state.

## Input

Receive the selected configuration, exact source-ledger/capture inventory,
evidence versions and the requested review/planning operation. Read persisted
status before doing work. Do not silently use another configuration or cohort.
Use `npm run pilot -- agent filter help` to discover the versioned role descriptor.
Existing commands retain their input contracts:

```powershell
npm run pilot -- agent filter filter-batch-check --file result.json --manifest batches.json --config pilot.local.json
```

Selecting this role does not launch a model or grant execution permission. Qualified
hosted FILTER execution still requires the existing private transport and its
explicit authorization; it is not a public CLI capability.

The fresh [one-shot controls](../../../ONE-SHOT.md) expose
`one-shot-filter-prepare` and `one-shot-filter-reserve` for separately approved
local aggregate/task reservations **before** the host submits any FILTER work.
They do not submit or observe provider jobs. Retain original reservations on
uncertain outcomes and never turn historical execution into fresh authorization.

## Procedure

For an already-reviewed, selected saved source, `agent filter replay-review`
validates the Collector receipt and reproduces the original decision records in
a separate held ledger. Follow the
[recorded handoff contract](../../../APP-NATIVE.md#recorded-source-role-handoff).
Distinguish genuinely captured input envelopes from explicitly labeled recovered
input projections. Neither replay nor recovery is a new review, coverage search
or full-cohort acceptance.

Follow [the coordinator review procedure](../evidence-coordinator/SKILL.md) for
exclusions, provenance, ownership and complete-record accounting. Use
[the improvement planner](../evidence-improvement-planner/SKILL.md) only for
eligible, current investigations. Coverage analysis still requires the installed
coverage-analysis skill and its pinned reference.

Keep the exact source versions, batch/input/result hashes, policy exclusions,
missing records and conflicting conclusions visible. A successful batch check
is structural evidence, not semantic qualification. One accepted batch is not
an accepted complete cohort. Intended behavior is not a confirmed defect;
unknown coverage is not a missing test.

## Output and resumption

Return durable investigation/plan or held-handoff references, exact source and
result pins, explicit acceptance scope (single batch or complete cohort),
exclusions, blockers and the next authorized gate. Preserve the underlying
result fields when returning an `agent-operation-result-v1` envelope;
`acceptance: not-inferred` never promotes a helper result into acceptance.

Resume from persisted evidence and decisions, not chat recollection. A changed
source/result/configuration requires the existing reconciliation procedure, not
overwriting a sealed handoff.

## Authority

Do not collect new sources, prepare or claim product workers, modify product
code, run product validation, publish, change activation or consume unapproved
provider budget. Local one-shot reservations require explicit approved limits;
they grant no provider submission permission beyond the configured contract.
A held review remains held until the separate dispatch gates are met.
Instructions and facade operation routing are not OS permission boundaries.
