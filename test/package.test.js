import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pilot-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet']);
  const inspect = () => spawnSync(process.execPath,
    [fileURLToPath(new URL('../scripts/check-package.mjs', import.meta.url))],
    { cwd: root, encoding: 'utf8', timeout: 30000 });
  return { root, git, inspect };
}

test('package check rejects a private file in the index even if gitignore covers it', t => {
  const { root, git, inspect } = fixture(t);
  writeFileSync(join(root, 'README.md'), 'Synthetic package\n');
  git(['add', 'README.md']);
  assert.equal(inspect().status, 0);
  writeFileSync(join(root, '.gitignore'), '*.local.json\n');
  writeFileSync(join(root, 'pilot.local.json'), '{"fixture":true}');
  git(['add', '-f', 'pilot.local.json']);
  const result = inspect();
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stderr);
  assert.ok(report.findings.some(f => f.path === 'pilot.local.json' && f.rule === 'runtime/private artifact path'));
});

test('package check accepts public execution guides, Agency contracts and verifier byte-preservation attributes', t => {
  const { root, git, inspect } = fixture(t);
  writeFileSync(join(root, 'EXECUTION-GUIDE.md'), 'Generic gated execution guide\n');
  writeFileSync(join(root, 'AGENCY-EXECUTOR.md'), 'Generic offline executor contract\n');
  writeFileSync(join(root, '.gitattributes'), 'src/filter-capture-verifier.js -text\n');
  git(['add', 'EXECUTION-GUIDE.md', 'AGENCY-EXECUTOR.md', '.gitattributes']);
  assert.equal(inspect().status, 0);
});

test('package check detects unsuitable historical contents removed from the current tree', t => {
  const { root, git, inspect } = fixture(t);
  const sample = ['fixture-person', 'microsoft.com'].join('@');
  writeFileSync(join(root, 'README.md'), sample);
  git(['add', 'README.md']);
  git(['-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic history']);
  writeFileSync(join(root, 'README.md'), 'Sanitized current tree\n');
  git(['add', 'README.md']);
  const result = inspect();
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes(sample), false);
  const report = JSON.parse(result.stderr);
  assert.ok(report.findings.some(f => f.origin !== 'index' && f.rule === 'personal Microsoft email'));
});

test('package check ignores history reachable only from unrelated refs', t => {
  const { root, git, inspect } = fixture(t);
  writeFileSync(join(root, 'README.md'), 'Safe package\n');
  git(['add', 'README.md']);
  git(['-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Safe package']);
  const packageBranch = git(['branch', '--show-current']).trim();
  git(['checkout', '--quiet', '--orphan', 'unrelated']);
  writeFileSync(join(root, 'AGENCY-EXECUTOR.md'), 'Not part of the package branch\n');
  git(['add', 'AGENCY-EXECUTOR.md']);
  git(['-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Unrelated history']);
  git(['checkout', '--quiet', packageBranch]);
  assert.equal(inspect().status, 0);
});
