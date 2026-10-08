// Uso diário do harness: o índice alcança também o grep digitado no Bash, os avisos de Stop são
// curtos, a instalação não roda hooks em dobro e o proveito das respostas é medido.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { localPath } from './paths.mjs';

const ROOT = localPath('../', import.meta.url);
const SCRIPTS = join(ROOT, 'scripts');

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-uso-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'calculo.mjs'), 'export function somaTotal(a, b) { return a + b; }\n');
  return dir;
}

function run(script, args, env, input = '') {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    input, encoding: 'utf8', env: { ...process.env, CONTEXT_TOOLS_HOST: 'claude', CONTEXT_TOOLS_LANG: 'en', ...env },
  });
}

test('instalação standalone registra o grep do Bash com filtro if, sem apagar o grupo do Grep, e é idempotente', () => {
  const root = tempProject();
  try {
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, [join(ROOT, 'install.mjs'), root, '--target=claude'], { encoding: 'utf8', input: '' });
      assert.equal(r.status, 0, r.stderr);
    }
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
    const pre = settings.hooks.PreToolUse;
    assert.deepEqual(pre.map((g) => g.matcher).sort(), ['Bash', 'Grep']);
    const bash = pre.find((g) => g.matcher === 'Bash');
    assert.deepEqual(bash.hooks.map((h) => h.if).sort(), ['Bash(grep *)', 'Bash(rg *)']);
    assert.equal(pre.find((g) => g.matcher === 'Grep').hooks.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('setup Claude remove só os hooks que a instalação standalone escreveu', async () => {
  const { TARGETS, isManagedClaudeHook } = await import('../scripts/lib/setup-targets.mjs');
  const root = tempProject();
  try {
    const own = { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/context-maps.mjs" --session-start' };
    const user = { type: 'command', command: 'node scripts/meu-hook.mjs' };
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        SessionStart: [{ matcher: '', hooks: [own, user] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', if: 'Bash(grep *)', command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/pre-tool.mjs"' }] }],
      },
    }));
    assert.equal(isManagedClaudeHook(own.command), true);
    assert.equal(isManagedClaudeHook(user.command), false);
    assert.equal(isManagedClaudeHook('node "$CLAUDE_PROJECT_DIR/scripts/context-maps.mjs"'), false, 'hooks do repositório-fonte não são da instalação standalone');
    assert.equal(TARGETS.claude.removeManagedProjectHooks(root), true);
    const after = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(after.permissions, { allow: ['Bash(npm test)'] });
    assert.deepEqual(after.hooks.SessionStart[0].hooks, [user]);
    assert.equal(after.hooks.PreToolUse, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('avisos de Stop do Claude são curtos nos dois idiomas', async () => {
  const { makeT } = await import('../scripts/lib/i18n.mjs');
  const p = { ctx: 297, msgs: 219, horas: '0.8', re: 0, mult: '2.1', arq: '.claude/handoff-x.md', n: 2, files: 'a.mjs, b.mjs', more: 0 };
  for (const lang of ['en', 'pt']) {
    const t = makeT(lang);
    assert.ok(t('ses.aviso', p).length + t('ses.preencha', p).length < 420, `${lang}: aviso de sessão longo demais`);
    assert.ok(!t('ses.aviso', p).includes('\n'), `${lang}: aviso de sessão em uma linha`);
    assert.ok(t('ver.header', p).length < 140, `${lang}: cabeçalho de verify longo demais`);
  }
});

test('julgamento de proveito: usada, ignorada e pendente', async () => {
  const { recordAnswer, evaluateFollowThrough, hasPendingAnswers } = await import('../scripts/lib/follow-through.mjs');
  const root = tempProject();
  const env = process.env.CONTEXT_TOOLS_HOST;
  process.env.CONTEXT_TOOLS_HOST = 'claude';
  try {
    const t0 = Date.now() - 60000;
    recordAnswer(root, 's', ['src/calculo.mjs'], t0);
    recordAnswer(root, 's', ['src/outro.mjs'], t0 + 1);
    recordAnswer(root, 's', ['src/tarde.mjs'], t0 + 50000);
    const calls = Array.from({ length: 6 }, (_, i) => ({ at: t0 + 10 + i, paths: i === 2 ? [join(root, 'src', 'calculo.mjs')] : [] }));
    assert.deepEqual(evaluateFollowThrough(root, 's', calls).sort(), ['ignored', 'used']);
    assert.equal(hasPendingAnswers(root, 's'), true, 'resposta sem 6 chamadas depois continua pendente');
    assert.equal(hasPendingAnswers(root, 'outra'), false);
  } finally {
    if (env === undefined) delete process.env.CONTEXT_TOOLS_HOST; else process.env.CONTEXT_TOOLS_HOST = env;
    rmSync(root, { recursive: true, force: true });
  }
});

test('grep digitado no Bash recebe a definição, e o Stop registra se ela foi aproveitada', () => {
  const root = tempProject();
  try {
    const env = { CLAUDE_PROJECT_DIR: root, CONTEXT_TOOLS_SESSION_ID: 'ft-session' };
    const evento = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'grep -rn "somaTotal" src' } });
    const pre = run('pre-tool.mjs', [], env, evento);
    assert.match(pre.stdout, /somaTotal/);
    assert.ok(existsSync(join(root, '.claude', '.pre-tool-answers.json')));

    const later = Date.now() + 1000;
    const call = (i, input) => JSON.stringify({ type: 'assistant', timestamp: new Date(later + i * 1000).toISOString(), message: { content: [{ type: 'tool_use', name: input.file_path ? 'Read' : 'Bash', input }] } });
    const lines = [call(0, { command: 'ls' }), call(1, { file_path: join(root, 'src', 'calculo.mjs') }), ...[2, 3, 4, 5].map((i) => call(i, { command: 'echo' }))];
    writeFileSync(join(root, 't.jsonl'), lines.join('\n'));
    const stop = run('verify.mjs', ['--stop-report'], { ...env, CONTEXT_TOOLS_TRANSCRIPT_PATH: join(root, 't.jsonl') });
    assert.equal(stop.status, 0);
    const metrics = JSON.parse(readFileSync(join(root, '.claude', '.context-tools-metrics.json'), 'utf8'));
    assert.deepEqual(metrics.events.filter((e) => e.type === 'pretool-followup').map((e) => e.outcome), ['used']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
