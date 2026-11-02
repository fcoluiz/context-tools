import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createPair, draftDir, expireIfIdle, findPairForSession, heartbeat, listSessions, readPair, registerSession, send, stopPair,
} from '../scripts/lib/pair.mjs';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

// Cada teste tem a própria pasta do usuário e o próprio projeto: a dupla vive em
// `CONTEXT_TOOLS_HOME/pair`, e nada pode vazar para a pasta real.
function fixture(fn) {
  const home = mkdtempSync(join(tmpdir(), 'ct-pair-home-'));
  const project = mkdtempSync(join(tmpdir(), 'ct-pair-proj-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  const env = { ...process.env, CONTEXT_TOOLS_HOME: home, CONTEXT_TOOLS_LANG: 'en' };
  try { return fn({ home, project, env }); } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function run(name, args, env, event, extraEnv = {}) {
  return spawnSync(process.execPath, [script(name), ...args], {
    input: event === undefined ? '' : JSON.stringify(event), encoding: 'utf8', env: { ...env, ...extraEnv },
  });
}
const claudeHook = (kind, env, event) => run('pair.mjs', [`--hook=${kind}`], env, event, { CONTEXT_TOOLS_HOST: 'claude' });
const codexHook = (args, env, event) => run('codex-hook.mjs', args, env, event);
const json = (stdout) => (stdout.trim() ? JSON.parse(stdout) : null);

test('pair: tarefa → plano → construção → validação, com reprovação e limite de rodadas', () => fixture(({ project, env }) => {
  const created = createPair({ project, planner: 'claude:c1', builder: 'codex:x1', env });
  assert.ok(created.ok, created.error);
  const id = created.pair.id;
  assert.equal(created.pair.stage, 'task');
  // A conversa mora no projeto, onde o sandbox do Codex deixa o agente gravar, e fora do git.
  assert.ok(existsSync(join(project, '.context-tools', 'pair', `${id}.json`)));
  assert.equal(readFileSync(join(project, '.context-tools', 'pair', '.gitignore'), 'utf8'), '*\n');
  assert.ok(draftDir(id, env).startsWith(join(project, '.context-tools', 'pair')));

  assert.equal(send({ id, role: 'planner', kind: 'plan', text: 'cedo demais', env }).error, 'not-your-turn');
  assert.equal(send({ id, role: 'builder', kind: 'task', text: 'pedido avulso', env }).error, 'not-your-turn', 'a tarefa entra só pelo planejador');
  assert.ok(send({ id, role: 'planner', kind: 'task', text: 'add sum()', env }).ok);
  assert.equal(readPair(id, env).stage, 'plan');
  assert.equal(send({ id, role: 'builder', kind: 'built', text: 'x', env }).error, 'not-your-turn');
  assert.ok(send({ id, role: 'planner', kind: 'plan', text: '1. src/sum.js', env }).ok);
  assert.ok(send({ id, role: 'builder', kind: 'built', text: 'done', env }).ok);
  assert.ok(send({ id, role: 'planner', kind: 'reject', text: 'missing negative test', env }).ok);
  let pair = readPair(id, env);
  assert.deepEqual([pair.stage, pair.round, pair.status], ['build', 2, 'active']);
  assert.ok(send({ id, role: 'builder', kind: 'built', text: 'test added', env }).ok);
  assert.ok(send({ id, role: 'planner', kind: 'reject', text: 'still wrong', env }).ok);
  pair = readPair(id, env);
  assert.deepEqual([pair.status, pair.outcome], ['finished', 'round-limit']);
  assert.equal(findPairForSession('claude', 'c1', env), null, 'dupla encerrada não prende mais a sessão');
  assert.equal(send({ id, role: 'builder', kind: 'built', text: 'x', env }).error, 'not-active');
}));

test('pair: sessão já ocupada, mesma sessão nos dois papéis e membro inválido são recusados', () => fixture(({ env }) => {
  assert.ok(createPair({ planner: 'claude:c1', builder: 'codex:x1', env }).ok);
  assert.equal(createPair({ planner: 'claude:c1', builder: 'codex:x2', env }).error, 'session-busy');
  assert.equal(createPair({ planner: 'claude:c9', builder: 'claude:c9', env }).error, 'same-session');
  assert.equal(createPair({ planner: 'vim:c9', builder: 'codex:x9', env }).error, 'invalid-member');
  assert.equal(createPair({ planner: 'claude:../x', builder: 'codex:x9', env }).error, 'invalid-member');
}));

test('pair: parada pelo usuário e por falta de progresso libera as duas sessões', () => fixture(({ env }) => {
  const a = createPair({ planner: 'claude:c1', builder: 'codex:x1', env }).pair;
  assert.equal(stopPair({ id: a.id, by: 'panel', env }).pair.outcome, 'stopped');
  assert.equal(findPairForSession('codex', 'x1', env), null);

  const now = Date.now();
  const b = createPair({ planner: 'claude:c2', builder: 'codex:x2', idleMinutes: 1, now, env }).pair;
  assert.equal(expireIfIdle(b, { now: now + 30000, env }).status, 'active');
  assert.equal(expireIfIdle(b, { now: now + 61000, env }).outcome, 'idle');
}));

test('pair: registro de sessões guarda título curto, filtra por projeto e descarta as antigas', () => fixture(({ project, env }) => {
  const now = Date.now();
  registerSession({ host: 'claude', sessionId: 'old', project, prompt: 'antiga', now: now - 8 * 86400000, env });
  registerSession({ host: 'claude', sessionId: 'c1', project, prompt: `  implement   the ${'x'.repeat(200)}`, now, env });
  registerSession({ host: 'codex', sessionId: 'x1', project: tmpdir(), prompt: 'other project', now, env });
  registerSession({ host: 'claude', sessionId: 'c1', project, prompt: 'segundo prompt não troca o título', now: now + 1, env });
  registerSession({ host: 'claude', sessionId: 'c2', project, prompt: `<system-reminder>${'status '.repeat(30)}</system-reminder> fix the login`, now, env });
  registerSession({ host: 'claude', sessionId: 'c3', project, prompt: '<system-reminder>cut before it closes', now, env });
  const mine = listSessions({ project, env });
  const title = (id) => mine.find((s) => s.sessionId === id)?.title;
  assert.deepEqual(mine.map((s) => s.sessionId).sort(), ['c1', 'c2', 'c3']);
  assert.ok(title('c1').startsWith('implement the x') && title('c1').length === 80);
  assert.equal(title('c2'), 'fix the login', 'a marcação do app sai antes do corte');
  assert.equal(title('c3'), null);
  assert.equal(listSessions({ env }).length, 4);
}));

test('pair: hooks do Claude calam sem dupla, ativam uma vez, travam edição fora da vez e seguram o Stop', () => fixture(({ home, project, env }) => {
  const prompt = (sid) => ({ session_id: sid, cwd: project, prompt: 'ok' });
  const quiet = claudeHook('prompt', env, prompt('c1'));
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '', 'sem dupla, o prompt não ganha contexto');
  assert.deepEqual(listSessions({ env }).map((s) => s.sessionId), ['c1']);

  const { id } = createPair({ project, planner: 'claude:c1', builder: 'claude:c2', env }).pair;
  const first = json(claudeHook('prompt', env, prompt('c1')).stdout).hookSpecificOutput.additionalContext;
  assert.match(first, /PAIR .* as PLANNER/);
  assert.match(first, /are local: they use no network and only write to .*\.context-tools\/pair\./, 'a justificativa que a revisão do Codex aceita');
  assert.match(first, new RegExp(`pair\\.mjs" send task --pair=${id} --role=planner`));
  const second = json(claudeHook('prompt', env, prompt('c1')).stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(second, /PAIR .* as PLANNER/, 'o briefing sai uma vez só');
  assert.match(second, /stage: waiting for the task/);

  const edit = (sid, file) => claudeHook('pre-tool', env, { session_id: sid, cwd: project, tool_name: 'Edit', tool_input: { file_path: file } });
  assert.equal(json(edit('c1', 'src/a.js').stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(edit('c1', join(draftDir(id, env), 'task.md')).stdout, '', 'rascunho da dupla é sempre liberado');
  const builderTurn = json(edit('c2', 'src/a.js').stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(builderTurn, /task is given in the planner's session \(Claude\)/, 'executor fora da construção também espera');
  send({ id, role: 'planner', kind: 'task', text: 't', env });
  send({ id, role: 'planner', kind: 'plan', text: 'p', env });
  assert.equal(edit('c2', 'src/a.js').stdout, '', 'executor edita na construção');
  assert.equal(edit('c9', 'src/a.js').stdout, '', 'sessão fora da dupla não é afetada');

  // Vez do executor: o planejador não pode encerrar o turno, até duas vezes seguidas.
  const stop = () => json(claudeHook('stop', env, { session_id: 'c1' }).stdout);
  assert.equal(stop().decision, 'block');
  assert.match(stop().reason, /wait --pair=/);
  assert.equal(stop(), null, 'a terceira recusa seguida deixaria o agente em laço');
  heartbeat(id, 'planner', { env });
  assert.equal(stop().decision, 'block', 'um wait no meio zera a contagem');
  assert.equal(json(claudeHook('stop', env, { session_id: 'c2' }).stdout), null, 'na própria vez, encerrar é legítimo');
}));

test('pair: no Codex, roda dentro dos hooks que já existiam', () => fixture(({ project, env }) => {
  const codexEnv = { ...env, CONTEXT_TOOLS_PROJECT_DIR: project };
  const { id } = createPair({ project, planner: 'codex:x1', builder: 'claude:c1', env }).pair;
  const audit = codexHook(['context-docs.mjs', '--prompt-audit'], codexEnv, {
    hook_event_name: 'UserPromptSubmit', session_id: 'x1', cwd: project, prompt: 'go',
  });
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(json(audit.stdout).hookSpecificOutput.additionalContext, /PAIR .* as PLANNER/);

  const patch = codexHook(['session-write-journal.mjs', '--pre-tool-use'], codexEnv, {
    hook_event_name: 'PreToolUse', session_id: 'x1', cwd: project, tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Add File: src/a.js\n+x\n*** End Patch' },
  });
  assert.equal(patch.status, 2);
  assert.equal(json(patch.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(patch.stderr, new RegExp(`Pair ${id}`));

  // Sem tarefa, o planejador encerra o turno para pedi-la; na vez do executor, volta ao `wait`.
  const stop = () => codexHook(['context-docs.mjs', '--stop-report'], codexEnv, { hook_event_name: 'Stop', session_id: 'x1', cwd: project });
  assert.equal(json(stop().stdout), null, 'planejador sem tarefa pode encerrar o turno');
  send({ id, role: 'planner', kind: 'task', text: 't', env });
  send({ id, role: 'planner', kind: 'plan', text: 'p', env });
  const blocked = stop();
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(json(blocked.stdout).decision, 'block');

  const outside = codexHook(['session-write-journal.mjs', '--pre-tool-use'], codexEnv, {
    hook_event_name: 'PreToolUse', session_id: 'x9', cwd: project, tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Add File: src/b.js\n+x\n*** End Patch' },
  });
  assert.equal(outside.status, 0, 'sessão fora da dupla segue como antes');
}));

test('pair: CLI cria, espera a vez, entrega e para', () => fixture(({ home, project, env }) => {
  const cli = (...args) => run('pair.mjs', args, env);
  const created = cli('create', `--project=${project}`, '--planner=claude:c1', '--builder=codex:x1', '--json');
  assert.equal(created.status, 0, created.stderr);
  const { id } = JSON.parse(created.stdout);

  const waiting = cli('wait', `--pair=${id}`, '--role=builder', '--max-seconds=1');
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.match(waiting.stdout, /Still waiting for the task/);
  // Sem tarefa, o wait do planejador volta na hora pedindo a tarefa ao usuário, sem mandar esperar de novo.
  const ask = cli('wait', `--pair=${id}`, '--role=planner', '--max-seconds=5');
  assert.match(ask.stdout, /Otherwise ask the user what the pair's task is/);
  assert.doesNotMatch(ask.stdout, /pair.mjs" wait/);

  const file = join(draftDir(id, env), 'task.md');
  writeFileSync(file, 'add sum()');
  assert.equal(cli('send', 'task', `--pair=${id}`, '--role=planner', `--file=${file}`).status, 0);
  const turn = cli('wait', `--pair=${id}`, '--role=planner', '--max-seconds=5');
  assert.match(turn.stdout, /Your turn: PLAN[\s\S]*> add sum\(\)/);
  assert.ok(readPair(id, env).roles.planner.seenAt, 'o wait marca o agente como vivo');

  const wrong = cli('send', 'built', `--pair=${id}`, '--role=builder', '--text=x');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /not your turn/);

  assert.equal(cli('stop', `--pair=${id}`, '--by=panel').status, 0);
  assert.match(cli('wait', `--pair=${id}`, '--role=builder', '--max-seconds=1').stdout, /is over: the pair was stopped/);
  assert.match(cli('sessions').stdout, /no sessions yet/);
}));
