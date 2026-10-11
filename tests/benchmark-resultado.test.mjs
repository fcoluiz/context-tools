// Harness do benchmark de resultado, sem chamar agente nenhum: plano, isolamento dos braços,
// conferência das respostas, rejeição de execução sem chamada ao modelo e o relatório.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { localPath } from './paths.mjs';
import { loadCases, plan, claudeArgs, conferir, runError, summarize, markdownReport } from '../scripts/benchmark-outcome.mjs';

test('casos: caminho relativo ao arquivo, {casesDir} nos comandos, campos obrigatórios', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-bench-'));
  try {
    const file = join(dir, 'cases.json');
    writeFileSync(file, JSON.stringify({ cases: [{ id: 'a', repo: 'alvo', prompt: 'p', check: { command: ['node', '{casesDir}/check.mjs'] } }] }));
    const [c] = loadCases(file);
    assert.equal(c.repo, join(dir, 'alvo'));
    assert.deepEqual(c.check.command, ['node', `${dir}/check.mjs`]);
    writeFileSync(file, JSON.stringify({ cases: [{ id: 'b', prompt: 'p', check: { answer: [] } }] }));
    assert.throws(() => loadCases(file), /repo or git/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('braços: só o "with" carrega o plugin; os dois ignoram configuração do usuário e MCP', () => {
  const sem = claudeArgs('without', { perRunCost: 2 });
  const com = claudeArgs('with', { perRunCost: 2 });
  for (const a of [sem, com]) {
    assert.deepEqual(a.slice(a.indexOf('--setting-sources'), a.indexOf('--setting-sources') + 2), ['--setting-sources', 'project']);
    assert.ok(a.includes('--strict-mcp-config'));
    assert.equal(a[a.indexOf('--max-budget-usd') + 1], '2', 'teto por execução vai para o CLI');
  }
  assert.ok(!sem.includes('--plugin-dir'));
  assert.equal(com[com.indexOf('--plugin-dir') + 1], localPath('..', import.meta.url).replace(/[\\/]$/, ''));
  const itens = plan([{ id: 'x' }, { id: 'y' }], ['without', 'with'], 2);
  assert.deepEqual(itens.map((i) => `${i.case.id}${i.rep}`), ['x1', 'x1', 'x2', 'x2', 'y1', 'y1', 'y2', 'y2']);
  assert.deepEqual(itens.map((i) => i.arm), ['without', 'with', 'without', 'with', 'without', 'with', 'without', 'with'], 'braços alternados');
});

test('conferência por resposta e rejeição de execução sem chamada ao modelo', () => {
  assert.equal(conferir({ answer: ['JsonReader', '\\b64\\b'] }, null, 'JsonReader.Push enforces it; default 64').ok, true);
  assert.match(conferir({ answer: ['\\b64\\b'] }, null, 'default 640').detail, /missing/);
  const semLogin = { type: 'result', subtype: 'success', is_error: false, result: 'Failed to authenticate: OAuth session expired', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } };
  assert.equal(runError(semLogin), 'no-model-call', 'custo zero e erro como resposta não é medida');
  assert.equal(runError({ ...semLogin, result: 'ok', usage: { input_tokens: 10, output_tokens: 2 } }), null);
  assert.match(runError(null, { status: 1, stderr: 'boom' }), /no JSON result/);
});

test('relatório: resolvidas, custo e turnos por braço', () => {
  const r = (arm, ok, cost, turns) => ({ case: 'c', arm, rep: 1, ok, check: '', costUsd: cost, turns, durationMs: 1000, tokens: { input: 10, cacheRead: 100 }, filesChanged: 0, error: null });
  const results = [r('without', false, 1.2, 30), r('with', true, 0.8, 18), r('without', true, 1.0, 20), r('with', true, 0.6, 12)];
  const s = summarize(results);
  assert.deepEqual([s.without.solved, s.with.solved], [1, 2]);
  assert.equal(s.with.totalCostUsd, 1.4);
  assert.equal(s.without.medianTurns, 25);
  assert.match(markdownReport(results, { date: '2026-10-09' }), /\| with \| 2\/2 \| \$1\.40 \|/);
});

test('paralelo: runAsync entrega stdin, saída e timeout; espelho estável por URL', async () => {
  const { runAsync } = await import('../scripts/lib/setup-shared.mjs');
  const { mirrorPath } = await import('../scripts/benchmark-outcome.mjs');
  const eco = await runAsync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'pergunta' });
  assert.deepEqual([eco.status, eco.stdout], [0, 'pergunta']);
  const lento = await runAsync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 200 });
  assert.match(String(lento.error?.message), /timeout/);
  const base = join(tmpdir(), 'x');
  assert.equal(mirrorPath('https://github.com/a/b.git', base), mirrorPath('https://github.com/a/b.git', base));
  assert.notEqual(mirrorPath('https://github.com/a/b.git', base), mirrorPath('https://github.com/a/c.git', base));
});

test('bug injetado não aparece no histórico: com setup, a cópia começa num commit único', async () => {
  const { prepararCopia } = await import('../scripts/benchmark-outcome.mjs');
  const { spawnSync } = await import('node:child_process');
  const repo = mkdtempSync(join(tmpdir(), 'ct-bench-hist-'));
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  const copias = [];
  try {
    g(repo, 'init', '--quiet');
    writeFileSync(join(repo, 'a.js'), 'module.exports = 1\n');
    g(repo, 'add', '-A'); g(repo, 'commit', '--quiet', '-m', 'um');
    writeFileSync(join(repo, 'a.js'), 'module.exports = 2\n');
    g(repo, 'add', '-A'); g(repo, 'commit', '--quiet', '-m', 'dois');
    const quebra = [process.execPath, '-e', "require('fs').writeFileSync('a.js', 'module.exports = 3')"];
    const comBug = prepararCopia({ id: 'h', repo, setup: [quebra] }); copias.push(comBug);
    assert.equal(g(comBug, 'rev-list', '--count', 'HEAD').stdout.trim(), '1', 'um commit só');
    assert.equal(g(comBug, 'remote').stdout.trim(), '', 'sem origem para comparar');
    assert.equal(g(comBug, 'status', '--porcelain').stdout.trim(), '');
    assert.match(readFileSync(join(comBug, 'a.js'), 'utf8'), /= 3/);
    const semSetup = prepararCopia({ id: 'h2', repo }); copias.push(semSetup);
    assert.equal(g(semSetup, 'rev-list', '--count', 'HEAD').stdout.trim(), '3', 'sem bug injetado, o histórico fica (mais o commit de base)');
    const mantido = prepararCopia({ id: 'h3', repo, setup: [quebra], history: 'keep' }); copias.push(mantido);
    assert.equal(g(mantido, 'rev-list', '--count', 'HEAD').stdout.trim(), '3');
  } finally {
    for (const d of [repo, ...copias]) rmSync(d, { recursive: true, force: true });
  }
});
