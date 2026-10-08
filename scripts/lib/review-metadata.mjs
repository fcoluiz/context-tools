// All metadata writes are byte-preserving, source-version checked, and mechanical. This module
// never generates factual documentation or treats file dates as review evidence.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lerDocumento, codificarDocumento } from './md-hint.mjs';
import { safeEditTarget } from './session-write-journal.mjs';
import { compareReviewedSources, fingerprintSourcesInRoots, parseSourceFingerprints } from './source-fingerprints.mjs';
import { readMetadata, documentationReviewTarget } from './documentation.mjs';
import { parseFrontmatter } from '../context-maps.mjs';
import { documentDependencies } from './document-dependencies.mjs';
import { reviewHash } from './review-findings.mjs';
import { statePath } from './roots.mjs';
import { transactState } from './state-store.mjs';
const pathKey = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

export function currentReviewTarget(root, finding) {
  const path = safeEditTarget(root, finding.document);
  if (!path || !/\.md$/i.test(path)) throw new Error('invalid review document');
  const document = lerDocumento(path);
  if (!document) throw new Error('document unavailable');
  let sources;
  let metadata;
  if (finding.kind === 'map') {
    const frontmatter = parseFrontmatter(document.text);
    if (!frontmatter || !Array.isArray(frontmatter.covers) || !frontmatter.covers.length) throw new Error('invalid map metadata');
    const repo = resolve(dirname(path), '..', '..');
    sources = frontmatter.covers.map((key) => ({ key, root: repo, path: resolve(repo, key) }));
    metadata = { sourceFingerprints: frontmatter.source_fingerprints, sourceDigest: frontmatter.source_digest };
  } else {
    const target = documentationReviewTarget(root, finding.document);
    metadata = target.document.metadata;
    sources = target.sources.map((source) => ({ key: `${source.repo.name}/${source.file}`, root: source.repo.path, path: resolve(source.repo.path, source.file) }));
  }
  if (sources.some((source) => !safeEditTarget(root, source.path))) throw new Error('source outside allowed roots');
  const current = fingerprintSourcesInRoots(sources.map((source) => ({ ...source, id: source.key })));
  if (current.markers.length) throw new Error('source verification unavailable');
  return { path, document, sources, metadata, current };
}

function replaceField(text, field, value, map) {
  const newline = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
  const closing = map ? /\r?\n---(?:\r?\n|$)/.exec(text.slice(3)) : null;
  const end = closing ? closing.index + 3 : -1;
  if (map && end < 0) throw new Error('invalid map frontmatter');
  const area = map ? text.slice(0, end) : text;
  const aliases = field === 'last_reviewed' ? '(?:last_reviewed|Last reviewed|Última revisão|Ultima revisao)' : field;
  const regex = new RegExp(`^([\\t ]*(?:-[\\t ]*)?${aliases}[\\t ]*:[\\t ]*)([^\\r\\n]*)(\\r?)$`, 'gmi');
  const fenced = [...area.matchAll(/^(?:```|~~~)[^\r\n]*\r?\n[\s\S]*?^(?:```|~~~)[^\r\n]*$/gm)].map((match) => [match.index, match.index + match[0].length]);
  const matches = [...area.matchAll(regex)].filter((match) => !fenced.some(([start, end]) => match.index >= start && match.index < end));
  if (matches.length > 1) throw new Error(`duplicate metadata field: ${field}`);
  if (matches.length) {
    const match = matches[0];
    const updated = `${area.slice(0, match.index)}${match[1]}${value}${match[3]}${area.slice(match.index + match[0].length)}`;
    return updated + (map ? text.slice(end) : '');
  }
  if (map) return `${area}${newline}${field}: ${value}${text.slice(end)}`;
  // Put metadata after the title, preserving all existing prose and newline styles.
  const title = text.match(/^# [^\r\n]*(?:\r\n|\n|\r)/);
  const at = title ? title[0].length : 0;
  return `${text.slice(0, at)}${newline}- ${field}: ${value}${newline}${text.slice(at)}`;
}

export function updateReviewMetadata(root, finding, { checkedKeys = [], syncOnly = false } = {}) {
  const lock = statePath(root, '.document-updates', `${reviewHash(finding.document)}.json`);
  const result = transactState(lock, () => ({ version: 1 }), () => {
    const target = currentReviewTarget(root, finding);
    const original = readFileSync(target.path);
    if (!codificarDocumento(target.document, target.document.text).equals(original)) throw new Error('document encoding cannot be preserved');
    const declared = new Map(finding.allSources.map((source) => [source.key, source.path]));
    if (declared.size !== target.sources.length || target.sources.some((source) => pathKey(declared.get(source.key) || '') !== pathKey(source.path))) throw new Error('source references changed; refresh the review manifest');
    const parsed = parseSourceFingerprints(target.metadata.sourceFingerprints);
    if (!parsed.valid) throw new Error('repair invalid source_fingerprints before acknowledgement');
    const merged = { ...parsed.sources };
    const supplied = new Map(finding.sources.map((source) => [source.key, source.fingerprint]));
    const keys = [...new Set(checkedKeys)];
    if (!syncOnly && (!keys.length || keys.some((key) => !supplied.has(key)))) throw new Error('acknowledge only sources listed in this review');
    for (const key of keys) {
      if (target.current.sources[key] !== supplied.get(key)) throw new Error('source changed during review');
      merged[key] = supplied.get(key);
    }
    const complete = compareReviewedSources(target.current, merged).metadataComplete;
    if (syncOnly && !complete) throw new Error('digest sync requires complete matching per-source metadata');
    let text = target.document.text;
    if (!syncOnly) {
      text = replaceField(text, 'source_fingerprints', JSON.stringify(merged), finding.kind === 'map');
      const deps = documentDependencies(target.metadata, target.current);
      if (deps.valid) {
        let prior = {};
        try { prior = JSON.parse(target.metadata.dependencyFingerprints || '{}'); } catch { /* replace invalid dependency metadata after source review */ }
        for (const [key, value] of Object.entries(deps.current)) if (keys.some((source) => key.startsWith(`${source}#`))) prior[key] = value;
        text = replaceField(text, 'dependency_fingerprints', JSON.stringify(prior), false);
      }
      text = replaceField(text, finding.kind === 'map' ? 'verified_date' : 'last_reviewed', new Date().toISOString().slice(0, 10), finding.kind === 'map');
      if (complete && finding.kind === 'map') {
        let revision;
        try { revision = execFileSync('git', ['-C', target.sources[0].root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','ignore'] }).trim(); }
        catch { revision = new Date().toISOString().slice(0,10); }
        text = replaceField(text, 'verified_at', revision, true);
      }
    }
    if (complete) text = replaceField(text, 'source_digest', target.current.digest, finding.kind === 'map');
    if (text === target.document.text) return { changed: false, complete };
    const temporary = `${target.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, codificarDocumento(target.document, text), { flag: 'wx' });
      // Other editors need not obey our lock. Refuse to overwrite a document they changed.
      if (!readFileSync(target.path).equals(original)) throw new Error('document changed during metadata update');
      // Revalidate checked source revisions immediately before saving.
      const final = currentReviewTarget(root, finding);
      if (final.sources.length !== target.sources.length || final.sources.some((source) => pathKey(declared.get(source.key) || '') !== pathKey(source.path))) throw new Error('source references changed during metadata update');
      if (keys.some((key) => final.current.sources[key] !== supplied.get(key)) || (complete && final.current.digest !== target.current.digest)) throw new Error('source changed during metadata update');
      renameSync(temporary, target.path);
    } finally { try { unlinkSync(temporary); } catch { /* rename already consumed it */ } }
    return { changed: true, complete };
  });
  return result;
}
