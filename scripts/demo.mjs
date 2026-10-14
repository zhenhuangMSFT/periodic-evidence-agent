import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAt } from '../src/common.js';
import { beginApp, openApp, appendApp, unavailableApp, appStatus, listAppRuns } from '../src/app-native.js';
import { principalPath, channelRoot, messageSelect } from '../src/runtime.js';
import { area, wiql } from '../src/sources.js';
import { runDemoStages } from './demo-stages.mjs';

// Fixed fixtures use the offline receipt importer, never a transport or SDK client.
const config = configAt(fileURLToPath(new URL('../pilot.example.json', import.meta.url)));
assert.deepEqual(config.activation, { collect: false, review: false, dispatch: false });
assert.equal(config.schedule.enabled, false);
assert.match(config.identity.designatedUser, /@example\.invalid$/);
if (process.platform === 'win32')
  assert.ok(process.env.PATHEXT?.split(';').some(value => value.toLowerCase() === '.exe'),
    'The Windows demo requires PATHEXT including .EXE so native validation actually runs');
globalThis.fetch = () => { throw new Error('Network calls are forbidden in the synthetic demo'); };
const stateRoot = resolve('.state');
mkdirSync(stateRoot, { recursive: true });
config.stateDirectory = mkdtempSync(join(stateRoot, 'demo-'));
// Child Git commands must not inherit credentials, hooks, signing or non-file transports.
for (const key of Object.keys(process.env)) if (/^GIT_/i.test(key)) delete process.env[key];
const gitConfig = join(config.stateDirectory, 'empty.gitconfig');
writeFileSync(gitConfig, '');
const home = join(config.stateDirectory, 'tool-home');
const appData = join(home, 'AppData', 'Roaming'), localAppData = join(home, 'AppData', 'Local');
mkdirSync(appData, { recursive: true });
mkdirSync(localAppData, { recursive: true });
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: 'file', HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData
});
config.statePolicy.accessApproved = true;
config.sources.ado = { enabled: true, scopeApproved: true };
config.sources.workiq.enabled = true;
config.sources.workiq.scopeApproved = true;
const runId = 'synthetic-demo';
const date = '2026-10-09T01:00:00Z';
const configPath = join(config.stateDirectory, 'demo-config.json');
writeFileSync(configPath, JSON.stringify(config, null, 2));
beginApp(config, { runId, dryRun: true, provenance: 'synthetic' });
let ledger = openApp(config, runId).ledger;
try {
  for (const lane of ['created', 'changed']) {
    const pass = `ado:${lane}`;
    const calls = [
      { endpoint: 'wiql', body: { query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'OC' AND [System.Id] = 0" },
        response: { asOf: date, workItems: [] } },
      { endpoint: 'wiql', body: { query: wiql(config.window, lane, date) },
        response: { asOf: date, workItems: [{ id: 1 }] } },
      { endpoint: 'workitemsbatch', body: { ids: [1], asOf: date, errorPolicy: 'Fail', $expand: 'Relations' },
        response: { value: [{ id: 1, rev: 1, fields: {
          'System.WorkItemType': 'Bug', 'System.Title': 'Synthetic demo record',
          'System.AreaPath': area, 'System.State': 'Active',
          'System.CreatedDate': '2026-10-08T01:00:00Z', 'System.ChangedDate': '2026-10-08T02:00:00Z'
        } }] } }
    ].map((c, i) => ({ id: `demo-ado-${lane}-${i}`, observedAt: date, tool: 'ado-delegated-read',
      request: { endpoint: c.endpoint, body: c.body }, response: c.response }));
    await appendApp(config, ledger, runId, { eventId: `demo-ado-${lane}`, pass, calls,
      principal: { objectId: config.identity.objectId, tenantId: config.identity.tenantId,
        userPrincipalName: config.identity.designatedUser, verifiedAt: date, toolCallId: 'synthetic-principal' } });
  }
  const root = channelRoot(config.sources.workiq.seeds[0]);
  const query = `?$select=${messageSelect}&$top=50`;
  const call = (id, path, data) => ({ id, observedAt: date, tool: 'workiq-fetch',
    request: { entityUrls: [path] }, response: { results: [{ statusCode: 200, data }] } });
  const message = (id, createdDateTime) => ({ id, createdDateTime, lastModifiedDateTime: createdDateTime,
    webUrl: `https://example.invalid/messages/${id}`, body: { contentType: 'text', content: 'Synthetic demo only' } });
  const batch = { eventId: 'demo-roots', pass: 'workiq:created', calls: [
    call('demo-me', principalPath, { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser }),
    call('demo-page', root + query, { value: [
      message('old-root', '2026-10-07T01:00:00Z'), message('new-root', '2026-10-08T02:00:00Z')
    ] })
  ] };
  const partial = await appendApp(config, ledger, runId, batch);
  assert.equal(partial.collection.find(p => p.pass === 'workiq:created').state, 'partial');
  assert.equal(ledger.cursor('app:workiq:created'), null);
  await appendApp(config, ledger, runId, batch);
  assert.equal(ledger.all('evidence').length, 2);
  await appendApp(config, ledger, runId, { eventId: 'demo-replies', pass: 'workiq:created', calls: [
    call('demo-old-replies', `${root}/old-root/replies${query}`, { value: [message('reply', '2026-10-08T03:00:00Z')] }),
    call('demo-new-replies', `${root}/new-root/replies${query}`, { value: [] })
  ] });
  unavailableApp(ledger, runId, { pass: 'icm:created', reason: 'no-approved-connector' });
  ledger.close();
  ledger = null;
  assert.equal(listAppRuns(config).runs.length, 1);
  ledger = openApp(configAt(configPath), runId).ledger;
  const status = appStatus(ledger, runId);
  const expected = [
    { pass: 'ado:created', state: 'complete', evidenceCount: 1 },
    { pass: 'ado:changed', state: 'complete', evidenceCount: 1 },
    { pass: 'workiq:created', state: 'complete', evidenceCount: 2 },
    { pass: 'icm:created', state: 'unavailable', evidenceCount: null }
  ];
  const passes = status.collection.map(({ pass, state, evidenceCount }) => ({ pass, state, evidenceCount }));
  assert.deepEqual(passes, expected);
  assert.equal(status.state, 'partial-or-blocked');
  assert.ok(ledger.all('evidence').every(e => e.source.provenance === 'synthetic'));
  assert.equal(ledger.all('evidence').length, 3);
  for (const pass of expected.slice(0, 3)) assert.ok(ledger.cursor(`app:${pass.pass}`));
  assert.equal(ledger.cursor('app:icm:created'), null);
  assert.equal(ledger.all('investigation').length, 0);
  assert.equal(ledger.status().jobs.length, 0);
  assert.equal(ledger.status().operations.length, 0);
  assert.equal(status.workers.length, 0);
  assert.equal(status.productionLedgerTouched, false);
  assert.equal(status.scheduleEnabledByHelper, false);
  assert.equal(status.modelCallsByHelper, 0);
  assert.equal(status.nativeSessionLaunchesByHelper, 0);
  assert.equal(status.sourceWritesByHelper, 0);
  const workflow = await runDemoStages(config,
    [{ ledgerPath: join(ledger.directory, 'ledger.sqlite'), runId }]);
  console.log(JSON.stringify({ result: 'synthetic-demo-passed', provenance: 'synthetic', passes,
    uniqueEvidence: 3, overallCollectionState: status.state, collectionWorkers: 0, scheduleEnabled: false,
    stateDirectory: config.stateDirectory, configPath, summaryPath: status.summaryPath,
    workflow }, null, 2));
} finally {
  ledger?.close();
}
