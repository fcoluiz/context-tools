// Aviso de versão nova (`scripts/update-check.mjs`).
//
// Nada aqui toca a rede: o cache é preparado à mão e a atualização em segundo plano é trocada por
// um contador. O que se fixa é QUANDO o aviso aparece, quando ele cala, e que o hook nunca espera
// por rede.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CHECK_INTERVAL_MS, REMIND_AFTER_MS, compareVersions, installedVersion, latestTagFromLsRemote, updateNotice,
} from '../scripts/update-check.mjs';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const NOW = Date.parse('2026-10-09T12:00:00Z');

function home(cache) {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-update-'));
  if (cache) writeFileSync(join(dir, 'update-check.json'), JSON.stringify(cache));
  return dir;
}

function notice(dir, { cfg = {}, env = {}, installed = '2.4.0', now = NOW, lang = 'pt' } = {}) {
  let refreshes = 0;
  const text = updateNotice(cfg, {
    env: { CONTEXT_TOOLS_HOME: dir, ...env },
    now, installed, lang,
    path: join(dir, 'update-check.json'),
    startRefresh: () => { refreshes++; },
  });
  return { text, refreshes };
}

test('compareVersions e latestTagFromLsRemote', () => {
  assert.ok(compareVersions('2.10.0', '2.9.9') > 0);
  assert.equal(compareVersions('v2.4.0', '2.4.0'), 0);
  const lsRemote = 'abc\trefs/tags/v2.2.0\ndef\trefs/tags/v2.10.0\nfff\trefs/tags/v2.4.0\n000\trefs/tags/nao-e-versao\n';
  assert.equal(latestTagFromLsRemote(lsRemote), 'v2.10.0');
  assert.equal(latestTagFromLsRemote(''), null);
});

test('installedVersion: plugin (package.json) e instalação standalone (marcador)', () => {
  const dir = home();
  try {
    assert.equal(installedVersion(dir), null);
    writeFileSync(join(dir, 'context-tools-install.json'), JSON.stringify({ name: 'context-tools', version: '2.1.0' }));
    assert.equal(installedVersion(dir), '2.1.0');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'outro-pacote', version: '9.9.9' }));
    assert.equal(installedVersion(dir), '2.1.0', 'package.json de outro projeto não conta');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('avisa quando o cache conhece versão mais nova, sem disparar rede com cache fresco', () => {
  const dir = home({ latest: '2.5.0', checkedAt: NOW - 1000 });
  try {
    const { text, refreshes } = notice(dir);
    assert.match(text, /context-tools 2\.5\.0 disponível \(instalado: 2\.4\.0\)/);
    assert.match(text, /context-tools-setup-all --yes/, 'instalação por projeto: sem --global');
    assert.match(text, /"updateCheck": false/);
    assert.equal(refreshes, 0);
    assert.match(notice(home({ latest: '2.5.0', checkedAt: NOW }), { env: { PLUGIN_ROOT: '/p' }, lang: 'en' }).text,
      /is available.*context-tools-setup-all --global --yes/, 'plugin: comando global, em inglês');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('repete só depois de uma semana, e cala quando já está atualizado', () => {
  const dir = home({ latest: '2.5.0', checkedAt: NOW });
  try {
    assert.notEqual(notice(dir).text, '');
    assert.equal(notice(dir, { now: NOW + 1000 }).text, '', 'mesmo aviso no mesmo dia: cala');
    assert.notEqual(notice(dir, { now: NOW + REMIND_AFTER_MS + 1 }).text, '', 'sem atualizar após 7 dias: lembra de novo');
    assert.equal(notice(dir, { installed: '2.5.0', now: NOW + 2 * REMIND_AFTER_MS }).text, '', 'atualizado: cala');
    assert.equal(notice(dir, { installed: '3.0.0' }).text, '', 'instalada mais nova que a conhecida: cala');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cache velho ou ausente dispara a atualização em segundo plano, sem esperar por ela', () => {
  const stale = home({ latest: '2.4.0', checkedAt: NOW - CHECK_INTERVAL_MS - 1 });
  const empty = home();
  try {
    assert.deepEqual(notice(stale), { text: '', refreshes: 1 });
    assert.deepEqual(notice(empty), { text: '', refreshes: 1 });
  } finally {
    rmSync(stale, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('desligado por configuração, por variável de ambiente e em CI: nem aviso nem rede', () => {
  const dir = home({ latest: '9.0.0', checkedAt: 0 });
  try {
    assert.deepEqual(notice(dir, { cfg: { updateCheck: false } }), { text: '', refreshes: 0 });
    assert.deepEqual(notice(dir, { env: { CONTEXT_TOOLS_UPDATE_CHECK: '0' } }), { text: '', refreshes: 0 });
    assert.deepEqual(notice(dir, { env: { CI: 'true' } }), { text: '', refreshes: 0 });
    assert.equal(JSON.parse(readFileSync(join(dir, 'update-check.json'), 'utf8')).notified, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function sessionStartEnv(dir) {
  const env = { ...process.env, CONTEXT_TOOLS_HOME: dir, CONTEXT_TOOLS_LANG: 'en' };
  delete env.CONTEXT_TOOLS_UPDATE_CHECK;
  delete env.CI;
  return env;
}

test('E2E: SessionStart do handoff entrega o aviso em systemMessage (Claude e Codex)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-update-root-'));
  const claudeHome = home({ latest: '99.0.0', checkedAt: Date.now() });
  const codexHome = home({ latest: '99.0.0', checkedAt: Date.now() });
  try {
    const claude = spawnSync(process.execPath, [script('handoff.mjs'), '--session-start'], {
      cwd: root, encoding: 'utf8', input: '{}',
      env: { ...sessionStartEnv(claudeHome), CLAUDE_PROJECT_DIR: root, CLAUDE_CODE_SESSION_ID: 'update-e2e' },
    });
    assert.equal(claude.status, 0, claude.stderr);
    assert.match(JSON.parse(claude.stdout).systemMessage, /context-tools 99\.0\.0 is available/);

    const codex = spawnSync(process.execPath, [script('codex-hook.mjs'), 'handoff.mjs', '--session-start'], {
      cwd: root, encoding: 'utf8',
      input: JSON.stringify({ session_id: 'update-e2e-codex', cwd: root, hook_event_name: 'SessionStart' }),
      env: sessionStartEnv(codexHome),
    });
    assert.equal(codex.status, 0, codex.stderr);
    assert.match(JSON.parse(codex.stdout).systemMessage, /context-tools 99\.0\.0 is available/);
  } finally {
    for (const dir of [root, claudeHome, codexHome]) rmSync(dir, { recursive: true, force: true });
  }
});
