import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { boundedPath, hash, json, requireThat, validateRecord, validationPackageAuth, validationLfsPaths } from './common.js';
import { adoAccessToken, adoGitEnvironment } from './ado-auth.js';

const exec = promisify(execFile);
export const skillQualificationId = (repoId, bindingId) => `repository-skill:${repoId}:${bindingId}`;

export function normalizeSkillInput(binding, input) {
  if (!binding.inputFormat) {
    requireThat(input === undefined || input === null,
      `Repository skill binding ${binding.id} does not accept a structured skill input`,
      'blocked-scope');
    return null;
  }
  requireThat(input && input.format === binding.inputFormat,
    `Repository skill binding ${binding.id} requires ${binding.inputFormat}`,
    'blocked-reconciliation');
  validateRecord(structuredClone(input), 'declarativeE2ESpecBatch');
  const ids = input.items.map(item => item.inputItemId);
  requireThat(new Set(ids).size === ids.length,
    'Repository skill input item IDs must be unique', 'blocked-reconciliation');
  return structuredClone(input);
}

function normalizedPrefix(prefix) {
  requireThat(typeof prefix === 'string' && prefix.length > 0 && !isAbsolute(prefix) &&
    !prefix.split(/[\\/]/).includes('..'), 'Repository skill write prefix is invalid', 'blocked-scope');
  return prefix.replaceAll('\\', '/').replace(/^\.\/|\/$/g, '');
}

function normalizedFile(path) {
  requireThat(typeof path === 'string' && path.length > 0 && !isAbsolute(path) &&
    !path.split(/[\\/]/).includes('..'), 'Repository skill write file is invalid', 'blocked-scope');
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function repositorySkillWritePrefixes(repo, binding) {
  requireThat(Array.isArray(binding.allowedWritePrefixes) && binding.allowedWritePrefixes.length > 0,
    `Repository skill binding ${binding.id} has no allowed write prefixes`, 'blocked-config');
  const repositoryPrefixes = (repo.allowedWritePrefixes ?? []).map(normalizedPrefix);
  const prefixes = [...new Set(binding.allowedWritePrefixes.map(normalizedPrefix))].sort();
  requireThat(prefixes.every(prefix => repositoryPrefixes.some(allowed =>
    prefix === allowed || prefix.startsWith(`${allowed}/`))),
  `Repository skill binding ${binding.id} write prefixes exceed repository bounds`, 'blocked-scope');
  return prefixes;
}

export function repositorySkillWriteFiles(repo, binding) {
  const repositoryFiles = (repo.allowedWriteFiles ?? []).map(normalizedFile);
  const files = [...new Set((binding.allowedWriteFiles ?? []).map(normalizedFile))].sort();
  requireThat(files.every(path => repositoryFiles.includes(path)),
    `Repository skill binding ${binding.id} write files exceed repository bounds`, 'blocked-scope');
  return files;
}

export function repositoryValidationContract(repo) {
  const version = repo.validationContractVersion ?? '1.0';
  const gates = (repo.validationGates ?? []).map(gate => ({
    id: gate.id,
    approved: gate.approved === true,
    executable: gate.executable,
    args: gate.args,
    timeoutMs: gate.timeoutMs,
    profileSha256: gate.profileSha256 ?? null,
    ...(gate.packageAuth !== undefined ? { packageAuth: validationPackageAuth(gate) } : {}),
    ...(gate.lfsPaths !== undefined ? { lfsPaths: validationLfsPaths(gate) } : {})
  }));
  return { version, sha256: hash(json(gates)) };
}

async function execute(executable, args, cwd, timeout = 120000, env = process.env) {
  return exec(executable, args, { cwd, env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
}

export function resolveSkillBinding(config, repoId, capability, bindingId = null,
  { requireQualified = true, requireEnabled = true, requireRouted = true } = {}) {
  const repo = config.repositories.find(candidate => candidate.id === repoId);
  requireThat(repo, `Unknown repository ${repoId}`, 'blocked-owner');
  if (requireRouted)
    requireThat(repo.routingApproved === true && repo.owner, `Repository ${repoId} ownership is unresolved`);
  const bindings = repo.skillBindings ?? [];
  const matches = bindings.filter(binding => binding.capability === capability &&
    (!bindingId || binding.id === bindingId));
  requireThat(matches.length === 1, `Repository ${repoId} needs one unambiguous ${capability} skill binding`,
    'blocked-owner');
  const binding = matches[0];
  if (requireEnabled)
    requireThat(binding.enabled === true, `Repository skill binding ${binding.id} is disabled`, 'blocked-config');
  if (requireQualified)
    requireThat(binding.qualification === 'qualified', `Repository skill binding ${binding.id} is unqualified`,
      'blocked-config');
  requireThat(typeof binding.skillPath === 'string' && binding.skillPath.length > 0 &&
    !isAbsolute(binding.skillPath), `Repository skill binding ${binding.id} has an invalid path`, 'blocked-scope');
  requireThat(Array.isArray(binding.requestedOutcomes) && binding.requestedOutcomes.length > 0,
    `Repository skill binding ${binding.id} has no requested outcomes`);
  repositorySkillWritePrefixes(repo, binding);
  repositorySkillWriteFiles(repo, binding);
  requireThat(typeof binding.requiresBehaviorCard === 'boolean',
    `Repository skill binding ${binding.id} must declare behavior-card policy`, 'blocked-config');
  requireThat(binding.sideEffects && ['commit', 'push', 'createDraftPR'].every(key =>
    typeof binding.sideEffects[key] === 'boolean'), `Repository skill binding ${binding.id} lacks explicit side effects`);
  return { repo, binding };
}

export function pinSkillQualification(receipt) {
  requireThat(receipt?.state === 'qualified-read-only', 'Repository skill qualification receipt is missing',
    'blocked-config');
  return {
    qualificationId: skillQualificationId(receipt.repoId, receipt.bindingId),
    baseRevision: receipt.baseRevision,
    skillSha256: receipt.skillSha256,
    skillPath: receipt.skillPath,
    remote: receipt.remote,
    qualificationSource: receipt.qualificationSource,
    validationContractVersion: receipt.validationContractVersion,
    validationContractSha256: receipt.validationContractSha256
  };
}

function failSkillGit(operation, error) {
  const reason = /filename too long/i.test(String(error.stderr ?? ''))
    ? 'filename-too-long' : error.code === 'ENOENT' ? 'git-unavailable' : 'native-command-failed';
  const status = Number.isInteger(error.status) ? error.status : 'unavailable';
  requireThat(false, `Repository skill Git ${operation} failed (${reason}; exit status ${status}); content drift is not established`,
    'blocked-repository-git');
}

export function loadRepositorySkill(config, assignment, workspace, sourceRevision, qualification) {
  requireThat(assignment.skillBindingId && assignment.capability,
    'Repository skill execution requires an assignment capability and binding');
  const { binding } = resolveSkillBinding(config, assignment.repoId, assignment.capability,
    assignment.skillBindingId);
  const pinned = pinSkillQualification(qualification);
  requireThat(json(pinned) === json(assignment.skillQualification),
    'Repository skill qualification changed after assignment preparation', 'blocked-reconciliation');
  requireThat(qualification.repoId === assignment.repoId &&
    qualification.bindingId === binding.id &&
    qualification.capability === binding.capability &&
    qualification.skillPath === binding.skillPath.replaceAll('\\', '/') &&
    qualification.remote.toLowerCase() === config.repositories.find(repo => repo.id === assignment.repoId)
      .remote.replace(/\/$/, '').toLowerCase() &&
    qualification.baseRevision === sourceRevision,
  'Repository skill qualification does not match the isolated source revision', 'blocked-reconciliation');
  const contract = repositoryValidationContract(
    config.repositories.find(repo => repo.id === assignment.repoId));
  requireThat(qualification.validationContractVersion === contract.version &&
    qualification.validationContractSha256 === contract.sha256,
  'Repository validation contract changed after skill qualification', 'blocked-reconciliation');
  const allowedWritePrefixes = repositorySkillWritePrefixes(
    config.repositories.find(repo => repo.id === assignment.repoId), binding);
  const allowedWriteFiles = repositorySkillWriteFiles(
    config.repositories.find(repo => repo.id === assignment.repoId), binding);
  requireThat(json(allowedWritePrefixes) === json(assignment.allowedWritePrefixes),
    'Repository skill write policy changed after assignment preparation', 'blocked-reconciliation');
  requireThat(json(allowedWriteFiles) === json(assignment.allowedWriteFiles ?? []),
    'Repository skill write policy changed after assignment preparation', 'blocked-reconciliation');
  const path = boundedPath(workspace, binding.skillPath);
  requireThat(statSync(path).isFile() && statSync(path).size <= config.limits.maxFileBytes,
    'Repository skill exceeds the configured read limit', 'blocked-budget');
  let source = readFileSync(path);
  if (existsSync(join(workspace, '.git'))) {
    try {
      execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.longpaths=true',
        'cat-file', '-e', `${sourceRevision}^{commit}`], {
        cwd: workspace, windowsHide: true, stdio: 'pipe'
      });
    } catch (error) {
      failSkillGit('cat-file', error);
    }
    try {
      execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.longpaths=true',
        'diff', '--quiet', sourceRevision,
        '--', binding.skillPath.replaceAll('\\', '/')], {
        cwd: workspace, windowsHide: true, stdio: 'pipe'
      });
    } catch (error) {
      requireThat(error.status !== 1, 'Repository skill content changed after qualification',
        'blocked-reconciliation');
      failSkillGit('diff', error);
    }
    try {
      source = execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.longpaths=true', 'show',
        `${sourceRevision}:${binding.skillPath.replaceAll('\\', '/')}`], {
        cwd: workspace, windowsHide: true, stdio: 'pipe', maxBuffer: config.limits.maxFileBytes
      });
    } catch (error) {
      failSkillGit('show', error);
    }
  }
  requireThat(source.length <= config.limits.maxFileBytes,
    'Repository skill exceeds the configured read limit', 'blocked-budget');
  requireThat(hash(source) === qualification.skillSha256,
    'Repository skill content changed after qualification', 'blocked-reconciliation');
  return {
    binding,
    instructions: source.toString('utf8'),
    allowedWritePrefixes,
    allowedWriteFiles,
    skillRevision: sourceRevision,
    skillPath: binding.skillPath.replaceAll('\\', '/')
  };
}

export function verifyRepositorySkillWorkspace(config, assignment, workspace, sourceRevision, qualification) {
  requireThat(typeof workspace === 'string' && isAbsolute(workspace),
    'Repository skill workspace must be an absolute path', 'blocked-reconciliation');
  let head;
  let remote;
  try {
    requireThat(statSync(workspace).isDirectory(), 'Repository skill workspace is not a directory',
      'blocked-reconciliation');
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.longpaths=true', '-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false', ...args], {
      cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 30000
    }).trim();
    head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    remote = git(['remote', 'get-url', 'origin']);
  } catch {
    requireThat(false, 'Repository skill workspace is not a readable Git checkout',
      'blocked-reconciliation');
  }
  requireThat(head === sourceRevision,
    'Repository skill workspace HEAD differs from the bound source revision',
    'blocked-reconciliation');
  requireThat(remote.replace(/\/$/, '').toLowerCase() === qualification?.remote.replace(/\/$/, '').toLowerCase(),
    'Repository skill workspace origin differs from the qualification receipt',
    'blocked-reconciliation');
  return loadRepositorySkill(config, assignment, workspace, head, qualification);
}

export function normalizeSkillResult(loaded, result) {
  requireThat(result && typeof result === 'object' &&
    ['succeeded', 'failed', 'needs-input', 'blocked'].includes(result.status),
  'Repository skill returned an invalid status', 'blocked-result');
  const arrays = ['changedFiles', 'testsAddedOrUpdated', 'behaviorCardsAddedOrUpdated', 'unknowns'];
  for (const field of arrays)
    requireThat(Array.isArray(result[field] ?? []) && (result[field] ?? []).every(value =>
      typeof value === 'string' && value.length > 0), `Repository skill returned invalid ${field}`, 'blocked-result');
  requireThat(typeof result.needsHumanDecision === 'boolean',
    'Repository skill must explicitly state whether a human decision is needed', 'blocked-result');
  const normalized = {
    bindingId: loaded.binding.id, capability: loaded.binding.capability,
    skillPath: loaded.skillPath, skillRevision: loaded.skillRevision,
    status: result.status, classification: result.classification ?? null,
    changedFiles: [...new Set((result.changedFiles ?? []).map(path => path.replaceAll('\\', '/')))].sort(),
    testsAddedOrUpdated: [...new Set(result.testsAddedOrUpdated ?? [])].sort(),
    behaviorCardsAddedOrUpdated: [...new Set((result.behaviorCardsAddedOrUpdated ?? [])
      .map(path => path.replaceAll('\\', '/')))].sort(),
    unknowns: [...new Set(result.unknowns ?? [])].sort(),
    needsHumanDecision: result.needsHumanDecision
  };
  const outsideBounds = normalized.changedFiles.filter(path =>
    !(loaded.allowedWriteFiles ?? []).includes(path) &&
    !loaded.allowedWritePrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`)));
  requireThat(outsideBounds.length === 0,
    `Repository skill reported files outside its test-only bounds: ${outsideBounds.join(', ')}`,
    'blocked-scope');
  if (normalized.status === 'succeeded' && normalized.changedFiles.length === 0 &&
      normalized.testsAddedOrUpdated.length === 0)
    requireThat(result.classification === 'existing-coverage',
      'A successful no-change skill result must identify existing coverage', 'blocked-result');
  if (normalized.status === 'succeeded' && normalized.changedFiles.length > 0 &&
      loaded.binding.requiresBehaviorCard) {
    requireThat(normalized.behaviorCardsAddedOrUpdated.length > 0,
      'Repository skill changes require a behavior-card update', 'blocked-result');
    const unreportedCards = normalized.behaviorCardsAddedOrUpdated.filter(path =>
      !normalized.changedFiles.includes(path));
    requireThat(unreportedCards.length === 0,
      `Behavior-card updates must be included in changedFiles: ${unreportedCards.join(', ')}`,
      'blocked-result');
  }
  return normalized;
}

export async function qualifyRepositorySkill(config, repoId, capability, bindingId = null,
  runCommand = execute, getToken = adoAccessToken) {
  const { repo, binding } = resolveSkillBinding(config, repoId, capability, bindingId,
    { requireQualified: false, requireEnabled: false, requireRouted: false });
  requireThat(isAbsolute(repo.referenceCheckout) && repo.baseRef && repo.remote,
    `Repository ${repoId} reference checkout, base and remote are required for qualification`);
  const run = args => runCommand('git', ['-c', 'core.hooksPath=', ...args], repo.referenceCheckout);
  const remote = (await run(['remote', 'get-url', 'origin'])).stdout.trim().replace(/\/$/, '');
  requireThat(remote.toLowerCase() === repo.remote.replace(/\/$/, '').toLowerCase(),
    `Repository ${repoId} origin does not match its configured remote`, 'blocked-scope');
  const refresh = repo.qualificationRefresh ?? 'local';
  if (refresh === 'fetch') {
    const fetchRef = repo.baseRef.startsWith('origin/')
      ? repo.baseRef.slice('origin/'.length)
      : repo.baseRef;
    const args = ['-c', 'core.hooksPath=', 'fetch', '--no-tags', '--prune', 'origin', fetchRef];
    const adoRemote = /^https:\/\/(?:dev\.azure\.com\/|[^/]+\.visualstudio\.com\/)/i.test(remote);
    const env = adoRemote
      ? adoGitEnvironment(await getToken(config, 'ADO repository skill qualification'))
      : process.env;
    await runCommand('git', args, repo.referenceCheckout, 120000, env);
  }
  const revisionRef = refresh === 'fetch' ? 'FETCH_HEAD' : repo.baseRef;
  const baseRevision = (await run(['rev-parse', '--verify', `${revisionRef}^{commit}`])).stdout.trim();
  requireThat(/^[a-f0-9]{40,64}$/.test(baseRevision), 'Repository skill qualification resolved an invalid base revision');
  await run(['cat-file', '-e', `${baseRevision}:${binding.skillPath.replaceAll('\\', '/')}`]);
  const content = (await run(['show', `${baseRevision}:${binding.skillPath.replaceAll('\\', '/')}`])).stdout;
  requireThat(Buffer.byteLength(content) <= config.limits.maxFileBytes,
    'Repository skill exceeds the configured read limit', 'blocked-budget');
  const validationContract = repositoryValidationContract(repo);
  return {
    repoId, bindingId: binding.id, capability: binding.capability,
    referenceCheckout: repo.referenceCheckout, remote, baseRef: repo.baseRef, baseRevision,
    skillPath: binding.skillPath.replaceAll('\\', '/'), skillSha256: hash(content),
    qualificationSource: refresh === 'fetch' ? 'trusted-remote' : 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    state: 'qualified-read-only', sideEffects: binding.sideEffects
  };
}
