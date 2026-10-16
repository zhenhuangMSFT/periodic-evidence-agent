import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { configAt, hash } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import {
  command, outputFingerprint, prepareValidation, runValidation, verifyPreparedOutputs
} from '../src/workers.js';

function requireLocalBenchmarkOutput(path) {
  const reserved = /(?:^|[\\/])e2e-evidence(?:[\\/]|$)/i;
  assert.ok(!reserved.test(path), 'Benchmark output is not an E2E proof bundle');
  let parent = dirname(path);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    assert.notEqual(parent, next, 'Output parent is unavailable');
    parent = next;
  }
  assert.ok(!reserved.test(realpathSync.native(parent)),
    'Benchmark output must not resolve inside e2e-evidence');
}

export function benchmarkOptions(args) {
  const options = { samples: 3, files: 4096 };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    assert.ok(['--output', '--samples', '--files'].includes(key) &&
      value && !seen.has(key), 'Use --output PATH [--samples N] [--files N]');
    seen.add(key);
    if (key === '--output') {
      assert.ok(isAbsolute(value), '--output must be absolute');
      requireLocalBenchmarkOutput(value);
      options.output = resolve(value);
    } else {
      const number = Number(value);
      const max = key === '--samples' ? 20 : 32768;
      assert.ok(Number.isInteger(number) && number >= 1 && number <= max,
        `${key} must be an integer from 1 to ${max}`);
      options[key.slice(2)] = number;
    }
  }
  assert.ok(options.output, 'Explicit --output is required');
  assert.ok(!existsSync(options.output), '--output must not already exist');
  return options;
}

export function sampleSummary(values) {
  assert.ok(values.length > 0 && values.every(Number.isFinite));
  const sorted = values.toSorted((a, b) => a - b);
  return {
    sampleCount: values.length, minMs: sorted[0], maxMs: sorted.at(-1),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    rawMs: values,
    percentileClaim: 'None: small local samples, not a stable p50/p95 estimate'
  };
}

function profileSource(files) {
  const plan = {
    version: 2, stages: ['dependencies', 'compile', 'policy', 'test'],
    testOnlyPrefixes: ['test/'], lockfilePaths: ['package.json', 'fixture.lock'],
    buildConfigPaths: ['build.config.json'],
    dependencySnapshotPaths: ['node_modules'],
    preparedOutputPaths: ['dist']
  };
  return `// PILOT_VALIDATION_PLAN: ${JSON.stringify(plan)}
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const stage = process.env.PILOT_VALIDATION_STAGE;
if (stage === 'fingerprint') {
  console.log('PILOT_VALIDATION_FINGERPRINT:' + JSON.stringify({
    node: process.version, corepack: 'synthetic', yarn: 'synthetic',
    platform: process.platform, architecture: process.arch
  }));
} else if (stage === 'dependencies') {
  const root = join('node_modules', 'wide');
  mkdirSync(root, { recursive: true });
  for (let index = 0; index < ${files}; index++)
    writeFileSync(join(root, index + '.js'), 'module.exports = ' + index + ';\\n');
} else if (stage === 'compile') {
  mkdirSync('dist');
  writeFileSync(join('dist', 'value.cjs'), readFileSync(join('src', 'value.cjs')));
} else if (stage === 'test') {
  const require = createRequire(join(process.cwd(), 'entry.cjs'));
  const actual = require('./dist/value.cjs');
  const { expected } = JSON.parse(readFileSync(join('test', 'expected.json')));
  console.log('FIXTURE_TEST:' + JSON.stringify({ actual, expected }));
  process.exitCode = actual === expected ? 0 : 1;
} else if (stage !== 'policy') {
  throw new Error('Unknown fixture stage: ' + stage);
}
`;
}

async function timed(operation) {
  const started = performance.now();
  const cpu = process.cpuUsage();
  const value = await operation();
  const used = process.cpuUsage(cpu);
  return {
    value, wallMs: performance.now() - started,
    controllerProcessCpuMs: (used.user + used.system) / 1000
  };
}

async function sample(root, files, record) {
  const author = join(root, 'author');
  mkdirSync(join(author, 'src'), { recursive: true });
  mkdirSync(join(author, 'test'));
  writeFileSync(join(author, '.gitignore'), 'node_modules/\ndist/\n');
  writeFileSync(join(author, 'package.json'), '{"private":true}\n');
  writeFileSync(join(author, 'fixture.lock'), 'synthetic locked dependencies\n');
  writeFileSync(join(author, 'build.config.json'), '{}\n');
  writeFileSync(join(author, 'src', 'value.cjs'), 'module.exports = 1;\n');
  writeFileSync(join(author, 'test', 'expected.json'), '{"expected":2}\n');
  const git = args => command('git', ['-c', 'core.hooksPath=',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], author);
  const commit = async message => {
    await git(['add', '.']);
    await git(['-c', 'user.name=Synthetic fixture', '-c',
      'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', message]);
    return (await git(['rev-parse', 'HEAD'])).stdout.trim();
  };
  await git(['init', '--quiet']);
  const failingRevision = await commit('Synthetic failing test');
  const profilePath = join(root, 'profile.mjs');
  writeFileSync(profilePath, profileSource(files));
  const repo = {
    id: 'benchmark', owner: 'synthetic', remote: author,
    validationGates: [{
      id: 'fingerprint-benchmark', approved: true, isolationVerified: true,
      executable: process.execPath, args: ['{profile}'], timeoutMs: 300000,
      profilePath, profileSha256: hash(readFileSync(profilePath))
    }]
  };
  const config = configAt(fileURLToPath(new URL('../pilot.example.json', import.meta.url)));
  config.stateDirectory = join(root, 'warm');
  config.limits.maxValidationInfrastructureRetries = 0;
  const job = { id: 'synthetic-benchmark', workspace: author, base_revision: failingRevision };
  const ledgers = [];
  const open = directory => {
    const ledger = new Ledger(directory);
    ledgers.push(ledger);
    return ledger;
  };
  try {
    const ledger = open(config.stateDirectory);
    const preparation = await timed(() =>
      prepareValidation(config, job, repo, failingRevision));
    const prepared = preparation.value;
    const receipt = prepared['fingerprint-benchmark'];
    assert.ok(!receipt.error, JSON.stringify(receipt));
    const preparationSummary = {
      wallMs: preparation.wallMs, timings: receipt.timings,
      compileCache: receipt.cache, dependencyCache: receipt.dependencyCache
    };
    record({ files, preparation: preparationSummary });
    const fingerprint = {};
    const captured = await outputFingerprint(
      receipt.workspace, receipt.outputs.paths, true, fingerprint);
    assert.equal(captured.sha256, receipt.outputs.sha256);
    record({ fingerprint, outputEntries: captured.entries.size,
      outputSha256: captured.sha256 });
    const initial = await timed(() => verifyPreparedOutputs(
      join(root, 'independent-guard'), receipt.workspace, receipt.outputs));
    record({ initial });
    assert.equal(initial.value.valid, true);
    assert.equal(initial.value.method, 'content+watch',
      'This local benchmark needs recursive filesystem watchers');
    const noChange = await timed(() => verifyPreparedOutputs(
      join(root, 'independent-guard'), receipt.workspace, receipt.outputs));
    record({ noChange });
    assert.equal(noChange.value.valid, true);
    const eventFiles = Math.min(files, 256);
    const eventWorkloadStarted = performance.now();
    for (let index = 0; index < eventFiles; index++) {
      const path = join(receipt.workspace, 'node_modules', 'wide', `${index}.js`);
      writeFileSync(path, readFileSync(path));
      if ((index + 1) % 8 === 0) await delay(10);
    }
    const eventWorkloadMs = performance.now() - eventWorkloadStarted;
    await delay(200);
    const eventHeavy = await timed(() => verifyPreparedOutputs(
      join(root, 'independent-guard'), receipt.workspace, receipt.outputs));
    record({ eventFiles, eventWorkloadMs, eventHeavy });
    assert.equal(eventHeavy.value.valid, true, JSON.stringify(eventHeavy.value));
    assert.ok(eventHeavy.value.details.observedEventCount > 0,
      'No observed events: cannot claim event-heavy performance');
    assert.ok(eventHeavy.value.details.hashedFileCount >= eventFiles,
      'Event coverage did not rehash all touched fixture files');
    let validationRound = 0;
    const validate = async (cfg, db, revision, preparation) => {
      const validationJob = { ...job, id: `${job.id}-${validationRound++}` };
      const measured = await timed(() => runValidation(
        cfg, db, validationJob, repo, revision, undefined, undefined, preparation));
      const result = measured.value[0];
      const artifact = JSON.parse(readFileSync(result.artifactRefs.at(-1)));
      return { wallMs: measured.wallMs, controllerProcessCpuMs: measured.controllerProcessCpuMs,
        revision, status: result.status, blockedReason: result.blockedReason,
        testOutput: artifact.output.stdout.match(/FIXTURE_TEST:[^\r\n]+/g),
        telemetry: artifact.telemetry };
    };
    const failing = await validate(config, ledger, failingRevision, prepared);
    record({ failing });
    const repeatFailing = await validate(config, ledger, failingRevision, prepared);
    record({ repeatFailing });
    assert.equal(failing.status, 'failed');
    assert.equal(repeatFailing.status, failing.status);
    assert.deepEqual(repeatFailing.testOutput, failing.testOutput);
    assert.deepEqual(failing.testOutput, ['FIXTURE_TEST:{"actual":1,"expected":2}']);
    for (const round of [failing, repeatFailing]) {
      assert.equal(round.telemetry.compileCache, 'hit');
      assert.equal(round.telemetry.dependencyCache, 'hit');
    }
    writeFileSync(join(author, 'test', 'expected.json'), '{"expected":1}\n');
    const repairedRevision = await commit('Test-only repair');
    assert.equal((await git(['diff', '--name-only', failingRevision, repairedRevision]))
      .stdout.trim(), 'test/expected.json');
    const repaired = await validate(config, ledger, repairedRevision, prepared);
    record({ repaired });
    assert.equal(repaired.status, 'passed');
    assert.deepEqual(repaired.testOutput, ['FIXTURE_TEST:{"actual":1,"expected":1}']);
    assert.equal(repaired.telemetry.compileCache, 'hit');
    assert.equal(repaired.telemetry.dependencyCache, 'hit');
    const freshConfig = { ...config, stateDirectory: join(root, 'full-fresh') };
    const freshLedger = open(freshConfig.stateDirectory);
    const freshPreparation = await timed(() =>
      prepareValidation(freshConfig, job, repo, repairedRevision));
    const freshPrepared = freshPreparation.value;
    const freshReceipt = freshPrepared['fingerprint-benchmark'];
    assert.ok(!freshReceipt.error, JSON.stringify(freshReceipt));
    assert.equal(freshReceipt.cache, 'miss');
    assert.equal(freshReceipt.dependencyCache, 'miss');
    const fresh = await validate(freshConfig, freshLedger, repairedRevision, freshPrepared);
    assert.equal(fresh.status, repaired.status);
    assert.deepEqual(fresh.testOutput, repaired.testOutput);
    assert.deepEqual(freshReceipt.outputs, receipt.outputs);
    assert.deepEqual(freshReceipt.inputs.toolchain, receipt.inputs.toolchain);
    assert.equal(freshReceipt.inputs.profileSha256, receipt.inputs.profileSha256);
    const freshCaptured = await outputFingerprint(
      freshReceipt.workspace, freshReceipt.outputs.paths, true);
    assert.deepEqual(freshCaptured.entries, captured.entries);
    assert.equal(freshCaptured.sha256, captured.sha256);
    assert.equal((await git(['status', '--porcelain'])).stdout, '');
    assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), repairedRevision);
    assert.equal((await command('git', ['rev-parse', 'HEAD'], receipt.workspace))
      .stdout.trim(), failingRevision);
    assert.equal((await command('git', ['status', '--porcelain'], receipt.workspace))
      .stdout, '');
    for (let index = 0; index < eventFiles; index++) {
      const path = join(freshReceipt.workspace, 'node_modules', 'wide', `${index}.js`);
      writeFileSync(path, readFileSync(path));
    }
    await delay(200);
    const burstVerification = await timed(() => verifyPreparedOutputs(
      freshReceipt.receiptPath, freshReceipt.workspace, freshReceipt.outputs));
    record({ burst: { verification: burstVerification } });
    let burstRecovery = null;
    if (!burstVerification.value.valid) {
      burstRecovery = await timed(() => verifyPreparedOutputs(
        join(root, 'burst-full-recovery'), freshReceipt.workspace, freshReceipt.outputs));
      record({ burst: { verification: burstVerification, fullRecovery: burstRecovery } });
      assert.equal(burstRecovery.value.valid, true);
      assert.ok(burstRecovery.value.fullVerification.baseline);
    } else {
      assert.ok(burstVerification.value.details.hashedFileCount >= eventFiles);
    }
    return {
      files, eventFiles, eventWorkloadMs, outputEntries: captured.entries.size,
      outputSha256: captured.sha256, fingerprint,
      preparation: preparationSummary,
      initial, noChange, eventHeavy, failing, repeatFailing, repaired,
      burst: { verification: burstVerification, fullRecovery: burstRecovery },
      fullFresh: { preparationWallMs: freshPreparation.wallMs, validation: fresh,
        compileCache: freshReceipt.cache, dependencyCache: freshReceipt.dependencyCache,
        timings: freshReceipt.timings },
      equivalence: {
        exactRepairedRevision: repairedRevision, failingRevision,
        completeOutputHashAndEntriesEqual: true, testOutputAndStatusEqual: true,
        profileAndToolchainEqual: true, sourceClean: true
      }
    };
  } finally {
    for (const ledger of ledgers) ledger.close();
  }
}

export async function runLocalBenchmark(options) {
  const result = {
    kind: 'synthetic-local-controller-benchmark', version: 1,
    startedAt: new Date().toISOString(), node: process.version,
    platform: process.platform, architecture: process.arch,
    implementationSha256: Object.fromEntries([
      '../src/workers.js', '../src/output-fingerprint.js',
      '../src/output-fingerprint-worker.js', './benchmark-fingerprint.mjs'
    ].map(path => [path, hash(readFileSync(new URL(path, import.meta.url)))])),
    limitations: [
      'Not real OfficeAgent evidence or a complete assignment E2E',
      'Process CPU excludes child Git/profile processes; includes fingerprint worker threads',
      'Worker compute includes CPU and synchronous filesystem wait, not measured disk I/O',
      'Round-trip includes worker startup, messaging and structured clone; not pure I/O',
      'Queue sums overlap across workers; do not add them to wall time',
      'Event-heavy writes yield every 8 files; a separate unpaced burst records watcher loss/fallback',
      'Full-fresh uses independent controller state, dependency creation and compilation',
      'No guardian, persisted trust, product checkout, live sources or remote operations'
    ],
    samples: []
  };
  requireLocalBenchmarkOutput(options.output);
  mkdirSync(dirname(options.output), { recursive: true });
  requireLocalBenchmarkOutput(options.output);
  const persist = () => writeFileSync(options.output, JSON.stringify(result, null, 2),
    { mode: 0o600 });
  writeFileSync(options.output, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  let root = null;
  try {
    root = mkdtempSync(join(tmpdir(), 'local-fingerprint-benchmark-'));
    for (let index = 0; index < options.samples; index++) {
      const directory = join(root, String(index));
      mkdirSync(directory);
      result.samples[index] = { state: 'running' };
      const measured = await sample(directory, options.files, partial => {
        Object.assign(result.samples[index], partial);
        persist();
      });
      result.samples[index] = { ...measured, state: 'passed' };
      persist();
    }
    result.distributions = Object.fromEntries(['initial', 'noChange', 'eventHeavy',
      'failing', 'repeatFailing', 'repaired'].map(stage =>
      [stage, sampleSummary(result.samples.map(sample => sample[stage].wallMs))]));
    result.result = 'checks-passed-cleanup-pending';
    persist();
    return result;
  } catch (error) {
    result.result = 'failed';
    result.error = { message: error.message, stack: error.stack };
    persist();
    throw error;
  } finally {
    // Only this invocation's mkdtemp fixture is eligible for removal.
    try {
      if (root)
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      result.cleanup = { state: root ? 'removed-own-fixture' : 'not-created' };
    } catch (error) {
      result.result = 'failed';
      result.cleanup = { state: 'failed', message: error.message };
      persist();
      throw error;
    }
    if (result.result === 'checks-passed-cleanup-pending') {
      result.result = 'passed';
      result.completedAt = new Date().toISOString();
    }
    persist();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = benchmarkOptions(process.argv.slice(2));
  const result = await runLocalBenchmark(options);
  console.log(JSON.stringify({
    result: result.result, kind: result.kind, output: options.output,
    distributions: result.distributions
  }, null, 2));
}
