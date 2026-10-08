// Explicit tool events, latest confirmed writer, and project-wide overlap detection.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { loadConfig, resolveExtraRepos, statePath } from './roots.mjs';
import { readState, transactState } from './state-store.mjs';

const RETENTION_MS = 90 * 86400000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 128 * 1024 * 1024;
const MAX_STOP_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 30000;
const MAX_EVENTS = 4000;
const explicitTools = new Set(['apply_patch', 'Edit', 'Write']);
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const keyPath = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const ledgerPath = (root) => statePath(root, '.session-write-journal', 'index.json');
const initial = () => ({ format: 2, sequence: 0, sessions: {}, owners: {}, pending: {}, events: {} });
const validLedger = (state) => state?.format === 2 && Number.isFinite(state.sequence)
  && ['sessions', 'owners', 'pending', 'events'].every((key) => state[key] && typeof state[key] === 'object' && !Array.isArray(state[key]))
  && Object.values(state.pending).every((pending) => pending && Array.isArray(pending.files) && pending.files.every((file) => typeof file?.path === 'string'))
  && Object.values(state.owners).every((owner) => owner && typeof owner.path === 'string' && typeof owner.session === 'string');
const within = (parent, candidate) => {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Only the project and declared extraRepos; revalidate real paths at capture and Stop. */
export function safeEditTarget(root, inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim() || inputPath.length > 2048 || inputPath.includes('\0')) return null;
  const candidate = resolve(root, inputPath);
  const allowed = [resolve(root), ...resolveExtraRepos(root, loadConfig(root)).map((repo) => repo.path || repo)];
  const parent = allowed.find((path) => candidate !== resolve(path) && within(path, candidate));
  if (!parent) return null;
  try {
    let existing = candidate;
    const suffix = [];
    while (!existsSync(existing)) {
      const up = dirname(existing);
      if (up === existing) return null;
      suffix.unshift(basename(existing));
      existing = up;
    }
    const actual = resolve(realpathSync(existing), ...suffix);
    const realParent = realpathSync(parent);
    if (!within(realParent, actual) || actual === realParent) return null;
    if (existsSync(candidate) && !statSync(candidate).isFile()) return null;
    return candidate;
  } catch { return null; }
}

/** Declarative marker for tracked-edit, never infer edit paths from arbitrary shell code. */
export function decodeEditManifest(command) {
  if (typeof command !== 'string' || !/(?:^|[\\/\s"'])tracked-edit\.mjs(?:["']?\s)/.test(command)) return null;
  const matches = [...command.matchAll(/(?:^|\s)--context-tools-edit=([A-Za-z\d_-]+)(?=\s|$)/g)];
  if (matches.length !== 1 || matches[0][1].length > 32768) return null;
  try {
    const value = JSON.parse(Buffer.from(matches[0][1], 'base64url').toString('utf8'));
    if (value?.version !== 1 || !Array.isArray(value.files) || !value.files.length || value.files.length > 2000
      || value.files.some((path) => typeof path !== 'string' || path.length > 2048)) return null;
    return [...new Set(value.files)];
  } catch { return null; }
}

function inputPaths(event) {
  const name = event?.tool_name;
  const input = event?.tool_input;
  if (name === 'Bash') return decodeEditManifest(input?.command);
  if (!explicitTools.has(name)) return null;
  const paths = new Set();
  if (name === 'apply_patch' && typeof input?.command === 'string') {
    for (const match of input.command.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+?)\s*$/gm)) paths.add(match[1]);
  }
  for (const field of ['file_path', 'filePath', 'path', 'filename']) {
    if (typeof input?.[field] === 'string') paths.add(input[field]);
  }
  return paths.size <= 2000 ? [...paths] : [];
}

function fileHash(path) {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return { error: 'hash-size-limit' };
    return { hash: `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`, bytes: info.size };
  } catch (error) {
    return error.code === 'ENOENT' ? { hash: 'missing', bytes: 0 } : { error: 'source-unavailable' };
  }
}

function failed(value, depth = 0) {
  if (depth > 4 || value == null) return false;
  if (typeof value === 'string') return /^\s*(?:error|failed|failure|rejected|cancelled|denied)(?:\b|:)/i.test(value);
  if (typeof value !== 'object') return false;
  if (value.isError === true || value.success === false || (typeof value.exit_code === 'number' && value.exit_code !== 0)
    || /^(?:error|failed|cancelled|denied)$/i.test(value.status || '')) return true;
  return Object.entries(value).some(([key, item]) => (key.toLowerCase() === 'error' && item != null && item !== false && item !== '') || failed(item, depth + 1));
}

function prune(state, now) {
  for (const [key, event] of Object.entries(state.events)) if (now - event.at > RETENTION_MS) delete state.events[key];
  for (const [key, owner] of Object.entries(state.owners)) if (now - owner.at > RETENTION_MS) delete state.owners[key];
  for (const [key, session] of Object.entries(state.sessions)) if (now - session.lastSeenAt > RETENTION_MS) delete state.sessions[key];
  for (const [key] of Object.entries(state.events).sort((a, b) => b[1].at - a[1].at).slice(MAX_EVENTS)) delete state.events[key];
  for (const [key, pending] of Object.entries(state.pending)) {
    if (now - pending.at <= 3600000) continue;
    for (const file of pending.files) delete state.owners[keyPath(resolve(state.root, file.path))];
    state.events[key] = { at: now, session: pending.session, status: 'abandoned-tool' };
    delete state.pending[key];
  }
}

export function recordSessionWriteEvent(root, event, action) {
  const sessionId = event?.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim()) return { status: 'missing-session' };
  const session = hash(sessionId);
  const paths = action === '--session-start' ? null : inputPaths(event);
  if (action !== '--session-start' && paths === null) return { status: 'ignored-tool' };
  const toolId = event?.tool_use_id;
  if (action !== '--session-start' && (typeof toolId !== 'string' || !toolId)) return { status: 'missing-id' };
  const tool = toolId ? hash(`${sessionId}\0${toolId}`) : null;
  const result = transactState(ledgerPath(root), initial, (state) => {
    if (!validLedger(state)) throw new Error('unsupported or invalid journal format');
    state.root = resolve(root);
    prune(state, Date.now());
    if (action === '--session-start') {
      state.sessions[session] = { epoch: randomUUID(), startedAt: Date.now(), lastSeenAt: Date.now(), latestTurn: null, consumedThrough: 0 };
      return { status: 'ready' };
    }
    const marker = state.sessions[session];
    if (!marker) return { status: 'not-initialized' };
    marker.lastSeenAt = Date.now();
    if (state.events[tool]) return { status: 'already-recorded' };
    const turn = typeof event.turn_id === 'string' && event.turn_id ? hash(event.turn_id) : marker.epoch;
    if (action === '--pre-tool-use') {
      if (state.pending[tool]) return { status: 'already-recorded' };
      const files = [];
      let bytes = 0;
      for (const input of paths) {
        const path = safeEditTarget(root, input);
        if (!path) continue;
        const before = fileHash(path);
        bytes += before.bytes || 0;
        if (before.error || bytes > MAX_EVENT_BYTES) {
          state.events[tool] = { at: Date.now(), session, status: before.error || 'hash-size-limit' };
          return { status: before.error || 'hash-size-limit' };
        }
        files.push({ path: relative(root, path).split(sep).join('/'), beforeHash: before.hash });
      }
      if (!files.length) {
        state.events[tool] = { at: Date.now(), session, status: 'no-readable-targets' };
        return { status: 'no-readable-targets' };
      }
      const pending = { session, turn, epoch: marker.epoch, at: Date.now(), files, ambiguous: false };
      const targets = new Set(files.map((file) => keyPath(resolve(root, file.path))));
      for (const other of Object.values(state.pending)) {
        if (other.files.some((file) => targets.has(keyPath(resolve(root, file.path))))) {
          pending.ambiguous = true;
          other.ambiguous = true;
        }
      }
      state.pending[tool] = pending;
      marker.latestTurn = turn;
      return { status: 'captured', files: files.length };
    }
    if (action !== '--post-tool-use') return { status: 'unknown-action' };
    const snapshot = state.pending[tool];
    if (!snapshot || snapshot.session !== session) {
      for (const input of paths) {
        const path = safeEditTarget(root, input);
        if (path) delete state.owners[keyPath(path)];
      }
      state.events[tool] = { at: Date.now(), session, status: 'pre-tool-snapshot-missing' };
      return { status: 'no-pre-tool-snapshot' };
    }
    const changed = [];
    let bytes = 0;
    let reason = snapshot.ambiguous ? 'overlapping-edits' : event.tool_response == null ? 'tool-response-missing' : failed(event.tool_response) ? 'failed-tool' : null;
    for (const file of snapshot.files) {
      const path = safeEditTarget(root, file.path);
      const after = path ? fileHash(path) : { error: 'source-unavailable' };
      bytes += after.bytes || 0;
      if (after.error || bytes > MAX_EVENT_BYTES) reason ||= after.error || 'hash-size-limit';
      if (after.hash !== file.beforeHash) changed.push({ ...file, afterHash: after.hash });
    }
    if (Object.keys(state.owners).length + changed.length > MAX_FILES) reason ||= 'file-limit';
    if (reason) {
      for (const file of snapshot.files) delete state.owners[keyPath(resolve(root, file.path))];
    } else {
      for (const file of changed) state.owners[keyPath(resolve(root, file.path))] = {
        ...file, session, turn: snapshot.turn, epoch: snapshot.epoch, sequence: ++state.sequence, at: Date.now(),
      };
    }
    const status = reason || (changed.length ? 'recorded' : 'unchanged');
    state.events[tool] = { session, at: Date.now(), status, files: changed.length };
    delete state.pending[tool];
    return { status, files: reason ? 0 : changed.length };
  });
  return result.ok ? result.value : { status: result.reason, code: result.code };
}

export function sessionWriteFiles(root, repoPath, sessionId, { turnId = process.env.CONTEXT_TOOLS_TURN_ID } = {}) {
  if (!sessionId) return null;
  const loaded = readState(ledgerPath(root), initial);
  if (!loaded.ok || !validLedger(loaded.value)) return null;
  const session = hash(sessionId);
  const marker = loaded.value.sessions[session];
  if (!marker) return null;
  const turn = turnId ? hash(turnId) : marker.latestTurn;
  const result = [];
  const inFlight = new Set(Object.values(loaded.value.pending).flatMap((pending) => pending.files.map((file) => keyPath(resolve(root, file.path)))));
  let bytes = 0;
  for (const owner of Object.values(loaded.value.owners)) {
    if (owner.session !== session || owner.epoch !== marker.epoch || owner.turn !== turn
      || owner.sequence <= marker.consumedThrough || Date.now() - owner.at > RETENTION_MS) continue;
    const path = safeEditTarget(root, owner.path);
    if (!path || !within(repoPath, path) || inFlight.has(keyPath(path))) continue;
    const current = fileHash(path);
    bytes += current.bytes || 0;
    if (current.error || bytes > MAX_STOP_BYTES) return null;
    if (current.hash === owner.afterHash) result.push(relative(repoPath, path).split(sep).join('/'));
  }
  return [...new Set(result)].sort();
}

export function consumeSessionWrites(root, sessionId, { turnId = process.env.CONTEXT_TOOLS_TURN_ID } = {}) {
  if (!sessionId) return { ok: false, reason: 'missing-session' };
  return transactState(ledgerPath(root), initial, (state) => {
    const session = hash(sessionId);
    const marker = state.sessions[session];
    if (!marker) return 0;
    const turn = turnId ? hash(turnId) : marker.latestTurn;
    const sequences = Object.values(state.owners).filter((owner) => owner.session === session && owner.epoch === marker.epoch && owner.turn === turn).map((owner) => owner.sequence);
    marker.consumedThrough = Math.max(marker.consumedThrough, ...sequences);
    return sequences.length;
  });
}

export function sessionWriteJournalDiagnostics(root, sessionId) {
  const empty = { editEvents: 0, observedFiles: 0, currentMatches: 0, pendingEvents: 0, skippedEvents: 0, skippedReasons: {} };
  if (!sessionId) return { status: 'no-session-id', ...empty };
  const loaded = readState(ledgerPath(root), initial);
  if (!loaded.ok) return { status: loaded.reason, ...empty };
  if (!validLedger(loaded.value)) return { status: 'unsupported-state', ...empty };
  const session = hash(sessionId);
  if (!loaded.value.sessions[session]) return { status: 'not-initialized', ...empty };
  const marker = loaded.value.sessions[session];
  const events = Object.values(loaded.value.events).filter((event) => event.session === session && event.at >= marker.startedAt);
  const reasons = {};
  for (const event of events) if (!['recorded', 'unchanged'].includes(event.status)) reasons[event.status] = (reasons[event.status] || 0) + 1;
  const current = sessionWriteFiles(root, dirname(resolve(root)), sessionId);
  const own = Object.values(loaded.value.owners).filter((owner) => owner.session === session && owner.epoch === marker.epoch);
  return {
    status: current === null ? 'verification-limited' : Object.keys(reasons).length ? 'incomplete' : 'active',
    editEvents: events.filter((event) => event.status === 'recorded').length,
    observedFiles: own.length,
    currentMatches: current?.length ?? null,
    pendingEvents: Object.values(loaded.value.pending).filter((pending) => pending.session === session).length,
    skippedEvents: Object.values(reasons).reduce((sum, count) => sum + count, 0),
    skippedReasons: reasons,
  };
}
