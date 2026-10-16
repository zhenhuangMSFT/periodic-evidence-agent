import { AzureCliCredential } from '@azure/identity';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PilotError, requireThat } from './common.js';

const resourcePattern = /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[\w.-]+\/providers\/Microsoft\.Logic\/workflows\/[\w-]+$/i;
const guidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function validateNotificationId(id) {
  requireThat(typeof id === 'string' && /^[\w-]{1,100}$/.test(id),
    'Teams notifications require a stable notification ID');
}

export function teamsNotificationReceiptPath(configPath, config, id) {
  validateNotificationId(id);
  requireThat(typeof configPath === 'string' && configPath, 'Teams notifications require a configuration path');
  const directory = config.stateDirectory ?? '.state/teams-notifications';
  requireThat(typeof directory === 'string' && directory.trim() && !directory.includes('\0'),
    'Teams notification stateDirectory must be a nonempty path');
  return resolve(dirname(resolve(configPath)), directory, `${id}.receipt.json`);
}

function validateConfig(config) {
  requireThat(config?.enabled === true, 'Teams notification sending must be explicitly enabled');
  requireThat(resourcePattern.test(config.workflowResourceId), 'Invalid Teams workflow resource ID');
  requireThat(guidPattern.test(config.identity?.tenantId) && guidPattern.test(config.identity?.objectId),
    'Teams notifications require the designated tenant and user identity');
  requireThat(guidPattern.test(config.teamId) && typeof config.channelId === 'string' &&
    /^19:[\w-]+@thread\.tacv2$/.test(config.channelId), 'Invalid Teams destination');
}

export function teamsNotificationCard({ text, test = false, mention }) {
  requireThat(typeof text === 'string' && text.trim() && text.length <= 4000,
    'Teams notification text must contain 1 through 4000 characters');
  requireThat(typeof test === 'boolean', 'Teams notification test marker must be boolean');
  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: `${test ? '[TEST] ' : ''}Periodic Evidence Agent`, weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text, wrap: true }
    ]
  };
  if (mention) {
    requireThat(guidPattern.test(mention.id) && typeof mention.name === 'string' &&
      /^[^<>&\r\n]{1,100}$/.test(mention.name), 'Invalid Teams user mention');
    const tag = `<at>${mention.name}</at>`;
    card.body.push({ type: 'TextBlock', text: tag, wrap: true });
    card.msteams = { entities: [{ type: 'mention', text: tag,
      mentioned: { id: mention.id, name: mention.name } }] };
  }
  return card;
}

export async function teamsArmToken(config, credential) {
  validateConfig(config);
  let access;
  try {
    access = await (credential ?? new AzureCliCredential({
      tenantId: config.identity.tenantId
    })).getToken('https://management.azure.com/.default');
  } catch {
    throw new PilotError('blocked-auth', 'Teams notifications require designated-user Azure CLI sign-in');
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(access?.token?.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    throw new PilotError('blocked-auth', 'Azure CLI returned no readable identity claims');
  }
  requireThat(claims.oid === config.identity.objectId && claims.tid === config.identity.tenantId,
    'Teams notification identity mismatch', 'blocked-auth');
  return access.token;
}

export async function sendTeamsNotification(config, notification, receiptPath, {
  credential, fetchImpl = fetch
} = {}) {
  validateConfig(config);
  validateNotificationId(notification.id);
  const card = teamsNotificationCard(notification);
  requireThat(typeof receiptPath === 'string' && receiptPath, 'Teams notifications require a durable receipt path');
  requireThat(!existsSync(receiptPath), 'Notification already attempted; reconcile its receipt instead of retrying',
    'notification-already-attempted');
  const token = await teamsArmToken(config, credential);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const resourceUrl = `https://management.azure.com${config.workflowResourceId}`;
  const armRequest = async (url, method = 'GET') => {
    const response = await fetchImpl(url, { method, headers, redirect: 'error',
      signal: AbortSignal.timeout(30000) });
    requireThat(response.ok, `Teams workflow lookup failed (HTTP ${response.status})`, 'notification-config-failed');
    return response.json();
  };
  const workflow = await armRequest(`${resourceUrl}?api-version=2019-05-01`);
  const parameters = workflow.properties?.parameters;
  const post = workflow.properties?.definition?.actions?.Post_periodic_agent_card;
  requireThat(workflow.properties?.state === 'Enabled' &&
    parameters?.teamId?.value === config.teamId && parameters?.channelId?.value === config.channelId &&
    post?.inputs?.path?.includes("encodeURIComponent('Flow bot')") &&
    post.inputs.body?.recipient?.groupId === "@parameters('teamId')" &&
    post.inputs.body?.recipient?.channelId === "@parameters('channelId')" &&
    post.inputs.retryPolicy?.type === 'none' &&
    workflow.properties?.accessControl?.triggers?.sasAuthenticationPolicy?.state === 'Disabled',
  'Teams workflow destination, Flow bot identity, retry policy or bearer-only authentication differs from configuration',
  'notification-config-failed');
  const callback = await armRequest(`${resourceUrl}/triggers/When_an_HTTP_request_is_received/listCallbackUrl?api-version=2019-05-01`, 'POST');
  const url = new URL(callback.value);
  requireThat(url.protocol === 'https:' && url.hostname.endsWith('.logic.azure.com') &&
    !url.username && !url.password && !url.hash && !url.port, 'Unexpected Teams workflow callback host');
  for (const key of [...url.searchParams.keys()]) {
    if (['sig', 'sp', 'sv', 'se'].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  mkdirSync(dirname(receiptPath), { recursive: true });
  const record = {
    recordType: 'teams-notification-receipt-v1', notificationId: notification.id,
    teamId: config.teamId, channelId: config.channelId,
    status: 'sending', attemptedAt: new Date().toISOString(), retrySafe: false
  };
  const fd = openSync(receiptPath, 'wx');
  try { writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`); }
  finally { closeSync(fd); }
  try {
    const response = await fetchImpl(url.href, {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ notificationId: notification.id, card })
    });
    const result = await response.json();
    if (typeof result.workflowRunId === 'string') record.workflowRunId = result.workflowRunId;
    requireThat(response.ok && result.status === 'sent' && result.notificationId === notification.id &&
      result.teamId === config.teamId && result.channelId === config.channelId &&
      typeof result.messageId === 'string' && result.messageId.trim(),
    'Teams connector did not confirm this notification; reconcile the workflow run and channel, do not retry',
    'notification-unconfirmed');
    Object.assign(record, { status: 'sent', messageId: result.messageId });
    writeFileSync(receiptPath, `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } catch {
    record.status = 'unknown';
    writeFileSync(receiptPath, `${JSON.stringify(record, null, 2)}\n`);
    throw new PilotError('notification-unconfirmed',
      'Teams delivery is unconfirmed; reconcile the saved receipt, workflow run and channel before any further send');
  }
}
