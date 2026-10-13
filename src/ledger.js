import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hash, json, now, uuid, requireThat, validateRecord } from './common.js';

export class Ledger {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = directory;
    this.db = new DatabaseSync(join(directory, 'ledger.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        body TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(kind,id,version));
      CREATE TABLE IF NOT EXISTS captures (hash TEXT PRIMARY KEY, body BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (
        run_id TEXT NOT NULL, evidence_id TEXT NOT NULL, observed_at TEXT NOT NULL,
        context TEXT,
        PRIMARY KEY(run_id,evidence_id));
      CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_blocks (source TEXT PRIMARY KEY, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS unblock_events (id TEXT PRIMARY KEY, source TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qualifications (id TEXT PRIMARY KEY, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assignment_budgets (bucket TEXT NOT NULL, assignment_id TEXT NOT NULL UNIQUE, PRIMARY KEY(bucket,assignment_id));
      CREATE TABLE IF NOT EXISTS discoveries (
        run_id TEXT NOT NULL, parent_id TEXT NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL,
        target_id TEXT, reason TEXT NOT NULL, PRIMARY KEY(run_id,parent_id,url));
      CREATE TABLE IF NOT EXISTS tracked_state (
        namespace TEXT NOT NULL, record_id TEXT NOT NULL, state TEXT NOT NULL,
        reason TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(namespace,record_id));
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, state TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, window TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS locks (
        name TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, acquired_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL, version INTEGER NOT NULL,
        repo TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT NOT NULL,
        workspace TEXT, base_revision TEXT, error TEXT, updated_at TEXT NOT NULL,
        UNIQUE(investigation_id,version,repo));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_investigation_repo
        ON jobs(investigation_id,repo) WHERE state NOT IN ('completed','superseded');
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL, detail TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_cleanup (
        job_id TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_records_update BEFORE UPDATE ON records
        BEGIN SELECT RAISE(ABORT,'Records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_records_delete BEFORE DELETE ON records
        BEGIN SELECT RAISE(ABORT,'Records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_captures_update BEFORE UPDATE ON captures
        BEGIN SELECT RAISE(ABORT,'Captures are immutable'); END;
    `);
    if (!this.db.prepare('PRAGMA table_info(observations)').all().some(c => c.name === 'context'))
      this.db.exec('ALTER TABLE observations ADD COLUMN context TEXT');
  }
  close() { this.db.close(); }
  transaction(fn) {
    const depth = this.transactionDepth ?? 0;
    const savepoint = `nested_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth = depth + 1;
    try {
      const result = fn();
      this.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw error;
    } finally { this.transactionDepth = depth; }
  }
  acquire(name) {
    const owner = uuid();
    const result = this.db.prepare('INSERT OR IGNORE INTO locks VALUES(?,?,?,?)').run(name, owner, process.pid, now());
    requireThat(result.changes === 1, `Ownership held for ${name}; reconcile the recorded owner, never steal a timed-out lock`, 'overlap');
    return owner;
  }
  release(name, owner) { this.db.prepare('DELETE FROM locks WHERE name=? AND owner=?').run(name, owner); }
  recoverLock(name, expectedOwner) {
    const lock = this.db.prepare('SELECT * FROM locks WHERE name=? AND owner=?').get(name, expectedOwner);
    requireThat(lock, 'Lock owner changed; refresh status');
    let dead = false;
    try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') dead = true; else throw error; }
    requireThat(dead, 'Recorded process is still present or PID was reused; do not reclaim');
    this.release(name, expectedOwner);
  }
  put(record) {
    validateRecord(record);
    const version = record.version ?? 1;
    const existing = this.get(record.recordType, record.id, version);
    if (existing) {
      requireThat(json(existing) === json(record), 'Immutable record identity conflict', 'invalid-record');
      return existing;
    }
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(record.recordType, record.id, version, json(record), now());
    return record;
  }
  get(kind, id, version) {
    const row = version === undefined
      ? this.db.prepare('SELECT body FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1').get(kind, id)
      : this.db.prepare('SELECT body FROM records WHERE kind=? AND id=? AND version=?').get(kind, id, version);
    return row ? JSON.parse(row.body) : null;
  }
  all(kind) { return this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY created_at,id,version').all(kind).map(r => JSON.parse(r.body)); }
  latest(kind) { return [...new Map(this.all(kind).map(r => [r.id, r])).values()]; }
  latestEvidence() {
    const latest = new Map();
    for (const record of this.all('evidence')) {
      const key = json([record.source.namespace, record.source.recordId]);
      const old = latest.get(key);
      const revisioned = record.source.kind === 'ado' && old?.source.revision;
      if (!old || (revisioned ? Number(record.source.revision) > Number(old.source.revision)
        : Date.parse(record.observedAt) >= Date.parse(old.observedAt))) latest.set(key, record);
    }
    return [...latest.values()];
  }
  evidenceRoles() {
    const roles = new Map();
    for (const row of this.db.prepare("SELECT r.body,o.context FROM observations o JOIN records r ON r.kind='evidence' AND r.id=o.evidence_id").all()) {
      const e = JSON.parse(row.body), role = JSON.parse(row.context ?? '{}').role;
      const key = json([e.source.namespace, e.source.recordId]);
      if (!roles.has(key)) roles.set(key, new Set());
      roles.get(key).add(role);
    }
    return roles;
  }
  candidates() {
    const roles = this.evidenceRoles();
    return this.latestEvidence().filter(e => {
      const observedRoles = roles.get(json([e.source.namespace, e.source.recordId]));
      return observedRoles?.has('seed') || observedRoles?.has('changed');
    });
  }
  trackedState(evidence) {
    return this.db.prepare('SELECT * FROM tracked_state WHERE namespace=? AND record_id=?')
      .get(evidence.source.namespace, evidence.source.recordId);
  }
  setTrackedState(evidence, state, reason) {
    this.db.prepare(`INSERT INTO tracked_state VALUES(?,?,?,?,?) ON CONFLICT(namespace,record_id)
      DO UPDATE SET state=excluded.state,reason=excluded.reason,observed_at=excluded.observed_at`)
      .run(evidence.source.namespace, evidence.source.recordId, state, reason, now());
  }
  evidence(record, payload, runId) {
    const body = Buffer.from(json(payload));
    const digest = hash(body);
    record.capture = { artifactRef: `sqlite:capture:${digest}`, sha256: digest, unavailableReason: null };
    record.id = `ev-${hash(json([record.source.namespace, record.source.recordId, record.source.revision, digest]))}`;
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO captures VALUES(?,?)').run(digest, body);
      const stored = this.get('evidence', record.id) ?? this.put(record);
      const run = this.db.prepare('SELECT source FROM runs WHERE id=?').get(runId);
      const role = run?.source.endsWith(':revisit') ? 'tracked' : record.discoveredFrom ? 'related' :
        run?.source.endsWith(':changed') ? 'changed' : 'seed';
      this.db.prepare('INSERT OR IGNORE INTO observations(run_id,evidence_id,observed_at,context) VALUES(?,?,?,?)')
        .run(runId, stored.id, record.observedAt, json({ queriedAt: record.queriedAt, snapshotAt: record.snapshotAt,
          queryText: record.queryText, role }));
      return stored;
    });
  }
  cursor(source) {
    const row = this.db.prepare('SELECT value FROM cursors WHERE source=?').get(source);
    return row ? JSON.parse(row.value) : null;
  }
  sourceBlock(source) {
    const row = this.db.prepare('SELECT detail FROM source_blocks WHERE source=?').get(source);
    return row ? JSON.parse(row.detail) : null;
  }
  blockSource(source, detail) {
    this.db.prepare('INSERT INTO source_blocks VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET detail=excluded.detail,created_at=excluded.created_at')
      .run(source, json(detail), now());
  }
  unblockSource(source, reason) {
    requireThat(typeof reason === 'string' && reason.trim().length >= 10, 'Record the concrete operator-verified unblock action');
    this.transaction(() => {
      requireThat(this.sourceBlock(source), 'Source is not blocked');
      this.db.prepare('INSERT INTO unblock_events VALUES(?,?,?,?)').run(uuid(), source, reason, now());
      this.db.prepare('DELETE FROM source_blocks WHERE source=?').run(source);
    });
  }
  qualify(id, detail) {
    this.db.prepare('INSERT INTO qualifications VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET detail=excluded.detail,created_at=excluded.created_at')
      .run(id, json(detail), now());
  }
  qualification(id) {
    const row = this.db.prepare('SELECT detail FROM qualifications WHERE id=?').get(id);
    return row ? JSON.parse(row.detail) : null;
  }
  startRun(source, window) {
    const id = uuid();
    this.db.prepare('INSERT INTO runs(id,source,state,started_at,window) VALUES(?,?,?,?,?)').run(id, source, 'collecting', now(), json(window));
    return id;
  }
  finishRun(id, state, error = null, cursor = null) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT source,state FROM runs WHERE id=?').get(id);
      requireThat(row?.state === 'collecting', 'Run already finalized');
      this.db.prepare('UPDATE runs SET state=?,finished_at=?,error=? WHERE id=?').run(state, now(), error && json(error), id);
      if (state === 'complete' && cursor) this.db.prepare('INSERT INTO cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value').run(row.source, json(cursor));
    });
  }
  prepare(assignment, budget = null) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM jobs WHERE investigation_id=? AND version=? AND repo=?')
        .get(assignment.investigationId, assignment.investigationVersion, assignment.repoId);
      if (existing) {
        const stored = this.get('assignment', existing.id);
        requireThat(stored && json(stored) === json(assignment),
          'Existing assignment has different execution semantics; reconcile before reuse',
          'blocked-reconciliation');
        return existing;
      }
      const prior = this.db.prepare('SELECT id FROM jobs WHERE investigation_id=? AND repo=? LIMIT 1').get(assignment.investigationId, assignment.repoId);
      requireThat(!prior, 'Prior assignment exists for this investigation/repository; reconcile existing work before any new version', 'blocked-reconciliation');
      if (budget) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM assignment_budgets WHERE bucket=?').get(budget.bucket).n;
        requireThat(count < budget.maxNew, 'Daily new-assignment budget exhausted; finding remains pending', 'blocked-budget');
      }
      this.put(assignment);
      this.db.prepare('INSERT INTO jobs(id,investigation_id,version,repo,state,session_id,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(assignment.id, assignment.investigationId, assignment.investigationVersion, assignment.repoId, 'prepared', uuid(), now());
      if (budget) this.db.prepare('INSERT INTO assignment_budgets VALUES(?,?)').run(budget.bucket, assignment.id);
      return this.job(assignment.id);
    });
  }
  job(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  moveJob(id, before, after, { workspace = null, baseRevision = null, error = null } = {}) {
    requireThat(!['prepared', 'dispatching', 'running'].includes(after) ||
      !['deleting', 'removed'].includes(this.workspaceCleanup(id)?.state),
    'Cleaned workspace cannot be reused; prepare a new assignment', 'blocked-reconciliation');
    const result = this.db.prepare(`UPDATE jobs SET state=?,workspace=COALESCE(?,workspace),
      base_revision=COALESCE(?,base_revision),error=?,updated_at=? WHERE id=? AND state=?`)
      .run(after, workspace, baseRevision, error && json(error), now(), id, before);
    requireThat(result.changes === 1, 'Assignment ownership/state changed', 'overlap');
  }
  operation(id, jobId, kind, detail) {
    const result = this.db.prepare('INSERT OR IGNORE INTO operations VALUES(?,?,?,?,?,?)')
      .run(id, jobId, kind, 'started', json(detail), now());
    requireThat(result.changes === 1, 'Operation already started; reconcile, do not duplicate or retry', 'blocked-reconciliation');
  }
  finishOperation(id, state, detail) {
    this.db.prepare('UPDATE operations SET state=?,detail=?,updated_at=? WHERE id=?').run(state, json(detail), now(), id);
  }
  workspaceCleanup(id) {
    const row = this.db.prepare('SELECT detail FROM workspace_cleanup WHERE job_id=?').get(id);
    return row ? JSON.parse(row.detail) : null;
  }
  recordWorkspaceCleanup(id, detail) {
    validateRecord(detail, 'workspaceCleanupResult');
    requireThat(detail.jobId === id, 'Cleanup receipt does not match its task', 'invalid-record');
    if (this.workspaceCleanup(id)?.state === 'removed' && detail.state !== 'removed') return;
    this.db.prepare(`INSERT INTO workspace_cleanup VALUES(?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET state=excluded.state,detail=excluded.detail,updated_at=excluded.updated_at`)
      .run(id, detail.state, json(detail), now());
  }
  evidenceForRuns(ids) {
    return [...new Set(ids.flatMap(id => this.db.prepare('SELECT evidence_id FROM observations WHERE run_id=?').all(id).map(r => r.evidence_id)))]
      .map(id => this.get('evidence', id));
  }
  discovery(runId, parentId, url, state, reason, targetId = null) {
    this.db.prepare(`INSERT INTO discoveries VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,parent_id,url)
      DO UPDATE SET state=excluded.state,reason=excluded.reason,target_id=excluded.target_id`)
      .run(runId, parentId, url, state, targetId, reason);
  }
  status() {
    return {
      locks: this.db.prepare('SELECT * FROM locks').all(),
      runs: this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 50').all(),
      cursors: this.db.prepare('SELECT * FROM cursors').all(),
      sourceBlocks: this.db.prepare('SELECT * FROM source_blocks').all(),
      discoveries: this.db.prepare('SELECT * FROM discoveries').all(),
      trackedState: this.db.prepare('SELECT * FROM tracked_state').all(),
      jobs: this.db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC').all(),
      operations: this.db.prepare('SELECT * FROM operations ORDER BY updated_at DESC').all(),
      workspaceCleanup: this.db.prepare('SELECT detail FROM workspace_cleanup ORDER BY updated_at DESC')
        .all().map(row => JSON.parse(row.detail)),
      counts: this.db.prepare('SELECT kind,COUNT(*) AS count FROM records GROUP BY kind').all()
    };
  }
}
