// Migração da cópia local antiga para o plugin global (`scripts/lib/local-migration.mjs`).
//
// O que se fixa: só sai o que o instalador escreveu (hook nosso, plugin do marketplace antigo,
// skill `context-tools`), o resto do settings.json fica intacto, toda mudança tem cópia FORA do
// projeto, e o aviso do hook global aparece uma vez por dia — nunca fora do plugin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectLocalCopy, disableUserLegacyPlugins, knownProjects, localCopyNotice, migrateLocalCopy, LOCAL_NOTICE_EVERY_MS,
} from '../scripts/lib/local-migration.mjs';
import { makeT } from '../scripts/lib/i18n.mjs';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const t = makeT('pt');
const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const writeJson = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2)); };
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function oldClaudeProject() {
  const root = temp('ct-mig-');
  writeJson(join(root, '.claude', 'settings.json'), {
    permissions: { allow: ['Bash(npm test)'] },
    enabledPlugins: { 'context-tools@luiz-context-tools': true, 'outro@mkt': true },
    hooks: {
      SessionStart: [{ matcher: '', hooks: [
        { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/context-maps.mjs" --session-start' },
        { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/meu-hook.mjs"' },
      ] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/grep-context.mjs"' }] }],
    },
  });
  writeJson(join(root, '.claude', 'context-tools-install.json'), { name: 'context-tools', version: '1.14.0' });
  writeJson(join(root, '.claude', 'context-tools.json'), { lang: 'pt' });
  return root;
}

test('detecta hooks antigos (inclusive grep-context) e o plugin do marketplace antigo', () => {
  const root = oldClaudeProject();
  try {
    const found = detectLocalCopy(root, 'claude');
    assert.equal(found.found, true);
    assert.equal(found.items[0].hooks, 2, 'meu-hook.mjs não é nosso');
    assert.deepEqual(found.items[0].legacyPlugins, ['context-tools@luiz-context-tools']);
    assert.equal(detectLocalCopy(root, 'codex').found, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migra: tira só o que é nosso, desliga o plugin antigo, marca global e guarda cópia fora do projeto', () => {
  const root = oldClaudeProject();
  const home = temp('ct-mig-home-');
  try {
    const result = migrateLocalCopy(root, 'claude', { env: { CONTEXT_TOOLS_HOME: home }, now: NOW });
    const settings = readJson(join(root, '.claude', 'settings.json'));
    assert.deepEqual(settings.hooks, { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/meu-hook.mjs"' }] }] });
    assert.deepEqual(settings.enabledPlugins, { 'context-tools@luiz-context-tools': false, 'outro@mkt': true });
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });
    assert.equal(readJson(join(root, '.claude', 'context-tools-install.json')).mode, 'global');
    assert.deepEqual(readJson(join(root, '.claude', 'context-tools.json')), { lang: 'pt' }, 'configuração fica');
    assert.ok(result.backup.startsWith(home), 'cópia fora do projeto');
    const saved = readJson(join(result.backup, '.claude', 'settings.json'));
    assert.equal(saved.hooks.PreToolUse.length, 1, 'a cópia é o arquivo de antes');
    assert.equal(detectLocalCopy(root, 'claude').found, false, 'rodar de novo não acha nada');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Codex: hooks de .codex/hooks.json e a skill local duplicada', () => {
  const root = temp('ct-mig-codex-');
  const home = temp('ct-mig-home-');
  try {
    writeJson(join(root, '.codex', 'hooks.json'), { hooks: { Stop: [{ hooks: [
      { type: 'command', command: 'node .codex/scripts/codex-hook.mjs context-maps.mjs --stop-report' },
      { type: 'command', command: 'node outro.mjs' },
    ] }] } });
    mkdirSync(join(root, '.agents', 'skills', 'context-tools'), { recursive: true });
    writeFileSync(join(root, '.agents', 'skills', 'context-tools', 'SKILL.md'), '---\nname: context-tools\n---\n');
    mkdirSync(join(root, '.agents', 'skills', 'minha'), { recursive: true });
    writeFileSync(join(root, '.agents', 'skills', 'minha', 'SKILL.md'), '---\nname: minha\n---\n');
    const result = migrateLocalCopy(root, 'codex', { env: { CONTEXT_TOOLS_HOME: home }, now: NOW });
    assert.equal(result.changed.length, 2);
    assert.deepEqual(readJson(join(root, '.codex', 'hooks.json')).hooks.Stop[0].hooks.map((h) => h.command), ['node outro.mjs']);
    assert.equal(existsSync(join(root, '.agents', 'skills', 'context-tools')), false);
    assert.equal(existsSync(join(root, '.agents', 'skills', 'minha', 'SKILL.md')), true, 'skill alheia fica');
    assert.equal(existsSync(join(result.backup, '.agents', 'skills', 'context-tools', 'SKILL.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('dry-run e projeto sem cópia local não mudam nada', () => {
  const root = oldClaudeProject();
  const clean = temp('ct-mig-clean-');
  try {
    const before = readFileSync(join(root, '.claude', 'settings.json'), 'utf8');
    assert.equal(migrateLocalCopy(root, 'claude', { dryRun: true }).backup, null);
    assert.equal(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'), before);
    assert.deepEqual(migrateLocalCopy(clean, 'claude').changed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});

test('knownProjects lê ~/.claude.json e o config.toml do Codex, sem repetir e só pastas que existem', () => {
  const config = temp('ct-mig-cfg-');
  const project = temp('ct-mig-proj-');
  try {
    writeJson(join(config, '.claude.json'), { projects: { [project]: {}, [project.replace(/\\/g, '/')]: {}, [join(config, 'sumiu')]: {} } });
    mkdirSync(join(config, 'codex'));
    writeFileSync(join(config, 'codex', 'config.toml'), `[projects.'${project}']\ntrust_level = "trusted"\n`);
    assert.deepEqual(knownProjects({ CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(config, 'codex') }), [project]);
  } finally {
    rmSync(config, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('plugin antigo ligado no escopo do usuário: desliga com cópia', () => {
  const config = temp('ct-mig-user-');
  const home = temp('ct-mig-home-');
  try {
    writeJson(join(config, 'settings.json'), { enabledPlugins: { 'context-tools@luiz-context-tools': true, 'context-tools@context-tools': true } });
    const result = disableUserLegacyPlugins({ env: { CLAUDE_CONFIG_DIR: config, CONTEXT_TOOLS_HOME: home }, now: NOW });
    assert.deepEqual(result.ids, ['context-tools@luiz-context-tools']);
    assert.deepEqual(readJson(join(config, 'settings.json')).enabledPlugins, { 'context-tools@luiz-context-tools': false, 'context-tools@context-tools': true });
    assert.equal(existsSync(join(result.backup, 'settings.json')), true);
  } finally {
    rmSync(config, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('aviso do hook: só no plugin global, uma vez por dia por projeto, com o comando de migrar', () => {
  const root = oldClaudeProject();
  const home = temp('ct-mig-home-');
  try {
    const env = { CONTEXT_TOOLS_HOME: home, CLAUDE_PLUGIN_ROOT: '/plugins/context-tools' };
    assert.equal(localCopyNotice(root, { env: { CONTEXT_TOOLS_HOME: home }, now: NOW, t }), '', 'cópia local rodando sozinha: não é duplicata');
    const text = localCopyNotice(root, { env, now: NOW, t });
    assert.match(text, /cópia local antiga do context-tools \(2 hook\(s\) local\(is\), plugin antigo context-tools@luiz-context-tools ligado\)/);
    assert.match(text, /node "\/plugins\/context-tools\/setup\.mjs" migrate --project ".+" --target=claude --yes/);
    assert.equal(localCopyNotice(root, { env, now: NOW + 1000, t }), '', 'mesmo dia: cala');
    assert.notEqual(localCopyNotice(root, { env, now: NOW + LOCAL_NOTICE_EVERY_MS + 1, t }), '');
    assert.equal(localCopyNotice(root, { env: { ...env, CONTEXT_TOOLS_LOCAL_COPY_CHECK: '0' }, now: NOW + 3 * LOCAL_NOTICE_EVERY_MS, t }), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
