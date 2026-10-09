// drift-check (conhecimento deixado para trás por um diff, para PR/CI) e o número de "conhecimento
// em dia" do health. Projeto montado aqui: um mapa com revisão registrada pelo ack, um documento
// ai-context sem revisão registrada, um branch que muda as duas fontes citadas.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { localPath } from './paths.mjs';
import { summarizeKnowledge } from '../scripts/health.mjs';

const SCRIPTS = localPath('../scripts', import.meta.url);
const git = (dir, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });

function projeto() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-drift-'));
  const w = (rel, content) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), content); };
  w('src/a.js', 'export function a() {}\n');
  w('src/b.js', 'export function b() {}\n');
  w('src/c.js', 'export function c() {}\n');
  w('.claude/context/a.md', '---\narea: area-a\ncovers:\n  - "src/a.js"\nverified_at: HEAD\nverified_date: 2026-10-09\n---\n# A\n');
  w('ai-context/00-index.md', '# Operational documentation index\n');
  w('ai-context/features/b.md', '# Feature B\n\nThe flow lives in `src/b.js`.\n');
  git(dir, 'init', '-q', '-b', 'main');
  ack(dir, '.claude/context/a.md');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'inicio');
  git(dir, 'checkout', '-q', '-b', 'feature');
  appendFileSync(join(dir, 'src/a.js'), '// muda a\n');
  appendFileSync(join(dir, 'src/b.js'), '// muda b\n');
  appendFileSync(join(dir, 'src/c.js'), '// muda c, que ninguém cita\n');
  git(dir, 'commit', '-q', '-am', 'muda fontes');
  return dir;
}

const env = (dir, extra = {}) => ({ ...process.env, CONTEXT_TOOLS_LANG: 'en', CONTEXT_TOOLS_HOST: 'claude', CONTEXT_TOOLS_STATE_DIR: join(dir, '.state'), GITHUB_BASE_REF: '', ...extra });
function ack(dir, file) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'ack.mjs'), file, `--root=${dir}`], { encoding: 'utf8', env: env(dir) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
}
const drift = (dir, ...args) => spawnSync(process.execPath, [join(SCRIPTS, 'drift-check.mjs'), `--root=${dir}`, ...args], { encoding: 'utf8', env: env(dir) });

test('drift-check: mapa com revisão antiga e documento sem revisão ficam para trás; fonte que ninguém cita não', () => {
  const dir = projeto();
  try {
    const r = drift(dir, '--base=main', '--format=json');
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    assert.equal(report.changed, 3);
    const porCaminho = Object.fromEntries(report.items.map((i) => [i.path, i]));
    assert.equal(porCaminho['.claude/context/a.md']?.reason, 'review-outdated');
    assert.equal(porCaminho['ai-context/features/b.md']?.reason, 'no-recorded-review');
    assert.equal(report.items.length, 2, 'src/c.js não é citado por nada');
    assert.equal(drift(dir, '--base=main', '--strict').status, 1, '--strict falha o job quando há achado');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('drift-check: revisão registrada no próprio PR resolve; formato github anota e escreve o resumo', () => {
  const dir = projeto();
  try {
    ack(dir, '.claude/context/a.md');
    ack(dir, 'ai-context/features/b.md');
    git(dir, 'commit', '-q', '-am', 'revisa');
    const limpo = drift(dir, '--base=main', '--strict');
    assert.equal(limpo.status, 0, limpo.stdout);
    assert.match(limpo.stdout, /no context map or ai-context document was left behind/);

    git(dir, 'checkout', '-q', '-b', 'outra', 'main');
    appendFileSync(join(dir, 'src/a.js'), '// de novo\n');
    git(dir, 'commit', '-q', '-am', 'muda a');
    const resumo = join(dir, 'summary.md');
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'drift-check.mjs'), `--root=${dir}`, '--format=github'], {
      encoding: 'utf8', env: env(dir, { GITHUB_BASE_REF: 'main', GITHUB_STEP_SUMMARY: resumo }),
    });
    // Sem remoto `origin`, a base derivada do GITHUB_BASE_REF não existe: tem que dizer, com código 2.
    assert.equal(r.status, 2);
    assert.match(r.stdout, /::error title=context-tools drift::could not compare against origin\/main/);
    const ok = spawnSync(process.execPath, [join(SCRIPTS, 'drift-check.mjs'), `--root=${dir}`, '--format=github', '--base=main'], {
      encoding: 'utf8', env: env(dir, { GITHUB_STEP_SUMMARY: resumo }),
    });
    assert.match(ok.stdout, /::warning file=\.claude\/context\/a\.md,title=context-tools drift::context map "area-a"/);
    assert.match(readFileSync(resumo, 'utf8'), /### context-tools — written knowledge left behind/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('drift-check: ref inválido ou que parece opção nunca vira "nada mudou"', () => {
  const dir = projeto();
  try {
    for (const base of ['nao-existe', '--output=/tmp/x']) {
      const r = drift(dir, `--base=${base}`);
      assert.equal(r.status, 2, `${base}: ${r.stdout}`);
      assert.match(r.stdout, /could not compare/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('health: conhecimento em dia conta só o verificável e mostra a tendência dos mapas', () => {
  const maps = new Map([['m1', 'fresh'], ['m2', 'stale'], ['m3', 'fresh']]);
  const docs = new Map([['d1', 'fresh'], ['d2', 'no-sources'], ['d3', 'not-live'], ['d4', 'stale']]);
  const now = Date.now();
  const events = [
    { at: now - 5000, type: 'map-freshness', total: 3, fresh: 1 },
    { at: now - 1000, type: 'map-freshness', total: 3, fresh: 2 },
    { at: now - 90 * 864e5, type: 'map-freshness', total: 3, fresh: 0 },
  ];
  const k = summarizeKnowledge(maps, docs, events, 30, now);
  assert.equal(k.verifiable, 5, 'documento sem fonte ou histórico fica fora da conta');
  assert.equal(k.fresh, 3);
  assert.equal(k.score, 60);
  assert.equal(k.documents.notTracked, 2);
  assert.deepEqual(k.mapTrend, { first: 33, last: 67, samples: 2 }, 'amostra fora da janela não entra');
  assert.equal(summarizeKnowledge(new Map(), new Map()).score, null, 'sem nada verificável: null, não 100%');
});
