import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseReadCommand, checkReread, resetRereads } from '../scripts/lib/reread.mjs';
import { buildSessionReport } from '../scripts/health.mjs';

const S = (name) => new URL(`../scripts/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function projeto() {
  const root = mkdtempSync(join(tmpdir(), 'ctx-211-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function rodar(script, root, args = [], { input = '', env = {} } = {}) {
  const r = spawnSync(process.execPath, [S(script), ...args], {
    cwd: root, input, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, CONTEXT_TOOLS_HOOK_DEDUPE: '0', CONTEXT_TOOLS_LANG: 'en', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('releitura: só leituras simples de um arquivo são reconhecidas', () => {
  assert.deepEqual(parseReadCommand('cat src/a.js'), { file: 'src/a.js', range: 'all' });
  assert.deepEqual(parseReadCommand("sed -n '10,40p' \"src/my file.js\""), { file: 'src/my file.js', range: '10-40' });
  assert.deepEqual(parseReadCommand('head -n 20 a.js'), { file: 'a.js', range: '1-20' });
  assert.deepEqual(parseReadCommand("nl -ba a.js | sed -n '5,9p'"), { file: 'a.js', range: '5-9' });
  assert.deepEqual(parseReadCommand('Get-Content -Raw C:\\p\\a.ps1'), { file: 'C:\\p\\a.ps1', range: 'all' });
  for (const nao of ['cat a b', 'cat a | grep x', 'cat a > b', 'cat $X', 'sed -i s/a/b/ a.js', 'tail -f log', 'cd x && cat a']) {
    assert.equal(parseReadCommand(nao), null, nao);
  }
});

test('releitura: avisa só quando o mesmo trecho não mudou, e o SessionStart zera', () => {
  const root = projeto();
  try {
    writeFileSync(join(root, 'a.txt'), 'um\ndois\ntrês\n');
    const all = { file: 'a.txt', range: 'all' };
    assert.equal(checkReread(root, 's1', root, all), null, 'a primeira leitura não é releitura');
    assert.equal(checkReread(root, 's1', root, all)?.times, 2);
    assert.equal(checkReread(root, 's1', root, { file: 'a.txt', range: '1-2' })?.file, 'a.txt', 'trecho dentro do já lido');
    assert.equal(checkReread(root, 's2', root, all), null, 'outra sessão tem registro próprio');
    appendFileSync(join(root, 'a.txt'), 'quatro\n');
    assert.equal(checkReread(root, 's1', root, all), null, 'arquivo mudou: a leitura é nova');
    resetRereads(root, 's1');
    assert.equal(checkReread(root, 's1', root, all), null, 'depois do SessionStart reler é legítimo');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('releitura: o hook PreToolUse do Bash avisa em uma linha e a leitura segue', () => {
  const root = projeto();
  try {
    writeFileSync(join(root, 'a.txt'), 'x\n');
    const ev = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'sx', cwd: root, tool_input: { command: 'cat a.txt' } });
    const env = { CONTEXT_TOOLS_SESSION_ID: 'sx' };
    assert.equal(rodar('pre-tool.mjs', root, [], { input: ev, env }).trim(), '');
    const out = JSON.parse(rodar('pre-tool.mjs', root, [], { input: ev, env }));
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined, 'nunca nega a leitura');
    assert.match(out.hookSpecificOutput.additionalContext, /`a\.txt` was already read in this session .*has not changed/);
    const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks;
    const ifs = hooks.PreToolUse.find((g) => g.matcher === 'Bash').hooks.map((h) => h.if);
    for (const want of ['Bash(cat *)', 'Bash(sed -n *)', 'Bash(head *)']) assert.ok(ifs.includes(want), want);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('health --session: separa a sessão, soma o que foi dito e explica o silêncio', () => {
  const ev = [
    { at: 1, type: 'pretool', session: 'a', outcome: 'miss', durationMs: 10 },
    { at: 2, type: 'pretool', session: 'a', outcome: 'already-answered' },
    { at: 3, type: 'hook-output', session: 'a', event: 'PreToolUse', script: 'pre-tool', outcome: 'emitted', chars: 400 },
    { at: 4, type: 'hook-output', session: 'a', event: 'Stop', script: 'handoff', outcome: 'deduped', chars: 0 },
    { at: 5, type: 'context-maps', session: 'b', mode: 'stop-report', durationMs: 50 },
  ];
  const r = buildSessionReport(ev, 'a');
  assert.equal(r.events, 4);
  assert.deepEqual(r.hooks.pretool.outcomes, { miss: 1, 'already-answered': 1 });
  assert.equal(r.outputs.emitted, 1);
  assert.equal(r.outputs.deduped, 1);
  assert.equal(r.outputs.estimatedTokens, 100);
  assert.equal(buildSessionReport(ev).session, 'b', 'sem id: a sessão mais recente');

  const root = projeto();
  try {
    const env = { CONTEXT_TOOLS_SESSION_ID: 'sess-health' };
    rodar('pre-tool.mjs', root, [], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'NadaComEsseNome' } }), env });
    const texto = rodar('health.mjs', root, ['--session'], { env });
    assert.match(texto, /pretool: 1×/);
    assert.match(texto, /miss 1 — quiet: the index has no definition by that name/);
    const json = JSON.parse(rodar('health.mjs', root, ['--session', '--json'], { env }));
    assert.equal(json.session, 'sess-health');
    assert.doesNotMatch(JSON.stringify(json), /NadaComEsseNome|ctx-211-/, 'sem padrão buscado nem caminho');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('find --body: traz o corpo da definição exata, com teto e onde continua', () => {
  const root = projeto();
  try {
    mkdirSync(join(root, 'src'));
    const corpo = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    writeFileSync(join(root, 'src', 'calc.js'), `export function somaTudo(a, b) {\n${corpo}\n  return a + b;\n}\n\nexport function outra() { return 1; }\n`);
    const out = rodar('symbols.mjs', root, ['somaTudo', '--body']);
    assert.match(out, /── src\/calc\.js:1-33/);
    assert.match(out, /^\s*32 {2}\s*return a \+ b;$/m);
    assert.doesNotMatch(out, /function outra/);
    const curto = rodar('symbols.mjs', root, ['somaTudo', '--body=5']);
    assert.match(curto, /5 of 33 lines shown; the rest: Read src\/calc\.js from line 6/);
    assert.doesNotMatch(rodar('symbols.mjs', root, ['somaTudo']), /──/, 'sem --body, só o lugar');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('docs search: uma linha por documento, sem o texto inteiro', () => {
  const root = projeto();
  try {
    rodar('context-docs.mjs', root, ['init'], { env: { CONTEXT_TOOLS_LANG: 'en' } });
    rodar('context-docs.mjs', root, ['create', '--type=feature', '--name=customer-credit']);
    rodar('context-docs.mjs', root, ['create', '--type=feature', '--name=invoice-export']);
    const lista = rodar('context-docs.mjs', root, ['search', 'credit']);
    assert.match(lista, /1 document\(s\) for "credit"/);
    assert.match(lista, /customer-credit/);
    assert.doesNotMatch(lista, /invoice-export/);
    assert.match(rodar('context-docs.mjs', root, ['search', 'nothing-like-this']), /No ai-context document mentions/);
    assert.match(rodar('ct.mjs', root, ['docs', 'search', 'invoice']), /invoice-export/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('limite de uso: prevê quando acaba só com ritmo medido e antes de renovar', async () => {
  const { mergeSamples, forecastWindow, fromClaude, fromCodex, samplesFromCodexTranscript } = await import('../scripts/lib/limits.mjs');
  const H = 3600e3;
  const now = Date.parse('2026-11-06T12:00:00Z');
  const reset = now + 3 * H;
  assert.deepEqual(fromClaude([{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-11-06T15:00:00Z' }]), [{ kind: 'five_hour', percent: 40, resetsAt: reset }]);
  assert.deepEqual(fromCodex({ primary: { used_percent: 20, window_minutes: 300, resets_at: reset / 1000 }, secondary: { used_percent: 5, window_minutes: 10080 } }).map((w) => w.kind), ['five_hour', 'seven_day']);
  const linha = (at, p) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: p, window_minutes: 300, resets_at: reset / 1000 } } } });
  assert.equal(samplesFromCodexTranscript([linha(now - H, 10), 'lixo', linha(now, 40)].join('\n')).length, 2);

  // 30 pontos em 30 min (1%/min): os 30 que faltam acabam em 30 min, antes de renovar (3 h).
  let s = mergeSamples({}, [{ kind: 'five_hour', percent: 40, resetsAt: reset, at: now - 30 * 60e3 }, { kind: 'five_hour', percent: 70, resetsAt: reset, at: now }]);
  assert.equal(forecastWindow('five_hour', s.five_hour, now).exhaustAt, now + 30 * 60e3);
  // Ritmo baixo: chega a 100% depois de renovar, então não há aviso.
  s = mergeSamples({}, [{ kind: 'five_hour', percent: 60, resetsAt: reset, at: now - 60 * 60e3 }, { kind: 'five_hour', percent: 65, resetsAt: reset, at: now }]);
  assert.equal(forecastWindow('five_hour', s.five_hour, now).exhaustAt, null);
  // Uma leitura só, ou janela nova (resetsAt mudou): diz o uso, cala sobre o futuro.
  s = mergeSamples(s, [{ kind: 'five_hour', percent: 5, resetsAt: reset + 5 * H, at: now + 60e3 }]);
  assert.equal(s.five_hour.length, 1);
  assert.equal(forecastWindow('five_hour', s.five_hour, now + 60e3).exhaustAt, null);
});

test('limite de uso: a faixa só mostra quando importa e avisa se acaba antes de renovar', async () => {
  const { formatBand } = await import('../scripts/status.mjs');
  const { makeT } = await import('../scripts/lib/i18n.mjs');
  const t = makeT('en');
  // 10h de hoje: com Date.now() o reset (+3 h) caía no dia seguinte à noite e ganhava a data.
  const now = new Date().setHours(10, 0, 0, 0);
  assert.equal(formatBand({ status: 'no-session', limits: [{ kind: 'five_hour', percent: 20, resetsAt: now + 3600e3, exhaustAt: null }] }, t).text, '');
  const b = formatBand({ status: 'no-session', limits: [{ kind: 'five_hour', percent: 72, resetsAt: now + 3 * 3600e3, exhaustAt: now + 3600e3 }] }, t);
  assert.match(b.text, /^⏳ 5h 72% → ~\d\d:\d\d$/);
  assert.match(b.warn, /At this pace the 5h usage limit runs out ~\d\d:\d\d, before it resets at \d\d:\d\d/);
});
