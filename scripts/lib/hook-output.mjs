// Saída única por hook. Quando o plugin e uma cópia standalone (ou dois registros do mesmo
// hook) estão ativos ao mesmo tempo, o agente recebe o mesmo bloco duas vezes: o dobro de
// tokens em toda sessão e um aviso repetido no chat. As cópias rodam em paralelo, então a
// deduplicação precisa ser atômica — `openSync(..., 'wx')` garante que só uma vença.
//
// A chave é o CONTEÚDO (evento + texto + sessão), não o caminho do script: duas instalações
// diferentes que dizem a mesma coisa são, para o agente, a mesma mensagem. A janela é curta
// de propósito — um SessionStart legítimo depois de /compact ou /clear volta a ser emitido.

import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig, safe, scriptCommand, statePath } from './roots.mjs';

export const HOOK_DEDUPE_WINDOW_MS = 90 * 1000;
/**
 * Teto de cada aviso de `Stop`. No Claude, todo texto de Stop faz o modelo dar mais um turno e
 * fica no contexto de todas as mensagens seguintes; o que passar disso é backlog, e o lugar dele
 * é o `health.mjs`, não o chat. O prompt de handoff (para o usuário colar) é a exceção: `cap: false`.
 */
export const STOP_NOTE_MAX_CHARS = 900;
const OVERFLOW = {
  pt: (cmd) => `\n… (aviso cortado; o restante está em ${cmd})`,
  en: (cmd) => `\n… (truncated; the rest is in ${cmd})`,
};

/** Corta no fim de linha mais próximo do teto, nunca no meio de um caminho. */
export function capStopNote(text, root, { max = STOP_NOTE_MAX_CHARS, lang = 'en' } = {}) {
  if (typeof text !== 'string' || text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  const head = text.slice(0, cut > max * 0.5 ? cut : max).trimEnd();
  return head + (OVERFLOW[lang] || OVERFLOW.en)(scriptCommand(root, 'health.mjs'));
}
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const DIR = '.hook-emissions';

function sessionIdFromEnv(env = process.env) {
  return env.CONTEXT_TOOLS_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || '';
}

function prune(dir, now) {
  safe(() => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs > PRUNE_AFTER_MS) safe(() => unlinkSync(file), null);
    }
  }, null);
}

/**
 * `true` quando este processo deve emitir. Falha de disco nunca silencia o hook: na dúvida,
 * emite — perder o aviso seria pior que repeti-lo.
 */
export function claimHookEmission(root, eventName, text, {
  sessionId = sessionIdFromEnv(), now = Date.now(), windowMs = HOOK_DEDUPE_WINDOW_MS, env = process.env,
} = {}) {
  if (!root || !text || env.CONTEXT_TOOLS_HOOK_DEDUPE === '0') return true;
  const dir = statePath(root, DIR);
  const key = createHash('sha256').update(`${eventName}\0${sessionId}\0${text}`).digest('hex').slice(0, 32);
  const file = join(dir, key);
  try {
    mkdirSync(dir, { recursive: true });
    closeSync(openSync(file, 'wx'));
    if (Math.random() < 0.05) prune(dir, now);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') return true;
  }
  // Já existe: duplicata dentro da janela, ou uma emissão antiga legítima de se repetir.
  const age = safe(() => now - statSync(file).mtimeMs, Infinity);
  if (age < windowMs) return false;
  safe(() => utimesSync(file, now / 1000, now / 1000), null);
  return true;
}

/**
 * Escreve a saída JSON do hook, deduplicada. Aceita objeto ou string JSON já serializada;
 * conteúdo sem `additionalContext`/`systemMessage` passa direto (não há o que repetir).
 */
export function writeHookOutput(root, payload, opts = {}) {
  if (!payload) return false;
  let parsed = typeof payload === 'string' ? safe(() => JSON.parse(payload), null) : payload;
  const ctx = parsed?.hookSpecificOutput;
  if (ctx?.hookEventName === 'Stop' && typeof ctx.additionalContext === 'string' && opts.cap !== false) {
    const lang = /^pt/i.test(String(process.env.CONTEXT_TOOLS_LANG || safe(() => loadConfig(root).lang, '') || '')) ? 'pt' : 'en';
    const capped = capStopNote(ctx.additionalContext, root, { lang });
    if (capped !== ctx.additionalContext) parsed = { ...parsed, hookSpecificOutput: { ...ctx, additionalContext: capped } };
  }
  const json = parsed ? JSON.stringify(parsed) : payload;
  const event = parsed?.hookSpecificOutput?.hookEventName || 'unknown';
  const text = parsed?.hookSpecificOutput?.additionalContext || parsed?.systemMessage || '';
  if (text && !claimHookEmission(root, event, text, opts)) return false;
  process.stdout.write(json);
  return true;
}
