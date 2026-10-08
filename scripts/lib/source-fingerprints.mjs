import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { safe, statePath } from './roots.mjs';
import { transactState } from './state-store.mjs';

const STATE_FILE = '.source-fingerprints.json';
const STATE_FORMAT = 1;

function pathKey(path) {
  const absolute = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createFingerprintCache() {
  return { files: new Map(), reads: 0, bytes: 0, hits: 0 };
}

export function fingerprintSources(paths, markers = [], cache = null) {
  const files = {};
  const sources = {};
  const rawSources = {};
  const sourcePaths = {};
  const errors = [];
  for (const entry of paths) {
    const path = pathKey(typeof entry === 'string' ? entry : entry.path);
    const identity = typeof entry === 'string' ? path : String(entry.id || path).replace(/\\/g, '/');
    if (!Object.hasOwn(files, path)) {
      let value = cache?.files.get(path);
      if (value) { if (cache) cache.hits++; }
      else {
        try {
          const size = statSync(path).size;
          if (size > 64 * 1024 * 1024) throw Object.assign(new Error('source exceeds hash budget'), { code: 'HASH_LIMIT' });
          if (cache && cache.bytes + size > 256 * 1024 * 1024) throw Object.assign(new Error('review exceeds hash budget'), { code: 'HASH_BUDGET' });
          const bytes = readFileSync(path);
          value = { hash: hashBytes(bytes) };
          if (cache) { cache.reads++; cache.bytes += bytes.length; }
        } catch (error) {
          value = error.code === 'ENOENT' ? { hash: 'missing' } : { hash: null, error: error.code || 'SOURCE_UNAVAILABLE' };
        }
        cache?.files.set(path, value);
      }
      files[path] = value.hash;
      if (value.error) errors.push({ path, code: value.error });
    }
    rawSources[identity] = files[path];
    sources[identity] = files[path] === null ? null : files[path] === 'missing' ? 'missing' : `sha256:${files[path]}`;
    sourcePaths[identity] = path;
  }
  const stableMarkers = [...new Set([...markers, ...errors.map((error) => `unavailable:${error.path}:${error.code}`)])].sort();
  const digest = `sha256:${hashBytes(Buffer.from(JSON.stringify({ sources: Object.entries(rawSources).sort(), markers: stableMarkers })))}`;
  return { digest, files, sources, sourcePaths, markers: stableMarkers, errors };
}

export function fingerprintSourcesInRoot(root, paths, cache = null) {
  const allowed = [];
  const markers = [];
  for (const path of paths) {
    const checked = checkedSourcePath(root, path);
    if (checked.path) allowed.push({ path: checked.path, id: relative(resolve(root), checked.path).replace(/\\/g, '/') });
    else markers.push(`outside:${String(path)}`);
  }
  return fingerprintSources(allowed, markers, cache);
}

export function fingerprintSourcesInRoots(sources, cache = null) {
  const allowed = [];
  const markers = [];
  for (const source of sources) {
    const checked = checkedSourcePath(source.root, source.path);
    if (checked.path) {
      const id = source.id || relative(resolve(source.root), checked.path).replace(/\\/g, '/');
      allowed.push({ path: checked.path, id });
    }
    else markers.push(`outside:${String(source.path)}`);
  }
  return fingerprintSources(allowed, markers, cache);
}

function checkedSourcePath(root, path) {
  const base = resolve(root);
  const realBase = safe(() => realpathSync(base), base);
  const absolute = resolve(base, path);
  const lexical = relative(base, absolute);
  const real = safe(() => realpathSync(absolute), absolute);
  const resolved = relative(realBase, real);
  const outside = !lexical || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)
    || !resolved || resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved);
  return outside ? { path: null } : { path: absolute };
}

function statePathFor(root) {
  return statePath(root, STATE_FILE);
}

export function loadFingerprintState(root) {
  const stored = safe(() => JSON.parse(readFileSync(statePathFor(root), 'utf8')), null);
  return stored?.format === STATE_FORMAT && stored.entries && typeof stored.entries === 'object'
    ? stored
    : { format: STATE_FORMAT, entries: {} };
}

export function changedFingerprintPaths(previousFiles, currentFiles) {
  const previous = previousFiles && typeof previousFiles === 'object' ? previousFiles : {};
  const all = new Set([...Object.keys(previous), ...Object.keys(currentFiles || {})]);
  return [...all].filter((path) => previous[path] !== currentFiles?.[path]).sort();
}

/**
 * Parse the portable per-source metadata shared by context maps and ai-context documents.
 * Invalid metadata is distinguishable from an absent legacy field so callers can fail closed.
 */
export function parseSourceFingerprints(value) {
  if (value === undefined || value === null || value === '') return { present: false, valid: true, sources: {} };
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return { present: true, valid: false, sources: {} }; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { present: true, valid: false, sources: {} };
  const sources = {};
  for (const [key, digest] of Object.entries(parsed)) {
    if (!key || typeof digest !== 'string' || (digest !== 'missing' && !/^(?:sha256:)?[a-f\d]{64}$/i.test(digest))) {
      return { present: true, valid: false, sources: {} };
    }
    sources[key.replace(/\\/g, '/')] = digest === 'missing' ? digest : `sha256:${digest.replace(/^sha256:/i, '')}`;
  }
  return { present: true, valid: true, sources };
}

/**
 * Compare portable review metadata with the current sources. A local cache is accepted as a
 * legacy baseline only when its aggregate digest is exactly the digest stored by the document.
 */
export function compareReviewedSources(current, metadata, previous = null, legacyDigest = null) {
  const parsed = parseSourceFingerprints(metadata);
  if (!parsed.valid) return { valid: false, complete: false, changed: Object.keys(current.sources || {}) };

  const currentSources = current.sources || {};
  const trustedCache = Boolean(legacyDigest && previous?.digest === legacyDigest);
  const baseline = {};
  for (const [id] of Object.entries(currentSources)) {
    if (Object.hasOwn(parsed.sources, id)) {
      baseline[id] = parsed.sources[id];
      continue;
    }
    if (trustedCache) {
      const path = current.sourcePaths?.[id];
      const cached = previous.sources?.[id] ?? (path ? previous.files?.[path] : undefined);
      if (typeof cached === 'string') baseline[id] = cached === 'missing' || cached.startsWith('sha256:') ? cached : `sha256:${cached}`;
    }
  }

  const changed = Object.keys(currentSources).filter((id) => baseline[id] !== currentSources[id]);
  const removed = Object.keys(parsed.sources).filter((id) => !Object.hasOwn(currentSources, id));
  changed.push(...removed);
  const metadataComplete = parsed.present
    && changed.length === 0
    && Object.keys(parsed.sources).length === Object.keys(currentSources).length;
  return {
    valid: true,
    complete: changed.length === 0 && Object.keys(baseline).length === Object.keys(currentSources).length && !(current.markers?.length),
    metadataComplete,
    changed: [...new Set(changed)].sort(),
    baseline,
    portable: parsed.present,
  };
}

export function rememberFingerprint(state, key, fingerprint) {
  state.entries[key] = { ...fingerprint, at: Date.now() };
}

export function saveFingerprintState(root, state) {
  const destination = statePathFor(root);
  const result = transactState(destination, () => ({ format: STATE_FORMAT, entries: {} }), (latest) => {
    if (latest.format !== STATE_FORMAT || !latest.entries) throw new Error('unsupported fingerprint state');
    for (const [key, entry] of Object.entries(state.entries)) {
      if ((entry?.at || 0) >= (latest.entries[key]?.at || 0)) latest.entries[key] = entry;
    }
    state.entries = { ...latest.entries };
    return true;
  });
  return result.ok;
}

export function fingerprintKey(path) {
  return pathKey(path);
}
