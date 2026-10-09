#!/usr/bin/env node
// 🎯 Impacto antes de editar — "se eu mexer em X, o que mais está em jogo?"
//
// Junta, numa resposta só e com orçamento de saída, quatro sinais que já existem separados:
//   1. quem usa X           (refs: usos por nome, com o símbolo que contém cada um)
//   2. o que muda junto     (coupling: co-mudança medida no git, direcional)
//   3. que testes cobrem    (verify: mesmo nome ou import — pista, não prova de cobertura)
//   4. o que está escrito   (mapas de contexto e documentos ai-context que citam o arquivo, e se
//                            o conteúdo que eles revisaram ainda é o de hoje)
//
// Cada seção diz de onde veio e o que não sabe. Nada aqui decide o que fazer: é o briefing que
// alguém experiente no projeto daria antes da mudança, montado do código e do histórico.
//
// Uso:
//   impact.mjs <símbolo|arquivo> [--budget=2000] [--json] [--root=<dir>]

import { existsSync, statSync } from 'node:fs';
import { resolve, relative, basename, extname } from 'node:path';
import {
  resolveRoot, loadConfig, isMain, findRepos, sanitizeModelText, safe,
} from './lib/roots.mjs';
import { buildIndex, QUALIFICADOR_RE } from './symbols.mjs';
import { findReferences, resumoDoArquivo } from './refs.mjs';
import { analyzeWithStatus, DEFAULTS as COUPLING_DEFAULTS } from './coupling.mjs';
import { verificationReport } from './verify.mjs';
import { isTestFile } from './lib/verification.mjs';
import { contextMapsExplainFile } from './context-maps.mjs';
import { documentationReferencesForFile, buildDocumentationCatalog } from './lib/documentation.mjs';
import { fingerprintSourcesInRoot, sameSource } from './lib/source-fingerprints.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { recordMetric } from './lib/telemetry.mjs';

const DEFAULT_BUDGET = 2000;
const MAX_TARGET_FILES = 3;

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
const dentroDe = (pai, filho) => {
  const rel = relative(pai, filho);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'));
};

function arquivoDoProjeto(root, alvo) {
  const abs = resolve(root, alvo);
  if (!dentroDe(root, abs)) return null;
  return safe(() => statSync(abs).isFile(), false) ? abs : null;
}

/** Co-mudança dos arquivos-alvo, só no sentido "mexer NESTE leva o outro junto". */
function mudaJunto(root, cfg, arquivos) {
  const repos = findRepos(root, { requireGit: true, cfg });
  const out = [];
  let disponivel = repos.length > 0;
  const porRepo = new Map();
  for (const abs of arquivos) {
    const repo = repos.filter((r) => dentroDe(r.path, abs)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!repo) continue;
    if (!porRepo.has(repo.path)) {
      const analise = analyzeWithStatus(repo.path, { ...COUPLING_DEFAULTS, ...(cfg.coupling || {}) });
      if (!analise.available) disponivel = false;
      porRepo.set(repo.path, analise);
    }
    const alvo = norm(relative(repo.path, abs));
    for (const l of porRepo.get(repo.path).links) {
      if (l.a !== alvo && l.b !== alvo) continue;
      const ehA = l.a === alvo;
      const leva = ehA ? l.ca : l.cb;
      if (leva < COUPLING_DEFAULTS.minConfidence) continue;
      out.push({ file: alvo, other: ehA ? l.b : l.a, confidence: Math.round(leva * 100) / 100, together: l.n });
    }
  }
  out.sort((a, b) => b.confidence - a.confidence || b.together - a.together);
  return { available: disponivel, links: out.slice(0, 8) };
}

/** Fingerprint gravado no documento para esta fonte, comparado ao conteúdo de hoje. */
function estadoDoDocumento(root, documento, abs) {
  const catalogo = buildDocumentationCatalog(root, loadConfig(root), { persist: false });
  const doc = catalogo.documents?.find((d) => d.path === documento.path);
  const gravados = doc?.metadata?.sourceFingerprints || {};
  const id = norm(relative(root, abs));
  const chave = Object.keys(gravados).find((k) => norm(k) === id || id.endsWith(`/${norm(k)}`));
  if (!chave) return 'unverified';
  const atual = fingerprintSourcesInRoot(root, [abs]);
  return sameSource(atual, id, gravados[chave]) ? 'fresh' : 'changed';
}

function conhecimento(root, cfg, arquivos) {
  const maps = [];
  const docs = [];
  for (const abs of arquivos) {
    const rel = norm(relative(root, abs));
    const explicado = safe(() => contextMapsExplainFile(root, rel), null);
    if (explicado?.resolved) {
      for (const m of explicado.maps) maps.push({ file: rel, area: m.area, path: m.path, status: m.status });
      const refs = safe(() => documentationReferencesForFile(root, cfg, explicado.repository, explicado.file), { documents: [] });
      for (const d of refs.documents || []) {
        docs.push({ file: rel, title: d.title, path: d.path, lastReviewed: d.lastReviewed, status: safe(() => estadoDoDocumento(root, d, abs), 'unverified') });
      }
    }
  }
  return { maps, docs };
}

export function buildImpact(root, query, opts = {}) {
  const started = Date.now();
  const cfg = opts.cfg || loadConfig(root);
  const index = buildIndex(root, cfg, {});
  const arquivo = arquivoDoProjeto(root, query);
  let target;
  let usageName;
  if (arquivo) {
    target = { kind: 'file', file: norm(relative(root, arquivo)), files: [arquivo], definitions: [] };
    // Uso de um ARQUIVO é uso do nome do módulo: `import … from './pedido'`, `uses UPedido`,
    // `new Pedido(` quando o arquivo leva o nome da classe — a convenção das linguagens lidas.
    usageName = basename(arquivo, extname(arquivo)).replace(/\.(?:test|spec)$/i, '');
  } else {
    const nome = String(query).replace(QUALIFICADOR_RE, '');
    const definitions = [];
    for (const [n, locs] of index.defs) {
      if (n.toLowerCase() !== nome.toLowerCase()) continue;
      for (const l of locs) if (!/^(key|test) /.test(l.kind)) definitions.push({ file: l.file, line: l.line, end: l.end, kind: l.kind });
    }
    const files = [...new Set(definitions.map((d) => d.file))].slice(0, MAX_TARGET_FILES).map((f) => resolve(root, f)).filter((f) => existsSync(f));
    target = { kind: 'symbol', name: nome, files, definitions };
    usageName = nome;
  }
  if (target.kind === 'symbol' && !target.definitions.length) {
    return { status: 'not-found', query: String(query), scanned: index.fileCount, ms: Date.now() - started };
  }
  const usage = /^[A-Za-z_$][\w$]*$/.test(usageName) ? findReferences(root, usageName, { cfg, index }) : { status: 'invalid' };
  const relFiles = target.files.map((f) => norm(relative(root, f)));
  const tests = safe(() => verificationReport(root, relFiles, cfg), []);
  const testsFromUsage = usage.status === 'ok'
    ? usage.references.filter((r) => isTestFile(r.file)).map((r) => r.file).slice(0, 6)
    : [];
  return {
    status: 'ok',
    query: String(query),
    target: { ...target, files: relFiles },
    usage,
    coupling: safe(() => mudaJunto(root, cfg, target.files), { available: false, links: [] }),
    tests,
    testsFromUsage,
    knowledge: safe(() => conhecimento(root, cfg, target.files), { maps: [], docs: [] }),
    ms: Date.now() - started,
  };
}

/** Seções em ordem de valor; a que estoura o orçamento é cortada com aviso, nunca em silêncio. */
export function formatImpact(r, t, budget = DEFAULT_BUDGET) {
  if (r.status === 'not-found') return [t('imp.notFound', { q: sanitizeModelText(r.query, 100), files: r.scanned })];
  const s = (v, n = 160) => sanitizeModelText(v, n);
  const blocos = [];
  const alvo = r.target.kind === 'file'
    ? t('imp.headerFile', { f: s(r.target.file), ms: r.ms })
    : t('imp.headerSymbol', { q: s(r.target.name, 80), n: r.target.definitions.length, ms: r.ms });
  const cabecalho = [alvo];
  for (const d of r.target.definitions.slice(0, 3)) cabecalho.push(`   ${s(d.file)}:${d.end > d.line ? `${d.line}-${d.end}` : d.line}  ${s(d.kind, 100)}`);
  blocos.push(cabecalho);

  const u = r.usage;
  if (u.status === 'ok' && u.total) {
    const linhas = [t('imp.usage', { n: u.total, files: u.files })];
    for (const ref of u.references.slice(0, 6)) linhas.push(`   ${s(ref.file)} (${ref.uses.length}) — ${resumoDoArquivo(ref, t, 2)}`);
    if (u.references.length > 6) linhas.push(t('imp.more', { n: u.references.length - 6, cmd: `refs.mjs ${u.name} --all` }));
    blocos.push(linhas);
  } else if (u.status === 'ok') {
    blocos.push([t('imp.usageNone')]);
  }

  if (r.coupling.links.length) {
    const linhas = [t('imp.coupling')];
    for (const l of r.coupling.links.slice(0, 5)) linhas.push(`   ${String(Math.round(l.confidence * 100)).padStart(3)}% (${l.together}x)  ${s(l.other)}`);
    blocos.push(linhas);
  } else {
    blocos.push([r.coupling.available ? t('imp.couplingNone') : t('imp.couplingUnavailable')]);
  }

  const relacionados = [...new Set(r.tests.flatMap((g) => g.files.flatMap((f) => f.related.map((x) => x.file))).concat(r.testsFromUsage))];
  const comando = r.tests.find((g) => g.command)?.command;
  if (relacionados.length || comando) {
    const linhas = [t('imp.tests', { n: relacionados.length })];
    if (relacionados.length) linhas.push(`   ${relacionados.slice(0, 5).map((f) => s(f, 100)).join(', ')}${relacionados.length > 5 ? ` +${relacionados.length - 5}` : ''}`);
    if (comando) linhas.push(t('imp.testCommand', { cmd: s(comando, 120) }));
    blocos.push(linhas);
  } else {
    blocos.push([t('imp.testsNone')]);
  }

  const { maps, docs } = r.knowledge;
  if (maps.length || docs.length) {
    const linhas = [t('imp.knowledge')];
    for (const m of maps.slice(0, 4)) linhas.push(`   ${m.status === 'fresh' ? '✅' : '⚠️'} ${s(m.path)} — ${t(`imp.state.${m.status === 'fresh' ? 'fresh' : 'stale'}`)}`);
    for (const d of docs.slice(0, 4)) linhas.push(`   ${d.status === 'fresh' ? '✅' : d.status === 'changed' ? '⚠️' : '•'} ${s(d.path)} — ${t(`imp.state.${d.status}`)}`);
    blocos.push(linhas);
  } else {
    blocos.push([t('imp.knowledgeNone')]);
  }
  blocos.push([r.target.kind === 'symbol' ? t('imp.why', { q: s(r.target.name, 80) }) : t('imp.whyFile', { f: s(r.target.file) })]);

  const out = [];
  let usado = 0;
  for (const bloco of blocos) {
    const texto = bloco.join('\n');
    if (usado + texto.length > budget && out.length) {
      out.push(t('imp.budget', { budget }));
      break;
    }
    out.push(...bloco);
    usado += texto.length + 1;
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot(args);
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  const alvo = args.find((a) => !a.startsWith('--'));
  if (!alvo) { console.log(t('imp.usage.cli')); return null; }
  const budget = Number((args.find((a) => a.startsWith('--budget=')) || '').slice(9)) || DEFAULT_BUDGET;
  const result = buildImpact(root, alvo, { cfg });
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(formatImpact(result, t, budget).join('\n'));
  return result;
}

if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot(process.argv.slice(2));
  let result = null;
  try { result = main(); } catch (e) {
    console.log(makeT(detectLang())('imp.fail', { err: e && e.message }));
  } finally {
    recordMetric(root, 'impact', { durationMs: Date.now() - started, status: result?.status || 'none' });
  }
  process.exit(0);
}
