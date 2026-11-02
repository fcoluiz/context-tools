// 🤝 Dupla de agentes: duas sessões (Claude, Codex, ou duas do mesmo) dividem uma tarefa em
// planejar → construir → validar, uma esperando a outra, sem CLI de nenhum dos dois.
//
// Tudo é arquivo. Na pasta do usuário (`~/.context-tools/pair/`):
//   - `sessions.json`: as sessões que os hooks viram recentemente (host, id, pasta, título). É de
//     onde quem monta a dupla escolhe as duas sessões.
//   - `pairs/<id>.json`: o índice da dupla — só o id e a pasta do projeto.
// No projeto (`<projeto>/.context-tools/pair/`, com um `.gitignore` que esconde tudo do git):
//   - `<id>.json`: a dupla — papéis, etapa, rodada e as mensagens trocadas.
//   - `<id>/`: rascunhos que os agentes escrevem antes de entregar (`send --file`).
// O que o agente grava (`wait`, `send`, rascunhos) fica dentro do projeto de propósito: o sandbox
// do Codex só deixa escrever na pasta de trabalho, e um comando que pede para gravar fora dela vai
// para a revisão automática, que recusou `send` como "envio de relatório a destino desconhecido".
// Dupla sem projeto (só nos testes e em `createPair` direto) guarda tudo em `pairs/`, como antes.
//
// Nada aqui inicia uma dupla sozinho: sem `pairs/<id>.json` ativo, os hooks só registram a sessão
// e saem. A dupla nasce de `pair.mjs create` e morre com `pair.mjs stop`, com o arquivo apagado ou
// sem progresso por `idleMinutes`.
//
// Por que a espera é um comando que o agente roda (`pair.mjs wait`): uma sessão parada não reage a
// arquivo nenhum, ela só age quando recebe mensagem. Enquanto o comando roda, o agente fica
// pendurado nele sem gastar token; quando volta, lê o que o outro entregou e segue.

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readState, transactState } from './state-store.mjs';

export const PAIR_FORMAT = 1;
export const ROLES = Object.freeze(['planner', 'builder']);
export const HOSTS = Object.freeze(['claude', 'codex']);
export const PAIR_DEFAULTS = Object.freeze({ maxRounds: 2, waitSeconds: 110, idleMinutes: 60 });
const SESSION_RETENTION_MS = 7 * 86400000;
const MAX_SESSIONS = 200;
const MAX_TEXT = 20000;
// Duas recusas de Stop seguidas sem um `wait` no meio: o agente não está seguindo a instrução, e
// insistir só gastaria turnos.
export const MAX_STOP_BLOCKS = 2;
const VALID_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const keyPath = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const within = (parent, candidate) => {
  const rel = relative(keyPath(parent), keyPath(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export const pairEnabled = (env = process.env) => env.CONTEXT_TOOLS_PAIR !== '0';
export function pairHome(env = process.env) {
  return join(env.CONTEXT_TOOLS_HOME || join(homedir(), '.context-tools'), 'pair');
}
const sessionsFile = (env) => join(pairHome(env), 'sessions.json');
const pairsDir = (env) => join(pairHome(env), 'pairs');
const indexFile = (id, env) => join(pairsDir(env), `${id}.json`);
export const projectPairDir = (project) => join(project, '.context-tools', 'pair');
export const validId = (value) => typeof value === 'string' && VALID_ID.test(value);

/** Pasta onde a dupla mora: a do projeto, quando o índice aponta para uma; senão, `pairs/`. */
function pairBase(id, env) {
  const index = readState(indexFile(id, env), () => null);
  const project = index.ok ? index.value?.project : null;
  return index.ok && index.value?.index === true && typeof project === 'string' && project ? projectPairDir(project) : pairsDir(env);
}
export const pairFile = (id, env = process.env) => join(pairBase(id, env), `${id}.json`);
export const draftDir = (id, env = process.env) => join(pairBase(id, env), id);

/**
 * Quem age em cada etapa; `done` é de ninguém. A tarefa entra só pelo planejador: aberta aos dois,
 * o executor chegava primeiro e registrava como tarefa um pedido avulso do usuário, e a tarefa de
 * verdade, dada ao planejador, se perdia.
 */
export function turnOf(stage) {
  if (stage === 'task' || stage === 'plan' || stage === 'review') return 'planner';
  if (stage === 'build') return 'builder';
  return null;
}

/** Só o executor escreve no projeto, e só na etapa de construção. */
export const mayWrite = (pair, role) => pair?.status !== 'active' || (role === 'builder' && pair.stage === 'build');

/** Title from the first prompt, without the app's own markup (`<system-reminder>…`: tags with a
 *  hyphen). Stripped before the cut, or a tag cut in half would end up in the title. */
function titleOf(prompt) {
  const text = String(prompt || '').replace(/<([a-z]+-[a-z-]+)[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 80) : null;
}

/** Registra que a sessão está viva. Chamado em todo prompt; falha de disco nunca atrapalha. */
export function registerSession({ host, sessionId, project, prompt, now = Date.now(), env = process.env }) {
  if (!pairEnabled(env) || !HOSTS.includes(host) || !validId(sessionId)) return null;
  const key = `${host}:${sessionId}`;
  const result = transactState(sessionsFile(env), () => ({ format: 1, sessions: {} }), (state) => {
    state.format = 1;
    if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) state.sessions = {};
    const prev = state.sessions[key];
    state.sessions[key] = {
      host, sessionId,
      project: project ? resolve(project) : prev?.project || null,
      title: prev?.title || titleOf(prompt),
      firstAt: prev?.firstAt || now,
      lastAt: now,
    };
    const kept = Object.entries(state.sessions)
      .filter(([, s]) => s && now - (s.lastAt || 0) < SESSION_RETENTION_MS)
      .sort(([, a], [, b]) => b.lastAt - a.lastAt)
      .slice(0, MAX_SESSIONS);
    state.sessions = Object.fromEntries(kept);
    return state.sessions[key];
  }, { now });
  return result.ok ? result.value : null;
}

export function listSessions({ project = null, env = process.env } = {}) {
  const loaded = readState(sessionsFile(env), () => ({ sessions: {} }));
  const all = loaded.ok ? Object.values(loaded.value.sessions || {}) : [];
  return all
    .filter((s) => s && validId(s.sessionId) && (!project || (s.project && keyPath(s.project) === keyPath(project))))
    .sort((a, b) => b.lastAt - a.lastAt);
}

function validPair(value) {
  return value?.format === PAIR_FORMAT && validId(value.id) && value.roles
    && ROLES.every((role) => HOSTS.includes(value.roles[role]?.host) && validId(value.roles[role]?.sessionId))
    && Array.isArray(value.messages);
}

export function readPair(id, env = process.env) {
  if (!validId(id)) return null;
  const loaded = readState(pairFile(id, env), () => null);
  return loaded.ok && validPair(loaded.value) ? loaded.value : null;
}

export function listPairs({ env = process.env, activeOnly = false } = {}) {
  let names = [];
  try { names = readdirSync(pairsDir(env)).filter((name) => name.endsWith('.json')); } catch { return []; }
  return names
    .map((name) => readPair(name.slice(0, -5), env))
    .filter((pair) => pair && (!activeOnly || pair.status === 'active'))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** A dupla ATIVA em que esta sessão está, e o papel dela. Uma sessão está em no máximo uma. */
export function findPairForSession(host, sessionId, env = process.env) {
  if (!pairEnabled(env) || !validId(sessionId)) return null;
  for (const pair of listPairs({ env, activeOnly: true })) {
    const role = ROLES.find((r) => pair.roles[r].host === host && pair.roles[r].sessionId === sessionId);
    if (role) return { pair, role };
  }
  return null;
}

function parseMember(value) {
  if (value && typeof value === 'object') return { host: value.host, sessionId: value.sessionId };
  const [host, ...rest] = String(value || '').split(':');
  return { host, sessionId: rest.join(':') };
}

function positive(value, fallback, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
}

export function createPair({ project, planner, builder, maxRounds, waitSeconds, idleMinutes, now = Date.now(), env = process.env } = {}) {
  const roles = { planner: parseMember(planner), builder: parseMember(builder) };
  for (const role of ROLES) {
    if (!HOSTS.includes(roles[role].host) || !validId(roles[role].sessionId)) return { ok: false, error: 'invalid-member', role };
  }
  if (roles.planner.host === roles.builder.host && roles.planner.sessionId === roles.builder.sessionId) return { ok: false, error: 'same-session' };
  for (const role of ROLES) {
    if (findPairForSession(roles[role].host, roles[role].sessionId, env)) return { ok: false, error: 'session-busy', role };
  }
  const id = `p${now.toString(36)}${randomBytes(3).toString('hex')}`;
  const pair = {
    format: PAIR_FORMAT, id,
    project: project ? resolve(project) : null,
    status: 'active', stage: 'task', round: 1, task: null, outcome: null,
    maxRounds: positive(maxRounds, PAIR_DEFAULTS.maxRounds, 10),
    waitSeconds: positive(waitSeconds, PAIR_DEFAULTS.waitSeconds, 3600),
    idleMinutes: positive(idleMinutes, PAIR_DEFAULTS.idleMinutes, 24 * 60),
    roles: Object.fromEntries(ROLES.map((role) => [role, { ...roles[role], joinedAt: null, seenAt: null, stopBlocks: 0 }])),
    messages: [],
    createdAt: now, updatedAt: now, progressAt: now,
  };
  if (pair.project) {
    try {
      mkdirSync(projectPairDir(pair.project), { recursive: true });
      writeFileSync(join(projectPairDir(pair.project), '.gitignore'), '*\n');
    } catch { return { ok: false, error: 'state-unavailable' }; }
    const index = transactState(indexFile(id, env), () => ({}), (state) => {
      Object.assign(state, { format: PAIR_FORMAT, index: true, id, project: pair.project, createdAt: now });
    }, { now });
    if (!index.ok) return { ok: false, error: index.reason || 'state-unavailable' };
  }
  const written = updatePair(id, () => pair, { now, env, replace: true });
  if (!written.ok || !written.pair) return { ok: false, error: written.error || 'state-unavailable' };
  try { mkdirSync(draftDir(id, env), { recursive: true }); } catch { /* o `wait` recria se precisar */ }
  return { ok: true, pair: written.pair };
}

/**
 * Lê, muda e grava a dupla sob a trava do arquivo. `mutate` recebe a dupla e devolve `false` para
 * desistir sem gravar. Com `replace`, o retorno de `mutate` substitui o conteúdo inteiro.
 */
export function updatePair(id, mutate, { now = Date.now(), env = process.env, replace = false } = {}) {
  if (!validId(id)) return { ok: false, error: 'invalid-pair' };
  let outcome = null;
  const result = transactState(pairFile(id, env), () => ({}), (state) => {
    if (replace) {
      const next = mutate(state);
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, next);
      outcome = { ok: true };
      return;
    }
    if (!validPair(state)) { outcome = { ok: false, error: 'no-pair' }; return; }
    const changed = mutate(state);
    if (changed === false) { outcome = { ok: false, error: 'unchanged' }; return; }
    if (changed && typeof changed === 'object' && changed.error) { outcome = { ok: false, ...changed }; return; }
    state.updatedAt = now;
    outcome = { ok: true };
  }, { now });
  if (!result.ok) return { ok: false, error: result.reason };
  return { ...outcome, pair: readPair(id, env) };
}

/** Sem progresso há `idleMinutes`: a dupla para sozinha, para nenhuma sessão esperar para sempre. */
export function expireIfIdle(pair, { now = Date.now(), env = process.env } = {}) {
  if (!pair || pair.status !== 'active' || now - (pair.progressAt || pair.createdAt) < pair.idleMinutes * 60000) return pair;
  const result = updatePair(pair.id, (p) => {
    if (p.status !== 'active') return false;
    p.status = 'stopped'; p.stage = 'done'; p.outcome = 'idle';
  }, { now, env });
  return result.pair || readPair(pair.id, env);
}

const KIND_RULES = Object.freeze({
  task: { roles: ['planner'], stage: 'task' },
  plan: { roles: ['planner'], stage: 'plan' },
  built: { roles: ['builder'], stage: 'build' },
  approve: { roles: ['planner'], stage: 'review' },
  reject: { roles: ['planner'], stage: 'review' },
});
export const SEND_KINDS = Object.freeze(Object.keys(KIND_RULES));

/** Entrega do agente: valida papel e etapa, guarda o texto e avança a etapa. */
export function send({ id, role, kind, text, now = Date.now(), env = process.env }) {
  const rule = KIND_RULES[kind];
  if (!rule) return { ok: false, error: 'invalid-kind' };
  if (!ROLES.includes(role)) return { ok: false, error: 'invalid-role' };
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'empty-text' };
  return updatePair(id, (p) => {
    if (p.status !== 'active') return { error: 'not-active', status: p.status };
    if (!rule.roles.includes(role) || p.stage !== rule.stage) return { error: 'not-your-turn', stage: p.stage };
    p.messages.push({ role, kind, round: p.round, text: body.slice(0, MAX_TEXT), at: now });
    if (kind === 'task') { p.task = body.slice(0, MAX_TEXT); p.stage = 'plan'; }
    else if (kind === 'plan') p.stage = 'build';
    else if (kind === 'built') p.stage = 'review';
    else if (kind === 'approve') { p.status = 'finished'; p.stage = 'done'; p.outcome = 'approved'; }
    else if (p.round >= p.maxRounds) { p.status = 'finished'; p.stage = 'done'; p.outcome = 'round-limit'; }
    else { p.round += 1; p.stage = 'build'; }
    p.progressAt = now;
  }, { now, env });
}

export function stopPair({ id, by = 'user', now = Date.now(), env = process.env }) {
  return updatePair(id, (p) => {
    if (p.status !== 'active') return false;
    p.status = 'stopped'; p.stage = 'done'; p.outcome = 'stopped'; p.stoppedBy = String(by).slice(0, 40);
  }, { now, env });
}

/** O agente entrou no `wait`: está vivo, e a contagem de Stop recusado recomeça. */
export function heartbeat(id, role, { now = Date.now(), env = process.env } = {}) {
  return updatePair(id, (p) => {
    if (!p.roles[role]) return false;
    p.roles[role].seenAt = now;
    p.roles[role].stopBlocks = 0;
  }, { now, env });
}

export function removePair(id, env = process.env) {
  if (!validId(id)) return false;
  const file = pairFile(id, env);
  let removed = false;
  for (const path of new Set([file, indexFile(id, env)])) {
    try { unlinkSync(path); removed = true; } catch { /* já não existia */ }
  }
  return removed;
}

export const lastMessage = (pair, kinds) => [...pair.messages].reverse().find((m) => kinds.includes(m.kind)) || null;

/** Caminhos que uma ferramenta de edição vai tocar (Claude: file_path/notebook_path; Codex: apply_patch). */
export function editTargets(event, cwd) {
  const input = event?.tool_input || {};
  const paths = new Set();
  if (typeof input.command === 'string' && event?.tool_name === 'apply_patch') {
    for (const match of input.command.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+?)\s*$/gm)) paths.add(match[1]);
  }
  for (const field of ['file_path', 'filePath', 'notebook_path', 'path']) {
    if (typeof input[field] === 'string' && input[field]) paths.add(input[field]);
  }
  return [...paths].map((path) => resolve(cwd || process.cwd(), path));
}

/** `true` quando todos os alvos estão na pasta de rascunhos da dupla — sempre liberado. */
export function onlyDrafts(pair, targets, env = process.env) {
  return targets.length > 0 && targets.every((path) => within(draftDir(pair.id, env), path));
}
