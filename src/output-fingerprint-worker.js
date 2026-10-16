import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import {
  dependencyEntriesFingerprint, dependencyEntryFingerprint, dependencyEntryFingerprintWithEntries,
  outputPathFingerprint, outputPathFingerprintWithEntries
} from './output-fingerprint.js';

parentPort.on('message', ({
  workspace, index, mode, path, dependencyPath, entryPath, entryPaths, captureEntries,
  measure = false
}) => {
  try {
    const started = performance.now();
    const fingerprint = (mode, entryPath) => {
      const result = captureEntries
        ? mode === 'dependency-entry'
          ? dependencyEntryFingerprintWithEntries(
            workspace, dependencyPath, entryPath)
          : outputPathFingerprintWithEntries(workspace, path)
        : null;
      return captureEntries ? result : {
        value: mode === 'dependency-entry'
          ? dependencyEntryFingerprint(workspace, dependencyPath, entryPath)
          : outputPathFingerprint(workspace, path)
      };
    };
    const result = mode === 'dependency-entries'
      ? dependencyEntriesFingerprint(workspace, dependencyPath, entryPaths, captureEntries)
      : fingerprint(mode, entryPath);
    const valid = result?.value != null;
    const value = valid ? result.value : null;
    const computed = performance.now();
    const serialized = JSON.stringify(value);
    const timing = {
      computeMs: computed - started,
      serializeMs: performance.now() - computed
    };
    parentPort.postMessage({
      index, valid, serialized,
      ...(measure ? { timing } : {}),
      ...(captureEntries
        ? { entries: valid ? result.entries : null }
        : {})
    });
  } catch (error) {
    parentPort.postMessage({ index, error: error.message });
  }
});
