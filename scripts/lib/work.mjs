// 🧭 Trabalho git em paralelo: vários agentes, várias branches, vários worktrees, um checkout só.
//
// O problema que isto resolve não é de git, é de visibilidade: com N sessões de agente abertas,
// cada uma cria seu worktree e sua branch, e ninguém vê o conjunto. Trabalho fica esquecido num
// worktree sujo, duas PRs mexem no mesmo arquivo sem saber uma da outra, e o status "falta
// migration" mora numa nota que defasa. Este módulo monta o painel (`board`), cria e encerra
// worktrees com regra (`createWorktree`, `closeWorktree`) e propõe a triagem do que já existe (`tidyPlan`).
//
// Regras de segurança (classe de bug recorrente neste plugin):
//   - Nome de branch, caminho de worktree e título de PR vêm do REPOSITÓRIO, não de nós. Tudo que vai
//     para a linha de comando do git antes do `--` passa por `refSeguro`; o que vai para a tela passa
//     por `sanitizar`. Sempre que dá, o git recebe o SHA do tip (40 hex), nunca o nome da branch.
//   - Caminho de worktree nunca vira argumento solto: entra como `cwd` do processo, ou depois do `--`.
//   - Leitura não escreve: todo git roda com GIT_OPTIONAL_LOCKS=0 (o `status` não regrava o índice).
//   - Nada de `reset --hard`, `clean`, `--force`, `branch -D` ou apagar pasta. Quem descarta é o humano.

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadConfig, safe, statePath } from './roots.mjs';
import { refSeguro, sanitizar } from '../context-maps.mjs';

export { refSeguro, sanitizar };

export const CACHE_FILE = '.work-board.json';
const STOP_STATE_FILE = '.work-stop.json';
const DEFAULT_TTL_MIN = 30;
const CONCURRENCY = 8;
const MAX_PROD_PATCH_IDS = 300;
const MAX_CONTENT_FILES = 200;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

// ── execução ───────────────────────────────────────────────────────────────────────────────────

const ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };

/** Um processo, sem shell. Nunca lança: devolve `{ ok, code, stdout, stderr, missing }`. */
export function run(cmd, args, { cwd, timeout = 30000, input } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = execFile(cmd, args, {
        cwd, encoding: 'utf8', maxBuffer: 256 << 20, timeout, windowsHide: true, env: { ...process.env, ...ENV },
      }, (err, stdout, stderr) => done({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        missing: err?.code === 'ENOENT',
        timedOut: Boolean(err?.killed),
        stdout: stdout || '',
        stderr: stderr || '',
      }));
    } catch (error) {
      done({ ok: false, code: 1, missing: error?.code === 'ENOENT', stdout: '', stderr: String(error?.message || error) });
      return;
    }
    if (input != null) child.stdin.end(input);
  });
}

const git = (cwd, args, opts) => run('git', args, { cwd, ...opts });

// CONTEXT_TOOLS_GH aponta para um gh falso (um .mjs) nos testes: a suíte nunca fala com o GitHub.
function gh(args, opts) {
  const fake = process.env.CONTEXT_TOOLS_GH;
  return fake ? run(process.execPath, [fake, ...args], opts) : run('gh', args, opts);
}

/** `fn` sobre cada item com no máximo `n` em voo — centenas de worktrees × ~1 s de `status` cada no Windows. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const firstLine = (s) => sanitizar(String(s || '').split(/\r?\n/).find((l) => l.trim()) || '', 160);
const norm = (p) => String(p || '').replace(/\\/g, '/');

// ── configuração ───────────────────────────────────────────────────────────────────────────────

/**
 * Procura `work.repos` na config da pasta e das pastas acima. Uma sessão aberta DENTRO de um
 * worktree (`<raiz>/.worktrees/api-x`) precisa achar a config do workspace, dois níveis acima.
 */
export function findWorkConfig(start, { env = process.env, maxUp = 8 } = {}) {
  let dir = resolve(start || '.');
  for (let i = 0; i < maxUp; i++) {
    const cfg = loadConfig(dir, env);
    if (Array.isArray(cfg?.work?.repos) && cfg.work.repos.length) {
      return { root: dir, lang: cfg.lang, ...normalizeWork(dir, cfg.work) };
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Valida cada repo da config. Repo com campo recusado entra com `error`, nunca é usado às cegas. */
export function normalizeWork(root, work = {}) {
  const worktreeRoot = typeof work.worktreeRoot === 'string' && work.worktreeRoot ? work.worktreeRoot : '.worktrees';
  const repos = (work.repos || []).map((r, i) => {
    const raw = typeof r === 'string' ? { path: r } : (r || {});
    const path = resolve(root, String(raw.path || ''));
    const name = String(raw.name || basename(path));
    const repo = {
      name,
      path,
      remote: String(raw.remote || 'origin'),
      production: String(raw.production || 'main'),
      worktreeRoot: resolve(root, String(raw.worktreeRoot || worktreeRoot)),
      branchPrefix: typeof raw.branchPrefix === 'string' ? raw.branchPrefix : (typeof work.branchPrefix === 'string' ? work.branchPrefix : ''),
      github: typeof raw.github === 'string' ? raw.github : '',
      prTemplate: Array.isArray(raw.prTemplate) ? raw.prTemplate.join('\n') : (typeof raw.prTemplate === 'string' ? raw.prTemplate : (Array.isArray(work.prTemplate) ? work.prTemplate.join('\n') : (work.prTemplate || ''))),
      checklist: (Array.isArray(raw.checklist) ? raw.checklist : (Array.isArray(work.checklist) ? work.checklist : [])).map(String),
      index: i,
    };
    if (!raw.path) repo.error = 'path';
    else if (!refSeguro(repo.remote)) repo.error = 'remote';
    else if (!refSeguro(repo.production)) repo.error = 'production';
    else if (!SLUG_RE.test(name.replace(/[^A-Za-z0-9._-]/g, '-'))) repo.error = 'name';
    else if (repo.branchPrefix && !refSeguro(`${repo.branchPrefix}x`)) repo.error = 'branchPrefix';
    else if (repo.github && !/^[\w.-]+\/[\w.-]+$/.test(repo.github)) repo.error = 'github';
    return repo;
  });
  const ttl = Number(work.cacheMinutes);
  return { repos, cacheMinutes: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MIN, hooks: work.hooks !== false };
}

/** Sem config: o repo da pasta atual, produção = `origin/HEAD` (ou `main`). */
export async function implicitWork(start) {
  const top = await git(start, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return null;
  const path = resolve(top.stdout.trim());
  const head = await git(path, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  const prod = head.ok ? head.stdout.trim().replace(/^origin\//, '') : 'main';
  // Num worktree, o "repo" é o checkout principal: é dele a lista de worktrees.
  const common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const mainPath = common.ok && basename(common.stdout.trim()) === '.git' ? dirname(resolve(common.stdout.trim())) : path;
  return { root: dirname(mainPath), implicit: true, ...normalizeWork(dirname(mainPath), { repos: [{ path: mainPath, production: refSeguro(prod) ? prod : 'main' }] }) };
}

// ── parsers ────────────────────────────────────────────────────────────────────────────────────

/** `git worktree list --porcelain` → lista. O primeiro bloco é sempre o checkout principal. */
export function parseWorktrees(text) {
  const out = [];
  for (const block of String(text || '').split(/\r?\n\r?\n/)) {
    const wt = {};
    for (const line of block.split(/\r?\n/)) {
      const sp = line.indexOf(' ');
      const key = sp < 0 ? line : line.slice(0, sp);
      const val = sp < 0 ? '' : line.slice(sp + 1);
      if (key === 'worktree') wt.path = resolve(val);
      else if (key === 'HEAD') wt.head = val;
      else if (key === 'branch') wt.branch = val.replace(/^refs\/heads\//, '');
      else if (key === 'detached') wt.detached = true;
      else if (key === 'bare') wt.bare = true;
      else if (key === 'locked') wt.locked = val || true;
      else if (key === 'prunable') wt.prunable = val || true;
    }
    if (wt.path) out.push({ ...wt, main: out.length === 0 });
  }
  return out;
}

/** `git status --porcelain=v1 -z` → rastreados × novos, com a lista. */
export function parseStatus(text) {
  const parts = String(text || '').split('\0');
  const tracked = [];
  const untracked = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const file = e.slice(3);
    if (xy === '??') untracked.push(file);
    else if (xy !== '!!') tracked.push(file);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // a origem do rename vem no campo seguinte
  }
  return { tracked, untracked };
}

/** URL do remoto → `dono/repo` do GitHub, ou '' (sem credencial na conta, sem host estranho). */
export function githubSlugFromUrl(url) {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : '';
}

/** Itens `- [ ] …` de um corpo de PR. */
export function uncheckedItems(body) {
  return String(body || '').split(/\r?\n/)
    .map((l) => /^\s*[-*]\s+\[ \]\s+(.*)$/.exec(l)?.[1])
    .filter(Boolean)
    .map((s) => sanitizar(s, 120));
}

const tokens = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !/^(feat|fix|chore|docs|wip|refactor|work|rescue|\d+)$/.test(t)));

/** Semelhança de nomes: Jaccard dos termos, sem os prefixos de tipo (`feat/`, `fix/`). */
export function nameSimilarity(a, b) {
  const x = tokens(a); const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

export function validSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

// ── GitHub (gh) ────────────────────────────────────────────────────────────────────────────────

/**
 * PRs de um repo. `state: 'ok'` com lista vazia é "zero PRs"; qualquer falha é `unavailable` com o
 * motivo — o painel diz "não consegui ler PRs", nunca mostra zero no lugar de "não sei".
 */
export async function readPullRequests(repo, { state = 'open', fields, limit = 100 } = {}) {
  const slug = repo.github || await remoteSlug(repo);
  if (!slug) return { state: 'unavailable', reason: 'not-github', prs: [] };
  const json = fields || (state === 'open'
    ? 'number,title,headRefName,headRefOid,baseRefName,isDraft,url,files'
    : 'number,title,headRefName,headRefOid,state,mergedAt,url,body');
  const r = await gh(['pr', 'list', '-R', slug, `--state=${state}`, `--limit=${limit}`, `--json=${json}`], { cwd: repo.path, timeout: 30000 });
  if (r.missing) return { state: 'unavailable', reason: 'no-gh', slug, prs: [] };
  if (!r.ok) return { state: 'unavailable', reason: r.timedOut ? 'timeout' : 'gh-error', detail: firstLine(r.stderr), slug, prs: [] };
  const prs = safe(() => JSON.parse(r.stdout), null);
  if (!Array.isArray(prs)) return { state: 'unavailable', reason: 'gh-error', detail: 'json', slug, prs: [] };
  return { state: 'ok', slug, prs };
}

async function remoteSlug(repo) {
  const r = await git(repo.path, ['remote', 'get-url', repo.remote]);
  return r.ok ? githubSlugFromUrl(r.stdout) : '';
}

// ── "já está na produção?" ─────────────────────────────────────────────────────────────────────

/**
 * Ancestralidade sozinha falha com squash-merge e rebase: o commit da branch nunca entra na
 * produção, só um equivalente. Os métodos vão do mais forte ao mais fraco e o primeiro que
 * confirma é o que o painel mostra:
 *   ancestry  o tip é ancestral da produção (merge comum, fast-forward)
 *   pr        PR mergeada com esta branch e este MESMO tip (gh); commit local depois do merge não conta
 *   cherry    cada commit da branch tem equivalente na produção (`git cherry`: rebase, cherry-pick)
 *   squash    o diff inteiro da branch tem o patch-id de um commit recente da produção
 *   content   todo arquivo que a branch mudou está idêntico na produção
 */
export async function productionCheck(repo, wt, ctx) {
  const tip = wt.head;
  if (!SHA_RE.test(tip || '')) return { inProd: null, method: 'unknown' };
  if (tip === ctx.baseSha) return { inProd: true, method: 'ancestry' };
  const anc = await git(repo.path, ['merge-base', '--is-ancestor', tip, ctx.baseSha]);
  if (anc.ok) return { inProd: true, method: 'ancestry' };
  if (anc.code !== 1) return { inProd: null, method: 'unknown' };
  const pr = wt.branch && ctx.mergedByBranch?.get(wt.branch);
  if (pr && pr.headRefOid === tip) return { inProd: true, method: 'pr', pr: pr.number };
  const cherry = await git(repo.path, ['cherry', ctx.baseSha, tip]);
  const lines = cherry.stdout.split(/\r?\n/).filter(Boolean);
  if (cherry.ok && lines.length && lines.every((l) => l.startsWith('-'))) return { inProd: true, method: 'cherry' };
  const mb = await git(repo.path, ['merge-base', ctx.baseSha, tip]);
  const base = mb.stdout.trim();
  if (!mb.ok || !SHA_RE.test(base)) return { inProd: false, method: 'none' };
  const diff = await git(repo.path, ['diff', '--no-color', '--no-ext-diff', base, tip]);
  if (diff.ok && diff.stdout) {
    const id = (await git(repo.path, ['patch-id', '--stable'], { input: diff.stdout })).stdout.split(' ')[0];
    if (id && (await ctx.prodPatchIds()).has(id)) return { inProd: true, method: 'squash' };
  }
  const names = (await git(repo.path, ['diff', '--name-only', base, tip])).stdout.split(/\r?\n/).filter(Boolean);
  if (names.length && names.length <= MAX_CONTENT_FILES) {
    const same = await git(repo.path, ['--literal-pathspecs', 'diff', '--quiet', '--no-ext-diff', tip, ctx.baseSha, '--', ...names]);
    if (same.ok) return { inProd: true, method: 'content' };
  }
  return { inProd: false, method: 'none' };
}

/** Patch-ids dos últimos commits da produção, calculado uma vez por repo e só se alguém precisar. */
function lazyProdPatchIds(repo, baseSha) {
  let memo = null;
  return () => {
    memo ||= (async () => {
      const log = await git(repo.path, ['log', '-p', '--no-merges', '--no-color', '--no-ext-diff', `-n${MAX_PROD_PATCH_IDS}`, baseSha]);
      if (!log.ok || !log.stdout) return new Set();
      const ids = await git(repo.path, ['patch-id', '--stable'], { input: log.stdout });
      return new Set(ids.stdout.split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean));
    })();
    return memo;
  };
}

// ── painel ─────────────────────────────────────────────────────────────────────────────────────

async function worktreeState(repo, wt, ctx) {
  if (wt.prunable || wt.bare || !existsSync(wt.path)) return { ...wt, missing: true };
  const [st, ab] = await Promise.all([
    git(wt.path, ['status', '--porcelain=v1', '-z', '-unormal']),
    SHA_RE.test(wt.head || '') ? git(repo.path, ['rev-list', '--left-right', '--count', `${ctx.baseSha}...${wt.head}`]) : Promise.resolve({ ok: false }),
  ]);
  const status = st.ok ? parseStatus(st.stdout) : null;
  const [behind, ahead] = ab.ok ? ab.stdout.trim().split(/\s+/).map(Number) : [null, null];
  const prod = await productionCheck(repo, wt, ctx);
  let changed = [];
  if (prod.inProd === false && SHA_RE.test(wt.head || '')) {
    changed = (await git(repo.path, ['diff', '--name-only', `${ctx.baseSha}...${wt.head}`])).stdout.split(/\r?\n/).filter(Boolean);
  }
  return {
    ...wt,
    statusError: status ? undefined : firstLine(st.stderr) || 'status',
    tracked: status ? status.tracked.length : null,
    untracked: status ? status.untracked.length : null,
    dirtyFiles: status ? [...status.tracked, ...status.untracked] : [],
    dirtyTracked: status ? status.tracked : [],
    ahead, behind, ...prod, changed,
  };
}

/** Arquivo → frentes que o tocam, só onde há 2+. Uma frente = branch/worktree/PR ainda não na produção, ou sujo. */
export function intersections(items) {
  const byFile = new Map();
  for (const item of items) {
    for (const f of new Set(item.files)) {
      if (!byFile.has(f)) byFile.set(f, new Set());
      byFile.get(f).add(item.label);
    }
  }
  return [...byFile.entries()]
    .filter(([, s]) => s.size >= 2)
    .map(([file, s]) => ({ file, fronts: [...s].sort() }))
    .sort((a, b) => b.fronts.length - a.fronts.length || a.file.localeCompare(b.file));
}

function frontsOf(worktrees, openPrs) {
  const fronts = new Map();
  const add = (key, label, files, extra = {}) => {
    const cur = fronts.get(key) || { label, files: [], ...extra };
    cur.files.push(...files);
    Object.assign(cur, extra);
    fronts.set(key, cur);
  };
  for (const wt of worktrees) {
    if (wt.missing) continue;
    // Só arquivo RASTREADO: novo não versionado (estado de ferramenta, pasta de build) não colide em merge.
    const files = [...(wt.inProd === false ? wt.changed : []), ...(wt.dirtyTracked || [])];
    if (!files.length) continue;
    const key = wt.branch ? `b:${wt.branch}` : `p:${wt.path}`;
    add(key, sanitizar(wt.branch || `(detached) ${basename(wt.path)}`, 80), files);
  }
  for (const pr of openPrs) {
    const key = `b:${pr.headRefName}`;
    const files = (pr.files || []).map((f) => f.path).filter(Boolean);
    const label = sanitizar(pr.headRefName, 80);
    add(key, label, files, { pr: pr.number });
  }
  return [...fronts.values()].map((f) => ({ ...f, label: f.pr ? `${f.label} (#${f.pr})` : f.label }));
}

/** Painel de UM repo. Nunca faz fetch: compara com o `<remoto>/<produção>` local. */
export async function repoBoard(repo) {
  const out = { name: repo.name, path: repo.path, remote: repo.remote, production: repo.production };
  if (repo.error) return { ...out, error: `config:${repo.error}` };
  if (!existsSync(repo.path)) return { ...out, error: 'missing' };
  const baseRef = `refs/remotes/${repo.remote}/${repo.production}`;
  const [list, base, openPr, mergedPr] = await Promise.all([
    git(repo.path, ['worktree', 'list', '--porcelain']),
    git(repo.path, ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`]),
    readPullRequests(repo, { state: 'open' }),
    readPullRequests(repo, { state: 'merged', fields: 'number,headRefName,headRefOid,mergedAt', limit: 300 }),
  ]);
  if (!list.ok) return { ...out, error: firstLine(list.stderr) || 'git' };
  const baseSha = base.stdout.trim();
  if (!SHA_RE.test(baseSha)) return { ...out, error: 'no-production-ref', baseRef };
  const mergedByBranch = new Map();
  for (const pr of mergedPr.prs) if (pr.headRefName && !mergedByBranch.has(pr.headRefName)) mergedByBranch.set(pr.headRefName, pr);
  const ctx = { baseSha, mergedByBranch, prodPatchIds: lazyProdPatchIds(repo, baseSha) };
  const worktrees = await pool(parseWorktrees(list.stdout), CONCURRENCY, (wt) => worktreeState(repo, wt, ctx));
  const openPrs = openPr.prs.map((pr) => ({
    number: pr.number, title: sanitizar(pr.title, 100), headRefName: String(pr.headRefName || ''), baseRefName: sanitizar(pr.baseRefName, 60),
    isDraft: Boolean(pr.isDraft), url: sanitizar(pr.url, 200), files: (pr.files || []).map((f) => ({ path: String(f.path || '') })),
  }));
  const methods = new Set(['ancestry', 'cherry', 'squash', 'content']);
  if (mergedPr.state === 'ok') methods.add('pr');
  return {
    ...out,
    baseRef, baseSha,
    prs: { state: openPr.state, reason: openPr.reason, detail: openPr.detail, slug: openPr.slug, open: openPrs },
    mergedPrs: { state: mergedPr.state, reason: mergedPr.reason, count: mergedPr.prs.length },
    methods: [...methods],
    worktrees,
    collisions: intersections(frontsOf(worktrees, openPrs)),
  };
}

export async function buildBoard(work) {
  const started = Date.now();
  const repos = await Promise.all(work.repos.map((r) => repoBoard(r)));
  return { schema: 1, root: work.root, generatedAt: new Date().toISOString(), durationMs: Date.now() - started, repos };
}

export function boardTotals(repo) {
  const w = (repo.worktrees || []).filter((x) => !x.missing);
  const dirty = (x) => (x.tracked || 0) + (x.untracked || 0) > 0;
  return {
    worktrees: w.length,
    dirty: w.filter(dirty).length,
    inProd: w.filter((x) => x.inProd === true).length,
    ancestry: w.filter((x) => x.method === 'ancestry').length,
    outside: w.filter((x) => x.inProd === false).length,
    dirtyInProd: w.filter((x) => dirty(x) && x.inProd === true).length,
    cleanInProd: w.filter((x) => !dirty(x) && x.inProd === true && !x.main).length,
    missing: (repo.worktrees || []).filter((x) => x.missing).length,
  };
}

// ── cache (para os hooks) ──────────────────────────────────────────────────────────────────────

export function cachePath(root) { return statePath(root, CACHE_FILE); }

export function readBoardCache(root) {
  return safe(() => JSON.parse(readFileSync(cachePath(root), 'utf8')), null);
}

/** Grava o cache SEM as listas de arquivos (só o que o resumo usa), troca atômica. */
export function writeBoardCache(root, board) {
  const slim = {
    ...board,
    repos: board.repos.map((r) => ({
      ...r,
      worktrees: (r.worktrees || []).map(({ dirtyFiles, dirtyTracked, changed, ...rest }) => rest),
      prs: r.prs ? { ...r.prs, open: (r.prs.open || []).map(({ files, ...rest }) => ({ ...rest, files: (files || []).length })) } : r.prs,
      collisions: (r.collisions || []).slice(0, 30),
      collisionCount: (r.collisions || []).length,
    })),
  };
  const file = cachePath(root);
  safe(() => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(slim));
    renameSync(tmp, file);
  }, null);
}

/** Dispara a atualização do cache num processo solto. A marca vem ANTES: duas sessões, uma busca. */
export function startBackgroundRefresh(root, script, { now = Date.now() } = {}) {
  const lock = statePath(root, `${CACHE_FILE}.refreshing`);
  const age = safe(() => now - Number(readFileSync(lock, 'utf8')), Infinity);
  if (age < 10 * 60 * 1000) return false;
  safe(() => { mkdirSync(dirname(lock), { recursive: true }); writeFileSync(lock, String(now)); }, null);
  safe(() => {
    const child = spawn(process.execPath, [script, 'board', '--refresh-cache', `--root=${root}`], {
      cwd: root, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env },
    });
    child.unref();
  }, null);
  return true;
}

export function clearRefreshLock(root) {
  safe(() => unlinkSync(statePath(root, `${CACHE_FILE}.refreshing`)), null);
}

// ── Stop: o que esta sessão deixou para trás ───────────────────────────────────────────────────

/** Estado do checkout da sessão e dos checkouts principais. Os principais, no máximo a cada 10 min. */
export async function stopFindings(work, cwd, { now = Date.now(), throttleMs = 10 * 60 * 1000 } = {}) {
  const findings = [];
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  const session = top.ok ? resolve(top.stdout.trim()) : null;
  const mains = new Set(work.repos.map((r) => resolve(r.path).toLowerCase()));
  if (session) {
    const st = await git(session, ['status', '--porcelain=v1', '-z', '-unormal']);
    if (st.ok) {
      const s = parseStatus(st.stdout);
      const files = [...s.tracked, ...s.untracked];
      if (files.length && !mains.has(session.toLowerCase())) findings.push({ kind: 'session', path: session, files });
    }
  }
  const stateFile = statePath(work.root, STOP_STATE_FILE);
  const prev = safe(() => JSON.parse(readFileSync(stateFile, 'utf8')), null);
  let mainState = prev && now - (prev.at || 0) < throttleMs ? prev.mains : null;
  if (!mainState) {
    mainState = await Promise.all(work.repos.filter((r) => !r.error && existsSync(r.path)).map(async (r) => {
      const [head, st] = await Promise.all([
        git(r.path, ['symbolic-ref', '-q', '--short', 'HEAD']),
        git(r.path, ['status', '--porcelain=v1', '-z', '-uno']),
      ]);
      return { name: r.name, path: r.path, production: r.production, branch: head.ok ? head.stdout.trim() : null, dirty: st.ok ? parseStatus(st.stdout).tracked.length : null };
    }));
    safe(() => { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify({ at: now, mains: mainState })); }, null);
  }
  for (const m of mainState) {
    const offProd = m.branch !== m.production;
    if (offProd || m.dirty) findings.push({ kind: 'main', ...m, offProd });
  }
  return findings;
}

// ── criar / encerrar / triagem ─────────────────────────────────────────────────────────────────

export function worktreeDirFor(repo, slug) {
  return join(repo.worktreeRoot, `${repo.name.replace(/[^A-Za-z0-9._-]/g, '-')}-${slug}`);
}

export function branchFor(repo, slug) { return `${repo.branchPrefix}${slug}`; }

/** Branch, worktree ou PR com nome parecido, e frentes que já tocam os arquivos pedidos. */
export async function similarWork(repo, slug, { files = [], board = null } = {}) {
  const branch = branchFor(repo, slug);
  const dir = worktreeDirFor(repo, slug);
  const hits = [];
  const [list, refs, prs] = await Promise.all([
    git(repo.path, ['worktree', 'list', '--porcelain']),
    git(repo.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    readPullRequests(repo, { state: 'open', fields: 'number,title,headRefName,files' }),
  ]);
  const seen = new Set();
  const consider = (kind, name, extra = {}) => {
    const key = `${kind}:${name}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    const exact = name === branch;
    const score = exact ? 1 : Math.max(nameSimilarity(slug, name), nameSimilarity(slug, extra.title || ''));
    if (exact || score >= 0.5) hits.push({ kind, name: sanitizar(name, 100), exact, score: Math.round(score * 100) / 100, ...extra });
  };
  for (const wt of parseWorktrees(list.stdout)) {
    if (resolve(wt.path).toLowerCase() === resolve(dir).toLowerCase()) hits.push({ kind: 'worktree-path', name: sanitizar(wt.path, 160), exact: true, score: 1 });
    consider('worktree', wt.branch || '', { path: sanitizar(wt.path, 160) });
  }
  for (const b of refs.stdout.split(/\r?\n/).filter(Boolean)) consider('branch', b);
  for (const pr of prs.prs) consider('pr', pr.headRefName, { pr: pr.number, title: sanitizar(pr.title, 100) });
  if (existsSync(dir) && !hits.some((h) => h.kind === 'worktree-path')) hits.push({ kind: 'dir', name: sanitizar(dir, 160), exact: true, score: 1 });
  const wanted = new Set(files.map(norm));
  if (wanted.size) {
    for (const pr of prs.prs) {
      const touched = (pr.files || []).map((f) => f.path).filter((p) => wanted.has(p));
      if (touched.length) hits.push({ kind: 'pr-files', name: sanitizar(pr.headRefName, 100), pr: pr.number, files: touched.map((f) => sanitizar(f, 120)), exact: false, score: 0 });
    }
    const cached = board?.repos?.find((r) => r.name === repo.name);
    for (const c of cached?.collisions || []) if (wanted.has(c.file)) hits.push({ kind: 'collision', name: sanitizar(c.file, 120), fronts: c.fronts, exact: false, score: 0 });
  }
  return { branch, dir, hits, prs: { state: prs.state, reason: prs.reason } };
}

/** `git fetch` + `git worktree add` a partir de `<remoto>/<produção>`, sem rastrear a produção. */
export async function createWorktree(repo, slug) {
  const branch = branchFor(repo, slug);
  const dir = worktreeDirFor(repo, slug);
  if (!validSlug(slug) || !refSeguro(branch)) return { ok: false, error: 'slug' };
  const fmt = await git(repo.path, ['check-ref-format', '--branch', branch]);
  if (!fmt.ok) return { ok: false, error: 'slug' };
  const fetch = await git(repo.path, ['fetch', '--quiet', repo.remote, repo.production], { timeout: 120000 });
  if (!fetch.ok) return { ok: false, error: 'fetch', detail: firstLine(fetch.stderr) };
  mkdirSync(dirname(dir), { recursive: true });
  // --no-track: com o upstream na produção, um `git push` distraído poderia ir para lá.
  const add = await git(repo.path, ['worktree', 'add', '--no-track', '-b', branch, '--', dir, `refs/remotes/${repo.remote}/${repo.production}`], { timeout: 120000 });
  if (!add.ok) return { ok: false, error: 'worktree-add', detail: firstLine(add.stderr) };
  return { ok: true, branch, dir };
}

/** Acha o worktree de um repo por slug, por caminho, ou o que contém `cwd`. */
export async function findWorktree(repo, { slug, path, cwd } = {}) {
  const list = parseWorktrees((await git(repo.path, ['worktree', 'list', '--porcelain'])).stdout);
  const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
  if (path) return list.find((w) => same(w.path, path)) || null;
  if (slug) {
    const dir = worktreeDirFor(repo, slug);
    const branch = branchFor(repo, slug);
    return list.find((w) => same(w.path, dir)) || list.find((w) => w.branch === branch) || list.find((w) => w.branch === slug) || null;
  }
  if (cwd) {
    const c = resolve(cwd).toLowerCase();
    return list.filter((w) => c === resolve(w.path).toLowerCase() || c.startsWith(`${resolve(w.path).toLowerCase()}${process.platform === 'win32' ? '\\' : '/'}`))
      .sort((a, b) => b.path.length - a.path.length)[0] || null;
  }
  return null;
}

/**
 * Verifica tudo antes de encerrar; só remove com tudo verde. Recusa (com o motivo) quando: é o
 * checkout principal; há arquivo sujo; o tip não está na produção; a PR não foi mergeada; o
 * checklist da PR tem item aberto; o gh não respondeu (a menos que `skipPr`).
 */
export async function closeWorktree(repo, wt, { skipPr = false, dryRun = false } = {}) {
  const result = { repo: repo.name, path: wt.path, branch: wt.branch ? sanitizar(wt.branch, 100) : null, refusals: [], done: [] };
  if (wt.main) { result.refusals.push({ code: 'main' }); return result; }
  if (wt.locked) result.refusals.push({ code: 'locked' });
  const st = await git(wt.path, ['status', '--porcelain=v1', '-z', '-unormal']);
  if (!st.ok) { result.refusals.push({ code: 'status', detail: firstLine(st.stderr) }); return result; }
  const s = parseStatus(st.stdout);
  if (s.tracked.length || s.untracked.length) result.refusals.push({ code: 'dirty', files: [...s.tracked, ...s.untracked].map((f) => sanitizar(f, 120)) });
  const base = (await git(repo.path, ['rev-parse', '--verify', '-q', `refs/remotes/${repo.remote}/${repo.production}^{commit}`])).stdout.trim();
  if (!SHA_RE.test(base)) { result.refusals.push({ code: 'no-production-ref' }); return result; }
  let pr = null;
  if (!skipPr && wt.branch && refSeguro(wt.branch)) {
    const slug = repo.github || await remoteSlug(repo);
    // Remoto que não é GitHub não tem PR para conferir: segue só com a produção. Falha do gh recusa.
    const r = slug ? await gh(['pr', 'list', '-R', slug, '--state=all', `--head=${wt.branch}`, '--limit=5', '--json=number,state,body,headRefOid,url'], { cwd: repo.path }) : null;
    const list = r?.ok ? safe(() => JSON.parse(r.stdout), null) : null;
    if (!r) result.noPr = true;
    else if (!Array.isArray(list)) result.refusals.push({ code: 'pr-unreadable', detail: r.missing ? 'no-gh' : firstLine(r.stderr) });
    else {
      pr = list.find((p) => p.state === 'MERGED') || list.find((p) => p.state === 'OPEN') || list[0] || null;
      if (pr) {
        result.pr = pr.number;
        if (pr.state !== 'MERGED') result.refusals.push({ code: 'pr-not-merged', pr: pr.number, state: sanitizar(pr.state, 20) });
        const open = uncheckedItems(pr.body);
        if (open.length) result.refusals.push({ code: 'checklist', pr: pr.number, items: open });
      } else result.noPr = true;
    }
  }
  const mergedByBranch = new Map(pr?.state === 'MERGED' ? [[wt.branch, pr]] : []);
  const prod = await productionCheck(repo, wt, { baseSha: base, mergedByBranch, prodPatchIds: lazyProdPatchIds(repo, base) });
  result.method = prod.method;
  if (prod.inProd !== true) result.refusals.push({ code: 'not-in-production' });
  if (result.refusals.length || dryRun) return result;
  const rm = await git(repo.path, ['worktree', 'remove', '--', wt.path]);
  if (!rm.ok) { result.refusals.push({ code: 'remove-failed', detail: firstLine(rm.stderr) }); return result; }
  result.done.push('worktree');
  if (wt.branch && refSeguro(wt.branch)) {
    // `-d`, nunca `-D`: depois de squash o git não vê a branch como mergeada e RECUSA — e tudo bem.
    const del = await git(repo.path, ['branch', '-d', wt.branch]);
    if (del.ok) result.done.push('branch');
    else result.branchKept = true;
  }
  return result;
}

/** Os três grupos da triagem, a partir de um painel já montado. */
export function tidyPlan(board) {
  return board.repos.map((repo) => {
    const plan = { name: repo.name, path: repo.path, production: repo.production, error: repo.error, removable: [], dirty: [], keep: [], orphan: [], mainCheckout: null };
    for (const wt of repo.worktrees || []) {
      if (wt.missing) { plan.orphan.push(wt); continue; }
      if (wt.main) { plan.mainCheckout = wt; continue; }
      const dirty = (wt.tracked || 0) + (wt.untracked || 0) > 0;
      if (dirty) plan.dirty.push(wt);
      else if (wt.inProd === true && !wt.locked) plan.removable.push(wt);
      else plan.keep.push(wt);
    }
    return plan;
  });
}

/** Resumo do que está sujo, para o humano decidir: `diff --stat` dos rastreados + os novos. */
export async function dirtySummary(wt, { maxFiles = 8 } = {}) {
  const [stat, st] = await Promise.all([
    git(wt.path, ['diff', 'HEAD', '--shortstat', '--no-ext-diff']),
    git(wt.path, ['status', '--porcelain=v1', '-z', '-unormal']),
  ]);
  const s = parseStatus(st.stdout);
  return {
    shortstat: sanitizar(stat.stdout.trim(), 120),
    tracked: s.tracked.slice(0, maxFiles).map((f) => sanitizar(f, 100)),
    untracked: s.untracked.slice(0, maxFiles).map((f) => sanitizar(f, 100)),
    more: Math.max(0, s.tracked.length + s.untracked.length - 2 * maxFiles),
  };
}

/** Remove o grupo (a). Confere de novo que está limpo logo antes: o painel pode ter minutos. */
export async function applyRemovals(repo, list) {
  const out = [];
  for (const wt of list) {
    const st = await git(wt.path, ['status', '--porcelain=v1', '-z', '-unormal']);
    const s = st.ok ? parseStatus(st.stdout) : null;
    if (!s || s.tracked.length || s.untracked.length) { out.push({ path: wt.path, skipped: 'dirty-now' }); continue; }
    const rm = await git(repo.path, ['worktree', 'remove', '--', wt.path]);
    if (!rm.ok) { out.push({ path: wt.path, skipped: 'remove-failed', detail: firstLine(rm.stderr) }); continue; }
    let branch = null;
    if (wt.branch && refSeguro(wt.branch)) branch = (await git(repo.path, ['branch', '-d', wt.branch])).ok ? 'deleted' : 'kept';
    out.push({ path: wt.path, removed: true, branch });
  }
  return out;
}

/** Salva o que está sujo num commit local de uma branch nova `rescue/<nome>-<data>`. Nada é enviado. */
export async function rescueWorktree(wt, { date = new Date() } = {}) {
  const stamp = date.toISOString().slice(0, 10).replace(/-/g, '');
  const name = basename(wt.path).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(0, 40) || 'worktree';
  let branch = `rescue/${name}-${stamp}`;
  for (let i = 2; (await git(wt.path, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).ok; i++) branch = `rescue/${name}-${stamp}-${i}`;
  if (!refSeguro(branch)) return { ok: false, error: 'branch' };
  const st = parseStatus((await git(wt.path, ['status', '--porcelain=v1', '-z', '-unormal'])).stdout);
  if (!st.tracked.length && !st.untracked.length) return { ok: false, error: 'clean' };
  const sw = await git(wt.path, ['switch', '-c', branch]);
  if (!sw.ok) return { ok: false, error: 'switch', detail: firstLine(sw.stderr) };
  const add = await git(wt.path, ['add', '-A']);
  if (!add.ok) return { ok: false, error: 'add', detail: firstLine(add.stderr), branch };
  const msg = `rescue: uncommitted work from ${name} (${date.toISOString().slice(0, 10)})`;
  const commit = await git(wt.path, ['commit', '-q', '-m', msg]);
  if (!commit.ok) return { ok: false, error: 'commit', detail: firstLine(commit.stderr || commit.stdout), branch };
  const sha = (await git(wt.path, ['rev-parse', 'HEAD'])).stdout.trim();
  return { ok: true, branch, sha, files: st.tracked.length + st.untracked.length };
}

/** Corpo da PR: modelo da config + checklist + "depende de". */
export function prBody(repo, { slug, branch, depends = [] }) {
  const lines = [];
  const tpl = repo.prTemplate || '';
  lines.push(tpl ? tpl.replace(/\{slug\}/g, slug).replace(/\{branch\}/g, branch).replace(/\{depends\}/g, depends.join(', ')) : `Task: ${slug}`);
  if (repo.checklist.length) lines.push('', ...repo.checklist.map((c) => `- [ ] ${c.replace(/\{depends\}/g, depends.join(', ') || '—')}`));
  if (depends.length && !/\{depends\}/.test(tpl) && !repo.checklist.some((c) => c.includes('{depends}'))) lines.push('', `Depends on: ${depends.join(', ')}`);
  return `${lines.join('\n').trim()}\n`;
}

/** Primeiro push + PR rascunho. Recusa sem commit à frente da produção (o gh recusaria também). */
export async function openDraftPr(repo, wt, { slug, title, depends = [] }) {
  if (!wt.branch || !refSeguro(wt.branch)) return { ok: false, error: 'branch' };
  const base = `refs/remotes/${repo.remote}/${repo.production}`;
  const ahead = Number((await git(repo.path, ['rev-list', '--count', `${base}..${wt.head}`])).stdout.trim());
  if (!ahead) return { ok: false, error: 'no-commits' };
  const ghSlug = repo.github || await remoteSlug(repo);
  if (!ghSlug) return { ok: false, error: 'not-github' };
  const existing = await gh(['pr', 'list', '-R', ghSlug, '--state=open', `--head=${wt.branch}`, '--json=number,url'], { cwd: repo.path });
  const found = existing.ok ? safe(() => JSON.parse(existing.stdout), [])[0] : null;
  if (found) return { ok: true, existing: true, number: found.number, url: sanitizar(found.url, 200), ref: `${ghSlug}#${found.number}` };
  const push = await git(wt.path, ['push', '-u', repo.remote, `refs/heads/${wt.branch}:refs/heads/${wt.branch}`], { timeout: 120000 });
  if (!push.ok) return { ok: false, error: 'push', detail: firstLine(push.stderr) };
  const bodyFile = join(tmpdir(), `ct-work-pr-${process.pid}-${Date.now()}.md`);
  writeFileSync(bodyFile, prBody(repo, { slug, branch: wt.branch, depends }));
  const r = await gh(['pr', 'create', '-R', ghSlug, '--draft', `--base=${repo.production}`, `--head=${wt.branch}`, `--title=${title || slug}`, `--body-file=${bodyFile}`], { cwd: wt.path, timeout: 60000 });
  safe(() => unlinkSync(bodyFile), null);
  if (!r.ok) return { ok: false, error: r.missing ? 'no-gh' : 'gh-error', detail: firstLine(r.stderr) };
  const url = r.stdout.trim().split(/\s+/).pop();
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]) || null;
  return { ok: true, number, url: sanitizar(url, 200), ref: number ? `${ghSlug}#${number}` : '' };
}

export function displayPath(root, p) {
  const rel = relative(root, p);
  return sanitizar(norm(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p), 140);
}
