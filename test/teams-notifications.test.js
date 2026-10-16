import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  sendTeamsNotification, teamsNotificationCard, teamsNotificationReceiptPath
} from '../src/teams-notifications.js';

const config = {
  enabled: true,
  workflowResourceId: '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/Fixture/providers/Microsoft.Logic/workflows/periodic-agent',
  identity: {
    tenantId: '22222222-2222-4222-8222-222222222222',
    objectId: '33333333-3333-4333-8333-333333333333'
  },
  teamId: '44444444-4444-4444-8444-444444444444',
  channelId: '19:fixture@thread.tacv2'
};
const notification = { id: 'test-notification', text: 'Fixture delivery check.', test: true,
  mention: { id: config.identity.objectId, name: 'Fixture User' } };
const credential = {
  async getToken() {
    return { token: `fixture.${Buffer.from(JSON.stringify({
      oid: config.identity.objectId, tid: config.identity.tenantId
    })).toString('base64url')}.fixture` };
  }
};

function fixture(t, deliver) {
  const root = mkdtempSync(join(tmpdir(), 'teams-notification-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return Response.json({
      properties: {
        state: 'Enabled',
        parameters: { teamId: { value: config.teamId }, channelId: { value: config.channelId } },
        accessControl: { triggers: { sasAuthenticationPolicy: { state: 'Disabled' } } },
        definition: { actions: { Post_periodic_agent_card: { inputs: {
          path: "/poster/@{encodeURIComponent('Flow bot')}",
          body: { recipient: { groupId: "@parameters('teamId')", channelId: "@parameters('channelId')" } },
          retryPolicy: { type: 'none' }
        } } } }
      }
    });
    if (calls.length === 2) return Response.json({
      value: 'https://fixture.logic.azure.com/workflows/fixture/invoke?api-version=2016-06-01&sig=fixture&sp=run&sv=1'
    });
    return deliver(url, options);
  };
  return { receiptPath: join(root, 'receipt.json'), calls, fetchImpl };
}

test('Teams sender posts one Flow bot card, strips SAS and persists its bound delivery receipt', async t => {
  const f = fixture(t, (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.notificationId, notification.id);
    assert.equal(payload.card.msteams.entities[0].mentioned.id, config.identity.objectId);
    assert.ok(payload.card.body.some(item => item.text === '<at>Fixture User</at>'));
    return Response.json({ status: 'sent', notificationId: notification.id,
      teamId: config.teamId, channelId: config.channelId, messageId: 'fixture-message', workflowRunId: 'fixture-run' });
  });
  const result = await sendTeamsNotification(config, notification, f.receiptPath, { credential, fetchImpl: f.fetchImpl });
  assert.equal(result.status, 'sent');
  assert.equal(result.messageId, 'fixture-message');
  assert.deepEqual(JSON.parse(readFileSync(f.receiptPath, 'utf8')), result);
  const url = new URL(f.calls[2].url);
  assert.equal(url.search, '?api-version=2016-06-01');
  assert.equal(f.calls[2].options.redirect, 'error');
  await assert.rejects(sendTeamsNotification(config, notification, f.receiptPath, {
    credential, fetchImpl: f.fetchImpl
  }), { code: 'notification-already-attempted' });
  assert.equal(f.calls.length, 3);
});

test('Teams sender preserves an ambiguous delivery without retrying or leaking the endpoint', async t => {
  const f = fixture(t, () => { throw new Error('private endpoint and credentials must not escape'); });
  await assert.rejects(sendTeamsNotification(config, notification, f.receiptPath, {
    credential, fetchImpl: f.fetchImpl
  }), error => error.code === 'notification-unconfirmed' && !error.message.includes('credentials'));
  assert.equal(f.calls.length, 3);
  assert.equal(JSON.parse(readFileSync(f.receiptPath, 'utf8')).status, 'unknown');
});

test('Teams sender rejects acceptance without a message ID or with another destination', async t => {
  for (const overrides of [{ messageId: null }, { channelId: 'another-channel' }]) {
    const f = fixture(t, () => Response.json({
      status: 'sent', notificationId: notification.id, teamId: config.teamId,
      channelId: config.channelId, messageId: 'fixture-message', ...overrides
    }));
    await assert.rejects(sendTeamsNotification(config, notification, f.receiptPath, {
      credential, fetchImpl: f.fetchImpl
    }), { code: 'notification-unconfirmed' });
    assert.equal(JSON.parse(readFileSync(f.receiptPath, 'utf8')).status, 'unknown');
    assert.equal(f.calls.length, 3);
  }
});

test('Teams sender blocks a mismatched identity before any HTTP request', async t => {
  const f = fixture(t, () => assert.fail('unexpected send'));
  await assert.rejects(sendTeamsNotification({
    ...config, identity: { ...config.identity, objectId: config.teamId }
  }, notification, f.receiptPath, { credential, fetchImpl: f.fetchImpl }), { code: 'blocked-auth' });
  assert.equal(f.calls.length, 0);
});

test('Teams sender fails closed when live routing differs from the configured channel', async t => {
  const f = fixture(t, () => assert.fail('unexpected send'));
  await assert.rejects(sendTeamsNotification({ ...config, channelId: '19:other@thread.tacv2' },
    notification, f.receiptPath, { credential, fetchImpl: f.fetchImpl }), { code: 'notification-config-failed' });
  assert.equal(f.calls.length, 1);
});

test('Teams cards reject malformed mention markup before any send', () => {
  assert.throws(() => teamsNotificationCard({
    ...notification, mention: { ...notification.mention, name: '<at>unexpected</at>' }
  }), /Invalid Teams user mention/);
});

test('Teams receipt defaults are bound to the selected repository config, not a session working directory', () => {
  const configRoot = resolve(tmpdir(), 'notification-repository');
  assert.equal(teamsNotificationReceiptPath(join(configRoot, 'teams.local.json'), config, notification.id),
    join(configRoot, '.state', 'teams-notifications', `${notification.id}.receipt.json`));
  const sharedState = resolve(tmpdir(), 'approved-shared-notifications');
  for (const checkout of ['reference', 'task-checkout']) {
    assert.equal(teamsNotificationReceiptPath(join(configRoot, checkout, 'teams.local.json'),
      { ...config, stateDirectory: sharedState }, notification.id),
    join(sharedState, `${notification.id}.receipt.json`));
  }
});

test('Teams canonical receipt paths reject traversal IDs and invalid state directories', () => {
  assert.throws(() => teamsNotificationReceiptPath('teams.local.json', config, '../another-task'), /stable notification ID/);
  assert.throws(() => teamsNotificationReceiptPath('teams.local.json',
    { ...config, stateDirectory: '' }, notification.id), /nonempty path/);
});
