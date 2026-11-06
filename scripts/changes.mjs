#!/usr/bin/env node
// 🔎 O que o diff mexe fora dele — "mudei estes símbolos; quem depende deles e não foi tocado?"
//
// Uma revisão que lê só o diff não vê o arquivo intocado que quebra: o campo renomeado que outra
// rota ainda lê, a função apagada que um teste ainda chama. Isto cruza as linhas do `git diff -U0`
// com os intervalos que o índice guarda para cada símbolo e, para cada símbolo mudado ou removido,
// lista os usos em arquivos FORA do diff. É busca por nome (como `refs`): nomes iguais em outros
// escopos contam, uso dinâmico não aparece.
//
// Uso:
//   changes.mjs [--base=<ref>] [--json] [--root=<dir>]
//     --base   compara a árvore de trabalho (inclui o que está no stage) com esta ref; padrão HEAD.
//              Para a branch inteira: --base=origin/main.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { resolveRoot, loadConfig, isMain, findRepos, safe, sanitizeModelText } from './lib/roots.mjs';
import { buildIndex, bareName } from './symbols.mjs';
import { findReferences } from './refs.mjs';
import { parserForExt } from './outline.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';

const MAX_SYMBOLS = 15;
const MAX_FILES_PER_SYMBOL = 4;
// O mesmo teto do handoff: acima disto o "símbolo" é um intervalo que engoliu vizinhos.
const MAX_SPAN = 200;

const norm = (p) => String(p || '').replace(/\\/g, '/');

function git(cwd, args) {
  return safe(() => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 << 20 }), '');
}

/** Faixas de linha mudadas do lado novo de um patch `-U0`. Remoção pura vira a posição onde estava. */
export function changedRanges(patch) {
  const out = [];
  for (const m of String(patch).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const ini = parseInt(m[1], 10);
    const n = m[2] === undefined ? 1 : parseInt(m[2], 10);
    out.push([ini, ini + Math.max(0, n - 1)]);
  }
  return out;
}

/** Nomes definidos no conteúdo antigo que não existem mais no novo (pelo parser do outline). */
export function removedNames(ext, before, after) {
  const parser = parserForExt(ext);
  if (!parser) return [];
  const nomes = (txt) => new Set(parser(String(txt).split('\n')).filter((s) => !/^(key|test) /.test(s.name)).map((s) => bareName(s.name)).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n)));
  const novos = nomes(after);
  return [...nomes(before)].filter((n) => !novos.has(n));
}

function changedInRepo(repoPath, base) {
  const tracked = git(repoPath, ['diff', '--name-only', base]).split('\n').filter(Boolean);
  // O estado do próprio plugin (.claude/, .codex/) nasce não rastreado e não é mudança do usuário.
  const untracked = git(repoPath, ['ls-files', '--others', '--exclude-standard']).split('\n').filter((f) => f && !/^\.(claude|codex)\//.test(f));
  return { tracked, untracked };
}

export function buildChanges(root, opts = {}) {
  const started = Date.now();
  const cfg = opts.cfg || loadConfig(root);
  const base = opts.base || 'HEAD';
  const repos = findRepos(root, { cfg });
  if (!repos.length) return { status: 'no-git', base };
  const index = buildIndex(root, cfg, {});
  const porArquivo = new Map();
  for (const [nome, locs] of index.defs) {
    for (const l of locs) {
      if (/^(key|test) /.test(l.kind || '')) continue;
      const f = norm(l.file);
      if (!porArquivo.has(f)) porArquivo.set(f, []);
      porArquivo.get(f).push({ nome, ini: l.line, fim: l.end || l.line });
    }
  }

  const changedFiles = new Set();
  const touched = new Map(); // nome → arquivo
  const removed = new Map();
  let baseOk = true;
  for (const repo of repos) {
    if (!git(repo.path, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).trim()) { baseOk = false; continue; }
    const { tracked, untracked } = changedInRepo(repo.path, base);
    for (const arq of [...tracked, ...untracked]) {
      const relRoot = norm(relative(root, join(repo.path, arq)));
      changedFiles.add(relRoot);
      if (untracked.includes(arq)) continue; // arquivo novo: ninguém fora dele dependia dele antes
      const abs = join(repo.path, arq);
      const before = git(repo.path, ['show', `${base}:${arq}`]);
      const atual = existsSync(abs) ? safe(() => readFileSync(abs, 'utf8'), '') : '';
      for (const nome of removedNames(extname(arq), before, atual)) if (!removed.has(nome)) removed.set(nome, relRoot);
      const faixas = changedRanges(git(repo.path, ['diff', '-U0', base, '--', arq]));
      const cands = porArquivo.get(relRoot) || [];
      for (const [a, b] of faixas) {
        const cobrem = cands.filter((s) => s.ini <= b && s.fim >= a && s.fim - s.ini + 1 <= MAX_SPAN);
        if (!cobrem.length) continue;
        let melhor = cobrem[0];
        for (const s of cobrem) if (s.fim - s.ini < melhor.fim - melhor.ini) melhor = s;
        if (!touched.has(melhor.nome)) touched.set(melhor.nome, relRoot);
      }
    }
  }
  if (!baseOk && !changedFiles.size) return { status: 'bad-base', base };

  const symbols = [];
  const alvos = [...[...removed].map(([n, f]) => [n, f, true]), ...[...touched].filter(([n]) => !removed.has(n)).map(([n, f]) => [n, f, false])];
  for (const [nome, file, isRemoved] of alvos.slice(0, MAX_SYMBOLS)) {
    const r = findReferences(root, nome, { cfg, index });
    // Arquivo que define o próprio `main`/`handler` usa o dele, não o que mudou aqui.
    const temPropria = new Set(r.status === 'ok' ? r.definitions.map((d) => norm(d.file)) : []);
    const fora = r.status === 'ok' ? r.references.filter((ref) => !changedFiles.has(norm(ref.file)) && !temPropria.has(norm(ref.file))) : [];
    // O índice é da árvore de hoje: removido e ainda definido em algum lugar (movido) não é chamada órfã.
    const aindaDefinido = isRemoved && r.status === 'ok' && r.definitions.length > 0;
    symbols.push({ name: nome, file, removed: isRemoved && !aindaDefinido, outside: fora.map((ref) => ({ file: norm(ref.file), uses: ref.uses })) });
  }
  return {
    status: 'ok', base, files: [...changedFiles], symbols, more: Math.max(0, alvos.length - MAX_SYMBOLS),
    scanned: index.fileCount, ms: Date.now() - started,
  };
}

export function formatChanges(r, t) {
  if (r.status === 'no-git') return t('chg.noGit');
  if (r.status === 'bad-base') return t('chg.badBase', { base: r.base });
  if (!r.files.length) return t('chg.none', { base: r.base });
  const linhas = [t('chg.head', { base: r.base, files: r.files.length, symbols: r.symbols.length })];
  // Removido com uso fora vem primeiro: é o que quebra sem ninguém ter tocado no arquivo.
  const ordem = [...r.symbols].sort((a, b) => (b.removed && b.outside.length ? 1 : 0) - (a.removed && a.outside.length ? 1 : 0) || b.outside.length - a.outside.length);
  for (const s of ordem) {
    const usos = s.outside.reduce((n, f) => n + f.uses.length, 0);
    const onde = s.outside.slice(0, MAX_FILES_PER_SYMBOL).map((f) => {
      const em = [...new Set(f.uses.map((u) => u.in).filter(Boolean))].slice(0, 2).join(', ');
      return `${f.file}${em ? ` (${em})` : ''} :${f.uses.slice(0, 3).map((u) => u.line).join(' :')}`;
    });
    if (s.outside.length > MAX_FILES_PER_SYMBOL) onde.push(t('chg.moreFiles', { n: s.outside.length - MAX_FILES_PER_SYMBOL }));
    const chave = s.removed ? (usos ? 'chg.removedUsed' : 'chg.removedFree') : (usos ? 'chg.used' : 'chg.free');
    linhas.push(t(chave, { name: sanitizeModelText(s.name), file: s.file, n: usos, where: onde.join('; ') }));
  }
  if (r.more) linhas.push(t('chg.moreSymbols', { n: r.more }));
  linhas.push(t('chg.caveat'));
  return linhas.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot(args);
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  const base = (args.find((a) => a.startsWith('--base=')) || '').slice(7) || 'HEAD';
  const r = buildChanges(root, { cfg, base });
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else console.log(formatChanges(r, t));
}

if (isMain(import.meta.url)) main();
