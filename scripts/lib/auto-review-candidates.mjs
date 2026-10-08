// Files without context coverage are weaker review candidates than stale, existing documents.
// Keep them in a local repeat signal and only auto-review sibling groups or recurring sources.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { statePath } from './roots.mjs';
import { transactState } from './state-store.mjs';

const FILE = '.auto-review-candidates.json';
const FORMAT = 1;
const TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 3000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedFile(file) {
  const value = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Keep one-off uncovered files in the health report. Auto-review them only when at least two
 * siblings changed together or the same source recurs in a different session within 90 days.
 * Stored identifiers are hashes; project paths and source text never enter the candidate ledger.
 */
export function selectAutomaticReviewCandidates(root, repoPath, files, sessionId, now = Date.now(), onIssue = null) {
  const candidates = [...new Set((Array.isArray(files) ? files : []).map(normalizedFile).filter(Boolean))];
  if (!candidates.length) return [];

  const siblings = new Map();
  for (const file of candidates) {
    const slash = file.lastIndexOf('/');
    const parent = slash < 0 ? '' : file.slice(0, slash);
    if (!parent) continue;
    const group = siblings.get(parent) || [];
    group.push(file);
    siblings.set(parent, group);
  }
  const selected = new Set([...siblings.values()].filter((group) => group.length > 1).flat());

  const sid = typeof sessionId === 'string' && sessionId ? sha256(sessionId) : null;
  const result = transactState(statePath(root, FILE), () => ({ format: FORMAT, entries: {} }), (state) => {
    if (state.format !== FORMAT || !state.entries) throw new Error('invalid candidate state');
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!entry || !Number.isFinite(entry.lastSeen) || now - entry.lastSeen > TTL_MS) {
        delete state.entries[key];
      }
    }

    const resolvedRepo = process.platform === 'win32' ? resolve(repoPath).toLowerCase() : resolve(repoPath);
    for (const file of candidates) {
      const key = sha256(`${resolvedRepo}\0${file}`);
      const previous = state.entries[key];
      const sessions = Array.isArray(previous?.sessions) ? previous.sessions.filter((value) => typeof value === 'string') : [];
      if (sid && sessions.some((value) => value !== sid)) selected.add(file);
      if (!sid || sessions.includes(sid)) {
        if (previous && previous.lastSeen !== now) {
          previous.lastSeen = now;
        }
        continue;
      }
      state.entries[key] = { sessions: [...sessions, sid].slice(-2), lastSeen: now };
    }

    const entries = Object.entries(state.entries);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].lastSeen - a[1].lastSeen);
      state.entries = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
    }
    return candidates.filter((file) => selected.has(file));
  });
  if (!result.ok) onIssue?.({ kind: 'candidate-state-unavailable', reason: result.reason });
  return result.ok ? result.value : [];
}
