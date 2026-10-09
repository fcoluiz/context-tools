#!/usr/bin/env node
// ✅ "Revisei este mapa/documento contra o código atual" — grava os hashes sozinho.
//
// Uso:
//   ack.mjs <mapa-ou-documento.md> [--source=<chave> …] [--json]
//
// Por que existe: o aviso de mapa defasado mandava ao agente um JSON de SHA-256 (64 hex por
// fonte) para ele copiar no frontmatter. Hash é dado mecânico — o modelo não precisa lê-lo nem
// transcrevê-lo, e transcrever é onde ele erra. Agora o aviso diz QUAL documento revisar e este
// comando calcula e grava source_fingerprints/source_digest/verified_* depois que o agente
// confirmou o conteúdo. Nada é confirmado sem alguém pedir: o comando É o pedido.
//
// A gravação reusa `updateReviewMetadata` (lib/review-metadata.mjs): preserva encoding e quebra
// de linha, revalida as fontes imediatamente antes de salvar e recusa se o documento mudou.

import { relative, resolve, sep } from 'node:path';
import { isMain, resolveRoot, sanitizeModelText } from './lib/roots.mjs';
import { currentReviewTarget, updateReviewMetadata } from './lib/review-metadata.mjs';
import { parseSourceFingerprints } from './lib/source-fingerprints.mjs';

const isMap = (path) => /(?:^|[\\/])\.(?:claude|codex)[\\/]context[\\/][^\\/]+\.md$/i.test(path);

export function acknowledgeDocument(root, documentPath, { sources: only = [] } = {}) {
  const document = relative(root, resolve(root, documentPath)).split(sep).join('/');
  const kind = isMap(document) ? 'map' : 'documentation';
  const target = currentReviewTarget(root, { kind, document });
  const recorded = parseSourceFingerprints(kind === 'map' ? target.metadata.sourceFingerprints : target.metadata.sourceFingerprints);
  const sources = target.sources.map((source) => ({ key: source.key, path: source.path, fingerprint: target.current.sources[source.key] }));
  const unknown = only.filter((key) => !sources.some((source) => source.key === key));
  if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(', ')}`);
  // Por padrão: toda fonte cujo hash atual difere do registrado (ou que nunca foi registrada).
  const pending = sources.filter((source) => !recorded.valid || recorded.sources[source.key] !== source.fingerprint).map((source) => source.key);
  const checkedKeys = only.length ? only : pending;
  if (!checkedKeys.length) {
    const sync = updateReviewMetadata(root, { kind, document, sources, allSources: sources }, { syncOnly: true });
    return { document, kind, acknowledged: [], ...(sync.ok ? sync.value : { error: sync.reason || sync.message }) };
  }
  const result = updateReviewMetadata(root, { kind, document, sources, allSources: sources }, { checkedKeys });
  if (!result.ok) throw new Error(result.message || result.reason || 'metadata update failed');
  return { document, kind, acknowledged: checkedKeys, ...result.value };
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot(args);
  const files = args.filter((arg) => !arg.startsWith('--'));
  const sources = args.filter((arg) => arg.startsWith('--source=')).map((arg) => arg.slice(9));
  if (!files.length) {
    console.log('usage: ack.mjs <map-or-document.md> [--source=<key> …] [--json]');
    return;
  }
  const results = [];
  for (const file of files) {
    try { results.push(acknowledgeDocument(root, file, { sources })); }
    catch (error) {
      results.push({ document: file, error: sanitizeModelText(error?.message || error, 240) });
      process.exitCode = 1;
    }
  }
  if (args.includes('--json')) { process.stdout.write(`${JSON.stringify(results, null, 2)}\n`); return; }
  for (const r of results) {
    if (r.error) console.log(`✗ ${r.document}: ${r.error}`);
    else console.log(`✓ ${r.document}: ${r.acknowledged.length} source(s) recorded${r.complete ? '; source_digest complete' : '; other sources still pending'}${r.changed ? '' : ' (already up to date)'}`);
  }
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) {
    console.log(`ack: ${sanitizeModelText(error?.message || error, 240)}`);
    process.exitCode = 1;
  }
}
