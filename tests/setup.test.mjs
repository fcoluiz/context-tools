import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveTargets, TARGETS } from '../scripts/lib/setup-targets.mjs';

function localPath(rel) {
  return fileURLToPath(new URL(rel, import.meta.url));
}

test('resolveTargets expande "both" e recusa agente desconhecido', () => {
  assert.deepEqual(resolveTargets('both').map((a) => a.id), ['codex', 'claude']);
  assert.deepEqual(resolveTargets(['claude']).map((a) => a.id), ['claude']);
  assert.deepEqual(resolveTargets(['claude', 'codex', 'claude']).map((a) => a.id), ['claude', 'codex']);
  assert.throws(() => resolveTargets(['bogus']), /agente inválido/);
});

test('setup.mjs --dry-run com --target=claude só simula o Claude', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-unified-'));
  const SETUP = localPath('../setup.mjs');
  try {
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz, '--target=claude'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `falhou: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\[Claude\]/);
    assert.doesNotMatch(r.stdout, /\[Codex\]/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('setup.mjs --dry-run com --target=both simula os dois agentes', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-unified-both-'));
  const SETUP = localPath('../setup.mjs');
  try {
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz, '--target=both'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `falhou: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\[Codex\]/);
    assert.match(r.stdout, /\[Claude\]/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('setup.mjs --dry-run detecta sozinho quando só .claude existe', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-detect-claude-'));
  const SETUP = localPath('../setup.mjs');
  try {
    mkdirSync(join(raiz, '.claude'), { recursive: true });
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz], { encoding: 'utf8', input: '' });
    assert.equal(r.status, 0, `falhou: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\[Claude\]/);
    assert.doesNotMatch(r.stdout, /\[Codex\]/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('setup.mjs --dry-run detecta sozinho quando só .codex/AGENTS.md existe', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-detect-codex-'));
  const SETUP = localPath('../setup.mjs');
  try {
    writeFileSync(join(raiz, 'AGENTS.md'), '# agents\n');
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz], { encoding: 'utf8', input: '' });
    assert.equal(r.status, 0, `falhou: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\[Codex\]/);
    assert.doesNotMatch(r.stdout, /\[Claude\]/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('setup.mjs --dry-run sem detecção e sem TTY cai para "both"', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-detect-none-'));
  const SETUP = localPath('../setup.mjs');
  try {
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz], { encoding: 'utf8', input: '' });
    assert.equal(r.status, 0, `falhou: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\[Codex\]/);
    assert.match(r.stdout, /\[Claude\]/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('setup.mjs recusa --target inválido de forma explícita', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-bad-target-'));
  const SETUP = localPath('../setup.mjs');
  try {
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz, '--target=bogus'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /agente inválido/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('adapters Codex e Claude compartilham repositório mas usam CLI e marketplace distintos', () => {
  assert.equal(TARGETS.codex.bin, 'codex');
  assert.equal(TARGETS.claude.bin, 'claude');
  assert.equal(TARGETS.codex.repository, TARGETS.claude.repository);
  assert.notEqual(TARGETS.codex.marketplaceName, TARGETS.claude.marketplaceName);
});
