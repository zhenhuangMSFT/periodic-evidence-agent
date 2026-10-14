import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, requireThat } from './common.js';

const exec = promisify(execFile);
const supervisor = fileURLToPath(new URL('./native-command.ps1', import.meta.url));

export function nativeTemporaryDirectory(stateDirectory, key) {
  const path = join(stateDirectory, 'nt', hash(key).slice(0, 24));
  requireThat(process.platform !== 'win32' || path.length <= 180,
    'Native TEMP needs a shorter private stateDirectory for Windows Node compile-cache paths',
    'blocked-validation');
  return path;
}

export async function nativeCommand(executable, args, cwd, timeout, env) {
  const options = { cwd, env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' };
  if (process.platform !== 'win32') return exec(executable, args, options);
  const pathExt = Object.entries(env ?? {}).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1];
  requireThat(typeof pathExt === 'string' && pathExt.split(';').some(value => value.toUpperCase() === '.EXE'),
    'Native validation requires PATHEXT including .EXE; restore the host environment before retrying',
    'blocked-native-environment');
  const host = /^pwsh(?:\.exe)?$/i.test(basename(executable)) ? executable : 'pwsh.exe';
  return exec(host,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', supervisor], {
      ...options,
      env: { ...env, PILOT_NATIVE_COMMAND: JSON.stringify({ executable, args }) }
    });
}
