import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';

export const reviewHash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const normalized = (path) => {
  const value = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
};

/** Stable identity is independent of batch order, prose, and changing source hashes. */
export function reviewFinding(root, { kind, document = null, reason = 'source-changed', fingerprint, keys = [], title = '', dependencies = null }) {
  const coverage = kind.startsWith('coverage');
  const need = coverage ? kind : null;
  const sourceKey = (key) => coverage ? relative(root, fingerprint.sourcePaths[key]).replace(/\\/g, '/') : key;
  const sources = keys.map((key) => ({ key: sourceKey(key), path: fingerprint.sourcePaths[key], fingerprint: fingerprint.sources[key] }))
    .filter((source) => source.path && typeof source.fingerprint === 'string').sort((a, b) => a.key.localeCompare(b.key));
  const allSources = Object.entries(fingerprint.sources).map(([key, value]) => ({ key: sourceKey(key), path: fingerprint.sourcePaths[key], fingerprint: value }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const target = document ? normalized(document) : sources.map((source) => normalized(source.path)).sort();
  if (coverage) kind = 'coverage';
  const id = reviewHash([kind, target]);
  // All covered sources participate: a sibling changing during a pending review creates a
  // new revision too, while identical batches in a different order remain the same work.
  const revision = reviewHash([allSources.map((source) => [source.key, source.fingerprint]), fingerprint.markers || [], dependencies]);
  return { id, revision, kind, reason, document: document ? relative(root, document).replace(/\\/g, '/') : null,
    title, sources, allSources, sourceDigest: fingerprint.digest, dependencies, ...(need ? { needs: [need] } : {}) };
}

export function completeItemsWithinBudget(items, render, budget) {
  const selected = [];
  for (const item of items) {
    if (render([...selected, item]).length <= budget) selected.push(item);
  }
  return selected;
}
