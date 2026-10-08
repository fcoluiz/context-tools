// Robustez do harness: comportamentos que existem para o agente receber cada informação UMA
// vez, no momento certo, sem custo extra de contexto.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { localPath } from './paths.mjs';
import { claimHookEmission, HOOK_DEDUPE_WINDOW_MS } from '../scripts/lib/hook-output.mjs';

const SCRIPTS = localPath('../scripts/', import.meta.url);

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-harness-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  return dir;
}

function runHook(script, args, env, input = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(SCRIPTS, script), ...args], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', (status) => resolve({ status, out }));
    child.stdin.end(input);
  });
}

test('a mesma mensagem de hook só é reivindicada uma vez dentro da janela', () => {
  const root = tempProject();
  const env = {};
  try {
    const now = Date.now();
    assert.equal(claimHookEmission(root, 'SessionStart', 'texto', { sessionId: 's1', now, env }), true);
    assert.equal(claimHookEmission(root, 'SessionStart', 'texto', { sessionId: 's1', now: now + 1000, env }), false);
    // Outro texto, outro evento ou outra sessão não são duplicatas.
    assert.equal(claimHookEmission(root, 'SessionStart', 'outro', { sessionId: 's1', now, env }), true);
    assert.equal(claimHookEmission(root, 'Stop', 'texto', { sessionId: 's1', now, env }), true);
    assert.equal(claimHookEmission(root, 'SessionStart', 'texto', { sessionId: 's2', now, env }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fora da janela a mensagem volta a ser emitida (ex.: SessionStart depois de /compact)', () => {
  const root = tempProject();
  const env = {};
  try {
    const now = Date.now();
    assert.equal(claimHookEmission(root, 'SessionStart', 'texto', { sessionId: 's', now, env }), true);
    const later = now + HOOK_DEDUPE_WINDOW_MS + 5000;
    assert.equal(claimHookEmission(root, 'SessionStart', 'texto', { sessionId: 's', now: later, env }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CONTEXT_TOOLS_HOOK_DEDUPE=0 desliga a deduplicação', () => {
  const root = tempProject();
  try {
    const env = { CONTEXT_TOOLS_HOOK_DEDUPE: '0' };
    assert.equal(claimHookEmission(root, 'SessionStart', 'texto', { env }), true);
    assert.equal(claimHookEmission(root, 'SessionStart', 'texto', { env }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duas instalações do mesmo hook rodando em paralelo entregam o contexto uma vez só', async () => {
  const root = tempProject();
  try {
    writeFileSync(join(root, 'README.md'), '# projeto\n');
    const env = { CLAUDE_PROJECT_DIR: root, CONTEXT_TOOLS_SESSION_ID: 'dup-session', CONTEXT_TOOLS_HOOK_DEDUPE: '' };
    // Primeira abertura cria o ai-context; as duplicatas reais acontecem no estado estável.
    await runHook('context-docs.mjs', ['--session-start'], { ...env, CONTEXT_TOOLS_SESSION_ID: 'warmup' });
    const [a, b] = await Promise.all([
      runHook('context-docs.mjs', ['--session-start'], env),
      runHook('context-docs.mjs', ['--session-start'], env),
    ]);
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    const emitted = [a.out, b.out].filter((out) => out.includes('additionalContext'));
    assert.equal(emitted.length, 1, `esperava uma emissão, veio ${emitted.length}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- laço de verificação ----------------------------------------------------------------

function transcriptLine(blocks) {
  return JSON.stringify({ type: 'assistant', message: { content: blocks.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input })) } });
}

function projectWithTests({ withTests = true } = {}) {
  const root = tempProject();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'calculo.mjs'), 'export function soma(a, b) { return a + b; }\n');
  if (withTests) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests', 'calculo.test.mjs'), "import { soma } from '../src/calculo.mjs';\n");
  }
  return root;
}

function stopEnv(root, transcript, sid = 'verify-session') {
  const file = join(root, 'transcript.jsonl');
  writeFileSync(file, transcript.join('\n'));
  return { CLAUDE_PROJECT_DIR: root, CONTEXT_TOOLS_SESSION_ID: sid, CONTEXT_TOOLS_TRANSCRIPT_PATH: file, CONTEXT_TOOLS_HOST: 'claude', CONTEXT_TOOLS_LANG: 'en' };
}

test('Stop avisa uma vez quando código foi editado sem teste depois', async () => {
  const root = projectWithTests();
  try {
    const env = stopEnv(root, [transcriptLine([['Edit', { file_path: join(root, 'src', 'calculo.mjs') }]])]);
    const first = await runHook('verify.mjs', ['--stop-report'], env);
    assert.match(first.out, /src\/calculo\.mjs/);
    assert.match(first.out, /tests\/calculo\.test\.mjs/);
    assert.match(first.out, /npm test/);
    const second = await runHook('verify.mjs', ['--stop-report'], env);
    assert.equal(second.out, '', 'o aviso é único por sessão');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Stop cala quando um teste rodou depois da última edição', async () => {
  const root = projectWithTests();
  try {
    const env = stopEnv(root, [
      transcriptLine([['Edit', { file_path: join(root, 'src', 'calculo.mjs') }]]),
      transcriptLine([['Bash', { command: 'npm test' }]]),
    ]);
    const out = await runHook('verify.mjs', ['--stop-report'], env);
    assert.equal(out.out, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Stop volta a cobrar edição feita DEPOIS do teste', async () => {
  const root = projectWithTests();
  try {
    const env = stopEnv(root, [
      transcriptLine([['Bash', { command: 'node --test tests/' }]]),
      transcriptLine([['Write', { file_path: join(root, 'src', 'calculo.mjs') }]]),
    ]);
    const out = await runHook('verify.mjs', ['--stop-report'], env);
    assert.match(out.out, /calculo\.mjs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Stop nunca fala em projeto sem testes, em edição só de documentação ou no Codex', async () => {
  const semTestes = projectWithTests({ withTests: false });
  const comTestes = projectWithTests();
  try {
    const edit = (r) => [transcriptLine([['Edit', { file_path: join(r, 'src', 'calculo.mjs') }]])];
    assert.equal((await runHook('verify.mjs', ['--stop-report'], stopEnv(semTestes, edit(semTestes)))).out, '');
    writeFileSync(join(comTestes, 'README.md'), '# x\n');
    const doc = [transcriptLine([['Edit', { file_path: join(comTestes, 'README.md') }]])];
    assert.equal((await runHook('verify.mjs', ['--stop-report'], stopEnv(comTestes, doc, 'doc'))).out, '');
    const codex = { ...stopEnv(comTestes, edit(comTestes), 'codex'), CONTEXT_TOOLS_HOST: 'codex' };
    assert.equal((await runHook('verify.mjs', ['--stop-report'], codex)).out, '');
  } finally {
    rmSync(semTestes, { recursive: true, force: true });
    rmSync(comTestes, { recursive: true, force: true });
  }
});

// ---- SQL no índice ------------------------------------------------------------------------

test('SQL: tabelas, colunas e objetos viram símbolos; comentário e string não', async () => {
  const { symbolsForSql } = await import('../scripts/outline.mjs');
  const sql = [
    '-- CREATE TABLE Fantasma (x int)',
    'CREATE TABLE dbo.[Clientes] (',
    '  Id INT NOT NULL PRIMARY KEY,',
    "  Nome VARCHAR(100) DEFAULT 'a, b',",
    '  LimiteCredito NUMERIC(15,2),',
    '  CONSTRAINT FK_X FOREIGN KEY (Id) REFERENCES Outra(Id)',
    ');',
    '/* CREATE VIEW Nada AS SELECT 1 */',
    'CREATE OR ALTER PROCEDURE SP_CALCULA_MARGEM AS SELECT 1;',
    'ALTER TABLE Clientes ADD COLUMN Email VARCHAR(200);',
    'create table if not exists pedidos (id serial, total numeric(10,2));',
  ];
  const nomes = symbolsForSql(sql).map((s) => `${s.line}:${s.name}`);
  assert.deepEqual(nomes, [
    '2:table Clientes', '3:column Clientes.Id', '4:column Clientes.Nome', '5:column Clientes.LimiteCredito',
    '9:procedure SP_CALCULA_MARGEM', '10:column Clientes.Email',
    '11:table pedidos', '11:column pedidos.id', '11:column pedidos.total',
  ]);
});

test('SQL entra no índice, mas não conta como código para mapas e revisão automática', async () => {
  const { CODE_RE, INDEX_RE } = await import('../scripts/lib/roots.mjs');
  assert.equal(INDEX_RE.test('db/schema.sql'), true);
  assert.equal(CODE_RE.test('db/schema.sql'), false);
  assert.equal(CODE_RE.test('src/app.ts'), true);
});

// ---- orçamento de latência ------------------------------------------------------------------
// O PreToolUse roda em TODA busca. Medir tempo no CI seria instável entre SOs; o que mantém o
// caminho barato é determinístico: o topo do hook (e o que ele importa) só carrega o mínimo, e o
// índice entra por `await import` depois que o padrão passa no teste de "cara de símbolo".
test('o hook PreToolUse não importa módulos pesados no topo', async () => {
  const { readFileSync } = await import('node:fs');
  const estaticos = (arquivo) => [...readFileSync(localPath(`../scripts/${arquivo}`, import.meta.url), 'utf8')
    .matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]).filter((m) => !m.startsWith('node:'));
  assert.deepEqual(estaticos('pre-tool.mjs').sort(), ['./lib/hook-output.mjs', './lib/roots.mjs']);
  assert.deepEqual(estaticos('lib/hook-output.mjs'), ['./roots.mjs']);
});

// A regex era `/\\s+/` — casava o TEXTO "\s", não espaço: `C:\x\scripts` virava `C:\x cripts`
// em todo handoff, e quebras de linha/tabs não eram colapsadas.
test('sanitizeModelText preserva "\\s" de caminho Windows e colapsa espaço em branco', async () => {
  const { sanitizeModelText } = await import('../scripts/lib/roots.mjs');
  assert.equal(sanitizeModelText('C:\\proj\\scripts\\lib\\a.mjs'), 'C:\\proj\\scripts\\lib\\a.mjs');
  assert.equal(sanitizeModelText('a  \t b'), 'a b');
});
