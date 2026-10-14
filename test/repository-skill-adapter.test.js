import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, hash } from '../src/common.js';
import {
  loadRepositorySkill, normalizeSkillResult, pinSkillQualification, qualifyRepositorySkill,
  normalizeSkillInput, repositoryValidationContract, resolveSkillBinding
} from '../src/repository-skills.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'repository-skill-'));
  const workspace = join(root, 'workspace');
  const skillDirectory = join(workspace, 'docs', 'skills', 'Integration-test-core');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(join(skillDirectory, 'SKILL.md'), '# Synthetic OA integration skill\n');
  const config = configAt('pilot.example.json');
  config.limits.maxFileBytes = 262144;
  config.repositories = [{
    id: 'office-src', owner: 'oa-owner', routingApproved: true,
    referenceCheckout: workspace, baseRef: 'main',
    remote: 'https://office.visualstudio.com/ISS/_git/OfficeAgent',
    allowedWritePrefixes: ['test'],
    skillBindings: [{
      id: 'oa-integration-test-core', capability: 'integration-test-authoring',
      skillPath: 'docs/skills/Integration-test-core/SKILL.md', enabled: true, qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'], requiresBehaviorCard: true,
      sideEffects: { commit: false, push: false, createDraftPR: false }
    }]
  }];
  const assignment = {
    repoId: 'office-src', capability: 'integration-test-authoring',
    skillBindingId: 'oa-integration-test-core'
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, config, assignment };
}
function qualification(config, assignment, revision, instructions = '# Synthetic OA integration skill\n') {
  const binding = config.repositories[0].skillBindings[0];
  assignment.allowedWritePrefixes = [...binding.allowedWritePrefixes];
  const contract = repositoryValidationContract(config.repositories[0]);
  const receipt = {
    state: 'qualified-read-only', repoId: assignment.repoId, bindingId: assignment.skillBindingId,
    capability: assignment.capability, remote: config.repositories[0].remote,
    baseRef: config.repositories[0].baseRef, baseRevision: revision,
    skillPath: binding.skillPath.replaceAll('\\', '/'), skillSha256: hash(instructions),
    qualificationSource: 'local-reference',
    validationContractVersion: contract.version,
    validationContractSha256: contract.sha256,
    sideEffects: binding.sideEffects
  };
  assignment.skillQualification = pinSkillQualification(receipt);
  return receipt;
}

test('adapter loads exactly the configured repository skill at the bound source revision', t => {
  const { workspace, config, assignment } = setup(t);
  const revision = 'a'.repeat(40);
  const receipt = qualification(config, assignment, revision);
  const loaded = loadRepositorySkill(config, assignment, workspace, revision, receipt);
  assert.match(loaded.instructions, /Synthetic OA integration skill/);
  assert.equal(loaded.skillPath, 'docs/skills/Integration-test-core/SKILL.md');
  assert.equal(loaded.skillRevision, 'a'.repeat(40));
});

test('adapter uses committed skill bytes when checkout line endings differ', async t => {
  const { workspace, config, assignment } = setup(t);
  writeFileSync(join(workspace, '.gitattributes'), '*.md text eol=crlf\n');
  const run = args => new Promise((resolve, reject) => {
    import('node:child_process').then(({ execFile }) =>
      execFile('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false',
        '-c', 'core.safecrlf=false', ...args], { cwd: workspace }, (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
  });
  await run(['init', '--quiet']);
  await run(['add', '.']);
  await run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Fixture']);
  const revision = (await run(['rev-parse', 'HEAD'])).trim();
  writeFileSync(join(workspace, 'docs', 'skills', 'Integration-test-core', 'SKILL.md'),
    '# Synthetic OA integration skill\r\n');
  const receipt = qualification(config, assignment, revision);
  const loaded = loadRepositorySkill(config, assignment, workspace, revision, receipt);
  assert.equal(loaded.instructions, '# Synthetic OA integration skill\n');
  writeFileSync(join(workspace, 'docs', 'skills', 'Integration-test-core', 'SKILL.md'),
    '# Changed skill\n');
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, revision, receipt),
    error => error.code === 'blocked-reconciliation' && /content changed/.test(error.message));
});

test('skill Git execution failure is not reported as established content drift', t => {
  const { workspace, config, assignment } = setup(t);
  mkdirSync(join(workspace, '.git'));
  const revision = 'a'.repeat(40);
  const receipt = qualification(config, assignment, revision);
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, revision, receipt),
    error => error.code === 'blocked-repository-git' &&
      /Git cat-file failed \(native-command-failed; exit status \d+\); content drift is not established/.test(error.message));
});

test('skill binding is fail-closed when disabled, unqualified or ambiguous', t => {
  const { config } = setup(t);
  config.repositories[0].skillBindings[0].enabled = false;
  assert.throws(() => resolveSkillBinding(config, 'office-src', 'integration-test-authoring'), /disabled/);
  config.repositories[0].skillBindings[0].enabled = true;
  config.repositories[0].skillBindings[0].qualification = 'unqualified';
  assert.throws(() => resolveSkillBinding(config, 'office-src', 'integration-test-authoring'), /unqualified/);
  config.repositories[0].skillBindings[0].qualification = 'qualified';
  config.repositories[0].skillBindings.push({
    ...structuredClone(config.repositories[0].skillBindings[0]), id: 'duplicate'
  });
  assert.throws(() => resolveSkillBinding(config, 'office-src', 'integration-test-authoring'), /unambiguous/);
});

test('read-only qualification verifies an exact repository revision before routing is enabled', async t => {
  const { config } = setup(t);
  const repo = config.repositories[0];
  repo.owner = null;
  repo.routingApproved = false;
  repo.skillBindings[0].enabled = false;
  repo.skillBindings[0].qualification = 'unqualified';
  const revision = 'd'.repeat(40);
  const calls = [];
  const result = await qualifyRepositorySkill(config, 'office-src', 'integration-test-authoring',
    'oa-integration-test-core', async (executable, args, cwd) => {
      calls.push({ executable, args, cwd });
      const operation = args[2];
      if (operation === 'remote') return { stdout: `${repo.remote}\n` };
      if (operation === 'rev-parse') return { stdout: `${revision}\n` };
      if (operation === 'cat-file') return { stdout: '' };
      if (operation === 'show') return { stdout: '# Synthetic OA integration skill\n' };
      throw new Error(`Unexpected operation ${operation}`);
    });
  assert.equal(result.baseRevision, revision);
  assert.equal(result.state, 'qualified-read-only');
  assert.equal(result.skillPath, 'docs/skills/Integration-test-core/SKILL.md');
  assert.match(result.skillSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.qualificationSource, 'local-reference');
  assert.match(result.validationContractSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.map(call => call.args[2]), ['remote', 'rev-parse', 'cat-file', 'show']);
});

test('trusted-remote qualification fetches before resolving and binds the validation contract', async t => {
  const { config } = setup(t);
  const repo = config.repositories[0];
  repo.qualificationRefresh = 'fetch';
  repo.baseRef = 'origin/feature/synthetic-validation';
  repo.validationContractVersion = 'oa-v2';
  repo.validationGates = [{
    id: 'oa-test', approved: true, executable: process.execPath,
    args: ['--test'], timeoutMs: 1000, profileSha256: 'a'.repeat(64)
  }];
  const revision = 'e'.repeat(40);
  const calls = [];
  const result = await qualifyRepositorySkill(config, 'office-src', 'integration-test-authoring',
    'oa-integration-test-core', async (executable, args) => {
      calls.push(args.slice(2));
      if (args[2] === 'remote') return { stdout: `${repo.remote}\n` };
      if (args[2] === 'fetch') return { stdout: '' };
      if (args[2] === 'rev-parse') return { stdout: `${revision}\n` };
      if (args[2] === 'cat-file') return { stdout: '' };
      if (args[2] === 'show') return { stdout: '# Synthetic OA integration skill\n' };
      throw new Error(`Unexpected operation ${args[2]}`);
    }, async () => 'synthetic-token');
  assert.deepEqual(calls.map(args => args[0]),
    ['remote', 'fetch', 'rev-parse', 'cat-file', 'show']);
  assert.equal(calls.find(args => args[0] === 'fetch').at(-1), 'feature/synthetic-validation');
  assert.equal(calls.find(args => args[0] === 'rev-parse').at(-1),
    'FETCH_HEAD^{commit}');
  assert.equal(result.qualificationSource, 'trusted-remote');
  assert.equal(result.validationContractVersion, 'oa-v2');
  assert.match(result.validationContractSha256, /^[a-f0-9]{64}$/);
});

test('trusted ADO qualification fetch uses a short-lived bearer without persisting it', async t => {
  const { config } = setup(t);
  const repo = config.repositories[0];
  repo.remote = 'https://office.visualstudio.com/ISS/_git/OfficeAgent';
  repo.qualificationRefresh = 'fetch';
  const revision = 'a'.repeat(40);
  const calls = [];
  await qualifyRepositorySkill(config, 'office-src', 'integration-test-authoring',
    'oa-integration-test-core', async (executable, args, cwd, timeout, env) => {
      calls.push({ args, env });
      if (args[2] === 'remote') return { stdout: `${repo.remote}\n` };
      if (args[2] === 'fetch') return { stdout: '' };
      if (args[2] === 'rev-parse') return { stdout: `${revision}\n` };
      if (args[2] === 'cat-file') return { stdout: '' };
      if (args[2] === 'show') return { stdout: '# Synthetic OA integration skill\n' };
      throw new Error(`Unexpected operation ${args[2]}`);
    }, async () => 'synthetic-token');
  const fetch = calls.find(call => call.args[2] === 'fetch');
  assert.equal(fetch.env.GIT_CONFIG_KEY_0, 'http.extraHeader');
  assert.equal(fetch.env.GIT_CONFIG_VALUE_0, 'AUTHORIZATION: bearer synthetic-token');
  assert.ok(fetch.args.every(arg => !arg.includes('synthetic-token')));
});

test('adapter rejects a validation contract changed after qualification', t => {
  const { workspace, config, assignment } = setup(t);
  const revision = 'f'.repeat(40);
  const receipt = qualification(config, assignment, revision);
  config.repositories[0].validationGates = [{
    id: 'new-gate', approved: true, executable: process.execPath,
    args: [], timeoutMs: 1000
  }];
  assert.throws(() =>
    loadRepositorySkill(config, assignment, workspace, revision, receipt),
  /validation contract changed/);
});

test('adapter rejects path traversal and reparse-point skill paths', t => {
  const { root, workspace, config, assignment } = setup(t);
  config.repositories[0].skillBindings[0].skillPath = '..\\outside.md';
  const revision = 'b'.repeat(40);
  let receipt = qualification(config, assignment, revision);
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, revision, receipt), /escapes workspace/);
  const external = join(root, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'SKILL.md'), '# external\n');
  const linked = join(workspace, 'docs', 'linked');
  symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  config.repositories[0].skillBindings[0].skillPath = 'docs/linked/SKILL.md';
  receipt = qualification(config, assignment, revision, '# external\n');
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, revision, receipt), /Symlink|reparse/);
});

test('skill result normalization is deterministic and rejects success-shaped empty output', t => {
  const { workspace, config, assignment } = setup(t);
  const revision = 'c'.repeat(40);
  const receipt = qualification(config, assignment, revision);
  const loaded = loadRepositorySkill(config, assignment, workspace, revision, receipt);
  const result = normalizeSkillResult(loaded, {
    status: 'succeeded', classification: 'missing-coverage',
    changedFiles: ['test/new.test.js', 'test/new.test.js', 'test/new.behavior-card.md'],
    testsAddedOrUpdated: ['new test'], behaviorCardsAddedOrUpdated: ['test/new.behavior-card.md'],
    unknowns: [], needsHumanDecision: false
  });
  assert.deepEqual(result.changedFiles, ['test/new.behavior-card.md', 'test/new.test.js']);
  assert.equal(result.bindingId, 'oa-integration-test-core');
  assert.throws(() => normalizeSkillResult(loaded, {
    status: 'succeeded', classification: 'missing-coverage',
    changedFiles: ['test/new.test.js'], testsAddedOrUpdated: ['new test'],
    behaviorCardsAddedOrUpdated: [], unknowns: [], needsHumanDecision: false
  }), /behavior-card update/);
  assert.throws(() => normalizeSkillResult(loaded, {
    status: 'succeeded', classification: 'missing-coverage',
    changedFiles: ['test/new.test.js'], testsAddedOrUpdated: ['new test'],
    behaviorCardsAddedOrUpdated: ['test/new.behavior-card.md'],
    unknowns: [], needsHumanDecision: false
  }), /included in changedFiles/);
  assert.throws(() => normalizeSkillResult(loaded, {
    status: 'succeeded', classification: 'missing-coverage',
    changedFiles: [], testsAddedOrUpdated: [], behaviorCardsAddedOrUpdated: [],
    unknowns: [], needsHumanDecision: false
  }), /existing coverage/);
});

test('declarative E2E skill input is versioned, complete and has unique item IDs', t => {
  const { config } = setup(t);
  const binding = config.repositories[0].skillBindings[0];
  binding.inputFormat = 'declarative-e2e-mini-spec-batch-v1';
  const input = {
    format: 'declarative-e2e-mini-spec-batch-v1',
    items: [{
      inputItemId: 'bizchat-excel-canary',
      title: 'Create an Excel workbook from BizChat',
      account: 'AAD',
      entryUrl: 'https://example.invalid/chat',
      preconditions: ['Signed in with the qualified AAD profile'],
      orderedTestSteps: ['Open BizChat', 'Create the workbook'],
      expectedUserVisibleAndDataOutcomes: ['A real workbook opens'],
      cleanup: ['Close only the test-owned tab']
    }]
  };
  assert.deepEqual(normalizeSkillInput(binding, input), input);
  assert.throws(() => normalizeSkillInput(binding, null),
    /requires declarative-e2e-mini-spec-batch-v1/);
  const duplicate = structuredClone(input);
  duplicate.items.push(structuredClone(input.items[0]));
  assert.throws(() => normalizeSkillInput(binding, duplicate), /unique/);
});

test('adapter rejects missing, changed or source-mismatched qualification receipts', t => {
  const { workspace, config, assignment } = setup(t);
  const revision = 'e'.repeat(40);
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, revision, null), /receipt is missing/);
  const receipt = qualification(config, assignment, revision);
  writeFileSync(join(workspace, 'docs', 'skills', 'Integration-test-core', 'SKILL.md'), '# changed\n');
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, revision, receipt), /content changed/);
  writeFileSync(join(workspace, 'docs', 'skills', 'Integration-test-core', 'SKILL.md'),
    '# Synthetic OA integration skill\n');
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, 'f'.repeat(40), receipt),
    /source revision/);
});
