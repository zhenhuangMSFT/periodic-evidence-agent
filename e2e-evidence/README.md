# Evidence-to-Draft-PR E2E proofs

This directory contains sanitized, machine-checkable proof bundles for completed
real evidence-to-Draft-PR runs.

Each run directory is immutable and contains aggregate collection coverage,
complete FILTER accounting, the selected coverage-gap binding, repository-skill
execution, exact-revision validation, the Draft PR receipt and safety limits.
`SHA256SUMS` binds the committed files.

Raw source bodies, captures, identities, local paths, private execution packets,
SQLite ledgers and logs must remain in approved ignored storage. A committed
bundle contains hashes that an authorized operator can revalidate against those
private artifacts with `e2e-proof-check`; it is not a replacement for them.

Do not manually mark a run successful. Generate the bundle only from a terminal
`draft-pr-validated` controller result and retain the private request used by the
checker.
