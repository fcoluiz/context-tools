// Sugestão de registro para sessões que só leram código (`lib/session-reads.mjs`).
//
// Caso real que motivou: uma pergunta "onde o sistema grava este campo?" atravessou o
// cadastro, a conexão e duas units de envio, terminou sem edição — e sem nada para a próxima
// sessão. Estes testes fixam quando a sugestão aparece e, sobretudo, quando ela CALA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { eventsFromLine, pathsInCommand, readCaptureSuggestion } from '../scripts/lib/session-reads.mjs';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

const FILES = [
  'cadastros/UCadCliente.pas',
  'shared/UConexao.pas',
  'shared/utils/UEnvioPedido.pas',
  'shared/utils/UEnvioBoleto.pas',
];

function projeto({ lang = 'pt' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ctx-reads-'));
  for (const file of FILES) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), 'unit X;\ninterface\nimplementation\nend.\n');
  }
  mkdirSync(join(root, 'ai-context', 'features'), { recursive: true });
  writeFileSync(join(root, 'ai-context', lang === 'pt' ? '00-indice.md' : '00-index.md'), '# Índice\n');
  return root;
}

const claudeRead = (path) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path } }] } });
const claudeEdit = (path) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path } }] } });
const codexExec = (cmd, workdir) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'custom_tool_call', name: 'exec', input: `const r=await tools.exec_command({cmd:${JSON.stringify(cmd)},"workdir":${JSON.stringify(workdir)},"max_output_tokens":3000});` },
});

function transcript(root, lines) {
  const path = join(root, 'transcript.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

test('pathsInCommand: caminhos entre aspas, com espaço e em lista separada por vírgula', () => {
  assert.deepEqual(
    pathsInCommand(`Get-Content -LiteralPath 'C:\\Meus Projetos\\a.pas'; Get-Content b.ts,c/d.go | Select-Object -First 10`),
    ['C:\\Meus Projetos\\a.pas', 'b.ts', 'c/d.go'],
  );
  assert.deepEqual(pathsInCommand('rg -n codCliente shared/utils'), [], 'pasta não é arquivo de código');
});

test('eventsFromLine: Claude e os dois formatos do Codex', () => {
  assert.deepEqual(eventsFromLine(JSON.parse(claudeRead('/r/a.pas'))), { reads: [{ path: '/r/a.pas' }], edited: false });
  assert.equal(eventsFromLine(JSON.parse(claudeEdit('/r/a.pas'))).edited, true);
  assert.equal(eventsFromLine(JSON.parse(claudeEdit('/r/notas.md'))).edited, false, 'editar doc não é editar código');

  const exec = eventsFromLine(JSON.parse(codexExec('Get-Content src/a.ts; rg -n x lib/b.py', 'C:\\proj')));
  assert.deepEqual(exec.reads, [{ path: 'src/a.ts', base: 'C:\\proj' }, { path: 'lib/b.py', base: 'C:\\proj' }]);

  const patch = eventsFromLine({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec',
    input: `text(await tools.apply_patch(${JSON.stringify('*** Begin Patch\n*** Update File: C:\\proj\\src\\a.ts\n@@\n-x\n+y\n*** End Patch')}))` } });
  assert.equal(patch.edited, true);

  const legacy = eventsFromLine({ type: 'response_item', payload: { type: 'function_call', name: 'shell',
    arguments: JSON.stringify({ command: ['powershell', '-Command', 'Get-Content src/a.ts'], workdir: '/proj' }) } });
  assert.deepEqual(legacy.reads, [{ path: 'src/a.ts', base: '/proj' }]);
});

test('sugere UMA vez quando a sessão leu código sem cobertura em pastas diferentes', async () => {
  const root = projeto();
  try {
    const path = transcript(root, FILES.map((file) => claudeRead(join(root, file))));
    const first = await readCaptureSuggestion(root, {}, { sessionId: 's1', transcriptPath: path });
    assert.match(first, /leu 4 arquivos/);
    assert.match(first, /diga "registre no contexto"/);
    assert.match(first, /captureHint/);
    assert.equal(await readCaptureSuggestion(root, {}, { sessionId: 's1', transcriptPath: path }), '', 'segunda vez na mesma sessão cala');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('leitura incremental: só fala quando a transcrição ganha leituras suficientes', async () => {
  const root = projeto({ lang: 'en' });
  try {
    const path = transcript(root, FILES.slice(0, 2).map((file) => claudeRead(join(root, file))));
    assert.equal(await readCaptureSuggestion(root, {}, { sessionId: 's2', transcriptPath: path }), '');
    appendFileSync(path, FILES.slice(2).map((file) => codexExec(`Get-Content '${file}'`, root)).join('\n') + '\n');
    assert.match(await readCaptureSuggestion(root, {}, { sessionId: 's2', transcriptPath: path }), /read 4 code files/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cala quando houve edição de código, quando está desligada e quando falta transcrição', async () => {
  const root = projeto();
  try {
    const reads = FILES.map((file) => claudeRead(join(root, file)));
    const edited = transcript(root, [...reads, claudeEdit(join(root, FILES[0]))]);
    assert.equal(await readCaptureSuggestion(root, {}, { sessionId: 'e', transcriptPath: edited }), '', 'edição já tem a revisão própria do Stop');
    const plain = transcript(root, reads);
    assert.equal(await readCaptureSuggestion(root, { documentation: { captureHint: false } }, { sessionId: 'off', transcriptPath: plain }), '');
    assert.equal(await readCaptureSuggestion(root, { documentation: { enabled: false } }, { sessionId: 'off2', transcriptPath: plain }), '');
    assert.equal(await readCaptureSuggestion(root, {}, { sessionId: 'none', transcriptPath: join(root, 'nao-existe.jsonl') }), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cala quando mapa ou documento já cobre o que foi lido', async () => {
  const root = projeto();
  try {
    const path = transcript(root, FILES.map((file) => claudeRead(join(root, file))));
    // Documento que cita só o nome do arquivo já conta: na dúvida, coberto.
    writeFileSync(join(root, 'ai-context', 'features', 'cliente.md'), '# Cadastro de cliente\n\n- UCadCliente.pas\n');
    assert.match(await readCaptureSuggestion(root, {}, { sessionId: 'doc', transcriptPath: path }), /leu 3 arquivos/,
      'o documento tira 1 dos 4; os 3 restantes ainda pedem registro');
    mkdirSync(join(root, '.claude', 'context'), { recursive: true });
    writeFileSync(join(root, '.claude', 'context', 'envio.md'), '---\narea: envio\ncovers:\n  - shared/utils/UEnvioPedido.pas\nverified_at: abc1234\n---\n# Envio\n');
    assert.equal(await readCaptureSuggestion(root, {}, { sessionId: 'doc-e-mapa', transcriptPath: path }), '',
      'com o mapa, sobram 2 sem cobertura: abaixo do limiar');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ignora cópias do IDE, arquivos fora da raiz e caminhos inexistentes', async () => {
  const root = projeto();
  const outside = mkdtempSync(join(tmpdir(), 'ctx-reads-fora-'));
  try {
    mkdirSync(join(root, 'cadastros', '__recovery'), { recursive: true });
    writeFileSync(join(root, 'cadastros', '__recovery', 'UCadCliente.pas'), 'unit X;\n');
    writeFileSync(join(outside, 'Fora.pas'), 'unit X;\n');
    const path = transcript(root, [
      claudeRead(join(root, FILES[0])),
      claudeRead(join(root, FILES[1])),
      claudeRead(join(root, 'cadastros', '__recovery', 'UCadCliente.pas')),
      claudeRead(join(outside, 'Fora.pas')),
      claudeRead(join(root, 'shared', 'NaoExiste.pas')),
    ]);
    assert.equal(await readCaptureSuggestion(root, {}, { sessionId: 'i', transcriptPath: path }), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('E2E Claude: Stop de context-docs entrega a sugestão em systemMessage', () => {
  const root = projeto();
  try {
    const path = transcript(root, FILES.map((file) => claudeRead(join(root, file))));
    const run = spawnSync(process.execPath, [script('context-docs.mjs'), '--stop-report'], {
      cwd: root,
      input: JSON.stringify({ session_id: 'claude-e2e', transcript_path: path, hook_event_name: 'Stop' }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, CONTEXT_TOOLS_HOST: 'claude' },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(JSON.parse(run.stdout).systemMessage, /leu 4 arquivos/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('E2E Codex: Stop sem revisão pendente entrega a sugestão em systemMessage', () => {
  const root = projeto();
  try {
    const path = transcript(root, FILES.map((file) => codexExec(`Get-Content '${file}'`, root)));
    const run = spawnSync(process.execPath, [script('codex-hook.mjs'), 'context-docs.mjs', '--stop-report'], {
      cwd: root,
      input: JSON.stringify({ session_id: 'codex-e2e', turn_id: 't1', cwd: root, transcript_path: path, hook_event_name: 'Stop', stop_hook_active: false }),
      encoding: 'utf8',
      env: { ...process.env, CONTEXT_TOOLS_LANG: 'en' },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(JSON.parse(run.stdout).systemMessage, /leu 4 arquivos/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a frase sugerida ao usuário é a mesma que a skill reconhece', () => {
  // A mensagem só funciona como atalho se a skill souber o que fazer com ela.
  const skill = readFileSync(fileURLToPath(new URL('../skills/context-tools/SKILL.md', import.meta.url)), 'utf8');
  assert.match(skill, /registre no contexto/);
  assert.match(skill, /save this to context/);
});
