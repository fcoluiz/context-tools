#!/usr/bin/env node
// Suggest possible map coverage from repeated Git co-changes. Never edits maps or config.

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRoot, findRepos, loadConfig, isMain, safe, CODE_RE, sanitizeModelText } from './lib/roots.mjs';
import { analyzeWithStatus, DEFAULTS } from './coupling.mjs';
import { contextMapCoverage, isDefaultUnmapped, isIntentionallyUnmapped } from './context-maps.mjs';

function pathKey(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isCodeFile(repoPath, relativeFile) {
  return CODE_RE.test(relativeFile)
    && safe(() => statSync(join(repoPath, relativeFile)).isFile(), false);
}

export function suggestMapCoverage(root = resolveRoot()) {
  const config = loadConfig(root);
  const couplingConfig = { ...DEFAULTS, ...(config.coupling || {}) };
  const maps = contextMapCoverage(root);
  const repos = findRepos(root, { requireGit: false, cfg: config });
  const intentionallyUnmapped = Array.isArray(config.contextMaps?.intentionallyUnmapped)
    ? config.contextMaps.intentionallyUnmapped : [];
  const results = [];

  for (const repo of repos) {
    if (!repo.git) {
      results.push({ repository: repo.name, status: 'no-git-history', candidates: [] });
      continue;
    }
    const history = safe(() => analyzeWithStatus(repo.path, couplingConfig), null);
    if (!history || !history.available) {
      results.push({ repository: repo.name, status: 'history-unavailable', candidates: [] });
      continue;
    }
    const repoMaps = maps.filter((map) => resolve(map.repo) === resolve(repo.path));
    const covered = new Set(repoMaps.flatMap((map) => map.covers.map(pathKey)));
    const candidates = new Map();

    for (const link of history.links) {
      for (const [candidate, mapped, confidence] of [
        [link.a, link.b, link.ca],
        [link.b, link.a, link.cb],
      ]) {
        const candidateKey = pathKey(candidate);
        if (confidence < couplingConfig.minConfidence || covered.has(candidateKey) || !covered.has(pathKey(mapped))) continue;
        if (!isCodeFile(repo.path, candidate)
          || isDefaultUnmapped(candidate)
          || isIntentionallyUnmapped(candidate, intentionallyUnmapped)) continue;

        for (const map of repoMaps.filter((item) => item.covers.some((cover) => pathKey(cover) === pathKey(mapped)))) {
          const key = `${candidateKey}\0${map.path}`;
          const previous = candidates.get(key);
          const row = {
            file: candidate,
            mapArea: map.area,
            map: map.path,
            coChanges: link.n,
            confidence,
            relatedFile: mapped,
          };
          if (!previous || row.confidence > previous.confidence || (row.confidence === previous.confidence && row.coChanges > previous.coChanges)) {
            candidates.set(key, row);
          }
        }
      }
    }

    const ranked = [...candidates.values()].sort((a, b) =>
      b.confidence - a.confidence || b.coChanges - a.coChanges || a.file.localeCompare(b.file));
    results.push({
      repository: repo.name,
      status: 'analyzed',
      historyBaskets: history.commits,
      candidates: ranked.slice(0, 30).map((item) => ({
        ...item,
        confidencePercent: Math.round(item.confidence * 100),
      })),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    since: couplingConfig.since,
    note: 'Co-change is a review lead, not proof that files belong in the same context map. No files were modified.',
    repositories: results,
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  if (args.some((arg) => arg !== '--json')) throw new Error('usage: node map-suggestions.mjs [--json]');
  const report = suggestMapCoverage(resolveRoot());
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Context map coverage suggestions (Git history: ${report.since})`);
  for (const repo of report.repositories) {
    console.log(`\n${sanitizeModelText(repo.repository, 100)}: ${repo.status}`);
    if (repo.status === 'analyzed' && !repo.candidates.length) console.log('  No strong uncovered co-change candidates found.');
    for (const item of repo.candidates) {
      console.log(`  ${sanitizeModelText(item.file, 180)} → ${sanitizeModelText(item.mapArea, 100)} (${item.confidencePercent}%, ${item.coChanges} co-changes; related file: ${sanitizeModelText(item.relatedFile, 180)})`);
    }
  }
  console.log(`\n${report.note}`);
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`context-tools map-suggestions: ${sanitizeModelText(error?.message || error, 300)}`);
    process.exitCode = 1;
  }
}
