// Orçamento de contexto do próprio plugin. Tudo aqui é custo fixo: entra em toda sessão (ou em
// todo prompt, no caso da descrição da skill e do bloco em CLAUDE.md/AGENTS.md), e cada token
// entrando cedo é relido em todas as mensagens seguintes. Os tetos ficam um pouco acima do
// medido em 2026-10-08 — servem para que crescer seja uma decisão, não um acidente.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { localPath } from './paths.mjs';

const ROOT = localPath('../', import.meta.url);
const SCRIPTS = join(ROOT, 'scripts');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-orc-'));
  mkdirSync(join(dir, '.claude', 'context'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function hook(script, args, env) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf8', input: '',
    env: { ...process.env, CONTEXT_TOOLS_HOST: 'claude', CONTEXT_TOOLS_HOOK_DEDUPE: '0', CONTEXT_TOOLS_LANG: 'pt', ...env },
  });
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; }
}

test('descrição da skill (vai em todo prompt) e corpo da skill têm teto', () => {
  const skill = read('skills', 'context-tools', 'SKILL.md');
  const description = skill.match(/^description:\s*(.*)$/m)?.[1] || '';
  assert.ok(description.length <= 450, `descrição da skill com ${description.length} chars (teto 450)`);
  assert.ok(skill.length <= 17000, `SKILL.md com ${skill.length} chars (teto 17.000)`);
});

test('bloco inserido em CLAUDE.md/AGENTS.md (vai em todo prompt) tem teto', () => {
  for (const file of ['claude-md-hint.mjs', 'codex-md-hint.mjs']) {
    for (const [, name, body] of read('scripts', file).matchAll(/const (BLOCO_\w+) = `([\s\S]*?)`;/g)) {
      assert.ok(body.length <= 750, `${file} ${name} com ${body.length} chars (teto 750)`);
    }
  }
});

test('SessionStart de um projeto comum custa pouco', () => {
  const root = tempProject();
  try {
    writeFileSync(join(root, '.claude', 'context', 'a.md'), '---\narea: a\ncovers:\n  - "src/a.mjs"\nverified_at: HEAD\nverified_date: 2026-10-08\n---\n# a\n');
    const env = { CLAUDE_PROJECT_DIR: root, CONTEXT_TOOLS_SESSION_ID: 'orc' };
    const total = ['context-maps.mjs', 'context-docs.mjs', 'handoff.mjs'].reduce((sum, script) => sum + hook(script, ['--session-start'], env).length, 0);
    assert.ok(total <= 900, `SessionStart somou ${total} chars (teto 900)`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('aviso de Stop é cortado no teto, com ponteiro para o health; o prompt de handoff não', async () => {
  const { capStopNote, STOP_NOTE_MAX_CHARS } = await import('../scripts/lib/hook-output.mjs');
  assert.ok(STOP_NOTE_MAX_CHARS <= 900);
  const longo = Array.from({ length: 60 }, (_, i) => `- [repo] mapa-${i}: editou src/arquivo-${i}.mjs`).join('\n');
  const cortado = capStopNote(longo, ROOT, { lang: 'pt' });
  assert.ok(cortado.length <= STOP_NOTE_MAX_CHARS + 120);
  assert.match(cortado, /health\.mjs/);
  assert.ok(!/arquivo-59/.test(cortado));
  assert.ok(cortado.split('\n').slice(0, -1).every((line) => longo.includes(line)), 'corta em fim de linha');
  assert.equal(capStopNote('curto', ROOT), 'curto');
});

test('aviso de mapa defasado no Claude manda rodar ack.mjs em vez de colar hashes', () => {
  const root = tempProject();
  try {
    const map = join(root, '.claude', 'context', 'a.md');
    writeFileSync(map, '---\narea: a\ncovers:\n  - "src/a.mjs"\nverified_at: HEAD\nverified_date: 2026-10-08\n---\n# a\n');
    const env = { CLAUDE_PROJECT_DIR: root, CONTEXT_TOOLS_SESSION_ID: 'ack-1' };
    const ack = spawnSync(process.execPath, [join(SCRIPTS, 'ack.mjs'), '.claude/context/a.md'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env, CONTEXT_TOOLS_HOST: 'claude' } });
    assert.equal(ack.status, 0, ack.stdout + ack.stderr);
    assert.match(readFileSync(map, 'utf8'), /^source_fingerprints: \{"src\/a\.mjs":"sha256:[0-9a-f]{64}"\}$/m);
    assert.match(readFileSync(map, 'utf8'), /^source_digest: sha256:[0-9a-f]{64}$/m);

    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root });
    hook('context-maps.mjs', ['--session-start'], env);
    writeFileSync(join(root, 'src', 'a.mjs'), 'export const a = 2;\n');
    const stop = hook('context-maps.mjs', ['--stop-report'], env);
    assert.match(stop, /ack\.mjs"? \.claude\/context\/a\.md/);
    assert.ok(!/sha256:[0-9a-f]{64}/.test(stop), `o aviso não deve carregar hashes: ${stop}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
