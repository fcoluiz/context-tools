#!/usr/bin/env node
// Explain why a source is or is not a candidate for context-map review. Read-only except local
// fingerprint caches are intentionally not persisted by this command.

import { resolveRoot, isMain, loadConfig, sanitizeModelText } from './lib/roots.mjs';
import { contextMapsExplainFile } from './context-maps.mjs';
import { documentationReferencesForFile } from './lib/documentation.mjs';
import { readReviewState, reviewQueueDiagnostics } from './lib/auto-review-state.mjs';
import { sessionWriteJournalDiagnostics } from './lib/session-write-journal.mjs';
import { resolve } from 'node:path';

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const fileFlag = args.indexOf('--file');
  const file = fileFlag >= 0 ? args[fileFlag + 1] : null;
  if (args.some((arg, index) => arg !== '--json' && arg !== '--file' && index !== fileFlag + 1)
    || fileFlag < 0 || !file || file.startsWith('--') || args.filter((arg) => arg === '--file').length !== 1) {
    throw new Error('usage: node explain.mjs --file <path> [--json]');
  }

  const root = resolveRoot();
  const report = contextMapsExplainFile(root, file);
  report.reviewQueue = reviewQueueDiagnostics(root);
  report.writeAttribution = sessionWriteJournalDiagnostics(root, process.env.CONTEXT_TOOLS_SESSION_ID);
  const queue = readReviewState(root);
  const key = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  report.pendingReviews = queue.ok ? Object.values(queue.value.entries)
    .filter((entry) => entry.status !== 'complete' && entry.finding.sources.some((source) => key(source.path) === key(resolve(root, file))))
    .map((entry) => ({ id: entry.finding.id, revision: entry.finding.revision, document: entry.finding.document, status: entry.status, reason: entry.reason, attempts: entry.attempts })) : [];
  if (report.resolved) {
    report.operationalDocumentation = documentationReferencesForFile(
      root, loadConfig(root), report.repository, report.file,
    );
    report.documentationNote = 'Document references are shown for routing; this command does not decide their semantic freshness.';
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!report.resolved) {
    console.log(`Could not resolve "${sanitizeModelText(report.input, 180)}": ${report.reason}.`);
    console.log(report.hint);
  } else {
    console.log(`File: ${sanitizeModelText(`${report.repository}/${report.file}`, 220)}`);
    console.log(`Session attribution: ${report.session.status}`);
    console.log(`Review queue: ${report.reviewQueue.status}; ${report.pendingReviews.length} pending item(s) for this source.`);
    if (report.session.reason) console.log(`Session reason: ${report.session.reason}`);
    if (report.session.baselineIssues?.length) {
      for (const issue of report.session.baselineIssues) {
        console.log(`  baseline: ${issue.kind}${issue.count == null ? '' : ` (${issue.count} files; limit ${issue.limit})`}`);
      }
    }
    console.log(`Coverage: ${report.coverage}`);
    if (report.maps.length) {
      for (const map of report.maps) {
        const action = map.wouldRequestReview ? 'Stop would request review' : 'no review request for this source';
        console.log(`  ${sanitizeModelText(map.area, 100)} — ${map.status} (${map.basis}); ${action}.`);
        console.log(`    ${sanitizeModelText(map.path, 180)}`);
      }
    } else if (report.coverage === 'unmapped-candidate') {
      console.log('  This code file has no covering context map and is eligible for the session warning.');
    }
    const docs = report.operationalDocumentation;
    console.log(`Operational documentation: ${docs.status}`);
    if (docs.documents.length) {
      for (const document of docs.documents) {
        console.log(`  ${sanitizeModelText(document.title, 100)} — ${sanitizeModelText(document.path, 180)}; last reviewed: ${document.lastReviewed || 'not recorded'}`);
      }
    } else if (docs.status === 'ready') {
      console.log('  No operational document references this source.');
    }
    const decisionText = {
      'session-baseline-unavailable': 'the session baseline is unavailable, so this file cannot be attributed safely',
      'source-not-changed-this-session': 'the source was not detected as changed in this session',
      'unmapped-code-candidate': 'changed code has no covering map and may be reported for review',
      'no-map-and-excluded': 'the source has no map and matches an intentional or default exclusion',
      'map-review-candidate': 'the changed source is covered by a map whose current status needs review',
      'covered-source-is-current': 'the source is covered and its bytes match the recorded review baseline',
    }[report.stopDecision];
    console.log(`Stop decision: ${report.stopDecision} — ${decisionText}`);
    console.log(report.note);
    console.log(report.documentationNote);
  }
  if (!report.resolved) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`context-tools explain: ${sanitizeModelText(error?.message || error, 300)}`);
    process.exitCode = 1;
  }
}
