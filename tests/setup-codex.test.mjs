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
} from '../setup-codex.mjs';

test('setup Codex detecta a raiz mais próxima sem exigir --project', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-setup-'));
  try {
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'src', 'feature');
    mkdirSync(nested, { recursive: true });
    assert.equal(detectProjectRoot(nested), root);
    assert.equal(detectProjectRoot(nested, root), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('setup Codex aceita comandos, projeto e opções sem depender do shell', () => {
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

test('setup Codex ordena tags semânticas e normaliza caminhos extra', () => {
  const tags = [
    'abc\trefs/tags/v1.9.0\n',
    'abc\trefs/tags/v1.11.1\n',
    'abc\trefs/tags/v1.10.0\n',
  ].join('');
  assert.equal(latestTagFromLsRemote(tags), 'v1.11.1');
  assert.ok(compareVersions('v1.11.1', 'v1.10.0') > 0);

  const root = mkdtempSync(join(tmpdir(), 'context-tools-extra-'));
  try {
    const sibling = join(root, '..', 'context-tools-sibling-test');
    mkdirSync(sibling, { recursive: true });
    assert.equal(relativeExtra(root, sibling), '../context-tools-sibling-test');
    assert.equal(relativeExtra(root, join(root, '..', '..')), null, 'um caminho acima do pai do workspace não é aceito');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(root, '..', 'context-tools-sibling-test'), { recursive: true, force: true });
  }
});

test('setup Codex aceita números detectados e caminhos manuais na mesma seleção', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-select-'));
  try {
    const one = join(root, '..', 'context-tools-select-one');
    const two = join(root, '..', 'context-tools-select-two');
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    const parsed = parseExtraSelection('1, ../context-tools-select-two', ['../context-tools-select-one'], root);
    assert.deepEqual(parsed.selected.sort(), ['../context-tools-select-one', '../context-tools-select-two']);
    assert.deepEqual(parsed.invalid, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(root, '..', 'context-tools-select-one'), { recursive: true, force: true });
    rmSync(join(root, '..', 'context-tools-select-two'), { recursive: true, force: true });
  }
});

test('setup Codex normaliza a escolha de idioma do ai-context', () => {
  assert.equal(normalizeSetupLanguage('P'), 'pt');
  assert.equal(normalizeSetupLanguage('português'), 'pt');
  assert.equal(normalizeSetupLanguage('en'), 'en');
  assert.equal(normalizeSetupLanguage('inglês'), 'en');
  assert.equal(normalizeSetupLanguage('fr'), null);
});
