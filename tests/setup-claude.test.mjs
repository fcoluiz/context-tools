import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  compareVersions,
  detectProjectRoot,
  latestTagFromLsRemote,
  normalizeSetupLanguage,
  parseExtraSelection,
  parseArgs,
  relativeExtra,
} from '../setup-claude.mjs';

// Mesmos casos de tests/setup-codex.test.mjs: setup-claude.mjs reexporta as mesmas funções puras
// de scripts/lib/setup-shared.mjs, e este teste prova que o adapter Claude não quebrou nada.

test('setup Claude detecta a raiz mais próxima sem exigir --project', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-setup-claude-'));
  try {
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'src', 'feature');
    mkdirSync(nested, { recursive: true });
    assert.equal(detectProjectRoot(nested), root);
    assert.equal(detectProjectRoot(nested, root), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('setup Claude aceita comandos, projeto e opções sem depender do shell', () => {
  assert.deepEqual(parseArgs(['status', '--project', 'C:\\Projeto', '--json']), {
    command: 'status',
    project: 'C:\\Projeto',
    flags: { project: 'C:\\Projeto', json: true },
    positionals: ['status'],
  });
  assert.deepEqual(parseArgs(['C:\\Projeto']), {
    command: 'install',
    project: 'C:\\Projeto',
    flags: {},
    positionals: ['C:\\Projeto'],
  });
});

test('setup Claude ordena tags semânticas e normaliza caminhos extra', () => {
  const tags = [
    'abc\trefs/tags/v1.9.0\n',
    'abc\trefs/tags/v1.11.1\n',
    'abc\trefs/tags/v1.10.0\n',
  ].join('');
  assert.equal(latestTagFromLsRemote(tags), 'v1.11.1');
  assert.ok(compareVersions('v1.11.1', 'v1.10.0') > 0);

  const root = mkdtempSync(join(tmpdir(), 'context-tools-extra-claude-'));
  try {
    const sibling = join(root, '..', 'context-tools-sibling-claude-test');
    mkdirSync(sibling, { recursive: true });
    assert.equal(relativeExtra(root, sibling), '../context-tools-sibling-claude-test');
    assert.equal(relativeExtra(root, join(root, '..', '..')), null, 'um caminho acima do pai do workspace não é aceito');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(root, '..', 'context-tools-sibling-claude-test'), { recursive: true, force: true });
  }
});

test('setup Claude aceita números detectados e caminhos manuais na mesma seleção', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-select-claude-'));
  try {
    const one = join(root, '..', 'context-tools-select-claude-one');
    const two = join(root, '..', 'context-tools-select-claude-two');
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    const parsed = parseExtraSelection('1, ../context-tools-select-claude-two', ['../context-tools-select-claude-one'], root);
    assert.deepEqual(parsed.selected.sort(), ['../context-tools-select-claude-one', '../context-tools-select-claude-two']);
    assert.deepEqual(parsed.invalid, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(root, '..', 'context-tools-select-claude-one'), { recursive: true, force: true });
    rmSync(join(root, '..', 'context-tools-select-claude-two'), { recursive: true, force: true });
  }
});

test('setup Claude normaliza a escolha de idioma do ai-context', () => {
  assert.equal(normalizeSetupLanguage('P'), 'pt');
  assert.equal(normalizeSetupLanguage('português'), 'pt');
  assert.equal(normalizeSetupLanguage('en'), 'en');
  assert.equal(normalizeSetupLanguage('inglês'), 'en');
  assert.equal(normalizeSetupLanguage('fr'), null);
});

test('setup Claude usa o marketplace context-tools, isolado do marketplace Codex', async () => {
  const { TARGETS } = await import('../scripts/lib/setup-targets.mjs');
  assert.equal(TARGETS.claude.marketplaceName, 'context-tools');
  assert.equal(TARGETS.codex.marketplaceName, 'context-tools-codex');
  assert.equal(TARGETS.claude.stateDir, '.claude');
  assert.equal(TARGETS.claude.needsHookTrustReminder, false);
});
