// Structured review lifecycle: per target, per source revision, independent of prompt text.
import { statePath } from './roots.mjs';
import { readState, transactState } from './state-store.mjs';
import { reviewHash } from './review-findings.mjs';
const FILE = '.codex-auto-review-state.json';
const FORMAT = 3;
const RETENTION_MS = 90 * 86400000;
const LEASE_MS = 30 * 60000; // Abandoned work becomes deferred; this never schedules a prompt.
const MAX_ENTRIES = 300;
const initial = () => ({ format: FORMAT, entries: {}, migratedLegacyClaims: 0 });
const file = (root) => statePath(root, FILE);

function migrate(state) {
  if (state.format === FORMAT && state.entries && !Array.isArray(state.entries)) return;
  if (state.format !== 2) throw new Error('unsupported review state');
  state.migratedLegacyClaims = Object.keys(state.entries || {}).length;
  state.format = FORMAT;
  state.entries = {}; // Opaque legacy claims contain no source revision or completion evidence.
}
function prune(state, now) {
  for (const entry of Object.values(state.entries)) {
    if (entry.status === 'claimed' && now - entry.claimedAt >= LEASE_MS) {
      entry.status = 'deferred'; entry.reason = 'abandoned-review'; entry.updatedAt = now;
    }
  }
  for (const [id, entry] of Object.entries(state.entries)) {
    if (entry.status === 'complete' && now - entry.updatedAt >= RETENTION_MS) delete state.entries[id];
  }
}
export function readReviewState(root) {
  const loaded = readState(file(root), initial);
  if (!loaded.ok) return loaded;
  try { migrate(loaded.value); return loaded; }
  catch { return { ok: false, reason: 'unsupported-state' }; }
}

/** Reconcile explicit reviewed evidence. Empty findings never mean that work was completed. */
export function reconcileReviews(root, { findings = [], reviewed = [] }, now = Date.now()) {
  return transactState(file(root), initial, (state) => {
    migrate(state); prune(state, now);
    let completed = 0;
    let capacity = 0;
    const reviewedIds = new Set(reviewed.map((finding) => finding.id));
    for (const finding of reviewed) {
      const existing = state.entries[finding.id];
      if (existing && existing.status !== 'complete') {
        existing.status = 'complete'; existing.completedRevision = finding.revision;
        existing.updatedAt = now; existing.reason = 'verified-metadata'; completed++;
      }
    }
    for (const finding of findings) {
      if (reviewedIds.has(finding.id) || finding.reason === 'digest-sync') continue;
      const previous = state.entries[finding.id];
      if (!previous && Object.keys(state.entries).length >= MAX_ENTRIES) {
        const terminal = Object.values(state.entries).filter((entry) => entry.status === 'complete').sort((a,b) => a.updatedAt-b.updatedAt)[0];
        if (terminal) delete state.entries[terminal.finding.id];
        else { capacity++; continue; }
      }
      if (!previous || previous.finding.revision !== finding.revision) {
        state.entries[finding.id] = { finding, status: 'ready', createdAt: now, updatedAt: now, attempts: 0 };
      } else {
        previous.finding = { ...finding, sources: [...new Map([...previous.finding.sources, ...finding.sources].map((source) => [source.key, source])).values()] };
        previous.updatedAt = now;
      }
    }
    return { completed, capacity };
  });
}

/** Claim only this call's relevant items. Other sessions' backlog remains diagnostic data. */
export function claimReviewFindings(root, findings, { sessionId = '', turnId = '', limit = 3, now = Date.now() } = {}) {
  if (!sessionId) return { ok: false, reason: 'missing-session', findings: [] };
  const result = transactState(file(root), initial, (state) => {
    migrate(state); prune(state, now);
    const selected = [];
    for (const candidate of [...findings].sort((a,b) => (state.entries[a.id]?.createdAt || now) - (state.entries[b.id]?.createdAt || now) || a.id.localeCompare(b.id))) {
      const entry = state.entries[candidate.id];
      if (!entry || entry.finding.revision !== candidate.revision || entry.status !== 'ready') continue;
      if (selected.length >= limit) break;
      entry.status = 'claimed'; entry.claimedAt = now; entry.updatedAt = now;
      entry.ownerSession = reviewHash(sessionId); entry.ownerTurn = turnId ? reviewHash(turnId) : null;
      entry.attemptSourceKeys = candidate.sources.map((source) => source.key);
      entry.attempts++; selected.push({ ...entry.finding, sources: candidate.sources });
    }
    return selected;
  });
  return result.ok ? { ok: true, findings: result.value } : { ...result, findings: [] };
}

export function finishSessionReviews(root, sessionId, now = Date.now()) {
  if (!sessionId) return { ok: false, reason: 'missing-session' };
  return transactState(file(root), initial, (state) => {
    migrate(state); prune(state, now);
    let deferred = 0;
    for (const entry of Object.values(state.entries)) {
      if (entry.status === 'claimed' && entry.ownerSession === reviewHash(sessionId)) {
        entry.status = 'deferred'; entry.reason = 'review-not-confirmed'; entry.updatedAt = now; deferred++;
      }
    }
    return deferred;
  });
}
export function setReviewDisposition(root, id, status, reason = 'manual', expectedRevision = null) {
  if (!['ready', 'deferred', 'complete'].includes(status)) return { ok: false, reason: 'invalid-disposition' };
  return transactState(file(root), initial, (state) => {
    migrate(state);
    const entry = state.entries[id];
    if (!entry) throw new Error('unknown review id');
    if (expectedRevision && entry.finding.revision !== expectedRevision) throw new Error('review revision changed');
    entry.status = status; entry.reason = reason; entry.updatedAt = Date.now();
    if (status === 'ready') delete entry.attemptSourceKeys;
    return entry.finding;
  });
}
export function activeSessionReviews(root, sessionId) {
  const loaded = readReviewState(root);
  if (!loaded.ok || !sessionId) return [];
  return Object.values(loaded.value.entries).filter((entry) => entry.status === 'claimed' && entry.ownerSession === reviewHash(sessionId)).map((entry) => entry.finding);
}
export function reviewQueueDiagnostics(root) {
  const loaded = readReviewState(root);
  if (!loaded.ok) return { status: loaded.reason, counts: {}, pending: null };
  const counts = {};
  for (const entry of Object.values(loaded.value.entries)) counts[entry.status] = (counts[entry.status] || 0) + 1;
  return { status: counts.deferred || counts.claimed || counts.ready ? 'pending' : 'clean', counts,
    pending: (counts.deferred || 0) + (counts.claimed || 0) + (counts.ready || 0),
    migratedLegacyClaims: loaded.value.migratedLegacyClaims || 0 };
}

// Compatibility for API callers using plain notices. Runtime hooks use structured findings.
// Each complete line is an independent finding; its version retains source hashes.
export function claimAutoReview(root, text, { sessionId = 'legacy-api', now = Date.now() } = {}) {
  const findings = [...new Set(String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean))].map((line) => ({
    id: reviewHash(['legacy', line.replace(/sha256:[a-f\d]{64}/gi, 'sha256:<version>')]),
    revision: reviewHash(line), kind: 'legacy', document: null, sources: [], allSources: [], reason: 'legacy-notice',
  }));
  const reconciled = reconcileReviews(root, { findings }, now);
  if (!reconciled.ok) return { claimed: false, reason: reconciled.reason };
  const claimed = claimReviewFindings(root, findings, { sessionId, now, limit: findings.length });
  return { claimed: claimed.ok && claimed.findings.length > 0, reason: !claimed.ok ? claimed.reason : claimed.findings.length ? 'new-pending' : 'already-pending' };
}
export function shouldStartAutoReview(root, text, now = Date.now(), sessionId = 'legacy-api') {
  return claimAutoReview(root, text, { now, sessionId }).claimed;
}
export function resolveAutoReviewForSession(root, sessionId, now = Date.now()) {
  // No evidence was supplied: defer rather than incorrectly certify completion.
  finishSessionReviews(root, sessionId, now);
  return 0;
}
