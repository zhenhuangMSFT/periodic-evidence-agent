import { json } from './common.js';

const prefix = 'PILOT_VALIDATION_AUTH_PREFLIGHT:';
const reasons = new Set(['provider-missing', 'interactive-sign-in-required']);

export function parseValidationAuthPreflight(output, contract) {
  const line = String(output?.stdout ?? '').split(/\r?\n/)
    .find(value => value.startsWith(prefix));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    const allowed = value?.state === 'ready'
      ? ['feedCount', 'provider', 'providerVersion', 'state', 'tokenRecorded']
      : ['feedCount', 'installProvider', 'provider', 'providerVersion', 'reason',
        'state', 'tokenRecorded'];
    if (!value || json(Object.keys(value).sort()) !== json(allowed.sort()) ||
      value.provider !== contract.provider ||
      value.providerVersion !== contract.providerVersion ||
      value.feedCount !== contract.feeds.length ||
      value.tokenRecorded !== false) return null;
    if (value.state === 'ready') return value;
    return value.state === 'action-required-auth' &&
      reasons.has(value.reason) &&
      value.installProvider === (value.reason === 'provider-missing') ? value : null;
  } catch {
    return null;
  }
}

export function validationAuthAction(gate, repo, preflight, controllerRoot) {
  const args = [
    'run', 'setup:validation-auth', '--',
    '-Workspace', repo.referenceCheckout
  ];
  if (preflight.installProvider) args.push('-InstallProvider');
  return {
    state: 'action-required-auth',
    code: 'validation-authentication-required',
    gateId: gate.id,
    repoId: repo.id,
    reason: preflight.reason,
    provider: preflight.provider,
    providerVersion: preflight.providerVersion,
    feedCount: preflight.feedCount,
    requiresUserInteraction: true,
    requiresInstallApproval: preflight.installProvider,
    remediation: {
      cwd: controllerRoot,
      command: 'npm',
      args
    },
    retryPolicy: 'retry-original-command-once-after-successful-remediation',
    tokenRequested: false
  };
}
