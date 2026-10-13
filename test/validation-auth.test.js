import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseValidationAuthPreflight, validationAuthAction
} from '../src/validation-auth.js';

const contract = {
  provider: 'artifacts-npm-credprovider',
  providerVersion: '1.2.1',
  feeds: [{}, {}]
};

test('validation authentication evidence accepts only the safe schema', () => {
  const output = value => ({
    stdout: `PILOT_VALIDATION_AUTH_PREFLIGHT:${JSON.stringify(value)}\n`
  });
  const ready = {
    state: 'ready',
    provider: contract.provider,
    providerVersion: contract.providerVersion,
    feedCount: 2,
    tokenRecorded: false
  };
  assert.deepEqual(parseValidationAuthPreflight(output(ready), contract), ready);
  assert.equal(parseValidationAuthPreflight(output({
    ...ready, token: 'synthetic-secret'
  }), contract), null);
  assert.equal(parseValidationAuthPreflight(output({
    ...ready, providerVersion: '9.9.9'
  }), contract), null);
});

test('validation authentication action never requests a token', () => {
  const action = validationAuthAction(
    { id: 'gate' },
    { id: 'repo', referenceCheckout: 'C:\\fixture' },
    {
      state: 'action-required-auth',
      reason: 'provider-missing',
      installProvider: true,
      provider: contract.provider,
      providerVersion: contract.providerVersion,
      feedCount: 2,
      tokenRecorded: false
    },
    'C:\\controller');
  assert.equal(action.requiresInstallApproval, true);
  assert.equal(action.tokenRequested, false);
  assert.deepEqual(action.remediation.args, [
    'run', 'setup:validation-auth', '--',
    '-Workspace', 'C:\\fixture', '-InstallProvider'
  ]);
  assert.doesNotMatch(JSON.stringify(action), /secret|credentialValue|accessToken/i);
});

test('PowerShell authentication check distinguishes provider and sign-in actions', {
  skip: process.platform !== 'win32'
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'validation-auth-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, '.yarnrc.yml'), [
    'npmRegistryServer: "https://office.pkgs.visualstudio.com/_packaging/AugmentationLoop/npm/registry/"',
    'npmScopes:',
    '  office:',
    '    npmRegistryServer: "https://office.pkgs.visualstudio.com/_packaging/Office/npm/registry/"'
  ].join('\n'));
  const script = join(process.cwd(), 'scripts', 'validation',
    'prepare-office-agent-auth.ps1');
  const powershell = join(process.env.SystemRoot, 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = path => spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Workspace', workspace, '-CheckOnly'
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: path }
  });
  const systemPath = join(process.env.SystemRoot, 'System32');
  const missing = run(systemPath);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /"reason":"provider-missing"/);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'artifacts-npm-credprovider.cmd'), [
    '@echo off',
    'if "%1"=="--version" (echo 1.2.1& exit /b 0)',
    'echo need refresh',
    'exit /b 0'
  ].join('\r\n'));
  const signIn = run(`${bin}${delimiter}${systemPath}`);
  assert.equal(signIn.status, 0, signIn.stderr);
  assert.match(signIn.stdout, /"reason":"interactive-sign-in-required"/);
  assert.doesNotMatch(signIn.stdout + signIn.stderr,
    /accessToken|credentialValue|password|synthetic-secret/i);

  writeFileSync(join(bin, 'artifacts-npm-credprovider.cmd'), [
    '@echo off',
    'if "%1"=="--version" (echo 1.2.1& exit /b 0)',
    'if "%1"=="--validate-only" (',
    '  if exist "%~dp0authenticated" exit /b 0',
    '  echo need refresh',
    '  exit /b 0',
    ')',
    'type nul > "%~dp0authenticated"',
    'exit /b 0'
  ].join('\r\n'));
  const acquired = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Workspace', workspace
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${systemPath}` }
  });
  assert.equal(acquired.status, 0, acquired.stderr);
  assert.match(acquired.stdout, /authentication is ready/);
  assert.equal(existsSync(join(bin, 'authenticated')), true);
  assert.doesNotMatch(acquired.stdout + acquired.stderr, /need refresh/i);
});
