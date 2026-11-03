#!/usr/bin/env node
// 🤝 Dupla de agentes (ver lib/pair.mjs): montar, acompanhar e conduzir.
//
//   pair.mjs sessions [--project=DIR] [--json]       sessões que os hooks viram (para escolher)
//   pair.mjs create --planner=HOST:ID --builder=HOST:ID [--project=DIR]
//                   [--max-rounds=N] [--wait-seconds=N] [--idle-minutes=N] [--json]
//   pair.mjs list [--active] [--json]                 duplas existentes
//   pair.mjs show --pair=ID [--json]                  uma dupla, com as mensagens
//   pair.mjs stop --pair=ID [--by=QUEM]               encerra; as duas sessões voltam ao normal
//
// Comandos que o agente roda (os hooks entregam a linha pronta):
//   pair.mjs wait --pair=ID --role=planner|builder [--max-seconds=N]
//   pair.mjs send task|plan|built|approve|reject --pair=ID --role=R (--file=ARQ | --text=TEXTO)
//
// Hooks do Claude: pair.mjs --hook=prompt|pre-tool|stop (evento no stdin). O Codex chama as
// mesmas funções de dentro do codex-hook.mjs.

import { readFileSync } from 'node:fs';
import { isMain, runtimeHost } from './lib/roots.mjs';
import { readHookEvent } from './lib/hook-input.mjs';
import {
  createPair, expireIfIdle, findPairForSession, heartbeat, listPairs, listSessions, readPair, registerSession, ROLES, send,
  SEND_KINDS, stopPair, turnOf,
} from './lib/pair.mjs';

// Os hooks rodam em todo prompt e em toda edição; sem dupla ativa, só `lib/pair.mjs` carrega.
// Textos e idioma (`pair-agent.mjs`, que puxa o catálogo de i18n) vêm só quando há o que dizer.
const agent = () => import('./lib/pair-agent.mjs');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const flag = (args, name) => {
  const hit = args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const ERRORS = {
  'invalid-member': 'use --planner=HOST:SESSION_ID and --builder=HOST:SESSION_ID (HOST is claude or codex)',
  'same-session': 'planner and builder must be different sessions',
  'session-busy': 'that session is already in an active pair',
  'not-your-turn': 'it is not your turn at this stage — run wait',
  'not-active': 'the pair is over — run no more pair commands',
  'empty-text': 'nothing to send: pass --file=PATH or --text=TEXT',
  'invalid-kind': `kind must be one of: ${SEND_KINDS.join(', ')}`,
  'invalid-role': `role must be one of: ${ROLES.join(', ')}`,
  'no-pair': 'unknown pair id',
};
const fail = (error, extra = '') => {
  process.stderr.write(`pair: ${ERRORS[error] || error}${extra ? ` (${extra})` : ''}\n`);
  return 1;
};
const out = (value, json) => console.log(json ? JSON.stringify(value, null, 2) : value);

/** Entrada dos hooks do Claude. Nunca falha o hook: na dúvida, sai calado. */
async function hook(kind) {
  const event = await readHookEvent();
  const host = runtimeHost();
  const sessionId = String(event.session_id || '');
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (kind === 'prompt') registerSession({ host, sessionId, project: cwd, prompt: event.prompt });
  if (!findPairForSession(host, sessionId)) return 0;
  const { pairEditDenial, pairPromptContext, pairStopReason } = await agent();
  if (kind === 'prompt') {
    const context = pairPromptContext({ host, sessionId, cwd, prompt: event.prompt, register: false });
    if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
  } else if (kind === 'pre-tool') {
    const reason = pairEditDenial({ host, sessionId, cwd, event });
    if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  } else if (kind === 'stop') {
    const reason = pairStopReason({ host, sessionId });
    if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  }
  return 0;
}

async function wait(args) {
  const id = flag(args, 'pair');
  const role = flag(args, 'role');
  if (!ROLES.includes(role)) return fail('invalid-role');
  let pair = readPair(id);
  if (!pair) return fail('no-pair');
  const { pairCommand, pairLang, turnInstructions } = await agent();
  const seconds = Number(flag(args, 'max-seconds')) || pair.waitSeconds;
  const deadline = Date.now() + Math.max(1, Math.min(seconds, 3600)) * 1000;
  heartbeat(id, role);
  for (;;) {
    pair = readPair(id);
    if (!pair) { console.log('🤝 The pair no longer exists. Back to normal mode: run no more pair commands.'); return 0; }
    pair = expireIfIdle(pair);
    if (pair.status !== 'active' || turnOf(pair.stage) === role) {
      console.log(turnInstructions(pair, role));
      return 0;
    }
    if (Date.now() >= deadline) {
      const again = pairCommand('wait', pair, role);
      console.log(pairLang(pair) === 'pt'
        ? `⏳ Ainda esperando ${pair.stage === 'task' ? 'a tarefa' : 'o outro agente'}. Rode o mesmo comando de novo: \`${again}\``
        : `⏳ Still waiting for ${pair.stage === 'task' ? 'the task' : 'the other agent'}. Run the same command again: \`${again}\``);
      return 0;
    }
    await sleep(1500);
  }
}

async function sendCommand(args) {
  const { turnInstructions } = await agent();
  const kind = args.filter((arg) => !arg.startsWith('--'))[1];
  const file = flag(args, 'file');
  let text = flag(args, 'text');
  if (typeof file === 'string') {
    try { text = readFileSync(file, 'utf8'); } catch (error) { return fail(`cannot read --file: ${error.code || error.message}`); }
  }
  const result = send({ id: flag(args, 'pair'), role: flag(args, 'role'), kind, text: typeof text === 'string' ? text : '' });
  if (!result.ok) return fail(result.error, result.stage ? `stage: ${result.stage}` : '');
  console.log(turnInstructions(result.pair, flag(args, 'role')));
  return 0;
}

function summary(pair) {
  return `${pair.id}  ${pair.status}/${pair.stage}  round ${pair.round}/${pair.maxRounds}  `
    + `planner=${pair.roles.planner.host}:${pair.roles.planner.sessionId}  builder=${pair.roles.builder.host}:${pair.roles.builder.sessionId}`
    + (pair.outcome ? `  outcome=${pair.outcome}` : '');
}

async function main(args = process.argv.slice(2)) {
  const hookKind = flag(args, 'hook');
  if (typeof hookKind === 'string') return hook(hookKind);
  const verb = args.find((arg) => !arg.startsWith('--')) || 'list';
  const json = flag(args, 'json') === true;
  if (verb === 'wait') return wait(args);
  if (verb === 'send') return sendCommand(args);
  if (verb === 'sessions') {
    const project = flag(args, 'project');
    const sessions = listSessions({ project: typeof project === 'string' ? project : null });
    out(json ? sessions : sessions.map((s) => `${s.host}:${s.sessionId}  ${new Date(s.lastAt).toISOString()}  ${s.title || ''}`).join('\n') || '(no sessions yet)', json);
    return 0;
  }
  if (verb === 'create') {
    const result = createPair({
      project: typeof flag(args, 'project') === 'string' ? flag(args, 'project') : process.cwd(),
      planner: flag(args, 'planner'), builder: flag(args, 'builder'),
      maxRounds: flag(args, 'max-rounds'), waitSeconds: flag(args, 'wait-seconds'), idleMinutes: flag(args, 'idle-minutes'),
    });
    if (!result.ok) return fail(result.error, result.role || '');
    out(json ? result.pair : `${summary(result.pair)}\nSend any message in each session to activate it.`, json);
    return 0;
  }
  if (verb === 'list') {
    const pairs = listPairs({ activeOnly: flag(args, 'active') === true }).map((p) => expireIfIdle(p));
    out(json ? pairs : pairs.map(summary).join('\n') || '(no pairs)', json);
    return 0;
  }
  if (verb === 'show') {
    const pair = readPair(flag(args, 'pair'));
    if (!pair) return fail('no-pair');
    out(json ? expireIfIdle(pair) : [summary(expireIfIdle(pair)), ...pair.messages.map((m) => `--- ${m.role} ${m.kind} (round ${m.round})\n${m.text}`)].join('\n'), json);
    return 0;
  }
  if (verb === 'stop') {
    const result = stopPair({ id: flag(args, 'pair'), by: typeof flag(args, 'by') === 'string' ? flag(args, 'by') : 'user' });
    if (!result.ok && result.error !== 'unchanged') return fail(result.error);
    out(json ? result.pair : `🤝 ${summary(result.pair)}`, json);
    return 0;
  }
  return fail(`unknown command "${verb}"`);
}

if (isMain(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) {
    // Hook nunca derruba a sessão; comando do agente mostra o erro.
    process.exitCode = typeof flag(process.argv.slice(2), 'hook') === 'string' ? 0 : fail(error.message);
  }
}
