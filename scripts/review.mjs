#!/usr/bin/env node
// Inspect/retry/defer a local pending review; acknowledge only after source inspection.
import { relative, resolve } from 'node:path';
import { isMain, resolveRoot, sanitizeModelText } from './lib/roots.mjs';
import { readReviewState, reviewQueueDiagnostics, setReviewDisposition } from './lib/auto-review-state.mjs';
import { currentReviewTarget, updateReviewMetadata } from './lib/review-metadata.mjs';
import { parseSourceFingerprints } from './lib/source-fingerprints.mjs';
import { reviewFinding } from './lib/review-findings.mjs';
import { reconcileReviews } from './lib/auto-review-state.mjs';
import { documentDependencies } from './lib/document-dependencies.mjs';

function main() {
  const root = resolveRoot();
  const args = process.argv.slice(2);
  const action = args[0] || 'status';
  const id = args.find((arg) => arg.startsWith('--id='))?.slice(5);
  const loaded = readReviewState(root);
  if (!loaded.ok) throw new Error(loaded.reason);
  if (action === 'status') {
    console.log(JSON.stringify({ ...reviewQueueDiagnostics(root), items: Object.values(loaded.value.entries).filter((entry) => entry.status !== 'complete').map((entry) => ({ id: entry.finding.id, revision: entry.finding.revision, kind: entry.finding.kind, document: entry.finding.document, status: entry.status, reason: entry.reason, attempts: entry.attempts })) }, null, 2));
    return;
  }
  if (!id || !/^[a-f\d]{64}$/i.test(id)) throw new Error('supply --id=ID from review status');
  const entry = loaded.value.entries[id];
  if (!entry) throw new Error('unknown review id');
  if (action === 'show') {
    const finding = entry.finding;
    const selected = entry.attemptSourceKeys ? finding.sources.filter((source) => entry.attemptSourceKeys.includes(source.key)) : finding.sources;
    console.log(JSON.stringify({ id, revision: finding.revision, status: entry.status, kind: finding.kind, document: finding.document, reason: finding.reason,
      sources: selected.map((source) => ({ key: source.key, path: relative(root, source.path).replace(/\\/g,'/'), fingerprint: source.fingerprint })),
      pendingSourceCount: finding.sources.length,
      totalReferencedSources: finding.allSources.length, dependencies: finding.dependencies, needs: finding.needs,
      acknowledgement: 'Inspect these sources, update factual content if required, then ack --id=ID --revision=REVISION --reviewed. Use --source=KEY repeatedly for a partial review.' }, null, 2));
    return;
  }
  let result;
  if (action === 'retry') {
    let finding = entry.finding;
    if (finding.document) {
      const target = currentReviewTarget(root, finding);
      const dependencies = documentDependencies(target.metadata, target.current);
      finding = reviewFinding(root, { kind: finding.kind, document: target.path, fingerprint: target.current,
        keys: Object.keys(target.current.sources), dependencies: dependencies.valid ? dependencies.current : null });
      const refreshed = reconcileReviews(root, { findings: [finding] });
      if (!refreshed.ok) throw new Error(refreshed.reason);
    }
    result = setReviewDisposition(root, id, 'ready', 'explicit-retry', finding.revision);
  }
  else if (action === 'defer') {
    const reason = args.find((arg) => arg.startsWith('--reason='))?.slice(9) || 'manual';
    if (!['manual','not-warranted','insufficient-evidence','conflict'].includes(reason)) throw new Error('unsupported deferral reason');
    result = setReviewDisposition(root, id, 'deferred', reason, entry.finding.revision);
  } else if (action === 'ack') {
    if (!args.includes('--reviewed')) throw new Error('ack requires --reviewed after inspecting the listed sources');
    const revision = args.find((arg) => arg.startsWith('--revision='))?.slice(11);
    if (!revision || revision !== entry.finding.revision) throw new Error('ack requires --revision=REVISION from the inspected manifest; the review may have changed');
    let finding = entry.attemptSourceKeys
      ? { ...entry.finding, sources: entry.finding.sources.filter((source) => entry.attemptSourceKeys.includes(source.key)) } : entry.finding;
    if (finding.kind === 'coverage') {
      const document = args.find((arg) => arg.startsWith('--document='))?.slice(11);
      const kind = args.find((arg) => arg.startsWith('--kind='))?.slice(7);
      if (!document || !['map','document'].includes(kind)) throw new Error('coverage: create warranted documentation and supply --document=PATH --kind=map|document, or defer --reason=not-warranted');
      const target = currentReviewTarget(root, { ...finding, kind, document });
      const own = finding.sources[0];
      const normalize = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
      const key = target.sources.find((source) => normalize(source.path) === normalize(own.path))?.key;
      if (!key) throw new Error('new document does not cover this source');
      finding = { ...finding, kind, document, sources: [{ ...own, key }], allSources: target.sources.map((source) => ({ key: source.key, path: source.path, fingerprint: target.current.sources[source.key] })) };
    }
    const requested = args.filter((arg) => arg.startsWith('--source=')).map((arg) => arg.slice(9));
    const checkedKeys = requested.length ? requested : finding.sources.map((source) => source.key);
    const update = updateReviewMetadata(root, finding, { checkedKeys });
    if (!update.ok) throw new Error(update.message || update.reason);
    const target = currentReviewTarget(root, finding);
    const parsed = parseSourceFingerprints(target.metadata.sourceFingerprints);
    const completionSources = entry.finding.kind === 'coverage' ? finding.sources : entry.finding.sources;
    const completed = parsed.valid && completionSources.every((source) => parsed.sources[source.key] === source.fingerprint && target.current.sources[source.key] === source.fingerprint);
    if (completed) result = setReviewDisposition(root, id, 'complete', 'verified-metadata', entry.finding.revision);
    else result = { ok: true, value: { status: 'partial', checkedKeys } };
  } else throw new Error('usage: review.mjs status|show|ack|defer|retry [--id=ID]');
  if (!result.ok) throw new Error(result.message || result.reason);
  console.log(JSON.stringify({ ok: true, action, id, result: result.value }, null, 2));
}
if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(`context-tools review: ${sanitizeModelText(error.message,300)}`); process.exitCode = 1; }
}
