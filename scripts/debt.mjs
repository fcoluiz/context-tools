#!/usr/bin/env node
// 🧾 Dívida adiada — "o que deixamos para depois, há quanto tempo, e o que nunca vai voltar?"
//
// Varre os marcadores que o próprio time já escreve (TODO, FIXME, HACK, XXX, ou os de
// `"debt": { "markers": [...] }`), nos arquivos rastreados pelo git, e diz a idade de cada um pelo
// `git blame`. Marca `sem gatilho` o que não diz quando volta (uma data, versão, issue, "quando…",
// "depois de…"): é o "depois" que vira "nunca". Não escreve nada no código do usuário.
//
// Uso:
//   debt.mjs [--all] [--json] [--root=<dir>]

import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { resolveRoot, loadConfig, isMain, findRepos, safe, sanitizeModelText } from './lib/roots.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';

const DEFAULT_MARKERS = ['TODO', 'FIXME', 'HACK', 'XXX'];
const MAX_SHOWN = 25;
const MAX_BLAME_FILES = 40;
const MAX_TEXT = 110;
const DAY = 86400000;

// Um gatilho diz quando o adiado volta: data, versão, issue/PR, condição ("quando", "depois de", "até").
const GATILHO = /\b(?:when|once|after|until|before|if|quando|depois|ap[oó]s|at[eé]|antes|se)\b|#\d+|\b[A-Z][A-Z\d]+-\d+\b|\bv?\d+\.\d+(?:\.\d+)?\b|\b20\d\d-\d\d(?:-\d\d)?\b|https?:\/\//i;

const norm = (p) => String(p || '').replace(/\\/g, '/');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function git(cwd, args) {
  return safe(() => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }), '');
}

export function hasTrigger(text) {
  return GATILHO.test(text);
}

/** Uma linha de `git grep -n` → item, ou null se o marcador não estiver num comentário plausível. */
export function parseHit(line, markerRe) {
  const m = /^(.+?):(\d+):(.*)$/.exec(line);
  if (!m) return null;
  const found = markerRe.exec(m[3]);
  if (!found) return null;
  const text = m[3].slice(found.index + found[1].length).replace(/^[\s:(\-–—\]]+/, '').replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
  return { file: norm(m[1]), line: Number(m[2]), marker: found[1].toUpperCase(), text: text.slice(0, MAX_TEXT) };
}

/** `git blame --line-porcelain` → Map(linha → epoch ms). */
function blameTimes(repoPath, file) {
  const out = git(repoPath, ['blame', '--line-porcelain', '--', file]);
  const times = new Map();
  let final = 0;
  for (const l of out.split('\n')) {
    const h = /^[0-9a-f]{40} \d+ (\d+)/.exec(l);
    if (h) { final = Number(h[1]); continue; }
    if (l.startsWith('author-time ')) times.set(final, Number(l.slice(12)) * 1000);
  }
  return times;
}

export function buildDebt(root, opts = {}) {
  const cfg = opts.cfg || loadConfig(root);
  const markers = Array.isArray(cfg?.debt?.markers) && cfg.debt.markers.length ? cfg.debt.markers.map(String) : DEFAULT_MARKERS;
  // Só como palavra em maiúsculas, seguida de `:`/`(`/espaço: "todos" e "hackathon" não contam.
  const markerRe = new RegExp(`\\b(${markers.map(esc).join('|')})\\b(?=[\\s:(\\]-]|$)`);
  const repos = findRepos(root, { cfg });
  if (!repos.length) return { status: 'no-git' };
  const items = [];
  for (const repo of repos) {
    const out = git(repo.path, ['grep', '-n', '-I', '-E', `\\b(${markers.map(esc).join('|')})\\b`, '--', '.', ':(exclude)*.md', ':(exclude)CHANGELOG*']);
    for (const line of out.split('\n')) {
      const hit = parseHit(line, markerRe);
      if (hit) items.push({ ...hit, repo: repo.path, file: norm(relative(root, join(repo.path, hit.file))), repoFile: hit.file });
    }
  }
  const now = opts.now || Date.now();
  const porArquivo = new Map();
  for (const it of items) {
    const k = `${it.repo}\0${it.repoFile}`;
    if (!porArquivo.has(k)) porArquivo.set(k, []);
    porArquivo.get(k).push(it);
  }
  // Arquivos com mais marcadores primeiro: a idade cobre o máximo de itens com o teto de blames.
  const ordem = [...porArquivo.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [, grupo] of ordem.slice(0, MAX_BLAME_FILES)) {
    const times = blameTimes(grupo[0].repo, grupo[0].repoFile);
    for (const it of grupo) {
      const at = times.get(it.line);
      if (at) it.ageDays = Math.max(0, Math.floor((now - at) / DAY));
    }
  }
  const lista = items.map(({ repo, repoFile, ...it }) => ({ ...it, trigger: hasTrigger(it.text) }));
  lista.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  const byMarker = {};
  for (const it of lista) byMarker[it.marker] = (byMarker[it.marker] || 0) + 1;
  return { status: 'ok', markers, total: lista.length, noTrigger: lista.filter((i) => !i.trigger).length, byMarker, items: lista };
}

export function formatDebt(r, t, { all = false } = {}) {
  if (r.status === 'no-git') return t('debt.noGit');
  if (!r.total) return t('debt.none', { markers: r.markers.join(', ') });
  const contagem = Object.entries(r.byMarker).map(([m, n]) => `${m} ${n}`).join(' · ');
  const linhas = [t('debt.head', { total: r.total, counts: contagem, noTrigger: r.noTrigger })];
  const shown = all ? r.items : r.items.slice(0, MAX_SHOWN);
  for (const it of shown) {
    const idade = it.ageDays === undefined ? '' : t('debt.age', { d: it.ageDays });
    const tag = it.trigger ? '' : ` ${t('debt.noTriggerTag')}`;
    linhas.push(`• ${it.file}:${it.line} ${it.marker}${idade}${tag} — ${sanitizeModelText(it.text) || '…'}`);
  }
  if (shown.length < r.items.length) linhas.push(t('debt.more', { n: r.items.length - shown.length }));
  return linhas.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot(args);
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  const r = buildDebt(root, { cfg });
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else console.log(formatDebt(r, t, { all: args.includes('--all') }));
}

if (isMain(import.meta.url)) main();
