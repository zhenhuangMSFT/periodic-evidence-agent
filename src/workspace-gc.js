import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  now, PilotError, requireThat, safeError, uuid, validateRecord, workspaceCleanupPolicy
} from './common.js';
import { adoAccessToken, adoGitEnvironment } from './ado-auth.js';

const exec = promisify(execFile);
const deliveredOutcomes = ['draft-pr-validated', 'draft-pr-validation-failed'];

function retain(condition, reason) {
  if (!condition) throw new PilotError('workspace-retained', reason);
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function checkedWorkspace(config, ledger, job) {
  retain(typeof job.workspace === 'string' && isAbsolute(job.workspace), 'Workspace is not registered');
  retain(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(job.session_id), 'Invalid workspace session ID');
  const stateRoot = resolve(config.stateDirectory);
  const workspace = resolve(job.workspace);
  retain(workspace === join(stateRoot, 'workspaces', job.session_id), 'Workspace is outside its registered task path');
  retain(resolve(ledger.directory) === stateRoot, 'Ledger and workspace state roots differ');
  for (let current = workspace; ; current = dirname(current)) {
    if (existsSync(current))
      retain(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(),
        'Workspace path contains a link or a non-directory');
    if (dirname(current) === current) break;
  }
  const physicalWorkspace = existsSync(workspace) ? realpathSync.native(workspace) : workspace;
  for (const repo of config.repositories) {
    if (!repo.referenceCheckout) continue;
    const reference = existsSync(repo.referenceCheckout)
      ? realpathSync.native(repo.referenceCheckout) : resolve(repo.referenceCheckout);
    retain(!inside(physicalWorkspace, reference) && !inside(reference, physicalWorkspace),
      'Workspace overlaps a primary checkout');
  }
  return workspace;
}
async function git(workspace, args, env = process.env) {
  const result = await exec('git', [
    '-c', 'core.hooksPath=.git/no-hooks', '-c', 'core.longpaths=true',
    '-c', 'credential.interactive=never', ...args
  ], {
    cwd: workspace, env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
  });
  return result.stdout.trim();
}
async function remoteRevision(config, repo, workspace, sourceRef, getToken) {
  const ado = /^https:\/\/(?:dev\.azure\.com\/|[^/]+\.visualstudio\.com\/)/i.test(repo.remote);
  const env = ado
    ? adoGitEnvironment(await getToken(config, 'ADO workspace cleanup verification'))
    : process.env;
  const output = await git(workspace, ['ls-remote', '--heads', '--', 'origin', sourceRef], env);
  const lines = output.split(/\r?\n/).filter(Boolean);
  retain(lines.length === 1 && lines[0].split(/\s+/)[1] === sourceRef,
    'Delivered remote branch is missing or ambiguous');
  return lines[0].split(/\s+/)[0];
}
function inactive(ledger, job, owners) {
  retain(ledger.job(job.id)?.state === 'completed', 'Task is not completed');
  retain(!ledger.db.prepare(`SELECT id FROM operations WHERE job_id=?
    AND state IN ('started','running','reserved','uncertain') LIMIT 1`).get(job.id),
  'Task has an unfinished operation');
  retain(!ledger.db.prepare('SELECT name,owner FROM locks').all()
    .some(lock => !owners.includes(lock.owner)), 'Another controller operation holds a lock');
  retain(!ledger.db.prepare(`SELECT id FROM jobs WHERE id<>? AND workspace=?
    AND state NOT IN ('completed','superseded') LIMIT 1`).get(job.id, job.workspace),
  'Workspace is referenced by another active task');
}
async function sourceBranch(workspace) {
  try {
    return await git(workspace, ['symbolic-ref', '--quiet', 'HEAD']);
  } catch (error) {
    if (error.code !== 1) throw error;
    retain(false, 'Workspace HEAD is detached; retain the clone for manual reconciliation');
  }
}
async function cleanSource(workspace, revision, baseRef) {
  retain(realpathSync.native(await git(workspace, ['rev-parse', '--show-toplevel'])) ===
    realpathSync.native(workspace), 'Workspace is not the root of an independent checkout');
  retain(await git(workspace, ['rev-parse', 'HEAD']) === revision, 'Workspace HEAD differs from the delivered revision');
  retain(!(await git(workspace, ['status', '--porcelain', '--untracked-files=all'])),
    'Workspace has uncommitted or untracked changes');
  retain(!(await git(workspace, ['ls-files', '--others', '--ignored', '--exclude-standard'])),
    'Workspace contains ignored files that have not been preserved');
  const headRef = await sourceBranch(workspace);
  const branches = (await git(workspace, [
    'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'
  ])).split(/\r?\n/).filter(Boolean);
  for (const branch of branches) {
    const [ref, tip] = branch.split(' ');
    if (ref === headRef) continue;
    let inheritedRef = baseRef?.startsWith('refs/heads/') ? baseRef : `refs/heads/${baseRef}`;
    if (baseRef === 'HEAD') {
      try {
        inheritedRef = (await git(workspace, [
          'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'
        ])).replace('refs/remotes/origin/', 'refs/heads/');
      } catch (error) {
        if (error.code !== 1) throw error;
        retain(false, 'Workspace contains additional local branches without an inherited base reference');
      }
    }
    retain(ref === inheritedRef, 'Workspace contains additional local branches');
    try {
      await git(workspace, ['merge-base', '--is-ancestor', tip, revision]);
    } catch (error) {
      if (error.code !== 1) throw error;
      retain(false, 'Inherited base branch contains commits outside the delivered revision');
    }
  }
  retain(!(await git(workspace, ['for-each-ref', '--format=%(refname)', 'refs/stash'])),
    'Workspace contains stashed changes');
  retain((await git(workspace, ['worktree', 'list', '--porcelain']))
    .split(/\r?\n/).filter(line => line.startsWith('worktree ')).length === 1,
  'Other Git worktrees depend on this clone');
}

export async function cleanupWorkspace(config, ledger, id, { execute = false } = {}, dependencies = {}) {
  const policy = workspaceCleanupPolicy(config);
  const job = ledger.job(id);
  let detail = {
    jobId: id, workspace: job?.workspace ?? null, state: 'skipped',
    reason: 'Workspace retained', checkedAt: now()
  };
  let dispatchOwner, workspaceOwner, operationId;
  try {
    retain(job, 'Unknown task');
    dispatchOwner = ledger.acquire('dispatch');
    workspaceOwner = ledger.acquire(`workspace-cleanup:${id}`);
    inactive(ledger, job, [dispatchOwner, workspaceOwner]);
    const workspace = checkedWorkspace(config, ledger, job);
    if (ledger.workspaceCleanup(id)?.state === 'removed') {
      retain(!existsSync(workspace), 'Removed workspace path has been recreated');
      detail = { ...ledger.workspaceCleanup(id), checkedAt: now() };
      return detail;
    }
    retain(existsSync(workspace), 'Workspace is missing without a cleanup receipt');
    const gitDirectory = join(workspace, '.git');
    retain(existsSync(gitDirectory) && lstatSync(gitDirectory).isDirectory() &&
      !lstatSync(gitDirectory).isSymbolicLink(), 'Workspace is not an independent Git clone');
    const result = ledger.all('workerResult')
      .filter(item => item.assignmentId === id && item.attemptId === job.session_id).at(-1);
    retain(result && deliveredOutcomes.includes(result.outcome) && !result.blocker &&
      result.draftPR?.isDraft === true && result.draftPR.headRevision === result.sourceRevision &&
      /^[a-f0-9]{40,64}$/.test(result.sourceRevision),
    'Task has no complete Draft PR delivery receipt');
    retain(Number.isFinite(Date.parse(result.reportedAt)) &&
      Date.now() - Date.parse(result.reportedAt) >= policy.retentionHours * 3600000,
    'Workspace is within its retention period');
    const repo = config.repositories.find(item => item.id === job.repo);
    retain(repo?.remote && await git(workspace, ['remote', 'get-url', 'origin']) === repo.remote,
      'Workspace remote differs from the configured repository');
    const sourceRef = `refs/heads/pilot/${id}`;
    retain(await sourceBranch(workspace) === sourceRef,
      'Workspace branch differs from the delivered task branch');
    const artifacts = [
      ...result.validation,
      ...result.validationAttempts.flatMap(attempt => attempt.validation)
    ].flatMap(validation => validation.artifactRefs);
    retain(artifacts.length > 0 && artifacts.every(path => isAbsolute(path) &&
      existsSync(path) && lstatSync(path).isFile() &&
      inside(realpathSync.native(config.stateDirectory), realpathSync.native(path)) &&
      !inside(realpathSync.native(workspace), realpathSync.native(path))),
    'Validation evidence is missing or is not preserved outside the workspace');
    await cleanSource(workspace, result.sourceRevision, repo.baseRef);
    const remoteHead = await remoteRevision(config, repo, workspace, sourceRef,
      dependencies.getToken ?? adoAccessToken);
    retain(remoteHead === result.sourceRevision, 'Remote branch differs from the delivered revision');
    detail = {
      ...detail, workspace, state: 'eligible', reason: 'Draft PR delivery is preserved and remotely available',
      resultId: result.id, sourceRevision: result.sourceRevision, sourceRef,
      remote: repo.remote, draftPR: result.draftPR.url
    };
    if (!execute) return detail;
    checkedWorkspace(config, ledger, ledger.job(id));
    await cleanSource(workspace, result.sourceRevision, repo.baseRef);
    ledger.transaction(() => {
      inactive(ledger, job, [dispatchOwner, workspaceOwner]);
      operationId = `${id}:workspace-cleanup:${uuid()}`;
      detail = { ...detail, state: 'deleting', reason: 'Deleting the delivered authoring clone' };
      ledger.operation(operationId, id, 'workspace-cleanup', detail);
      ledger.recordWorkspaceCleanup(id, detail);
    });
    (dependencies.remove ?? rmSync)(workspace, {
      recursive: true, force: false, maxRetries: 3, retryDelay: 250
    });
    requireThat(!existsSync(workspace), 'Workspace remains after deletion', 'cleanup-failed');
    detail = { ...detail, state: 'removed', reason: 'Delivered authoring clone removed', checkedAt: now() };
    ledger.finishOperation(operationId, 'completed', detail);
  } catch (error) {
    detail = {
      ...detail, state: error.code === 'workspace-retained' || error.code === 'overlap' ? 'skipped' : 'failed',
      reason: error.code === 'workspace-retained' ? error.message : safeError(error).message,
      checkedAt: now(), ...error.code === 'workspace-retained' ? {} : { error: safeError(error) }
    };
    if (operationId) ledger.finishOperation(operationId, 'failed', detail);
  } finally {
    try {
      if (execute && job && dispatchOwner && workspaceOwner)
        ledger.recordWorkspaceCleanup(id, detail);
    } finally {
      if (workspaceOwner) ledger.release(`workspace-cleanup:${id}`, workspaceOwner);
      if (dispatchOwner) ledger.release('dispatch', dispatchOwner);
    }
  }
  return validateRecord(detail, 'workspaceCleanupResult');
}

export async function cleanupWorkspaces(config, ledger, options = {}, dependencies = {}) {
  const jobs = ledger.db.prepare("SELECT id FROM jobs WHERE workspace IS NOT NULL ORDER BY updated_at,id").all();
  const results = [];
  for (const job of jobs)
    results.push(await cleanupWorkspace(config, ledger, job.id, options, dependencies));
  return { mode: options.execute ? 'execute' : 'preview', workspaces: results };
}
