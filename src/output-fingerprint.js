import {
  closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync,
  readlinkSync, readSync, realpathSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hash } from './hash.js';

const json = JSON.stringify;

const FILE_HASH_BUFFER = Buffer.allocUnsafe(1024 * 1024);

function fileSha256(path, size) {
  if (size <= FILE_HASH_BUFFER.length) return hash(readFileSync(path));
  const digest = createHash('sha256');
  const handle = openSync(path, 'r');
  try {
    let bytesRead;
    while ((bytesRead = readSync(handle, FILE_HASH_BUFFER, 0,
      FILE_HASH_BUFFER.length, null)) > 0)
      digest.update(FILE_HASH_BUFFER.subarray(0, bytesRead));
  } finally {
    closeSync(handle);
  }
  return digest.digest('hex');
}

export function fileContentSha256(path) {
  return fileSha256(path, lstatSync(path).size);
}

function recordEntry(entries, path, value) {
  if (entries) entries.push([path.replaceAll('\\', '/'), value]);
}

function pathFingerprint(root, path, recordedEntries = null) {
  const target = join(root, path);
  if (!existsSync(target)) return null;
  const info = lstatSync(target);
  if (info.isSymbolicLink()) {
    const rawTarget = readlinkSync(target);
    const resolvedTarget = resolve(dirname(target), rawTarget);
    const rootRelative = relative(root, resolvedTarget);
    const value = {
      path, type: 'link',
      target: !rootRelative.startsWith('..') && !isAbsolute(rootRelative)
        ? { rootRelative } : { external: rawTarget }
    };
    recordEntry(recordedEntries, path, {
      type: 'link',
      sha256: hash(json(!rootRelative.startsWith('..') &&
        !isAbsolute(rootRelative)
        ? rootRelative.replaceAll('\\', '/')
        : rawTarget.replaceAll('\\', '/')))
    });
    return value;
  }
  if (info.isFile()) {
    const sha256 = fileSha256(target, info.size);
    recordEntry(recordedEntries, path, { type: 'file', sha256 });
    return { path, type: 'file', sha256 };
  }
  if (!info.isDirectory()) return null;
  const entries = [];
  for (const name of readdirSync(target).sort()) {
    const entry = pathFingerprint(root, join(path, name), recordedEntries);
    if (!entry) return null;
    entries.push(entry);
  }
  recordEntry(recordedEntries, path, {
    type: 'directory', sha256: hash(json(entries))
  });
  return { path, type: 'directory', entries };
}

function dependencyNodeFingerprint(workspace, physicalWorkspace, entryPath, name,
  recordedEntries = null, recordedPath = name) {
  const info = lstatSync(entryPath);
  if (info.isSymbolicLink()) {
    const resolvedTarget = resolve(dirname(entryPath), readlinkSync(entryPath));
    const rootRelative = relative(workspace, resolvedTarget);
    if (rootRelative.startsWith('..') || isAbsolute(rootRelative) ||
      !existsSync(resolvedTarget)) return null;
    let finalTarget;
    try { finalTarget = realpathSync.native(entryPath); }
    catch { return null; }
    const finalRootRelative = relative(physicalWorkspace, finalTarget);
    if (finalRootRelative.startsWith('..') || isAbsolute(finalRootRelative))
      return null;
    const value = {
      name, type: 'link',
      target: rootRelative.replaceAll('\\', '/'),
      resolvedTarget: finalRootRelative.replaceAll('\\', '/')
    };
    recordEntry(recordedEntries, recordedPath, {
      type: 'link', sha256: hash(json(value.target))
    });
    return value;
  }
  if (info.isFile()) {
    const sha256 = fileSha256(entryPath, info.size);
    recordEntry(recordedEntries, recordedPath, { type: 'file', sha256 });
    return { name, type: 'file', size: info.size, sha256 };
  }
  if (!info.isDirectory()) return null;
  const entries = [];
  for (const entry of readdirSync(entryPath, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const value = dependencyNodeFingerprint(workspace, physicalWorkspace,
      join(entryPath, entry.name), entry.name, recordedEntries,
      join(recordedPath, entry.name));
    if (!value) return null;
    entries.push(value);
  }
  const sha256 = hash(json(entries));
  recordEntry(recordedEntries, recordedPath, { type: 'directory', sha256 });
  return { name, type: 'directory', sha256 };
}

function dependencyEntryValue(
  workspace, dependencyPath, dependencyDirectory, entryPath,
  physicalWorkspace = null, entries = null) {
  const target = resolve(dependencyDirectory, entryPath);
  const bounded = relative(dependencyDirectory, target);
  if (!bounded || bounded.startsWith('..') || isAbsolute(bounded) ||
    !existsSync(target)) return null;
  return dependencyNodeFingerprint(
    workspace, physicalWorkspace ?? realpathSync.native(workspace),
    target, basename(target), entries, join(dependencyPath, entryPath));
}

export function dependencyEntryFingerprint(workspace, dependencyPath, entryPath) {
  return dependencyEntryValue(
    workspace, dependencyPath, resolve(workspace, dependencyPath), entryPath);
}

export function dependencyEntryFingerprintWithEntries(
  workspace, dependencyPath, entryPath) {
  const entries = [];
  const value = dependencyEntryValue(
    workspace, dependencyPath, resolve(workspace, dependencyPath), entryPath,
    null, entries);
  return value ? { value, entries } : null;
}

export function dependencyEntriesFingerprint(
  workspace, dependencyPath, entryPaths, captureEntries = false) {
  const dependencyDirectory = resolve(workspace, dependencyPath);
  const physicalWorkspace = realpathSync.native(workspace);
  const values = [];
  const entries = captureEntries ? [] : null;
  for (const entryPath of entryPaths) {
    const value = dependencyEntryValue(
      workspace, dependencyPath, dependencyDirectory, entryPath,
      physicalWorkspace, entries);
    if (!value) return null;
    values.push(value);
  }
  return { value: values, entries };
}

export function dependencyOutputFingerprint(path, entries) {
  const state = entries.find(entry => entry.name === '.yarn-state.yml' &&
    entry.type === 'file');
  return {
    path, type: 'dependency-directory', fingerprintVersion: 2,
    stateSha256: state?.sha256 ?? null,
    manifestSha256: hash(json(entries))
  };
}

function dependencyDirectoryFingerprint(workspace, directory, path) {
  const physicalWorkspace = realpathSync.native(workspace);
  const entries = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const value = dependencyNodeFingerprint(workspace, physicalWorkspace,
      join(directory, entry.name), entry.name);
    if (!value) return null;
    entries.push(value);
  }
  return dependencyOutputFingerprint(path, entries);
}

export function outputPathFingerprint(workspace, path) {
  const target = join(workspace, path);
  if (!existsSync(target) || !lstatSync(target).isDirectory() ||
    !path.replaceAll('\\', '/').endsWith('node_modules'))
    return pathFingerprint(workspace, path);
  return dependencyDirectoryFingerprint(workspace, target, path);
}

export function outputPathFingerprintWithEntries(workspace, path) {
  const target = join(workspace, path);
  const entries = [];
  if (!existsSync(target) || !lstatSync(target).isDirectory() ||
    !path.replaceAll('\\', '/').endsWith('node_modules')) {
    const value = pathFingerprint(workspace, path, entries);
    return value ? { value, entries } : null;
  }
  const physicalWorkspace = realpathSync.native(workspace);
  const values = [];
  for (const entry of readdirSync(target, { withFileTypes: true })
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const value = dependencyNodeFingerprint(
      workspace, physicalWorkspace, join(target, entry.name), entry.name,
      entries, join(path, entry.name));
    if (!value) return null;
    values.push(value);
  }
  const value = dependencyOutputFingerprint(path, values);
  recordEntry(entries, path, {
    type: 'directory', sha256: value.manifestSha256
  });
  return { value, entries };
}
