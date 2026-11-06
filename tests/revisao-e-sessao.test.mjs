// Os recursos que vieram da comparação com o ponytail: regra mínima no SessionStart, `ct changes`
// (o que o diff mexe fora dele), `ct debt` (trabalho adiado) e `ct status` / faixa (custo, contexto
// e testes da sessão). Cada um num projeto temporário; nada lê a pasta real do usuário.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { localPath } from './paths.mjs';

import { buildChanges, changedRanges, removedNames } from '../scripts/changes.mjs';
import { buildDebt, hasTrigger, parseHit } from '../scripts/debt.mjs';
import { buildStatus, formatBand, ultimoTesteClaude, atividadeCodex, LIMIAR_DIVISAO } from '../scripts/status.mjs';
import { leanRuleLine } from '../scripts/verify.mjs';
import { makeT } from '../scripts/lib/i18n.mjs';
import { VERBS } from '../scripts/ct.mjs';

const SCRIPTS = localPath('../scripts/', import.meta.url);
const rm = (d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'ct-rev-'));
  for (const [f, txt] of Object.entries(files)) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), txt);
  }
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

test('verbos novos estão no ct', () => {
  for (const v of ['changes', 'debt', 'status']) assert.ok(VERBS[v], `falta o verbo ${v}`);
});

test('regra mínima: ligada por padrão, curta, e "leanRule": false desliga', () => {
  const t = makeT('pt');
  const linha = leanRuleLine({}, t);
  assert.match(linha, /^🪶/);
  assert.match(linha, /nunca cortando validação/);
  assert.match(linha, /suíte existente/, 'o teste vai na suíte, não em arquivo avulso (a linha de testes proíbe)');
  assert.ok(linha.length <= 360, `regra com ${linha.length} chars (teto 360): entra em toda sessão`);
  assert.ok(makeT('en')('ver.lean').length <= 360);
  assert.equal(leanRuleLine({ leanRule: false }, t), '');
});

test('regra mínima sai no SessionStart do verify e some com a chave', () => {
  const root = repo({ 'package.json': '{"scripts":{"test":"node --test"}}', 'src/a.mjs': 'export const a = 1;\n' });
  const rodar = () => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'verify.mjs'), '--session-start'], {
      encoding: 'utf8', input: '',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, CONTEXT_TOOLS_HOST: 'claude', CONTEXT_TOOLS_HOOK_DEDUPE: '0', CONTEXT_TOOLS_LANG: 'pt' },
    });
    return r.stdout;
  };
  try {
    assert.match(rodar(), /🪶/);
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'context-tools.json'), '{"leanRule": false}');
    assert.doesNotMatch(rodar(), /🪶/);
  } finally { rm(root); }
});

test('changes: faixas do patch e nomes removidos', () => {
  assert.deepEqual(changedRanges('@@ -1,2 +3,4 @@\n@@ -9 +12 @@\n@@ -20,3 +22,0 @@'), [[3, 6], [12, 12], [22, 22]]);
  assert.deepEqual(removedNames('.mjs', 'export function a() {}\nexport function b() {}\n', 'export function a() {}\n'), ['b']);
  assert.deepEqual(removedNames('.xyz', 'qualquer', ''), []);
});

test('changes: função removida com chamada fora do diff aparece; quem define a própria não', () => {
  const root = repo({
    'src/lib.mjs': 'export function oldFn() {\n  return 1;\n}\n\nexport function keep() {\n  return 2;\n}\n',
    'src/use.mjs': "import { oldFn } from './lib.mjs';\n\nexport function run() {\n  return oldFn();\n}\n",
    'src/other.mjs': 'function oldFn() {\n  return 3;\n}\n\nexport const x = oldFn();\n',
  });
  try {
    writeFileSync(join(root, 'src/lib.mjs'), 'export function keep() {\n  return 20;\n}\n');
    const r = buildChanges(root, { cfg: {} });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.files, ['src/lib.mjs']);
    const old = r.symbols.find((s) => s.name === 'oldFn');
    // `other.mjs` ainda define `oldFn`: o índice a vê definida, então não é "removida" de vez.
    assert.ok(old, 'oldFn deveria aparecer');
    assert.ok(old.outside.some((o) => o.file === 'src/use.mjs'), 'chamada em use.mjs, fora do diff');
    assert.ok(!old.outside.some((o) => o.file === 'src/other.mjs'), 'other.mjs usa a própria oldFn');
    assert.ok(r.symbols.some((s) => s.name === 'keep'), 'keep mudou');
  } finally { rm(root); }
});

test('changes: base inválida e pasta sem git', () => {
  const root = repo({ 'a.mjs': 'export const a = 1;\n' });
  const solto = mkdtempSync(join(tmpdir(), 'ct-rev-nogit-'));
  try {
    assert.equal(buildChanges(root, { cfg: {}, base: 'nao-existe' }).status, 'bad-base');
    assert.equal(buildChanges(solto, { cfg: {} }).status, 'no-git');
  } finally { rm(root); rm(solto); }
});

test('debt: marcadores, gatilho e configuração', () => {
  assert.ok(hasTrigger('remover quando a API v2 sair'));
  assert.ok(hasTrigger('see #123'));
  assert.ok(!hasTrigger('arrumar isso'));
  const re = /\b(TODO|FIXME)\b(?=[\s:(\]-]|$)/;
  assert.deepEqual(parseHit('src/a.mjs:3:// TODO: arrumar', re), { file: 'src/a.mjs', line: 3, marker: 'TODO', text: 'arrumar' });
  assert.equal(parseHit('src/a.mjs:3:// todos os itens', re), null);

  const root = repo({
    'src/a.mjs': '// TODO: arrumar isso\n// FIXME quando a v2 sair\nconst todos = 1; // hackathon\n// NOTE: anotado\n',
    'README.md': 'TODO no markdown não conta\n',
  });
  try {
    const r = buildDebt(root, { cfg: {} });
    assert.equal(r.status, 'ok');
    assert.equal(r.total, 2);
    assert.equal(r.noTrigger, 1);
    assert.ok(r.items.every((i) => typeof i.ageDays === 'number'), 'idade pelo git blame');
    const custom = buildDebt(root, { cfg: { debt: { markers: ['NOTE'] } } });
    assert.equal(custom.total, 1);
    assert.equal(custom.items[0].marker, 'NOTE');
  } finally { rm(root); }
});

// Transcript mínimo do Claude Code: uma linha por mensagem, `tool_use` no assistente, `tool_result` no usuário.
const assistente = (id, name, input, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-06T10:00:00Z', message: { id: `m-${id}`, usage: { cache_read_input_tokens: extra.ctx || 50000, cache_creation_input_tokens: 0, input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id, name, input }] } });
const resultado = (id, texto, isError = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: texto }] } });

test('status: testes depois da edição passaram, editado depois virou pendente', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-status-'));
  try {
    const tr = join(root, 'sessao.jsonl');
    const linhas = [
      assistente('e1', 'Edit', { file_path: join(root, 'src', 'a.mjs') }),
      resultado('e1', 'ok'),
      assistente('t1', 'Bash', { command: 'npm test' }),
      resultado('t1', '# pass 3\n# fail 0'),
    ];
    writeFileSync(tr, linhas.join('\n') + '\n');
    let r = buildStatus(root, { cfg: {}, transcript: tr });
    assert.equal(r.status, 'ok');
    assert.equal(r.tests.state, 'pass');
    assert.equal(r.messages, 2);
    assert.equal(r.splitAdvised, false);

    writeFileSync(tr, [...linhas, assistente('e2', 'Write', { file_path: join(root, 'src', 'b.mjs') }, { ctx: LIMIAR_DIVISAO + 1 })].join('\n') + '\n');
    r = buildStatus(root, { cfg: {}, transcript: tr });
    assert.equal(r.tests.state, 'stale');
    assert.deepEqual(r.tests.unverified, ['src/b.mjs']);
    assert.equal(r.splitAdvised, true);
    assert.ok(r.costMultiplier > 1);

    const band = formatBand(r, makeT('pt'), { usd: 1.5, lastUsd: 0.25, turns: 4 });
    assert.match(band.text, /^\$1\.50 \(último turno \$0\.25\) · 4 turno\(s\) · ctx 200k/);
    assert.match(band.text, /1 editado\(s\) após os testes/);
    assert.match(band.warn, /Dividir já compensa/);
  } finally { rm(root); }
});

test('status: falha lida pelo código de saída e pelo resumo que um pipe esconde', () => {
  assert.equal(ultimoTesteClaude([assistente('t', 'Bash', { command: 'npm test' }), resultado('t', 'Exit code 1', true)].join('\n')), 'fail');
  assert.equal(ultimoTesteClaude([assistente('t', 'Bash', { command: 'npm test | tail' }), resultado('t', '# pass 9\n# fail 2')].join('\n')), 'fail');
  assert.equal(ultimoTesteClaude(assistente('t', 'Bash', { command: 'npm test' })), 'running');
  assert.equal(ultimoTesteClaude(assistente('t', 'Bash', { command: 'ls' })), null);
});

test('status: rollout do Codex lê edição por apply_patch e teste pelo texto da chamada', () => {
  const linha = (input) => JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } });
  const a = atividadeCodex([linha('*** Begin Patch\n*** Update File: src/a.mjs\n@@'), linha('tools.exec_command({cmd:"npm test"})')].join('\n'));
  assert.deepEqual(a.edits, [{ seq: 1, path: 'src/a.mjs' }]);
  assert.equal(a.commands.length, 2);
});

test('status: sem transcript não inventa nada', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-status-vazio-'));
  try {
    const r = buildStatus(root, { cfg: {}, transcript: join(root, 'nao-existe.jsonl') });
    assert.equal(r.status, 'no-session');
    assert.deepEqual(formatBand(r, makeT('en'), {}), { text: '', warn: null });
  } finally { rm(root); }
});

test('faixa: módulo declarado num arquivo de hooks próprio, sem repetir hooks/hooks.json', () => {
  const manifest = JSON.parse(readFileSync(localPath('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.hooks, './hooks/band.json');
  const band = JSON.parse(readFileSync(localPath('../hooks/band.json', import.meta.url), 'utf8'));
  assert.deepEqual(band.hooks, {});
  assert.deepEqual(band.modules, ['./band/register.tsx']);
  const mod = readFileSync(localPath('../hooks/band/register.tsx', import.meta.url), 'utf8');
  assert.match(mod, /scripts\/status\.mjs`, '--band'/);
});
