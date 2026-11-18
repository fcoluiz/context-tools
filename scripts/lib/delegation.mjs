// 🧩 Delegação a subagentes baratos: papéis, escopo de escrita declarado e a trava dos hooks.
//
// A sessão principal (modelo caro) entrega a um subagente barato o trabalho volumoso e de pouca
// decisão: achar onde algo está, rodar testes, editar o que já foi decidido. O subagente é uma
// mini-sessão: o que ele lê não fica no contexto principal, que é relido a cada mensagem.
//
// O que este módulo garante é pequeno e verificável:
//   - papéis só-leitura (`ct-explorer`, `ct-verifier`) não editam arquivo;
//   - papéis que escrevem só editam o escopo declarado pela sessão principal (`ct brief --allow`)
//     ou, no caso do `ct-map-keeper`, os mapas e o `ai-context/`;
//   - nenhum papel muda o git (commit, push, reset…), chama `gh` ou escreve arquivo pelo shell.
// É uma trava contra engano, não um sandbox: um comando que escreva por outro caminho não é visto.
//
// Este arquivo roda em todo PreToolUse de edição e de Bash: só `node:` e nada que leia índice.

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const DELEGATION_FORMAT = 1;
export const SCOPE_TTL_MINUTES = 240;

/** Fonte única dos papéis. `writes`: edita arquivos; `defaultScope`: o que pode sem declarar. */
export const ROLES = Object.freeze({
  'ct-explorer': { writes: false, effort: 'low' },
  'ct-verifier': { writes: false, effort: 'low' },
  'ct-map-keeper': { writes: true, effort: 'low', defaultScope: ['.claude/context/**', '.codex/context/**', 'ai-context/**'] },
  'ct-translator': { writes: true, effort: 'low' },
  'ct-executor': { writes: true, effort: 'medium' },
});
export const ROLE_NAMES = Object.freeze(Object.keys(ROLES));

/** `explorer`, `ct-explorer` e `context-tools:ct-explorer` são o mesmo papel. */
export function normalizeRole(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^.*:/, '');
  const name = raw.startsWith('ct-') ? raw : `ct-${raw}`;
  return ROLES[name] ? name : null;
}

const ROLE_RE = /^(?:[\w.-]+:)?(ct-(?:explorer|verifier|map-keeper|translator|executor))$/i;

/** Primeira linha de um arquivo (o `session_meta` do Codex traz dezenas de KB de instruções). */
function firstLine(path, max = 1024 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const chunk = Buffer.alloc(64 * 1024);
    const parts = [];
    for (let read = 0; read < max;) {
      const n = readSync(fd, chunk, 0, chunk.length, read);
      if (!n) break;
      const end = chunk.subarray(0, n).indexOf(10);
      parts.push(Buffer.from(chunk.subarray(0, end >= 0 ? end : n)));
      if (end >= 0) break;
      read += n;
    }
    return Buffer.concat(parts).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nada */ } }
}

/** Procura um nome de papel em qualquer valor de texto de um objeto (até 4 níveis). */
function roleInside(value, depth = 0) {
  if (typeof value === 'string') return ROLE_RE.test(value.trim()) ? normalizeRole(value) : null;
  if (!value || typeof value !== 'object' || depth > 4) return null;
  for (const item of Object.values(value)) {
    const hit = roleInside(item, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** O papel descrito num `session_meta` de rollout do Codex, ou `null` se não é subagente nosso. */
function roleFromMeta(payload) {
  if (!payload?.source?.subagent) return null;
  for (const field of ['agent_role', 'agent_type', 'agent_name', 'agent_nickname']) {
    if (typeof payload[field] === 'string' && ROLE_RE.test(payload[field].trim())) return normalizeRole(payload[field]);
  }
  return roleInside(payload.source.subagent);
}
const metaOf = (path) => { try { const o = JSON.parse(firstLine(path)); return o?.type === 'session_meta' ? o.payload : null; } catch { return null; } };

/** O `turn_id` do último `task_started` de um rollout, lido de trás para frente (até 8 MB). */
function lastTurnStarted(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    let tail = '';
    for (let end = size; end > 0 && size - end < 8 * 1024 * 1024;) {
      const start = Math.max(0, end - 256 * 1024);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      tail = buf.toString('utf8') + tail;
      const hits = [...tail.matchAll(/"type":"task_started"[^\n]*?"turn_id":"([^"]+)"|"turn_id":"([^"]+)"[^\n]*?"type":"task_started"/g)];
      if (hits.length) { const last = hits[hits.length - 1]; return last[1] || last[2]; }
      end = start;
    }
    return null;
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nada */ } }
}

/**
 * Codex: o `PreToolUse` de um subagente chega com o `session_id` e o `transcript_path` da sessão
 * PRINCIPAL, mas com o `turn_id` do próprio subagente (verificado em 2026-11-15 com o Codex CLI
 * 0.162 e subagentes `ct-*` reais). Se o turno do evento não é o último aberto no rollout do pai,
 * procura, entre os rollouts recentes, o filho daquela sessão que abriu esse turno.
 */
function roleFromCodexTurn(event, transcript, now = Date.now()) {
  const turn = typeof event?.turn_id === 'string' ? event.turn_id : '';
  const session = String(event?.session_id || '');
  if (!turn || !session || lastTurnStarted(transcript) === turn) return null;
  const root = dirname(dirname(dirname(dirname(transcript))));   // <sessions>/AAAA/MM/DD/rollout-…
  const recent = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        try { const m = statSync(p).mtimeMs; if (now - m < 6 * 3600000) recent.push({ p, m }); } catch { /* nada */ }
      }
    }
  };
  walk(root, 0);
  const marker = `"turn_id":"${turn}"`;
  for (const { p } of recent.sort((a, b) => b.m - a.m).slice(0, 200)) {
    const meta = metaOf(p);
    const parent = meta?.parent_thread_id || meta?.source?.subagent?.thread_spawn?.parent_thread_id;
    if (String(parent || '') !== session) continue;
    try { if (!readFileSync(p, 'utf8').includes(marker)) continue; } catch { continue; }
    return roleFromMeta(meta);
  }
  return null;
}

/**
 * O papel do agente que disparou o hook, ou `null` (sessão principal, ou agente que não é nosso).
 *
 * Claude: o hook de um subagente recebe `agent_type` (`context-tools:ct-explorer` no plugin,
 * `ct-explorer` numa instalação em `.claude/agents/`). Codex: o evento pode trazer o nome do
 * agente; senão, o rollout do transcript pode ser o do próprio subagente (`session_meta` com
 * `agent_role`); senão, o turno do evento leva ao rollout filho (ver `roleFromCodexTurn`). Sem
 * nada disso, não trava.
 */
export function roleFromEvent(event = {}) {
  for (const field of ['agent_type', 'agent_role', 'agent_name', 'agent_nickname']) {
    const value = event?.[field];
    if (typeof value === 'string' && ROLE_RE.test(value.trim())) return normalizeRole(value);
  }
  const transcript = typeof event?.transcript_path === 'string' ? event.transcript_path : '';
  if (event?.agent_type || !transcript || !/rollout-.*\.jsonl$/i.test(transcript)) return null;
  try {
    const meta = metaOf(transcript);
    if (meta?.source?.subagent) return roleFromMeta(meta);
    return roleFromCodexTurn(event, transcript);
  } catch { return null; }
}

// ---------------------------------------------------------------- escopo declarado (ticket)

export function delegationHome(env = process.env) {
  return join(env.CONTEXT_TOOLS_HOME || join(homedir(), '.context-tools'), 'delegation');
}
const keyPath = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)).replace(/[\\/]+$/, '');
const projectKey = (root) => createHash('sha256').update(keyPath(root)).digest('hex').slice(0, 16);
const ticketFile = (root, role, env) => join(delegationHome(env), projectKey(root), `${role}.json`);
const within = (parent, candidate) => {
  const rel = relative(keyPath(parent), keyPath(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Normaliza a lista de `--allow`: barra normal, sem `./`, pasta vira `pasta/**`. */
export function parseAllow(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[,\n]/);
  return [...new Set(items.map((x) => String(x).trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((x) => x && !x.startsWith('/') && !/^[a-z]:/i.test(x) && !x.split('/').includes('..'))
    .map((x) => (x.endsWith('/') ? `${x}**` : x)))];
}

/** Glob mínimo: `**` atravessa pastas, `*` e `?` não. Sem curinga, só o próprio arquivo. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}

export function matchesScope(relPath, globs) {
  const rel = String(relPath).replace(/\\/g, '/');
  return globs.some((glob) => globToRegExp(glob).test(rel));
}

export function writeScope({ root, role, allow, task = '', ttlMinutes = SCOPE_TTL_MINUTES, now = Date.now(), env = process.env }) {
  const name = normalizeRole(role);
  if (!name) return { ok: false, error: 'invalid-role' };
  const globs = parseAllow(allow);
  const ticket = {
    format: DELEGATION_FORMAT, role: name, root: resolve(root), allow: globs,
    task: String(task || '').slice(0, 400), createdAt: now, expiresAt: now + Math.max(1, Number(ttlMinutes) || SCOPE_TTL_MINUTES) * 60000,
  };
  const file = ticketFile(root, name, env);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ticket, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return { ok: true, ticket, file };
}

export function readScope(root, role, { now = Date.now(), env = process.env } = {}) {
  try {
    const ticket = JSON.parse(readFileSync(ticketFile(root, role, env), 'utf8'));
    if (ticket?.format !== DELEGATION_FORMAT || !Array.isArray(ticket.allow) || !(ticket.expiresAt > now)) return null;
    return ticket;
  } catch { return null; }
}

/** Escopos vivos do projeto (para `ct delegate status`). */
export function listScopes(root, { now = Date.now(), env = process.env } = {}) {
  const dir = join(delegationHome(env), projectKey(root));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => readScope(root, f.slice(0, -5), { now, env })).filter(Boolean);
}

export function clearScope(root, role = null, env = process.env) {
  const names = role ? [normalizeRole(role)].filter(Boolean) : ROLE_NAMES;
  let removed = 0;
  for (const name of names) {
    const file = ticketFile(root, name, env);
    if (existsSync(file)) { rmSync(file, { force: true }); removed++; }
  }
  return removed;
}

/** O ticket mais próximo: o hook recebe o cwd, que pode ser uma subpasta da raiz do `brief`. */
function scopeFor(cwd, role, opts) {
  let dir = resolve(cwd || process.cwd());
  for (let i = 0; i < 12; i++) {
    const ticket = readScope(dir, role, opts);
    if (ticket) return ticket;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// ---------------------------------------------------------------- a trava

/** Caminhos que uma ferramenta de edição vai tocar (Claude: file_path/notebook_path; Codex: apply_patch). */
export function editTargets(event, cwd) {
  const input = event?.tool_input || {};
  const paths = new Set();
  if (typeof input.command === 'string' && event?.tool_name === 'apply_patch') {
    for (const match of input.command.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+?)\s*$/gm)) paths.add(match[1]);
  }
  if (typeof input.patch === 'string') {
    for (const match of input.patch.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+?)\s*$/gm)) paths.add(match[1]);
  }
  for (const field of ['file_path', 'filePath', 'notebook_path', 'path']) {
    if (typeof input[field] === 'string' && input[field]) paths.add(input[field]);
  }
  return [...paths].map((path) => resolve(cwd || process.cwd(), path));
}

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

const GIT_WRITE = /\bgit(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+(commit|push|pull|reset|checkout|switch|restore|rebase|merge|stash|clean|apply|am|cherry-pick|revert|tag|add|rm|mv|worktree|init|clone|update-ref|branch\s+(?:-[dDmMcC]|--delete|--move|--force))\b/;
const SHELL_WRITE = /(?:^|[;&|(){}\n]|\bxargs|\bsudo|\bthen|\bdo)\s*(rm|rmdir|mv|cp|mkdir|touch|truncate|dd|chmod|chown|ln|tee|install|patch|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|ni|del|erase|ren|move|copy)(?=\s|$)/i;
const IN_PLACE = /\b(?:sed|perl)\s+(?:-\w*\s+)*-i\b|\bsed\s+--in-place\b/;
const PUBLISH = /\b(?:npm|pnpm|yarn)\s+(?:publish|version|unpublish)\b/;

/** Tira o conteúdo entre aspas: `node -e "x => y"` não é um redirecionamento. */
function withoutQuotes(command) {
  return command.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Redirecionamento para arquivo; `2>&1`, `>/dev/null`, `>$null` e `>nul` não escrevem nada. */
function redirectsToFile(command) {
  for (const match of withoutQuotes(command).matchAll(/(?<![=\-<>])(\d*|&)>{1,2}(?!>)\s*(&?[^\s;&|)]*)/g)) {
    const target = match[2];
    if (target.startsWith('&')) continue;
    if (/^(?:\/dev\/(?:null|stdout|stderr)|\$null|nul)$/i.test(target)) continue;
    return true;
  }
  return false;
}

/** Motivo para recusar um comando de shell num papel delegado, ou `null`. */
export function bashViolation(command) {
  const text = String(command || '');
  if (!text.trim()) return null;
  const bare = withoutQuotes(text);
  if (GIT_WRITE.test(bare)) return 'git-write';
  if (/(?:^|[;&|(\n])\s*gh(?=\s|$)/.test(bare)) return 'gh';
  if (PUBLISH.test(bare)) return 'publish';
  if (IN_PLACE.test(bare)) return 'in-place-edit';
  if (SHELL_WRITE.test(bare)) return 'shell-write';
  if (redirectsToFile(text)) return 'redirect';
  return null;
}

const WHY = {
  'git-write': 'it changes git state (commit, push, reset, checkout…); the main session does that',
  gh: 'it calls the GitHub CLI; the main session does that',
  publish: 'it publishes or bumps a package',
  'in-place-edit': 'it edits a file in place from the shell',
  'shell-write': 'it creates, moves or deletes files from the shell',
  redirect: 'it writes a file through shell redirection',
};

/**
 * PreToolUse: texto da recusa, ou `null` quando a ferramenta pode seguir.
 * Fora de um subagente `ct-*`, sempre `null` — a sessão principal nunca é tocada.
 */
/**
 * Conta uma recusa da trava nas métricas locais (`delegation-guard`), com o papel e nada mais.
 * Import tardio: só quem recusa paga o carregamento. Nunca lança.
 */
export async function recordDenial(cwd, event = {}) {
  try {
    if (!cwd) return;
    const { recordMetric } = await import('./telemetry.mjs');
    recordMetric(cwd, 'delegation-guard', { outcome: 'deny', role: roleFromEvent(event) || 'unknown' });
  } catch { /* métrica nunca derruba a trava */ }
}

export function delegationDenial({ event = {}, cwd = null, role = roleFromEvent(event), now = Date.now(), env = process.env } = {}) {
  if (!role || env.CONTEXT_TOOLS_DELEGATION_GUARD === '0') return null;
  const where = cwd || (typeof event.cwd === 'string' && event.cwd) || process.cwd();
  const tool = String(event.tool_name || '');
  const spec = ROLES[role];
  const ask = 'Stop and report this to the main session in your final answer instead of working around it.';

  if (tool === 'Bash' || tool === 'shell' || tool === 'exec_command' || (typeof event.tool_input?.command === 'string' && !EDIT_TOOLS.has(tool))) {
    const why = bashViolation(event.tool_input?.command ?? event.tool_input?.cmd);
    if (!why) return null;
    return `🧩 ${role}: this command is not allowed for a delegated agent: ${WHY[why]}. ${spec.writes ? 'File edits go through the edit tools, inside the declared scope.' : 'This role is read-only.'} ${ask}`;
  }
  if (!EDIT_TOOLS.has(tool)) return null;
  if (!spec.writes) return `🧩 ${role} is read-only: it does not edit files. Return what you found; the main session edits. ${ask}`;

  const targets = editTargets(event, where);
  const ticket = scopeFor(where, role, { now, env });
  const base = ticket ? ticket.root : resolve(where);
  const globs = [...(spec.defaultScope || []), ...(ticket?.allow || [])];
  if (!globs.length) {
    return `🧩 ${role}: no write scope was declared for this project. The main session declares it with \`ct brief --role=${role.slice(3)} --allow=<files>\`. ${ask}`;
  }
  const outside = targets.filter((path) => !within(base, path) || !matchesScope(relative(base, path), globs));
  if (!targets.length || !outside.length) return null;
  const shown = outside.slice(0, 3).map((p) => (within(base, p) ? relative(base, p).replace(/\\/g, '/') : p)).join(', ');
  return `🧩 ${role}: ${shown} is outside the declared write scope (${globs.slice(0, 8).join(', ')}). ${ask}`;
}
