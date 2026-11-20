#!/usr/bin/env node
// 🧭 Várias sessões de agente, vários worktrees — `ct work`.
//
//   work.mjs board|painel [--all] [--json]          worktrees, PRs abertas e arquivos em 2+ frentes
//   work.mjs new|nova <slug> [--both] [--repo=<n>] [--files=a,b] [--anyway]
//   work.mjs pr <slug> [--both] [--title=<t>]       1º push + PR rascunho com o checklist da config
//   work.mjs close|encerrar [<slug>] [--both] [--no-pr-check] [--dry-run]
//   work.mjs tidy|limpar [--apply|--aplicar] [--json]  plano de triagem; só remove com --apply
//   work.mjs rescue|resgatar <slug|caminho>          salva o sujo num commit de `rescue/<nome>-<data>`
//   work.mjs --session-start | --stop-report         hooks (só com `work.repos` na config)
//
// Config em `.claude/context-tools.json` (ou `.codex/…`) do workspace, procurada também nas pastas
// acima — uma sessão aberta dentro de um worktree acha a do workspace:
//   "work": { "worktreeRoot": ".worktrees", "repos": [ { "path": "api", "production": "main",
//             "remote": "origin", "branchPrefix": "feat/", "checklist": ["Migration: …"] } ] }
// Sem config, vale o repo da pasta atual com produção = origin/HEAD.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, loadConfig, resolveRoot, runtimeHost } from './lib/roots.mjs';

// O Stop roda a cada turno para todo mundo que tem o plugin, e quase ninguém configura `work`: a
// conferência da config vem antes de qualquer import pesado (i18n, lib/work → context-maps).
export function hasWorkConfig(start) {
  let dir = resolve(start || '.');
  for (let i = 0; i < 8; i++) {
    const repos = loadConfig(dir)?.work?.repos;
    if (Array.isArray(repos) && repos.length) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

async function translator(lang) {
  const { makeT, detectLang } = await import('./lib/i18n.mjs');
  return makeT(detectLang({ lang }));
}

const SELF = fileURLToPath(import.meta.url);
const STOP_WINDOW_MS = 6 * 3600 * 1000;
const MAX_ATTENTION = 15;
const MAX_COLLISIONS = 12;

const SUB = {
  board: 'board', painel: 'board',
  new: 'new', nova: 'new',
  pr: 'pr',
  close: 'close', encerrar: 'close',
  tidy: 'tidy', limpar: 'tidy',
  rescue: 'rescue', resgatar: 'rescue',
};

const flag = (args, ...names) => names.some((n) => args.includes(n));
const value = (args, name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const positional = (args) => args.filter((a) => !a.startsWith('-'));

async function lib() { return import('./lib/work.mjs'); }

async function loadWork(root) {
  const L = await lib();
  return L.findWorkConfig(root) || await L.implicitWork(process.cwd()) || await L.implicitWork(root);
}

/** Repos pedidos: `--both`/`--ambos` = todos; `--repo=<nome>`; senão o que contém a pasta atual; senão o único. */
function pickRepos(work, args, cwd = process.cwd()) {
  const ok = work.repos.filter((r) => !r.error);
  if (flag(args, '--both', '--ambos', '--all-repos')) return ok;
  const name = value(args, '--repo');
  if (name) return ok.filter((r) => r.name === name);
  const c = resolve(cwd).toLowerCase();
  const inside = ok.filter((r) => c === r.path.toLowerCase() || c.startsWith(r.path.toLowerCase() + (process.platform === 'win32' ? '\\' : '/')));
  if (inside.length) return inside;
  const byWt = ok.filter((r) => c.startsWith(r.worktreeRoot.toLowerCase()) && resolve(cwd).slice(r.worktreeRoot.length + 1).startsWith(`${r.name}-`));
  if (byWt.length === 1) return byWt;
  return ok.length === 1 ? ok : [];
}

// ── texto ──────────────────────────────────────────────────────────────────────────────────────

function dirtyText(t, wt) {
  if (wt.tracked == null) return t('wk.statusErr');
  return (wt.tracked + wt.untracked) ? t('wk.dirty', { tracked: wt.tracked, untracked: wt.untracked }) : t('wk.clean');
}

function prodText(t, wt) {
  if (wt.inProd === true) return t('wk.inProd', { method: t(`wk.method.${wt.method}`, { pr: wt.pr }) });
  if (wt.inProd === false) return t('wk.outside');
  return t('wk.unknownProd');
}

export function renderBoard(board, t, { all = false, san = (x) => String(x) } = {}) {
  const L = [];
  const n = board.repos.reduce((s, r) => s + (r.worktrees || []).length, 0);
  const methods = [...new Set(board.repos.flatMap((r) => r.methods || []))].map((m) => t(`wk.method.${m}`, { pr: 'N' }));
  L.push(t('wk.header', { repos: board.repos.length, worktrees: n, secs: (board.durationMs / 1000).toFixed(1), methods: methods.join(', ') }));
  for (const repo of board.repos) {
    if (repo.error) { L.push(t('wk.repoError', { name: repo.name, error: repo.error, ref: repo.baseRef || '' })); continue; }
    const tot = repo.totals;
    L.push(t('wk.repoLine', { name: repo.name, ref: `${repo.remote}/${repo.production}`, sha: repo.baseSha.slice(0, 7), ...tot }));
    const main = repo.worktrees.find((w) => w.main);
    if (main) {
      const off = main.branch !== repo.production;
      L.push(`  ${t('wk.main', { branch: main.branch || t('wk.detached'), off, prod: repo.production, dirty: dirtyText(t, main) })}`);
    }
    if (repo.prs.state === 'ok') {
      const list = repo.prs.open.map((p) => `#${p.number} ${p.headRefName ? san(p.headRefName) : ''}${p.isDraft ? ` (${t('wk.draft')})` : ''} · ${t('wk.files', { n: Array.isArray(p.files) ? p.files.length : p.files })}`);
      L.push(`  ${list.length ? t('wk.prsOpen', { n: list.length, list: list.join(' · ') }) : t('wk.prsNone')}`);
    } else L.push(`  ${t('wk.prsUnreadable', { reason: t(`wk.reason.${repo.prs.reason}`), detail: repo.prs.detail || '' })}`);
    // Primeiro o que tem commit fora da produção; depois o sujo, do mais rastreado ao menos.
    const attention = repo.worktrees.filter((w) => !w.main && !w.missing && (w.inProd !== true || (w.tracked || 0) + (w.untracked || 0) > 0))
      .sort((a, b) => (a.inProd === false ? 0 : 1) - (b.inProd === false ? 0 : 1) || (b.tracked || 0) - (a.tracked || 0) || (b.untracked || 0) - (a.untracked || 0));
    if (attention.length) {
      L.push(`  ${t('wk.attention', { n: attention.length })}`);
      for (const w of all ? attention : attention.slice(0, MAX_ATTENTION)) {
        const ab = w.ahead == null ? '' : ` · +${w.ahead} −${w.behind}`;
        L.push(`    ${w.display} · ${w.branch ? san(w.branch) : t('wk.detached')} · ${dirtyText(t, w)}${ab} · ${prodText(t, w)}`);
      }
      if (!all && attention.length > MAX_ATTENTION) L.push(`    ${t('wk.more', { n: attention.length - MAX_ATTENTION })}`);
    }
    if (tot.cleanInProd) L.push(`  ${t('wk.cleanInProd', { n: tot.cleanInProd })}`);
    if (tot.missing) L.push(`  ${t('wk.orphans', { n: tot.missing })}`);
    if (repo.collisions.length) {
      L.push(`  ${t('wk.collisions', { n: repo.collisions.length })}`);
      for (const c of all ? repo.collisions : repo.collisions.slice(0, MAX_COLLISIONS)) L.push(`    ${san(c.file)} ← ${c.fronts.join(', ')}`);
      if (!all && repo.collisions.length > MAX_COLLISIONS) L.push(`    ${t('wk.more', { n: repo.collisions.length - MAX_COLLISIONS })}`);
    } else L.push(`  ${t('wk.noCollisions')}`);
  }
  return L.join('\n');
}

/** Uma linha para o SessionStart, a partir do cache. */
export function summaryLine(cache, t, { ageMin = 0, refreshing = false } = {}) {
  const parts = [];
  let prs = 0; const unreadable = [];
  let collisions = 0; let top = null; let dirtyInProd = 0; const mains = [];
  for (const r of cache.repos || []) {
    if (r.error) { unreadable.push(r.name); continue; }
    if (r.prs?.state === 'ok') prs += r.prs.open.length; else unreadable.push(r.name);
    collisions += r.collisionCount ?? (r.collisions || []).length;
    const c = (r.collisions || [])[0];
    if (c && (!top || c.fronts.length > top.n)) top = { file: c.file.split('/').pop(), n: c.fronts.length };
    dirtyInProd += r.totals?.dirtyInProd || 0;
    const main = (r.worktrees || []).find((w) => w.main);
    if (main && (main.branch !== r.production || (main.tracked || 0) > 0)) mains.push(t('wk.hook.main', { name: r.name, branch: main.branch || t('wk.detached'), prod: r.production, off: main.branch !== r.production, dirty: main.tracked || 0 }));
  }
  parts.push(t('wk.hook.prs', { n: prs }));
  if (unreadable.length) parts.push(t('wk.hook.prsUnreadable', { list: unreadable.join(', ') }));
  if (collisions) parts.push(t('wk.hook.collisions', { n: collisions, file: top?.file || '', fronts: top?.n || 2 }));
  if (dirtyInProd) parts.push(t('wk.hook.dirtyInProd', { n: dirtyInProd }));
  parts.push(...mains);
  return t('wk.hook.summary', { parts: parts.join('; '), age: Math.round(ageMin), refreshing, cmd: 'ct work board' });
}

// ── hooks ──────────────────────────────────────────────────────────────────────────────────────

/** Texto do hook (ou ''). Usado pelo `work.mjs --session-start/--stop-report` e pelo adaptador Codex. */
export async function workHookText(cwd, kind, { now = Date.now() } = {}) {
  if (!hasWorkConfig(cwd)) return '';
  const L = await lib();
  const work = L.findWorkConfig(cwd);
  if (!work || !work.hooks) return '';
  const t = await translator(work.lang);
  if (kind === 'session-start') {
    const cache = L.readBoardCache(work.root);
    const ageMin = cache ? (now - Date.parse(cache.generatedAt)) / 60000 : Infinity;
    const refreshing = ageMin > work.cacheMinutes && L.startBackgroundRefresh(work.root, SELF, { now });
    if (!cache) return t('wk.hook.building', { cmd: 'ct work board' });
    return summaryLine(cache, t, { ageMin, refreshing: Boolean(refreshing) });
  }
  const findings = await L.stopFindings(work, cwd, { now });
  const { claimHookEmission } = await import('./lib/hook-output.mjs');
  const lines = [];
  for (const f of findings) {
    // A chave não leva a contagem: no meio da tarefa o número muda a cada turno, e o aviso não deve.
    const key = f.kind === 'session' ? `session:${f.path}` : `main:${f.path}:${f.branch}:${f.offProd}:${Boolean(f.dirty)}`;
    if (!claimHookEmission(work.root, 'Stop:work', key, { windowMs: STOP_WINDOW_MS, now })) continue;
    if (f.kind === 'session') {
      const shown = f.files.slice(0, 4).map((x) => L.sanitizar(x, 80)).join(', ');
      lines.push(t('wk.stop.session', { path: L.displayPath(work.root, f.path), n: f.files.length, files: shown, more: f.files.length > 4 }));
    } else {
      lines.push(t('wk.stop.main', { name: f.name, branch: f.branch ? L.sanitizar(f.branch, 80) : t('wk.detached'), prod: f.production, off: f.offProd, dirty: f.dirty || 0 }));
    }
  }
  return lines.length ? [t('wk.stop.title'), ...lines].join('\n') : '';
}

// ── subcomandos ────────────────────────────────────────────────────────────────────────────────

async function boardCmd(work, args, t) {
  const L = await lib();
  const board = await L.buildBoard(work);
  for (const r of board.repos) {
    if (r.error) continue;
    r.totals = L.boardTotals(r);
    for (const w of r.worktrees) w.display = L.displayPath(work.root, w.path);
  }
  if (!work.implicit) L.writeBoardCache(work.root, board);
  if (flag(args, '--refresh-cache')) { L.clearRefreshLock(work.root); return 0; }
  if (flag(args, '--json')) {
    process.stdout.write(`${JSON.stringify(board, null, 2)}\n`);
    return 0;
  }
  console.log(renderBoard(board, t, { all: flag(args, '--all'), san: (x) => L.sanitizar(x, 100) }));
  return 0;
}

async function newCmd(work, args, t) {
  const L = await lib();
  const [slug] = positional(args);
  if (!L.validSlug(slug)) { console.log(t('wk.new.badSlug', { slug: L.sanitizar(slug || '', 60) })); return 1; }
  const repos = pickRepos(work, args);
  if (!repos.length) { console.log(t('wk.pickRepo', { list: work.repos.map((r) => r.name).join(', ') })); return 1; }
  const files = (value(args, '--files') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const board = L.readBoardCache(work.root);
  const checks = await Promise.all(repos.map((r) => L.similarWork(r, slug, { files, board })));
  let blocked = false; let hard = false;
  for (const [i, c] of checks.entries()) {
    if (!c.hits.length) continue;
    console.log(t('wk.new.similar', { repo: repos[i].name }));
    for (const h of c.hits) {
      console.log(`  ${t(`wk.hit.${h.kind}`, { ...h, files: (h.files || []).join(', '), fronts: (h.fronts || []).join(', ') })}`);
      if (h.exact) hard = true;
    }
    blocked = true;
  }
  if (hard) { console.log(t('wk.new.exact')); return 2; }
  if (blocked && !flag(args, '--anyway', '--mesmo-assim')) { console.log(t('wk.new.blocked')); return 2; }
  let code = 0;
  for (const r of repos) {
    const res = await L.createWorktree(r, slug);
    if (res.ok) console.log(t('wk.new.created', { repo: r.name, dir: L.displayPath(work.root, res.dir), branch: res.branch, base: `${r.remote}/${r.production}` }));
    else { code = 1; console.log(t('wk.new.failed', { repo: r.name, error: res.error, detail: res.detail || '' })); }
  }
  if (!code) console.log(t('wk.new.next', { slug, both: repos.length > 1 }));
  return code;
}

async function prCmd(work, args, t) {
  const L = await lib();
  const [slug] = positional(args);
  if (!L.validSlug(slug)) { console.log(t('wk.new.badSlug', { slug: L.sanitizar(slug || '', 60) })); return 1; }
  const repos = pickRepos(work, args);
  if (!repos.length) { console.log(t('wk.pickRepo', { list: work.repos.map((r) => r.name).join(', ') })); return 1; }
  const depends = [];
  let code = 0;
  for (const r of repos) {
    const wt = await L.findWorktree(r, { slug });
    if (!wt) { console.log(t('wk.notFound', { repo: r.name, slug })); code = 1; continue; }
    const res = await L.openDraftPr(r, wt, { slug, title: value(args, '--title'), depends: [...depends] });
    if (res.ok) { console.log(t(res.existing ? 'wk.pr.existing' : 'wk.pr.created', { repo: r.name, ref: res.ref, url: res.url })); if (res.ref) depends.push(res.ref); }
    else { code = 1; console.log(t('wk.pr.failed', { repo: r.name, error: t(`wk.err.${res.error}`), detail: res.detail || '' })); }
  }
  return code;
}

async function closeCmd(work, args, t) {
  const L = await lib();
  const [slug] = positional(args);
  if (slug && !L.validSlug(slug)) { console.log(t('wk.new.badSlug', { slug: L.sanitizar(slug, 60) })); return 1; }
  const picked = slug ? pickRepos(work, args) : [];
  const repos = picked.length ? picked : work.repos.filter((r) => !r.error);
  let found = 0; let code = 0;
  for (const r of repos) {
    const wt = await L.findWorktree(r, slug ? { slug } : { cwd: process.cwd() });
    if (!wt) continue;
    found++;
    const res = await L.closeWorktree(r, wt, { skipPr: flag(args, '--no-pr-check'), dryRun: flag(args, '--dry-run') });
    const where = `${r.name}: ${L.displayPath(work.root, wt.path)}`;
    if (res.refusals.length) {
      code = 2;
      console.log(t('wk.close.refused', { where }));
      for (const x of res.refusals) console.log(`  ${t(`wk.close.${x.code}`, { ...x, files: (x.files || []).slice(0, 10).join(', '), more: Math.max(0, (x.files || []).length - 10), items: (x.items || []).join(' · ') })}`);
      continue;
    }
    if (flag(args, '--dry-run')) { console.log(t('wk.close.wouldRemove', { where, method: t(`wk.method.${res.method}`, { pr: res.pr }) })); continue; }
    console.log(t('wk.close.ok', { where, method: t(`wk.method.${res.method}`, { pr: res.pr }), pr: res.pr || '', noPr: Boolean(res.noPr) }));
    if (res.branchKept) console.log(`  ${t('wk.close.branchKept', { branch: res.branch })}`);
  }
  if (!found) { console.log(t('wk.notFound', { repo: repos.map((r) => r.name).join(', ') || '—', slug: slug || '.' })); return 1; }
  return code;
}

async function tidyCmd(work, args, t) {
  const L = await lib();
  const board = await L.buildBoard(work);
  if (!work.implicit) { for (const r of board.repos) if (!r.error) r.totals = L.boardTotals(r); L.writeBoardCache(work.root, board); }
  const plan = L.tidyPlan(board);
  const apply = flag(args, '--apply', '--aplicar');
  const details = new Map();
  const dirtyAll = plan.flatMap((p) => p.dirty);
  const sums = await L.pool(dirtyAll, 8, (w) => L.dirtySummary(w));
  dirtyAll.forEach((w, i) => details.set(w.path, sums[i]));
  if (flag(args, '--json') && !apply) {
    process.stdout.write(`${JSON.stringify(plan.map((p) => ({ ...p, dirty: p.dirty.map((w) => ({ ...w, summary: details.get(w.path) })) })), null, 2)}\n`);
    return 0;
  }
  const dp = (p) => L.displayPath(work.root, p);
  const br = (w) => (w.branch ? L.sanitizar(w.branch, 80) : t('wk.detached'));
  for (const p of plan) {
    if (p.error) { console.log(t('wk.repoError', { name: p.name, error: p.error, ref: '' })); continue; }
    console.log(t('wk.tidy.repo', { name: p.name, prod: p.production }));
    if (p.mainCheckout && (p.mainCheckout.branch !== p.production || (p.mainCheckout.tracked || 0) + (p.mainCheckout.untracked || 0))) {
      console.log(`  ${t('wk.main', { branch: p.mainCheckout.branch || t('wk.detached'), off: p.mainCheckout.branch !== p.production, prod: p.production, dirty: dirtyText(t, p.mainCheckout) })}`);
    }
    console.log(`  ${t('wk.tidy.removable', { n: p.removable.length })}`);
    for (const w of p.removable) console.log(`    ${dp(w.path)} · ${br(w)} · ${t(`wk.method.${w.method}`, { pr: w.pr })}`);
    // Mudança rastreada primeiro: é o trabalho de verdade. Só arquivo novo costuma ser estado de
    // ferramenta fora do .gitignore — o humano decide mais rápido vendo os dois separados.
    const real = p.dirty.filter((w) => w.tracked > 0).sort((a, b) => b.tracked - a.tracked);
    const onlyNew = p.dirty.filter((w) => !(w.tracked > 0));
    console.log(`  ${t('wk.tidy.dirty', { n: p.dirty.length, real: real.length, onlyNew: onlyNew.length })}`);
    for (const [i, w] of [...real, ...onlyNew].entries()) {
      if (i === real.length && onlyNew.length) console.log(`    ${t('wk.tidy.onlyNew', { n: onlyNew.length })}`);
      const s = details.get(w.path);
      console.log(`    ${dp(w.path)} · ${br(w)} · ${dirtyText(t, w)} · ${prodText(t, w)}${s.shortstat ? ` · ${s.shortstat}` : ''}`);
      const shown = [...s.tracked, ...s.untracked.map((f) => `${f} (${t('wk.new')})`)];
      if (shown.length) console.log(`      ${shown.join(', ')}${s.more ? ` ${t('wk.more', { n: s.more })}` : ''}`);
    }
    if (p.dirty.length) console.log(`    ${t('wk.tidy.dirtyHint')}`);
    console.log(`  ${t('wk.tidy.keep', { n: p.keep.length })}`);
    for (const w of p.keep) console.log(`    ${dp(w.path)} · ${br(w)} · +${w.ahead ?? '?'} −${w.behind ?? '?'} · ${prodText(t, w)}`);
    if (p.orphan.length) console.log(`  ${t('wk.tidy.orphan', { n: p.orphan.length })}`);
    if (apply && p.removable.length) {
      const repo = work.repos.find((r) => r.name === p.name);
      for (const res of await L.applyRemovals(repo, p.removable)) {
        console.log(`    ${res.removed ? t('wk.tidy.removed', { path: dp(res.path), branch: res.branch }) : t('wk.tidy.skipped', { path: dp(res.path), why: res.skipped, detail: res.detail || '' })}`);
      }
    }
  }
  if (!apply) console.log(t('wk.tidy.applyHint'));
  return 0;
}

async function rescueCmd(work, args, t) {
  const L = await lib();
  const [target] = positional(args);
  if (!target) { console.log(t('wk.usage')); return 1; }
  for (const r of work.repos.filter((x) => !x.error)) {
    const wt = L.validSlug(target) ? await L.findWorktree(r, { slug: target }) || await L.findWorktree(r, { path: resolve(target) }) : await L.findWorktree(r, { path: resolve(target) });
    if (!wt) continue;
    if (wt.main) { console.log(t('wk.rescue.main')); return 2; }
    const res = await L.rescueWorktree(wt);
    console.log(res.ok
      ? t('wk.rescue.ok', { where: L.displayPath(work.root, wt.path), branch: res.branch, sha: res.sha.slice(0, 7), n: res.files })
      : t('wk.rescue.failed', { where: L.displayPath(work.root, wt.path), error: res.error, detail: res.detail || '' }));
    return res.ok ? 0 : 1;
  }
  console.log(t('wk.notFound', { repo: work.repos.map((r) => r.name).join(', '), slug: target }));
  return 1;
}

async function main(argv = process.argv.slice(2)) {
  const root = resolveRoot(argv);
  if (argv.includes('--session-start') || argv.includes('--stop-report')) {
    const kind = argv.includes('--session-start') ? 'session-start' : 'stop';
    if (!hasWorkConfig(root)) return 0;
    const { readClaudeStopContinuation } = await import('./lib/hook-input.mjs');
    if (kind === 'stop' && await readClaudeStopContinuation(runtimeHost())) return 0;
    const text = await workHookText(root, kind);
    if (text) {
      const { writeHookOutput } = await import('./lib/hook-output.mjs');
      writeHookOutput(root, { hookSpecificOutput: { hookEventName: kind === 'stop' ? 'Stop' : 'SessionStart', additionalContext: text } });
    }
    return 0;
  }
  const [first, ...rest] = argv.filter((a) => !a.startsWith('--root='));
  const sub = SUB[first];
  const work = await loadWork(root);
  const t = await translator(work?.lang);
  if (!sub) { console.log(t('wk.usage')); return first && !['help', '--help', '-h'].includes(first) ? 1 : 0; }
  if (!work) { console.log(t('wk.noRepo')); return 1; }
  const run = { board: boardCmd, new: newCmd, pr: prCmd, close: closeCmd, tidy: tidyCmd, rescue: rescueCmd }[sub];
  return run(work, rest, t);
}

if (isMain(import.meta.url)) {
  const hook = process.argv.includes('--session-start') || process.argv.includes('--stop-report');
  let code = 0;
  try { code = await main(); } catch (error) {
    // Hook nunca derruba a sessão; comando manual mostra o erro.
    if (!hook) { console.log(`work: ${error?.message || error}`); code = 1; }
  }
  if (hook) {
    const { exitWhenFlushed } = await import('./lib/hook-output.mjs');
    exitWhenFlushed(0);
  } else process.exitCode = code;
}

