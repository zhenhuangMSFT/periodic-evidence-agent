import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { hash } from './hash.js';

export class PilotError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function requireThat(condition, message, code = 'blocked-config') {
  if (!condition) throw new PilotError(code, message);
}
export const now = () => new Date().toISOString();
export const uuid = () => randomUUID();
export { hash };
export const json = value => JSON.stringify(value);
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function utc(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)), 'Expected an explicit UTC timestamp');
  return value;
}
export function windowCheck(window) {
  utc(window.start); utc(window.end);
  requireThat(Date.parse(window.start) < Date.parse(window.end), 'Window must be nonempty and half-open');
}
export function positive(value, name) {
  requireThat(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}
export function nonNegative(value, name) {
  requireThat(Number.isInteger(value) && value >= 0, `${name} must be a nonnegative integer`);
  return value;
}
export function safeError(error) {
  if (error instanceof PilotError) return { code: error.code, message: error.message };
  // Library errors can contain request headers, source payloads or credentials.
  return { code: 'failed', message: `Operation failed (${error?.name ?? 'Error'}); inspect the operation and supported sign-in state, not credential caches.` };
}
export function boundedPath(root, name, { write = false } = {}) {
  requireThat(typeof name === 'string' && name && !isAbsolute(name) &&
    !name.includes(':') && !name.includes('\0'), 'Invalid relative path', 'blocked-scope');
  const base = realpathSync(root);
  const target = resolve(base, name);
  const rel = relative(base, target);
  requireThat(rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel), 'Path escapes workspace', 'blocked-scope');
  const parts = rel.split(sep);
  requireThat(!parts.some(p => ['.git', '.copilot', '.env'].includes(p.toLowerCase()) ||
    p.toLowerCase().startsWith('.env.')), 'Protected path', 'blocked-scope');
  let current = base;
  for (const part of parts) {
    current = resolve(current, part);
    if (existsSync(current)) {
      requireThat(!lstatSync(current).isSymbolicLink(), 'Symlink/reparse paths are not allowed', 'blocked-scope');
      if (write && lstatSync(current).isFile()) requireThat(lstatSync(current).nlink === 1, 'Hard-linked writes are not allowed', 'blocked-scope');
    }
  }
  if (!write) requireThat(existsSync(target), 'Requested path does not exist', 'unavailable');
  return target;
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const contracts = readJson(new URL('../scaffold/contracts.schema.json', import.meta.url));
ajv.addSchema(contracts, 'contracts');
export function validateRecord(value, type = value.recordType) {
  const validate = ajv.getSchema(`contracts#/$defs/${type}`);
  requireThat(validate && validate(value), `Invalid ${type} record: ${ajv.errorsText(validate?.errors)}`, 'invalid-record');
  return value;
}
export const exclusions = contracts.$defs.exclusion.enum;
export function workspaceCleanupPolicy(config) {
  return validateRecord(config.workspaceCleanup ?? {
    enabled: false, retentionHours: 0
  }, 'workspaceCleanupPolicy');
}
export function proposerExecutorFlight(repo) {
  if (repo?.flights === undefined) return null;
  validateRecord(repo.flights, 'executorFlights');
  return repo.flights.proposerExecutor;
}
export function validationPackageAuth(gate) {
  const auth = gate.packageAuth;
  if (auth === undefined) return null;
  requireThat(auth && !Array.isArray(auth) &&
    Object.keys(auth).length === 2 && auth.kind === 'yarn-token' &&
    typeof auth.tokenEnvironmentVariable === 'string' &&
    /^PILOT_[A-Z0-9_]+_TOKEN$/.test(auth.tokenEnvironmentVariable),
  'Validation packageAuth must specify kind yarn-token and a PILOT_*_TOKEN environment variable');
  return { kind: auth.kind, tokenEnvironmentVariable: auth.tokenEnvironmentVariable };
}
export function validationLfsPaths(gate) {
  if (gate.lfsPaths === undefined) return [];
  requireThat(Array.isArray(gate.lfsPaths) && gate.lfsPaths.length > 0 &&
    new Set(gate.lfsPaths).size === gate.lfsPaths.length &&
    gate.lfsPaths.every(path => typeof path === 'string' && path && path.trim() === path &&
      !isAbsolute(path) && !/[\0\r\n]/.test(path) &&
      !['\\', ':', '*', '?', '[', ']', '!', ',', '#'].some(char => path.includes(char)) &&
      path.split('/').every(part => part && part !== '.' && part !== '..')),
  'Validation lfsPaths must contain unique exact repository-relative files, not patterns');
  return [...gate.lfsPaths];
}
export function configAt(path) {
  const config = readJson(path);
  requireThat(config.version === 1, 'Unsupported configuration version');
  windowCheck(config.window);
  requireThat(config.activation && ['collect', 'review', 'dispatch'].every(k => typeof config.activation[k] === 'boolean'),
    'Explicit collect/review/dispatch activation booleans are required');
  requireThat(config.statePolicy?.retention === 'manual-no-auto-delete', 'Evidence state requires explicit manual retention');
  workspaceCleanupPolicy(config);
  requireThat([0, 1].includes(config.followUp.maxDepth), 'Follow-up is limited to zero or one level');
  if (config.followUp.maxDepth === 1) {
    positive(config.followUp.maxItems, 'followUp.maxItems'); positive(config.followUp.maxToolCalls, 'followUp.maxToolCalls');
  }
  requireThat(Array.isArray(config.repositories), 'repositories must be an array');
  config.limits.maxValidationRepairRounds =
    nonNegative(config.limits.maxValidationRepairRounds ?? 10, 'maxValidationRepairRounds');
  requireThat(config.limits.maxValidationRepairRounds <= 10,
    'maxValidationRepairRounds must not exceed 10');
  config.limits.maxValidationInfrastructureRetries =
    nonNegative(config.limits.maxValidationInfrastructureRetries ?? 0,
      'maxValidationInfrastructureRetries');
  requireThat(config.limits.maxValidationInfrastructureRetries <= 2,
    'maxValidationInfrastructureRetries must not exceed 2');
  for (const repo of config.repositories) {
    proposerExecutorFlight(repo);
    repo.qualificationRefresh ??= 'local';
    repo.validationContractVersion ??= '1.0';
    requireThat(['local', 'fetch'].includes(repo.qualificationRefresh),
      `Repository ${repo.id} qualificationRefresh must be local or fetch`);
    requireThat(typeof repo.validationContractVersion === 'string' &&
      repo.validationContractVersion.length > 0,
    `Repository ${repo.id} validationContractVersion is required`);
    requireThat(Array.isArray(repo.skillBindings ?? []), `Repository ${repo.id} skillBindings must be an array`);
    repo.allowedWriteFiles ??= [];
    requireThat(Array.isArray(repo.allowedWritePrefixes ?? []) &&
      Array.isArray(repo.allowedWriteFiles), `Repository ${repo.id} write bounds must be arrays`);
    for (const allowedPath of [...repo.allowedWritePrefixes, ...repo.allowedWriteFiles])
      requireThat(typeof allowedPath === 'string' && allowedPath.length > 0 &&
        !isAbsolute(allowedPath) && !allowedPath.split(/[\\/]/).includes('..'),
      `Repository ${repo.id} has an invalid write bound`);
    const ids = new Set();
    for (const binding of repo.skillBindings ?? []) {
      requireThat(binding && typeof binding.id === 'string' && binding.id.length > 0 && !ids.has(binding.id),
        `Repository ${repo.id} skill binding IDs must be nonempty and unique`);
      ids.add(binding.id);
      requireThat(typeof binding.capability === 'string' && binding.capability.length > 0 &&
        typeof binding.skillPath === 'string' && binding.skillPath.length > 0 && !isAbsolute(binding.skillPath),
      `Repository ${repo.id} skill binding ${binding.id} is incomplete`);
      requireThat(binding.inputFormat === undefined ||
        binding.inputFormat === 'declarative-e2e-mini-spec-batch-v1',
      `Repository ${repo.id} skill binding ${binding.id} has an unsupported input format`);
      requireThat(typeof binding.enabled === 'boolean' &&
        ['unqualified', 'qualified'].includes(binding.qualification) &&
        Array.isArray(binding.requestedOutcomes) && binding.requestedOutcomes.length > 0,
      `Repository ${repo.id} skill binding ${binding.id} activation is incomplete`);
      requireThat(binding.sideEffects && ['commit', 'push', 'createDraftPR'].every(key =>
        typeof binding.sideEffects[key] === 'boolean'),
      `Repository ${repo.id} skill binding ${binding.id} needs explicit side effects`);
    }
    for (const gate of repo.validationGates ?? []) {
      validationPackageAuth(gate);
      validationLfsPaths(gate);
      requireThat(Boolean(gate.profilePath) === Boolean(gate.profileSha256),
        `Repository ${repo.id} validation gate ${gate.id} must bind profilePath and profileSha256 together`);
      if (!gate.profilePath) continue;
      requireThat(!isAbsolute(gate.profilePath) &&
        /^[a-f0-9]{64}$/.test(gate.profileSha256 ?? ''),
      `Repository ${repo.id} validation gate ${gate.id} needs a relative profilePath and profileSha256`);
      const profilePath = resolve(dirname(resolve(path)), gate.profilePath);
      requireThat(existsSync(profilePath) && lstatSync(profilePath).isFile(),
        `Repository ${repo.id} validation gate ${gate.id} profile does not exist`);
      requireThat(hash(readFileSync(profilePath)) === gate.profileSha256,
        `Repository ${repo.id} validation gate ${gate.id} profile hash mismatch`);
      gate.profilePath = profilePath;
    }
  }
  config.stateDirectory = resolve(dirname(resolve(path)), config.stateDirectory);
  return config;
}
export function collectionPreflight(config) {
  requireThat(config.activation.collect === true, 'Live collection is disabled');
  requireThat(config.statePolicy.accessApproved === true, 'Approve state directory ACLs and manual retention before storing live evidence');
  requireThat(config.identity.designatedUser, 'Designated delegated user is unresolved');
  positive(config.limits.maxItems, 'maxItems'); positive(config.limits.maxCalls, 'maxCalls');
}
export function modelPreflight(config) {
  requireThat(Number.isFinite(config.limits.maxAiCreditsPerSession) && config.limits.maxAiCreditsPerSession > 0,
    'A positive per-session AI credit ceiling must be approved before model execution');
}
export class Budget {
  constructor(limits) { this.items = positive(limits.maxItems, 'maxItems'); this.calls = positive(limits.maxCalls, 'maxCalls'); }
  call() { requireThat(this.calls-- > 0, 'Tool-call budget exhausted; coverage is partial', 'partial'); }
  item(count = 1) { this.items -= count; requireThat(this.items >= 0, 'Item budget exhausted; coverage is partial', 'partial'); }
}
