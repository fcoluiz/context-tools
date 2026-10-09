#!/usr/bin/env node
// 🗺️ Panorama do projeto — o que alguém experiente diria no primeiro minuto, gerado do código e do git.
//
// O `ai-context/` nasce vazio, e o valor dele só aparece depois de semanas de uso. Este comando dá
// valor no primeiro minuto, sem escrever nada: onde o código está concentrado, quais arquivos são
// grandes demais para ler inteiros, quais mudam o tempo todo, o que muda junto, como testar — e
// quanto disso já tem conhecimento escrito. As áreas quentes sem mapa nem documento são exatamente
// o que vale registrar primeiro.
//
// Tudo é mecânico e diz de onde veio. Não interpreta o domínio: nomes de pasta e de arquivo não
// viram afirmação sobre o que o código faz.
//
// Uso:
//   overview.mjs [--json] [--budget=1800] [--root=<dir>]

import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, extname, relative } from 'node:path';
import {
  resolveRoot, loadConfig, isMain, findRepos, sanitizeModelText, safe, lerTexto, capabilityForExtension,
  HISTORY_CODE_RE,
} from './lib/roots.mjs';
import { buildIndex } from './symbols.mjs';
import { analyzeWithStatus, DEFAULTS as COUPLING_DEFAULTS } from './coupling.mjs';
import { detectTestCommand, listTestFiles } from './lib/verification.mjs';
import { contextMapCoverage } from './context-maps.mjs';
import { buildDocumentationCatalog } from './lib/documentation.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { recordMetric } from './lib/telemetry.mjs';

const DEFAULT_BUDGET = 1800;
const LINHAS_ARQUIVO_GRANDE = 1500;
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

/** Área = primeira pasta do caminho; se uma só pasta concentra quase tudo, desce um nível. */
function areas(files, defsPorArquivo) {
  const contar = (nivel) => {
    const mapa = new Map();
    for (const f of files) {
      const partes = f.split('/');
      const pasta = partes.slice(0, Math.min(nivel, partes.length - 1)).join('/');
      const chave = pasta || '(raiz)';
      const a = mapa.get(chave) || { area: chave, files: 0, symbols: 0 };
      a.files++;
      a.symbols += defsPorArquivo.get(f) || 0;
      mapa.set(chave, a);
    }
    return [...mapa.values()].sort((a, b) => b.files - a.files);
  };
  let lista = contar(1);
  for (let nivel = 2; nivel <= 4 && lista.length && lista[0].files / files.length > 0.6; nivel++) {
    const mais = contar(nivel);
    if (mais.length <= lista.length) break;   // a pasta dominante não se divide: descer não informa nada
    lista = mais;
  }
  return lista;
}

function arquivosGrandes(root, absFiles) {
  const porTamanho = absFiles
    .map((f) => ({ f, s: safe(() => statSync(f).size, 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 12);
  const out = [];
  for (const { f } of porTamanho) {
    const texto = lerTexto(f);
    if (texto === null) continue;
    const linhas = texto.split('\n').length;
    if (linhas >= LINHAS_ARQUIVO_GRANDE) out.push({ file: norm(relative(root, f)), lines: linhas });
  }
  return out.sort((a, b) => b.lines - a.lines).slice(0, 5);
}

/** Arquivos de código mais alterados nos últimos meses, pelo git. Sem git: lista vazia, dito. */
function arquivosQuentes(root, cfg) {
  const repos = findRepos(root, { requireGit: true, cfg });
  const contagem = new Map();
  for (const repo of repos) {
    const saida = safe(() => execFileSync('git', ['log', '--since=6 months ago', '--name-only', '--pretty=format:'], {
      cwd: repo.path, encoding: 'utf8', timeout: 8000, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'],
    }), '');
    for (const linha of saida.split('\n')) {
      const f = linha.trim();
      if (!f || !HISTORY_CODE_RE.test(f)) continue;
      const rel = norm(relative(root, `${repo.path}/${f}`));
      contagem.set(rel, (contagem.get(rel) || 0) + 1);
    }
  }
  return {
    available: repos.length > 0,
    changed: contagem.size,
    // Um commit só não ordena nada (clone raso, projeto novo): "mais alterado" exige ao menos dois.
    files: [...contagem.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([file, commits]) => ({ file, commits })),
  };
}

function acoplamentos(root, cfg) {
  const out = [];
  for (const repo of findRepos(root, { requireGit: true, cfg })) {
    const r = safe(() => analyzeWithStatus(repo.path, { ...COUPLING_DEFAULTS, ...(cfg.coupling || {}) }), { links: [] });
    const prefixo = norm(relative(root, repo.path));
    for (const l of r.links.slice(0, 3)) {
      const p = (x) => (prefixo ? `${prefixo}/${x}` : x);
      out.push({ a: p(l.a), b: p(l.b), confidence: Math.round(l.conf * 100) / 100, together: l.n });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 4);
}

/** Conjunto de arquivos citados por mapa de contexto ou documento ai-context. */
function conhecimento(root, cfg) {
  const cobertos = new Set();
  const maps = safe(() => contextMapCoverage(root), []);
  for (const m of maps) for (const c of m.covers) cobertos.add(norm(relative(root, `${m.repo}/${c}`)));
  const catalogo = safe(() => buildDocumentationCatalog(root, cfg, { persist: false }), { documents: [] });
  const docs = (catalogo.documents || []).filter((d) => d.type !== 'index');
  const citados = new Set();
  for (const d of docs) for (const r of d.references || []) citados.add(norm(r).toLowerCase());
  const cobre = (file) => cobertos.has(file)
    || citados.has(file.toLowerCase())
    || [...citados].some((r) => file.toLowerCase().endsWith(`/${r}`) || r === basename(file).toLowerCase());
  return { maps: maps.length, docs: docs.length, cobre };
}

export function buildOverview(root, opts = {}) {
  const started = Date.now();
  const cfg = opts.cfg || loadConfig(root);
  const index = buildIndex(root, cfg, {});
  const files = index.files.map((f) => norm(relative(root, f)));
  const defsPorArquivo = new Map();
  for (const locs of index.defs.values()) for (const l of locs) defsPorArquivo.set(l.file, (defsPorArquivo.get(l.file) || 0) + 1);

  const linguagens = new Map();
  for (const f of files) {
    const nome = capabilityForExtension(extname(f))?.name || extname(f);
    linguagens.set(nome, (linguagens.get(nome) || 0) + 1);
  }
  const quentes = arquivosQuentes(root, cfg);
  const saber = conhecimento(root, cfg);
  const testes = safe(() => listTestFiles(root).length, 0);
  return {
    status: index.fileCount ? 'ok' : 'no-files',
    repos: index.repos,
    files: index.fileCount,
    symbols: [...defsPorArquivo.values()].reduce((a, b) => a + b, 0),
    languages: [...linguagens.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, files: count })),
    areas: areas(files, defsPorArquivo).slice(0, 8),
    largeFiles: arquivosGrandes(root, index.files),
    hotFiles: { available: quentes.available, changed: quentes.changed, files: quentes.files.map((h) => ({ ...h, documented: saber.cobre(h.file) })) },
    coupling: acoplamentos(root, cfg),
    tests: { command: detectTestCommand(root, cfg), files: testes },
    knowledge: { maps: saber.maps, docs: saber.docs },
    ms: Date.now() - started,
  };
}

export function formatOverview(r, t, budget = DEFAULT_BUDGET) {
  if (r.status !== 'ok') return [t('ov.noFiles')];
  const s = (v, n = 120) => sanitizeModelText(v, n);
  const blocos = [];
  blocos.push([
    t('ov.header', { files: r.files, symbols: r.symbols, repos: r.repos.map((x) => s(x, 60)).join(', '), ms: r.ms }),
    `   ${r.languages.slice(0, 5).map((l) => `${l.name} ${l.files}`).join(' · ')}`,
  ]);
  blocos.push([t('ov.areas'), ...r.areas.slice(0, 6).map((a) => `   ${s(a.area).padEnd(28)} ${String(a.files).padStart(4)} ${t('ov.files')} · ${a.symbols} ${t('ov.symbols')}`)]);
  if (r.hotFiles.files.length) {
    blocos.push([t('ov.hot'), ...r.hotFiles.files.map((h) => `   ${h.documented ? '📚' : '  '} ${s(h.file)} (${h.commits})`)]);
  } else {
    blocos.push([!r.hotFiles.available ? t('ov.hotUnavailable') : r.hotFiles.changed ? t('ov.hotShallow') : t('ov.hotNone')]);
  }
  if (r.largeFiles.length) blocos.push([t('ov.large'), ...r.largeFiles.map((f) => `   ${s(f.file)} (${f.lines})`)]);
  if (r.coupling.length) blocos.push([t('ov.coupling'), ...r.coupling.map((c) => `   ${Math.round(c.confidence * 100)}% (${c.together}x) ${s(c.a, 70)} ↔ ${s(c.b, 70)}`)]);
  blocos.push([r.tests.command ? t('ov.tests', { cmd: s(r.tests.command), n: r.tests.files }) : t('ov.testsNone', { n: r.tests.files })]);
  const semDoc = r.hotFiles.files.filter((h) => !h.documented).length;
  blocos.push([
    t('ov.knowledge', { maps: r.knowledge.maps, docs: r.knowledge.docs }),
    ...(semDoc ? [t('ov.capture', { n: semDoc })] : []),
  ]);
  const out = [];
  let usado = 0;
  for (const bloco of blocos) {
    const texto = bloco.join('\n');
    if (usado + texto.length > budget && out.length) { out.push(t('ov.budget', { budget })); break; }
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
  const budget = Number((args.find((a) => a.startsWith('--budget=')) || '').slice(9)) || DEFAULT_BUDGET;
  const result = buildOverview(root, { cfg });
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(formatOverview(result, t, budget).join('\n'));
  return result;
}

if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot(process.argv.slice(2));
  let result = null;
  try { result = main(); } catch (e) {
    console.log(makeT(detectLang())('ov.fail', { err: e && e.message }));
  } finally {
    recordMetric(root, 'overview', { durationMs: Date.now() - started, status: result?.status || 'none' });
  }
  process.exit(0);
}
