import { execFileSync } from 'node:child_process';

const allowedRoots = /^(?:src\/|test\/|scripts\/|scaffold\/|e2e-evidence\/|\.github\/skills\/|\.github\/workflows\/)/;
const allowedTop = new Set(['.gitignore', '.gitattributes', 'README.md', 'APP-NATIVE.md', 'AGENCY-EXECUTOR.md', 'EXECUTION-GUIDE.md', 'CONTRIBUTING.md',
  'AGENTS.md', 'package.json', 'package-lock.json', 'pilot.example.json']);
const forbiddenPath = /(?:^|\/)(?:\.state|node_modules|\.copilot|captures|receipts|session-state)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.local\.json$|\.(?:sqlite|db)(?:-|$)|(?:-wal|-shm|\.log)$|(?:auth-support|support-evidence|parent-app.*receipts)/i;
const patterns = [
  ['personal Microsoft email', /\b[A-Z0-9._%+-]+@microsoft\.com\b/i],
  ['personal home path', /[A-Z]:[\\/]+Users[\\/]+|\/(?:home|Users)\/[A-Z0-9._-]+\//i],
  ['personal SharePoint document', /https:\/\/[^\s"')]+\/personal\//i],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential token literal', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/]
];
const git = args => execFileSync('git', ['--no-pager', ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const findings = [];
const seen = new Set();
function inspect(path, mode, oid, origin) {
  if (!allowedTop.has(path) && !allowedRoots.test(path)) findings.push({ origin, path, rule: 'unexpected package path' });
  if (forbiddenPath.test(path)) findings.push({ origin, path, rule: 'runtime/private artifact path' });
  if (!['100644', '100755'].includes(mode)) findings.push({ origin, path, rule: 'symlink/submodule or unresolved index entry' });
  if (seen.has(oid)) return;
  seen.add(oid);
  const content = git(['cat-file', 'blob', oid]);
  if (content.includes('\0')) findings.push({ origin, path, rule: 'binary payload' });
  for (const [rule, pattern] of patterns) if (pattern.test(content)) findings.push({ origin, path, rule });
}
try {
  const entries = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  if (!entries.length) throw new Error('Stage the intended package or run from a committed checkout first');
  for (const entry of entries) {
    const [header, path] = entry.split('\t');
    const [mode, oid, stage] = header.split(' ');
    if (stage !== '0') throw new Error('Resolve index conflicts first');
    inspect(path, mode, oid, 'index');
  }
  let commits = [];
  try {
    git(['rev-parse', '--verify', '--quiet', 'HEAD']);
    commits = git(['rev-list', 'HEAD']).trim().split(/\s+/).filter(Boolean);
  } catch {
    // A staged, not-yet-committed package has no HEAD history to inspect.
  }
  for (const commit of commits) {
    for (const entry of git(['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean)) {
      const [header, path] = entry.split('\t');
      const [mode, , oid] = header.split(' ');
      inspect(path, mode, oid, commit);
    }
  }
  if (findings.length) {
    console.error(JSON.stringify({ result: 'package-check-failed', findings }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ result: 'package-check-passed', indexFiles: entries.length,
      commitsChecked: commits.length, uniqueBlobsChecked: seen.size,
      limitation: 'Targeted file/history hygiene, not a comprehensive secret scanner; author metadata intentionally retained' }, null, 2));
  }
} catch {
  console.error('Package inspection failed. Use a Git checkout with staged files, no conflicts and readable local history.');
  process.exitCode = 1;
}
