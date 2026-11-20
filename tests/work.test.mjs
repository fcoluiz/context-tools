// `ct work`: várias sessões de agente, vários worktrees. O que mais importa aqui:
//   - "já na produção" acerta também squash-merge (ancestralidade sozinha erra) e diz o método;
//   - a interseção mostra o arquivo tocado por 2+ frentes, e arquivo novo não versionado não conta;
//   - PR ilegível aparece como "não consegui ler PRs", nunca como zero;
//   - nada sujo é removido, nada é descartado, e o checkout principal nunca sai;
//   - nome de branch/título de PR vindo do repositório não vira opção do git nem escape na tela.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPath } from './paths.mjs';
import {
  githubSlugFromUrl, nameSimilarity, parseStatus, parseWorktrees, uncheckedItems, normalizeWork, intersections, validSlug,
} from '../scripts/lib/work.mjs';
import { VERBS } from '../scripts/ct.mjs';

const SCRIPT = localPath('../scripts/work.mjs');
const CODEX_HOOK = localPath('../scripts/codex-hook.mjs');

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Workspace com espaço no caminho: `origem.git` (bare), `app` (checkout principal em main) e
 * worktrees em `.worktrees/` cobrindo cada caso do painel.
 */
function workspace({ config = true, github = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ct work espaço '));
  const origin = join(root, 'origem.git');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const app = join(root, 'app');
  sh(root, 'init', '-q', '-b', 'main', app);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) sh(app, 'config', k, v);
  sh(app, 'remote', 'add', 'origin', origin);
  mkdirSync(join(app, 'src'));
  writeFileSync(join(app, 'src', 'shared.js'), 'export const a = 1;\n');
  writeFileSync(join(app, 'src', 'other.js'), 'export const b = 1;\n');
  sh(app, 'add', '-A'); sh(app, 'commit', '-qm', 'base');
  const wt = (name, branch) => { const p = join(root, '.worktrees', `app-${name}`); sh(app, 'worktree', 'add', '-q', '-b', branch, p, 'main'); return p; };
  const commit = (dir, file, text, msg) => { writeFileSync(join(dir, file), text); sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', msg); };

  // merged: fast-forward em main → ancestralidade
  const merged = wt('merged', 'feat/merged');
  commit(merged, 'src/m.js', 'm\n', 'merged work');
  sh(app, 'merge', '-q', '--ff-only', 'feat/merged');
  // squashed: dois commits, entram em main como UM commit de squash → ancestralidade falha
  const squashed = wt('squashed', 'feat/squashed');
  commit(squashed, 'src/s1.js', 's1\n', 's1');
  commit(squashed, 'src/s2.js', 's2\n', 's2');
  sh(app, 'merge', '-q', '--squash', 'feat/squashed'); sh(app, 'commit', '-qm', 'squash');
  sh(app, 'push', '-q', 'origin', 'main');
  // open: commit fora da produção tocando shared.js
  const open = wt('open', 'feat/open-shared');
  commit(open, 'src/shared.js', 'export const a = 2;\n', 'open');
  // dirty: mudança rastreada em shared.js, sem commit → colide com open
  const dirty = wt('dirty', 'feat/dirty-shared');
  writeFileSync(join(dirty, 'src', 'shared.js'), 'export const a = 3;\n');
  // newonly: só arquivo novo (estado de ferramenta) → sujo, mas fora da interseção
  const newonly = wt('newonly', 'feat/newonly');
  writeFileSync(join(newonly, 'src', 'shared.js.cache'), 'x\n');
  writeFileSync(join(newonly, 'notes.tmp'), 'x\n');
  sh(app, 'fetch', '-q', 'origin');
  if (config) {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'context-tools.json'), JSON.stringify({
      lang: 'en',
      work: { repos: [{ path: 'app', production: 'main', branchPrefix: 'feat/', checklist: ['Migration: none', 'Validated: {depends}'], ...(github ? { github } : {}) }] },
    }));
  }
  return { root, app, origin, merged, squashed, open, dirty, newonly };
}

function fakeGh(root, data) {
  const file = join(root, 'fake-gh.mjs');
  writeFileSync(join(root, 'fake-gh.json'), JSON.stringify(data));
  writeFileSync(file, `import { readFileSync, appendFileSync } from 'node:fs';
const d = JSON.parse(readFileSync(${JSON.stringify(join(root, 'fake-gh.json'))}, 'utf8'));
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, 'fake-gh.log'))}, JSON.stringify(a) + '\\n');
if (d.fail) { process.stderr.write('HTTP 404: Could not resolve to a Repository\\n'); process.exit(1); }
const state = (a.find((x) => x.startsWith('--state=')) || '').slice(8);
const head = (a.find((x) => x.startsWith('--head=')) || '').slice(7);
if (a[1] === 'create') { process.stdout.write('https://github.com/dono/app/pull/42\\n'); process.exit(0); }
let list = state === 'merged' ? d.merged || [] : state === 'all' ? d.all || [] : d.open || [];
if (head) list = list.filter((p) => p.headRefName === head);
process.stdout.write(JSON.stringify(list));
`);
  return file;
}

function work(ws, args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, `--root=${ws.root}`], {
    cwd: env.cwd || ws.root, encoding: 'utf8',
    env: { ...process.env, CONTEXT_TOOLS_HOST: 'claude', CLAUDE_PROJECT_DIR: ws.root, CONTEXT_TOOLS_LANG: 'en', ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const board = (ws, env) => JSON.parse(work(ws, ['board', '--json'], env).out).repos[0];
const byBranch = (repo, b) => repo.worktrees.find((w) => w.branch === b);
const clean = (ws) => rmSync(ws.root, { recursive: true, force: true });

test('parsers: worktree porcelain, status -z, slug do GitHub, checklist, semelhança', () => {
  const wts = parseWorktrees('worktree /a b/main\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\nworktree /a b/w\nHEAD 2222222222222222222222222222222222222222\ndetached\nlocked\n\nworktree /gone\nHEAD 3333333333333333333333333333333333333333\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n');
  assert.equal(wts.length, 3);
  assert.equal(wts[0].main, true);
  assert.equal(wts[0].branch, 'main');
  assert.equal(wts[1].detached, true);
  assert.ok(wts[1].locked);
  assert.ok(wts[2].prunable);
  const st = parseStatus(' M src/a.js\0R  novo.js\0velho.js\0?? tmp/\0!! ignorado\0');
  assert.deepEqual(st, { tracked: ['src/a.js', 'novo.js'], untracked: ['tmp/'] });
  assert.equal(githubSlugFromUrl('https://github.com/Org/Repo---X.git'), 'Org/Repo---X');
  assert.equal(githubSlugFromUrl('git@github.com:org/repo.git'), 'org/repo');
  assert.equal(githubSlugFromUrl('https://gitlab.com/org/repo.git'), '');
  assert.deepEqual(uncheckedItems('- [x] feito\n- [ ] Migration\n  * [ ] Rebuild api\n'), ['Migration', 'Rebuild api']);
  assert.ok(nameSimilarity('cart-split', 'fix/cart-split-quantity') >= 0.5);
  assert.equal(nameSimilarity('cart-split', 'feat/monitor'), 0);
  assert.deepEqual(intersections([{ label: 'a', files: ['x', 'y'] }, { label: 'b', files: ['x'] }]), [{ file: 'x', fronts: ['a', 'b'] }]);
});

test('config: valor que viraria opção do git é recusado antes de qualquer comando', () => {
  const w = normalizeWork('/ws', { repos: [{ path: 'a', production: '--upload-pack=x' }, { path: 'b', remote: '-o' }, { path: 'c', production: 'main' }] });
  assert.equal(w.repos[0].error, 'production');
  assert.equal(w.repos[1].error, 'remote');
  assert.equal(w.repos[2].error, undefined);
  for (const bad of ['-rf', '../x', 'a/b', '--upload-pack=x', 'a b', '', 'x'.repeat(49)]) assert.equal(validSlug(bad), false, bad);
  assert.equal(validSlug('cart-split.v2'), true);
  assert.ok(VERBS.work, 'ct work registrado');
});

test('board: produção por ancestralidade e por squash, interseção, caminho com espaço, PR ilegível ≠ zero', () => {
  const ws = workspace();
  try {
    const repo = board(ws);
    assert.equal(repo.error, undefined);
    assert.equal(repo.worktrees.length, 6);
    assert.equal(byBranch(repo, 'feat/merged').method, 'ancestry');
    const sq = byBranch(repo, 'feat/squashed');
    assert.equal(sq.inProd, true, 'squash-merge conta como produção');
    assert.ok(['squash', 'content'].includes(sq.method), sq.method);
    assert.equal(byBranch(repo, 'feat/open-shared').inProd, false);
    assert.equal(byBranch(repo, 'feat/open-shared').ahead, 1);
    assert.equal(byBranch(repo, 'feat/dirty-shared').tracked, 1);
    assert.equal(byBranch(repo, 'feat/newonly').untracked, 2);
    assert.deepEqual(repo.collisions, [{ file: 'src/shared.js', fronts: ['feat/dirty-shared', 'feat/open-shared'] }]);
    assert.equal(repo.prs.state, 'unavailable');
    assert.equal(repo.prs.reason, 'not-github');
    const text = work(ws, ['board']).out;
    assert.match(text, /could not read PRs \(remote is not GitHub\) — this is NOT "zero PRs"/);
    assert.match(text, /src\/shared\.js ← feat\/dirty-shared, feat\/open-shared/);
    assert.match(text, /\.worktrees\/app-open · feat\/open-shared · clean · \+1 −0 · outside production/);
    assert.ok(existsSync(join(ws.root, '.claude', '.work-board.json')), 'board grava o cache dos hooks');
  } finally { clean(ws); }
});

test('board com gh: PR mergeada com o MESMO tip conta; título com escape sai limpo; arquivos da PR entram na interseção', () => {
  const ws = workspace({ github: 'dono/app' });
  try {
    const tip = sh(ws.open, 'rev-parse', 'HEAD');
    const gh = fakeGh(ws.root, {
      open: [{ number: 7, title: 'Fix \u001b[31mred\u001b[0m\nnext', headRefName: 'feat/other', headRefOid: 'x', baseRefName: 'main', isDraft: true, url: 'u', files: [{ path: 'src/other.js' }, { path: 'src/shared.js' }] }],
      merged: [{ number: 5, headRefName: 'feat/open-shared', headRefOid: tip }],
    });
    const repo = board(ws, { CONTEXT_TOOLS_GH: gh });
    assert.equal(repo.prs.state, 'ok');
    assert.doesNotMatch(repo.prs.open[0].title, /[\u0000-\u001f]/);
    const open = byBranch(repo, 'feat/open-shared');
    assert.equal(open.inProd, true);
    assert.equal(open.method, 'pr');
    assert.equal(open.pr, 5);
    assert.deepEqual(repo.collisions, [{ file: 'src/shared.js', fronts: ['feat/dirty-shared', 'feat/other (#7)'] }]);
    // Um commit local DEPOIS do merge: aquele trabalho não está na produção.
    writeFileSync(join(ws.open, 'src', 'late.js'), 'late\n'); sh(ws.open, 'add', '-A'); sh(ws.open, 'commit', '-qm', 'late');
    assert.equal(byBranch(board(ws, { CONTEXT_TOOLS_GH: gh }), 'feat/open-shared').inProd, false);
    writeFileSync(join(ws.root, 'fake-gh.json'), JSON.stringify({ fail: true }));
    const failed = board(ws, { CONTEXT_TOOLS_GH: gh });
    assert.equal(failed.prs.state, 'unavailable');
    assert.equal(failed.prs.reason, 'gh-error');
    assert.match(failed.prs.detail, /Could not resolve/);
  } finally { clean(ws); }
});

test('new: avisa do parecido, recusa o igual e o slug ruim, cria a partir da produção sem rastreá-la', () => {
  const ws = workspace();
  try {
    assert.equal(work(ws, ['new', '--upload-pack=x']).code, 1);
    const exact = work(ws, ['new', 'open-shared']);
    assert.equal(exact.code, 2);
    assert.match(exact.out, /same branch/);
    const similar = work(ws, ['new', 'open-shared-v2']);
    assert.equal(similar.code, 2);
    assert.match(similar.out, /similar name/);
    assert.match(similar.out, /--anyway/);
    const made = work(ws, ['nova', 'open-shared-v2', '--anyway']);
    assert.equal(made.code, 0, made.out);
    const dir = join(ws.root, '.worktrees', 'app-open-shared-v2');
    assert.ok(existsSync(join(dir, 'src', 'shared.js')));
    assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/open-shared-v2');
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), sh(ws.app, 'rev-parse', 'origin/main'));
    const upstream = spawnSync('git', ['config', '--get', 'branch.feat/open-shared-v2.merge'], { cwd: dir, encoding: 'utf8' });
    assert.equal(upstream.stdout.trim(), '', 'a branch nova não rastreia a produção');
    const files = work(ws, ['new', 'unrelated', '--files=src/shared.js']);
    assert.equal(files.code, 0, 'sem cache de interseção e sem PR, arquivo pedido não bloqueia');
  } finally { clean(ws); }
});

test('close: recusa sujo (lista os arquivos) e fora da produção; encerra o mergeado; squash mantém a branch', () => {
  const ws = workspace();
  try {
    const dirty = work(ws, ['close', 'dirty-shared']);
    assert.equal(dirty.code, 2);
    assert.match(dirty.out, /uncommitted file\(s\): src\/shared\.js/);
    assert.ok(existsSync(ws.dirty));
    const open = work(ws, ['encerrar', 'open-shared']);
    assert.equal(open.code, 2);
    assert.match(open.out, /not in production/);
    const merged = work(ws, ['close', 'merged']);
    assert.equal(merged.code, 0, merged.out);
    assert.match(merged.out, /closed \(in production by ancestry, no PR found\)/);
    assert.ok(!existsSync(ws.merged));
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/feat/merged'], { cwd: ws.app }).status, 1, 'branch mergeada apagada com -d');
    const sq = work(ws, ['close', 'squashed']);
    assert.equal(sq.code, 0, sq.out);
    assert.match(sq.out, /local branch feat\/squashed kept/);
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/feat/squashed'], { cwd: ws.app }).status, 0, 'nunca -D');
    // Sem slug: o worktree da pasta atual. O checkout principal nunca é removido.
    const main = work(ws, ['close'], { cwd: ws.app });
    assert.match(main.out, /main checkout — it is never removed/);
  } finally { clean(ws); }
});

test('close com gh: PR aberta ou checklist por marcar recusam; gh fora do ar recusa sem --no-pr-check', () => {
  const ws = workspace({ github: 'dono/app' });
  try {
    const tip = sh(ws.merged, 'rev-parse', 'HEAD');
    const gh = fakeGh(ws.root, { all: [{ number: 3, state: 'MERGED', headRefName: 'feat/merged', headRefOid: tip, body: '- [x] Migration\n- [ ] Rebuild api' }] });
    const r = work(ws, ['close', 'merged'], { CONTEXT_TOOLS_GH: gh });
    assert.equal(r.code, 2);
    assert.match(r.out, /PR #3 checklist still open: Rebuild api/);
    writeFileSync(join(ws.root, 'fake-gh.json'), JSON.stringify({ fail: true }));
    assert.match(work(ws, ['close', 'merged'], { CONTEXT_TOOLS_GH: gh }).out, /could not read the PR/);
    assert.equal(work(ws, ['close', 'merged', '--no-pr-check'], { CONTEXT_TOOLS_GH: gh }).code, 0);
  } finally { clean(ws); }
});

test('tidy: três grupos; só --apply remove, e só o grupo (a); sujo nunca é tocado', () => {
  const ws = workspace();
  try {
    const plan = JSON.parse(work(ws, ['tidy', '--json']).out)[0];
    const names = (list) => list.map((w) => w.branch).sort();
    assert.deepEqual(names(plan.removable), ['feat/merged', 'feat/squashed']);
    assert.deepEqual(names(plan.dirty), ['feat/dirty-shared', 'feat/newonly']);
    assert.deepEqual(names(plan.keep), ['feat/open-shared']);
    assert.equal(plan.mainCheckout.branch, 'main');
    const text = work(ws, ['limpar']).out;
    assert.match(text, /\(b\) dirty → you decide \(2: 1 with tracked changes, 1 with only untracked files\)/);
    assert.match(text, /plan only/);
    assert.ok(existsSync(ws.merged), 'sem --apply nada sai');
    const applied = work(ws, ['tidy', '--apply']);
    assert.equal(applied.code, 0, applied.out);
    assert.ok(!existsSync(ws.merged) && !existsSync(ws.squashed));
    for (const kept of [ws.dirty, ws.newonly, ws.open, ws.app]) assert.ok(existsSync(kept), kept);
    assert.equal(readFileSync(join(ws.dirty, 'src', 'shared.js'), 'utf8'), 'export const a = 3;\n');
  } finally { clean(ws); }
});

test('rescue: o sujo vira commit local numa branch rescue/…; a branch original fica intacta', () => {
  const ws = workspace();
  try {
    const before = sh(ws.app, 'rev-parse', 'feat/dirty-shared');
    const r = work(ws, ['resgatar', ws.dirty]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /saved in local commit [0-9a-f]{7} on rescue\/app-dirty-\d{8} \(nothing pushed\)/);
    assert.equal(sh(ws.dirty, 'status', '--porcelain'), '');
    assert.equal(sh(ws.app, 'rev-parse', 'feat/dirty-shared'), before);
    assert.match(sh(ws.dirty, 'show', 'HEAD:src/shared.js'), /a = 3/);
    assert.equal(work(ws, ['rescue', ws.app]).code, 2, 'checkout principal recusado');
  } finally { clean(ws); }
});

test('hooks: sem config ficam mudos; SessionStart resume o cache; Stop avisa uma vez o que ficou sujo', () => {
  const plain = workspace({ config: false });
  try {
    assert.equal(work(plain, ['--session-start']).out, '');
  } finally { clean(plain); }
  const ws = workspace();
  try {
    // Sem cache: avisa que está montando — com a trava fresca, sem disparar processo solto no teste.
    writeFileSync(join(ws.root, '.claude', '.work-board.json.refreshing'), String(Date.now()));
    assert.match(work(ws, ['--session-start']).out, /being built in the background/);
    work(ws, ['board']);
    const start = JSON.parse(work(ws, ['--session-start']).out).hookSpecificOutput.additionalContext;
    assert.match(start, /🧭 worktrees: 0 open PR\(s\); PRs NOT read in app; 1 file\(s\) in 2\+ fronts \(`shared\.js` in 2\); 2 dirty worktree\(s\) already in production/);
    const env = { cwd: ws.dirty, CLAUDE_PROJECT_DIR: ws.dirty };
    const stop = spawnSync(process.execPath, [SCRIPT, '--stop-report'], { cwd: ws.dirty, encoding: 'utf8', input: '{}', env: { ...process.env, CONTEXT_TOOLS_HOST: 'claude', CONTEXT_TOOLS_LANG: 'en', ...env } });
    const text = JSON.parse(stop.stdout).hookSpecificOutput.additionalContext;
    assert.match(text, /this session's checkout \.worktrees\/app-dirty has 1 uncommitted file\(s\): src\/shared\.js/);
    const again = spawnSync(process.execPath, [SCRIPT, '--stop-report'], { cwd: ws.dirty, encoding: 'utf8', input: '{}', env: { ...process.env, CONTEXT_TOOLS_HOST: 'claude', CONTEXT_TOOLS_LANG: 'en', ...env } });
    assert.equal(again.stdout, '', 'o mesmo aviso não reabre o turno de novo');
    // Checkout principal fora da produção.
    sh(ws.app, 'switch', '-q', '-c', 'feat/in-main');
    rmSync(join(ws.root, '.claude', '.work-stop.json'));
    const off = spawnSync(process.execPath, [SCRIPT, '--stop-report'], { cwd: ws.root, encoding: 'utf8', input: '{}', env: { ...process.env, CONTEXT_TOOLS_HOST: 'claude', CONTEXT_TOOLS_LANG: 'en', CLAUDE_PROJECT_DIR: ws.root } });
    assert.match(JSON.parse(off.stdout).hookSpecificOutput.additionalContext, /main checkout of app is on feat\/in-main, not main/);
  } finally { clean(ws); }
});

test('Codex: o resumo vai junto da saída do handoff no SessionStart', () => {
  const ws = workspace();
  try {
    const env = { ...process.env, CONTEXT_TOOLS_HOST: 'claude', CONTEXT_TOOLS_LANG: 'en' };
    // No Codex a config é a de .codex/ (cada host tem a sua) e o cache mora no estado do Codex.
    mkdirSync(join(ws.root, '.codex'), { recursive: true });
    writeFileSync(join(ws.root, '.codex', 'context-tools.json'), readFileSync(join(ws.root, '.claude', 'context-tools.json')));
    spawnSync(process.execPath, [SCRIPT, 'board', `--root=${ws.root}`], { cwd: ws.root, encoding: 'utf8', env: { ...env, CONTEXT_TOOLS_HOST: 'codex' } });
    const r = spawnSync(process.execPath, [CODEX_HOOK, 'handoff.mjs', '--session-start'], {
      cwd: ws.root, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: ws.root, session_id: 's1' }), env,
    });
    assert.match(r.stdout, /🧭 worktrees: /);
  } finally { clean(ws); }
});
