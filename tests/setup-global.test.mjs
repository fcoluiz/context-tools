// `setup.mjs --global` contra CLIs falsas de Claude e Codex. As falsas reproduzem o comportamento
// MEDIDO nos CLIs reais (Claude Code 2.1.x, codex-cli 0.147): o Claude sobrescreve o marketplace
// ao adicioná-lo de novo e `plugin install` num plugin já instalado só responde "already
// installed" (atualizar exige `plugin update`); o Codex recusa adicionar o mesmo marketplace com
// outra tag sem remover antes. Nada aqui acessa a rede nem a configuração real da máquina.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { localPath } from './paths.mjs';

const SETUP = localPath('../setup.mjs');

const FAKE_CLI = String.raw`
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const [agent, ...args] = process.argv.slice(2);
const file = process.env.FAKE_CLI_STATE;
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
state[agent] ||= { marketplace: null, plugin: null };
state.calls ||= [];
state.calls.push([agent, ...args].join(' '));
const me = state[agent];
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const out = (value) => { save(); process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0); };
const fail = (message) => { save(); process.stderr.write(message); process.exit(1); };
const cmd = args.filter((a) => !a.startsWith('--')).join(' ');
const scope = args.includes('--scope') ? args[args.indexOf('--scope') + 1] : null;
const ver = (ref) => ref.replace(/^v/, '');

if (args[0] === '--version') out('fake 1.0');
if (agent === 'claude') {
  if (cmd === 'plugin list') out(me.plugin ? [{ id: 'context-tools@context-tools', version: me.plugin.version, scope: me.plugin.scope }] : []);
  if (cmd === 'plugin marketplace list') out(me.marketplace ? [{ name: 'context-tools', source: 'github', ref: me.marketplace.ref }] : []);
  if (cmd.startsWith('plugin marketplace add ')) { me.marketplace = { ref: args[3].split('@')[1], scope }; out('added'); }
  if (cmd.startsWith('plugin marketplace remove ')) { me.marketplace = null; out('removed'); }
  if (cmd.startsWith('plugin install ')) {
    if (me.plugin && me.plugin.scope === scope) out('already installed');
    me.plugin = { version: ver(me.marketplace.ref), scope }; out('installed');
  }
  if (cmd.startsWith('plugin update ')) { me.plugin.version = ver(me.marketplace.ref); out('updated'); }
}
if (agent === 'codex') {
  if (cmd === 'plugin list') out({ installed: me.plugin ? [{ pluginId: 'context-tools@context-tools-codex', name: 'context-tools', marketplaceName: 'context-tools-codex', version: me.plugin.version, source: { ref: me.plugin.ref } }] : [] });
  if (cmd === 'plugin marketplace list') out({ marketplaces: me.marketplace ? [{ name: 'context-tools-codex' }] : [] });
  if (cmd.startsWith('plugin marketplace add ')) {
    const ref = args[args.indexOf('--ref') + 1];
    if (me.marketplace && me.marketplace.ref !== ref) fail('already added from a different source');
    me.marketplace = { ref }; out('added');
  }
  if (cmd.startsWith('plugin marketplace remove ')) { me.marketplace = null; out('removed'); }
  if (cmd.startsWith('plugin add ')) { me.plugin = { version: ver(me.marketplace.ref), ref: me.marketplace.ref }; out('added'); }
}
fail('fake cli: unexpected ' + args.join(' '));
`;

function fakeMachine(agents, initial = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-global-'));
  const bin = join(dir, 'bin');
  const project = join(dir, 'project');
  for (const sub of [bin, project]) spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(sub)}, { recursive: true })`]);
  const script = join(dir, 'fake-cli.mjs');
  writeFileSync(script, FAKE_CLI);
  for (const agent of agents) {
    if (process.platform === 'win32') {
      writeFileSync(join(bin, `${agent}.cmd`), `@"${process.execPath}" "${script}" ${agent} %*\r\n`);
    } else {
      const path = join(bin, agent);
      writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${agent} "$@"\n`);
      chmodSync(path, 0o755);
    }
  }
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify(initial));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [bin, dirname(process.execPath)].join(delimiter);
  Object.assign(env, { FAKE_CLI_STATE: stateFile, CONTEXT_TOOLS_LANG: 'en' });
  delete env.CONTEXT_TOOLS_PROJECT_DIR;
  return {
    dir,
    project,
    run: (...extra) => spawnSync(process.execPath, [SETUP, '--global', '--yes', ...extra], { cwd: project, env, encoding: 'utf8' }),
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('setup --global instala nos dois agentes, no escopo do usuário, sem tocar no projeto', () => {
  const m = fakeMachine(['claude', 'codex']);
  try {
    const r = m.run('--ref=v9.9.9');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { calls, claude, codex } = m.state();
    assert.ok(calls.includes('claude plugin marketplace add fcoluiz/context-tools@v9.9.9 --scope user'), calls.join('\n'));
    assert.ok(calls.includes('claude plugin install context-tools@context-tools --scope user'), calls.join('\n'));
    assert.ok(calls.includes('codex plugin marketplace add fcoluiz/context-tools --ref v9.9.9'), calls.join('\n'));
    assert.ok(calls.includes('codex plugin add context-tools@context-tools-codex'), calls.join('\n'));
    assert.deepEqual(claude.plugin, { version: '9.9.9', scope: 'user' });
    assert.equal(codex.plugin.version, '9.9.9');
    assert.deepEqual(readdirSync(m.project), [], 'global não escreve nada na pasta onde rodou');
    assert.match(r.stdout, /Global installation/);
  } finally { m.cleanup(); }
});

test('setup --global atualiza uma instalação anterior (Claude via update, Codex trocando a tag)', () => {
  const m = fakeMachine(['claude', 'codex'], {
    claude: { marketplace: { ref: 'v9.9.8', scope: 'user' }, plugin: { version: '9.9.8', scope: 'user' } },
    codex: { marketplace: { ref: 'v9.9.8' }, plugin: { version: '9.9.8', ref: 'v9.9.8' } },
  });
  try {
    const r = m.run('--ref=v9.9.9');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { calls, claude, codex } = m.state();
    assert.equal(claude.plugin.version, '9.9.9', `install sozinho não atualizaria o Claude\n${calls.join('\n')}\n${r.stdout}`);
    assert.ok(calls.includes('claude plugin update context-tools@context-tools --scope user'), calls.join('\n'));
    assert.ok(!calls.some((c) => c.startsWith('claude plugin marketplace remove')), 'o Claude sobrescreve o marketplace; não precisa remover');
    assert.ok(calls.includes('codex plugin marketplace remove context-tools-codex'), calls.join('\n'));
    assert.equal(codex.plugin.version, '9.9.9');
  } finally { m.cleanup(); }
});

test('setup --global sem --target só atua nos agentes cujo CLI existe', () => {
  const m = fakeMachine(['claude']);
  try {
    const r = m.run('--ref=v9.9.9');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { calls } = m.state();
    assert.ok(calls.some((c) => c.startsWith('claude plugin install')));
    assert.ok(!calls.some((c) => c.startsWith('codex ')), 'Codex ausente não é tocado nem instalado');
    assert.ok(!existsSync(join(m.project, '.claude')));
  } finally { m.cleanup(); }
});

test('setup --global sem nenhum CLI explica o que falta, em vez de instalar algo por conta própria', () => {
  const m = fakeMachine([]);
  try {
    const r = m.run('--ref=v9.9.9');
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /Neither the Claude Code CLI nor the Codex CLI/);
    assert.deepEqual(m.state().calls || [], []);
  } finally { m.cleanup(); }
});
