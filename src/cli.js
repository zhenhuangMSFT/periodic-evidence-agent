#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { configAt, readJson, safeError, requireThat } from './common.js';
import { Ledger } from './ledger.js';
import { collect, acceptReview, reviewPending, route, report, reconcile, tick, runOnce, nextDailyWake } from './coordinator.js';
import { smokeRuntime, withWorkiq, principalPath, verifyPrincipal } from './runtime.js';
import { adoTransport } from './sources.js';
import { dryRun } from './dry-run.js';
import { beginApp, openApp, appendApp, blockApp, unavailableApp, appStatus, appReview, appWorker, appPlanImprovement, collectAppAdo, reconcileAppAdo, listAppRuns, importParentReceipts, prepareWorkiqContinuation, threadContext } from './app-native.js';
import { collectCliWorkiq, reconcileCliWorkiq } from './cli-collection.js';
import { persistIcmReplay } from './icm-replay.js';
import { prepareStage2, checkStage2Files } from './stage2.js';
import { prepareTitleIndex, materializeTitleScreen } from './filter.js';
import { prepareFilterBatches, sizeFilterGroups, checkFilterBatchFiles, consolidateFilterBatches } from './filter-batches.js';
import { reconcileFilterExecutionCohort } from './filter-execution.js';
import { planImprovement } from './improvements.js';
import { qualifyRepositorySkill, skillQualificationId } from './repository-skills.js';
import { bootstrapLocalRepository } from './local-settings.js';
import { setupLocalEnvironment } from './setup.js';
import { publishReviewReceipt, verifyReviewReceipt } from './pr-review-receipt.js';
import { acceptReviewedHandoff } from './reviewed-handoff.js';
import { acceptFilterProposerHandoff } from './filter-handoff.js';
import { cleanupWorkspaces } from './workspace-gc.js';

const [action = 'help', ...args] = process.argv.slice(2);
const configIndex = args.indexOf('--config');
const configFile = configIndex >= 0 ? args[configIndex + 1] :
  ['setup', 'bootstrap-repo', 'submit-reviewed-handoff', 'submit-filter-handoff', 'workspace-gc'].includes(action)
    ? 'pilot.local.json' : 'pilot.example.json';
function option(name) {
  const index = args.indexOf(name); return index < 0 ? null : args[index + 1];
}
function options(name) {
  return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []);
}
function failedOutcome(result) {
  if (Array.isArray(result)) return result.some(failedOutcome);
  if (!result || typeof result !== 'object') return false;
  return Boolean(result.error) ||
    result.state === 'failed' ||
    ['action-required-auth', 'blocked', 'blocked-auth', 'partial', 'partial-or-blocked',
      'draft-pr-validation-failed'].includes(result.state) ||
    ['blocked', 'draft-pr-validation-failed'].includes(result.outcome) ||
    ['collection', 'reviews', 'workers', 'result', 'workspaces'].some(key => failedOutcome(result[key]));
}
const help = `Local evidence pilot (live operations disabled by default)
  node src\\cli.js setup [--repo ID ...] [--allow-clone] [--search-root C:\\src] [--clone-root D:\\repos]
  node src\\cli.js bootstrap-repo --repo office-agent --config pilot.local.json [--search-root C:\\src] [--clone-root D:\\repos]
  node src\\cli.js pr-review-publish --repo OWNER/REPO --pr NUMBER --file review-receipt.local.json [--approve-other-author]
  node src\\cli.js pr-review-verify --repo OWNER/REPO --pr NUMBER
  node src\\cli.js submit-reviewed-handoff --file reviewed-handoff.json --config pilot.local.json --prepare
  node src\\cli.js submit-reviewed-handoff --file reviewed-handoff.json --config pilot.local.json --execute --authorize-synthetic --authorize-commit --authorize-push --authorize-draft-pr
  node src\\cli.js submit-filter-handoff --file filter-handoff.json --config pilot.local.json --prepare
  node src\\cli.js submit-filter-handoff --file filter-handoff.json --config pilot.local.json --execute --authorize-commit --authorize-push --authorize-draft-pr
  node src\\cli.js status [--config pilot.local.json]
  node src\\cli.js workspace-gc --config pilot.local.json [--execute]
  node src\\cli.js doctor
  node src\\cli.js runtime-smoke
  node src\\cli.js auth-check
  node src\\cli.js dry-run --config pilot.example.json
  node src\\cli.js dry-run --collect --auth-refreshed --config pilot.example.json
  node src\\cli.js collect --config pilot.local.json
  node src\\cli.js run --config pilot.local.json
  node src\\cli.js review --file review.json --config pilot.local.json
  node src\\cli.js review-pending --config pilot.local.json
  node src\\cli.js dispatch --intent rca-only|defect-fix|improvement --config pilot.local.json
  node src\\cli.js report
  node src\\cli.js reconcile
  node src\\cli.js recover-lock --name NAME --owner EXACT_OWNER
  node src\\cli.js unblock-source --source ado:created --reason "Verified supported reauthentication"
  node src\\cli.js tick --config pilot.local.json
  node src\\cli.js serve --config pilot.local.json
  node src\\cli.js app-begin --file begin.json
  node src\\cli.js app-runs
  node src\\cli.js app-import-parent --run ID --file parent-receipts.json
  node src\\cli.js app-append --run ID --file receipt-batch.json
  node src\\cli.js app-unavailable --run ID --file unavailable.json
  node src\\cli.js app-block --run ID --file authentication-failure.json
  node src\\cli.js app-status --run ID
  node src\\cli.js app-ado --run ID --pass ado:created|ado:changed --collect
  node src\\cli.js app-ado-reconcile --run ID --pass ado:created|ado:changed
  node src\\cli.js app-workiq-cli --run ID --pass workiq:created|workiq:changed --collect --config pilot.local.json
  node src\\cli.js app-workiq-cli-reconcile --run ID --pass workiq:created|workiq:changed --config pilot.local.json
  node src\\cli.js app-workiq-continue --from-run OLD --run NEW --pass workiq:created|workiq:changed --authorize-additional-budget
  node src\\cli.js app-thread-context --run ID --pass workiq:created|workiq:changed
  node src\\cli.js icm-replay --file receipt-bundle.json --config pilot.local.json
  node src\\cli.js stage2-handoff --file source-ledgers.json --output private-handoff.json
  node src\\cli.js filter-title-index --file source-ledgers.json --output private-titles.json
  node src\\cli.js filter-title-materialize --file title-decisions.json --index private-titles.json --output private-details.json
  node src\\cli.js filter-batches --file batch-request.json --output private-batches.json
  node src\\cli.js filter-batch-size --file batch-request.json --output private-sizes.json
  node src\\cli.js filter-batch-check --file batch-result.json --manifest private-batches.json
  node src\\cli.js filter-consolidate --file result-paths.json --manifest private-batches.json --output consolidation.json
  node src\\cli.js filter-execution-check --file result-paths.json --manifest private-batches.json --ledger execution.sqlite
  node src\\cli.js stage2-proposal-check --file private-proposal.json --handoff private-handoff.json
  node src\\cli.js app-review --run ID --production --file review.json
  node src\\cli.js app-plan-improvement --run ID --production --file improvement-plan.json
  node src\\cli.js app-worker --run ID --production --operation prepare|claim|bind|result|uncertain --file action.json
  node src\\cli.js plan-improvement --file improvement-plan.json --config pilot.local.json
  node src\\cli.js qualify-skill --repo office-agent --capability integration-test-authoring --binding oa-integration-test-core --config pilot.local.json
App commands default to isolated dry-run storage. They never call SDK WorkIQ.
Only app-ado --collect and explicitly configured app-workiq-cli --collect perform source reads.
No source writes, merge, validation retry/cancel or automatic lock stealing.`;
let ledger;
try {
  if (action === 'help') console.log(help);
  else if (action === 'setup') {
    const result = await setupLocalEnvironment({
      settingsPath: configFile,
      templatePath: option('--template') ?? 'pilot.example.json',
      repoIds: options('--repo'),
      searchRoots: options('--search-root'),
      cloneRoot: option('--clone-root'),
      allowClone: args.includes('--allow-clone')
    });
    const setupConfig = configAt(resolve(configFile));
    ledger = new Ledger(setupConfig.stateDirectory);
    for (const qualification of result.qualifications)
      ledger.qualify(skillQualificationId(qualification.repoId, qualification.bindingId), qualification);
    console.log(JSON.stringify(result, null, 2));
  }
  else if (action === 'bootstrap-repo') {
    requireThat(option('--repo'), 'bootstrap-repo requires --repo');
    const result = await bootstrapLocalRepository({
      settingsPath: configFile,
      templatePath: option('--template') ?? 'pilot.example.json',
      repoId: option('--repo'),
      searchRoots: options('--search-root'),
      cloneRoot: option('--clone-root'),
      allowClone: true
    });
    console.log(JSON.stringify(result, null, 2));
  }
  else if (action === 'pr-review-publish') {
    requireThat(option('--repo') && option('--pr') && option('--file'),
      'pr-review-publish requires --repo, --pr and --file');
    const result = await publishReviewReceipt({
      repository: option('--repo'),
      number: Number(option('--pr')),
      receipt: readJson(resolve(option('--file'))),
      approveOtherAuthor: args.includes('--approve-other-author')
    });
    console.log(JSON.stringify(result, null, 2));
  }
  else if (action === 'pr-review-verify') {
    requireThat(option('--repo') && option('--pr'), 'pr-review-verify requires --repo and --pr');
    const result = await verifyReviewReceipt({
      repository: option('--repo'),
      number: Number(option('--pr'))
    });
    console.log(JSON.stringify(result, null, 2));
  }
  else {
    const config = configAt(resolve(configFile));
    const appAction = action.startsWith('app-');
    if (config.executionMode === 'app-native' && !appAction &&
      ['auth-check', 'dry-run', 'collect', 'run', 'dispatch', 'review-pending', 'tick', 'serve', 'runtime-smoke'].includes(action)) {
      requireThat(option('--execution-mode') === 'standalone-sdk',
        'App-native mode does not launch SDK gates/workers/schedules. Use app-* commands; legacy SDK requires explicit --execution-mode standalone-sdk');
    }
    if (!appAction && !['dry-run', 'icm-replay', 'stage2-handoff', 'stage2-proposal-check',
      'filter-title-index', 'filter-title-materialize', 'filter-batches', 'filter-batch-size',
      'filter-batch-check', 'filter-consolidate', 'filter-execution-check'].includes(action))
      ledger = new Ledger(config.stateDirectory);
    if (appAction && !['app-begin', 'app-runs', 'app-workiq-continue'].includes(action)) {
      requireThat(option('--run'), 'App commands require --run');
      ({ ledger } = openApp(config, option('--run'), !args.includes('--production')));
    }
    const input = () => { requireThat(option('--file'), 'Command requires --file'); return readJson(resolve(option('--file'))); };
    let result;
    switch (action) {
      case 'filter-batch-size':
        requireThat(option('--output'), 'Batch measurement requires --output');
        result = sizeFilterGroups(config, input(), option('--output')); break;
      case 'filter-batches':
        requireThat(option('--output'), 'Batch preparation requires --output');
        result = await prepareFilterBatches(config, input(), option('--output')); break;
      case 'filter-batch-check':
        requireThat(option('--file') && option('--manifest'), 'Batch check requires --file and --manifest');
        result = checkFilterBatchFiles(config, option('--manifest'), option('--file')); break;
      case 'filter-consolidate': {
        requireThat(option('--manifest') && option('--output'), 'Consolidation requires --manifest and --output');
        const files = input();
        requireThat(Array.isArray(files) && files.every(p => typeof p === 'string'),
          'Consolidation --file must contain an array of result paths');
        result = consolidateFilterBatches(config, readJson(option('--manifest')),
          files.map(p => readJson(resolve(p))), option('--output')); break;
      }
      case 'filter-execution-check': {
        requireThat(option('--manifest') && option('--ledger'), 'Execution check requires --manifest and --ledger');
        const files = input();
        requireThat(Array.isArray(files) && files.every(p => typeof p === 'string'),
          'Execution check --file must contain an array of result paths');
        const db = new DatabaseSync(resolve(option('--ledger')), { readOnly: true });
        try {
          result = reconcileFilterExecutionCohort(config, { db }, readJson(option('--manifest')),
           files.map(p => readFileSync(resolve(p), 'utf8')),
           option('--policy') ? readJson(option('--policy')) : null);
        } finally { db.close(); }
        break;
      }
      case 'filter-title-index':
        requireThat(option('--output'), 'Title index requires an explicit private output path');
        result = prepareTitleIndex(config, input(), option('--output')); break;
      case 'filter-title-materialize':
        requireThat(option('--file') && option('--index') && option('--output'),
          'Title materialization requires --file, --index and --output');
        result = materializeTitleScreen(config, option('--index'), option('--file'), option('--output')); break;
      case 'icm-replay':
        requireThat(!args.includes('--collect'), 'IcM replay is offline only; live timestamp contract is unresolved');
        result = persistIcmReplay(config, input()); break;
      case 'stage2-handoff':
        requireThat(option('--output'), 'Stage2 requires an explicit private output path');
        result = prepareStage2(config, input(), option('--output')); break;
      case 'stage2-proposal-check':
        requireThat(option('--file') && option('--handoff'), 'Proposal check requires --file and --handoff');
        result = checkStage2Files(config, option('--file'), option('--handoff')); break;
      case 'app-begin': result = beginApp(config, input()); break;
      case 'app-runs': result = listAppRuns(config); break;
      case 'app-import-parent': result = await importParentReceipts(config, ledger, option('--run'), input()); break;
      case 'app-append': result = await appendApp(config, ledger, option('--run'), input()); break;
      case 'app-block': result = blockApp(config, ledger, option('--run'), input()); break;
      case 'app-unavailable': result = unavailableApp(ledger, option('--run'), input()); break;
      case 'app-status': result = appStatus(ledger, option('--run')); break;
      case 'app-review': result = appReview(config, ledger, option('--run'), input()); break;
      case 'app-plan-improvement': result = appPlanImprovement(config, ledger, option('--run'), input()); break;
      case 'app-worker': result = appWorker(config, ledger, option('--run'), option('--operation'), input()); break;
      case 'app-ado':
        requireThat(args.includes('--collect'), 'Live ADO reads require explicit --collect');
        result = await collectAppAdo(config, ledger, option('--run'), option('--pass')); break;
      case 'app-ado-reconcile':
        result = await reconcileAppAdo(config, ledger, option('--run'), option('--pass')); break;
      case 'app-workiq-cli':
        requireThat(args.includes('--collect'), 'Live CLI reads require explicit --collect');
        result = await collectCliWorkiq(config, ledger, option('--run'), undefined, option('--pass') ?? 'workiq:created'); break;
      case 'app-workiq-cli-reconcile':
        result = await reconcileCliWorkiq(config, ledger, option('--run'), option('--pass') ?? 'workiq:created'); break;
      case 'app-workiq-continue':
        requireThat(!args.includes('--production'), 'Continuation currently supports collection-only dry runs');
        result = await prepareWorkiqContinuation(config, { fromRunId: option('--from-run'), runId: option('--run'),
          pass: option('--pass') ?? 'workiq:created', additionalBudgetApproved: args.includes('--authorize-additional-budget') }); break;
      case 'app-thread-context':
        result = threadContext(ledger, option('--run'), option('--pass') ?? 'workiq:created'); break;
      case 'doctor':
        result = {
          node: process.version, activation: config.activation, initialWindow: config.window,
          identityConfigured: Boolean(config.identity.designatedUser && config.identity.tenantId && config.identity.objectId),
          workiqSeeds: config.sources.workiq.seeds.length, repositoryMappings: config.repositories.length,
          reviewMethod: config.reviewMethod, scheduleEnabled: config.schedule.enabled,
          icm: 'Offline connector receipt replay and owner export supported. Live connector execution is not enabled; exact timestamp/saved-query scope contract required.',
          validation: 'Fixed configured repo-native runners in isolated task workspaces; none assumed from repository names.',
          liveAccessVerified: false
        };
        break;
      case 'runtime-smoke': result = await smokeRuntime(config, process.cwd()); break;
      case 'dry-run': result = await dryRun(config, {
        collectRequested: args.includes('--collect'), authRefreshed: args.includes('--auth-refreshed')
      }); break;
      case 'auth-check': {
        result = [];
        if (!option('--source') || option('--source') === 'workiq') try {
          await withWorkiq(config, async read => verifyPrincipal(config, await read(principalPath)));
          result.push({ source: 'workiq', state: 'authenticated', principalMatched: true, evidenceAccessVerified: false });
        } catch (error) { result.push({ source: 'workiq', state: 'blocked', error: safeError(error) }); }
        if (!option('--source') || option('--source') === 'ado') try {
          const request = await adoTransport(config);
          await request('wiql', { query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'OC' AND [System.Id] = 0" });
          result.push({ source: 'ado', state: 'authenticated', principalMatched: true, evidenceAccessVerified: false });
        } catch (error) { result.push({ source: 'ado', state: 'blocked', error: safeError(error) }); }
        if (!option('--source') || option('--source') === 'icm')
          result.push({ source: 'icm', state: 'blocked', error: { code: 'blocked-scope',
            message: 'No IcM authentication call made. Live connector execution is not enabled; timestamp/saved-query scope contract required.' } });
        break;
      }
      case 'status': result = ledger.status(); break;
      case 'workspace-gc':
        result = await cleanupWorkspaces(config, ledger, { execute: args.includes('--execute') });
        break;
      case 'collect': result = await collect(config, ledger); break;
      case 'run': result = await runOnce(config, ledger); break;
      case 'review':
        requireThat(option('--file'), 'review requires --file');
        result = acceptReview(config, ledger, readJson(resolve(option('--file')))); break;
      case 'review-pending': result = await reviewPending(config, ledger); break;
      case 'plan-improvement': result = planImprovement(ledger, input()); break;
      case 'qualify-skill': {
        requireThat(option('--repo') && option('--capability'), 'qualify-skill requires --repo and --capability');
        result = await qualifyRepositorySkill(config, option('--repo'), option('--capability'), option('--binding'));
        ledger.qualify(skillQualificationId(result.repoId, result.bindingId), result);
        break;
      }
      case 'submit-reviewed-handoff': {
        requireThat(args.includes('--prepare') !== args.includes('--execute'),
          `${action} requires exactly one of --prepare or --execute`);
        const handoff = input();
        const handoffOptions = {
          execute: args.includes('--execute'),
          authorizeSynthetic: args.includes('--authorize-synthetic'),
          authorizeCommit: args.includes('--authorize-commit'),
          authorizePush: args.includes('--authorize-push'),
          authorizeDraftPR: args.includes('--authorize-draft-pr')
        };
        result = await acceptReviewedHandoff(config, ledger, handoff, {
          ...handoffOptions,
          source: 'submit-reviewed-handoff'
        });
        break;
      }
      case 'submit-filter-handoff': {
        requireThat(args.includes('--prepare') !== args.includes('--execute'),
          `${action} requires exactly one of --prepare or --execute`);
        result = await acceptFilterProposerHandoff(config, ledger, input(), {
          execute: args.includes('--execute'),
          authorizeCommit: args.includes('--authorize-commit'),
          authorizePush: args.includes('--authorize-push'),
          authorizeDraftPR: args.includes('--authorize-draft-pr')
        });
        break;
      }
      case 'dispatch': result = await route(config, ledger, option('--intent') ?? 'rca-only'); break;
      case 'report': result = report(ledger); break;
      case 'reconcile': result = reconcile(ledger); break;
      case 'recover-lock':
        requireThat(option('--name') && option('--owner'), 'Exact lock name and owner are required');
        ledger.recoverLock(option('--name'), option('--owner')); result = { recovered: option('--name') }; break;
      case 'unblock-source':
        requireThat(option('--source'), 'Exact source:lane key is required');
        ledger.unblockSource(option('--source'), option('--reason')); result = { unblocked: option('--source') }; break;
      case 'tick': result = await tick(config, ledger); break;
      case 'serve': {
        requireThat(config.schedule.enabled, 'Schedule is disabled');
        nextDailyWake(config.schedule);
        let stopped = false;
        process.once('SIGINT', () => { stopped = true; });
        process.once('SIGTERM', () => { stopped = true; });
        while (!stopped) {
          const current = configAt(resolve(configFile));
          if (!current.schedule.enabled) break;
          const until = nextDailyWake(current.schedule).getTime();
          while (!stopped && Date.now() < until) await new Promise(done => setTimeout(done, Math.min(1000, until - Date.now())));
          if (stopped) break;
          const refreshed = configAt(resolve(configFile));
          if (!refreshed.schedule.enabled) break;
          try { console.log(JSON.stringify(await tick(refreshed, ledger))); }
          catch (error) { console.error(JSON.stringify(safeError(error))); process.exitCode = 2; break; }
        }
        result = { state: 'stopped' }; break;
      }
      default: throw new Error(`Unknown command: ${action}`);
    }
    console.log(JSON.stringify(result, null, 2));
    if (failedOutcome(result)) process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify(safeError(error), null, 2));
  process.exitCode = 1;
} finally { ledger?.close(); }
