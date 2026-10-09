// Servidor MCP opcional: protocolo (JSON-RPC por linha em stdio), as cinco ferramentas, a fronteira
// de caminho, o custo das definições e o registro pelo setup (`--mcp`, atualização, `--remove-mcp`)
// contra CLIs falsas. Nada aqui toca a configuração real da máquina.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { localPath } from './paths.mjs';
import { TOOLS, PROTOCOL_VERSIONS } from '../scripts/mcp-server.mjs';

const SERVER = localPath('../scripts/mcp-server.mjs');
const SETUP = localPath('../setup.mjs');

function projeto() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-mcp-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'pedido.js'), 'export function confirmar(p) {\n  return p;\n}\n');
  writeFileSync(join(dir, 'src', 'tela.js'), "import { confirmar } from './pedido.js';\nexport function salvar() {\n  return confirmar(1);\n}\n");
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** Conversa inteira numa execução: manda as linhas, devolve as respostas (uma por linha de stdout). */
function conversa(dir, mensagens) {
  const input = mensagens.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('\n') + '\n';
  const r = spawnSync(process.execPath, [SERVER], {
    cwd: dir, input, encoding: 'utf8',
    env: { ...process.env, CONTEXT_TOOLS_LANG: 'en', CONTEXT_TOOLS_STATE_DIR: join(dir, '.state'), CLAUDE_PROJECT_DIR: '', CONTEXT_TOOLS_PROJECT_DIR: dir },
  });
  const linhas = r.stdout.split('\n').filter(Boolean);
  return linhas.map((l) => JSON.parse(l));   // lança se algo que não é JSON-RPC sair em stdout
}

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('MCP: handshake, lista de ferramentas e versão de protocolo negociada', () => {
  const dir = projeto();
  try {
    const [init, lista] = conversa(dir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    assert.equal(init.result.protocolVersion, PROTOCOL_VERSIONS[0], 'versão desconhecida recebe a mais nova suportada');
    assert.equal(init.result.serverInfo.name, 'context-tools');
    assert.deepEqual(lista.result.tools.map((t) => t.name), ['find_symbol', 'references', 'impact', 'outline', 'overview']);
    assert.ok(lista.result.tools.every((t) => t.annotations.readOnlyHint === true), 'todas as ferramentas só leem');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCP: as ferramentas devolvem a mesma resposta das CLIs, e caminho fora do projeto é recusado', () => {
  const dir = projeto();
  try {
    const r = conversa(dir, [
      call(1, 'find_symbol', { names: ['confirmar'] }),
      call(2, 'references', { name: 'confirmar' }),
      call(3, 'impact', { target: 'confirmar' }),
      call(4, 'outline', { file: 'src/tela.js' }),
      call(5, 'outline', { file: '../fora.js' }),
      call(6, 'overview', {}),
      call(7, 'nada', {}),
      { jsonrpc: '2.0', id: 8, method: 'resources/list' },
      'isto não é json',
    ]);
    const porId = Object.fromEntries(r.filter((x) => x.id !== null).map((x) => [x.id, x]));
    const texto = (id) => porId[id].result.content[0].text;
    assert.match(texto(1), /src\/pedido\.js:1-\d/);
    assert.match(texto(2), /src\/tela\.js \(2\) — \(top level\) :1, function salvar :3/);
    assert.match(texto(3), /🎯 impact of "confirmar"/);
    assert.match(texto(4), /function salvar/);
    assert.equal(porId[5].result.isError, true);
    assert.match(texto(5), /inside the project/);
    assert.match(texto(6), /source files/);
    assert.equal(porId[7].result.isError, true);
    assert.equal(porId[8].error.code, -32601);
    assert.ok(r.some((x) => x.id === null && x.error?.code === -32700), 'linha inválida vira Parse error, não silêncio');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCP: definição das ferramentas tem teto (entra em toda requisição do cliente)', () => {
  const tamanho = JSON.stringify({ tools: TOOLS }).length;
  assert.ok(tamanho <= 2200, `tools/list com ${tamanho} caracteres (teto 2.200)`);
});

// CLI falsa com o subconjunto de `plugin` e `mcp` que o setup usa; guarda as chamadas.
const FAKE = String.raw`
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const [agent, ...args] = process.argv.slice(2);
const file = process.env.FAKE_CLI_STATE;
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
state.calls ||= [];
state.calls.push([agent, ...args].join(' '));
state[agent] ||= { plugin: null, mcp: null };
const me = state[agent];
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const out = (v) => { save(); process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
const fail = (m) => { save(); process.stderr.write(m); process.exit(1); };
const cmd = args.filter((a) => !a.startsWith('--')).join(' ');
if (args[0] === '--version') out('fake 1.0');
if (cmd === 'plugin list') out(me.plugin ? [{ id: 'context-tools@context-tools', version: me.plugin, scope: 'user' }] : []);
if (cmd === 'plugin marketplace list') out([]);
if (cmd.startsWith('plugin marketplace add')) out('added');
if (cmd.startsWith('plugin install') || cmd.startsWith('plugin update')) { me.plugin = '9.9.9'; out('ok'); }
if (cmd === 'mcp get context-tools') return me.mcp ? out(me.mcp) : fail('No MCP server named context-tools');
if (args[0] === 'mcp' && args[1] === 'add') { if (me.mcp) fail('already exists'); me.mcp = args.slice(args.indexOf('--') + 1).join(' '); out('added'); }
if (args[0] === 'mcp' && args[1] === 'remove') { if (!me.mcp) fail('not found'); me.mcp = null; out('removed'); }
fail('fake cli: unexpected ' + args.join(' '));
`.replace('return me.mcp', 'me.mcp');

function maquina() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-mcp-setup-'));
  const bin = join(dir, 'bin');
  const project = join(dir, 'project');
  mkdirSync(bin, { recursive: true });
  mkdirSync(project, { recursive: true });
  const script = join(dir, 'fake.mjs');
  writeFileSync(script, FAKE);
  if (process.platform === 'win32') writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${script}" claude %*\r\n`);
  else { writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" claude "$@"\n`); chmodSync(join(bin, 'claude'), 0o755); }
  const state = join(dir, 'state.json');
  writeFileSync(state, '{}');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  Object.assign(env, { PATH: [bin, dirname(process.execPath)].join(delimiter), FAKE_CLI_STATE: state, CONTEXT_TOOLS_LANG: 'en', CONTEXT_TOOLS_HOME: join(dir, 'home dir') });
  return {
    dir,
    run: (...extra) => spawnSync(process.execPath, [SETUP, '--global', '--yes', '--target=claude', '--ref=v9.9.9', ...extra], { cwd: project, env, encoding: 'utf8' }),
    state: () => JSON.parse(readFileSync(state, 'utf8')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('setup: MCP só com --mcp; atualização renova a cópia estável; --remove-mcp desfaz', () => {
  const m = maquina();
  // Pasta com espaço de propósito: é o caso em que o CLI recebia o caminho com aspas literais.
  const servidor = join(m.dir, 'home dir', 'runtime', 'scripts', 'mcp-server.mjs');
  try {
    let r = m.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!m.state().calls.some((c) => c.startsWith('claude mcp add')), 'sem --mcp, nenhum registro');
    assert.equal(existsSync(servidor), false);

    r = m.run('--mcp');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(m.state().claude.mcp, `node ${servidor}`);
    assert.ok(m.state().calls.some((c) => c.startsWith('claude mcp add context-tools --scope user -- node ')), m.state().calls.join('\n'));
    assert.ok(existsSync(servidor), 'scripts copiados para a pasta estável');
    assert.match(r.stdout, /MCP server registered for Claude/);

    rmSync(servidor);
    r = m.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(servidor), 'já registrado: a atualização renova a cópia sem perguntar');
    assert.match(r.stdout, /MCP server for Claude updated/);

    r = m.run('--remove-mcp');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(m.state().claude.mcp, null);
  } finally { m.cleanup(); }
});
