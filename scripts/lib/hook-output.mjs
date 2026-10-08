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
import { safe, statePath } from './roots.mjs';

export const HOOK_DEDUPE_WINDOW_MS = 90 * 1000;
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
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const parsed = typeof payload === 'string' ? safe(() => JSON.parse(payload), null) : payload;
  const event = parsed?.hookSpecificOutput?.hookEventName || 'unknown';
  const text = parsed?.hookSpecificOutput?.additionalContext || parsed?.systemMessage || '';
  if (text && !claimHookEmission(root, event, text, opts)) return false;
  process.stdout.write(json);
  return true;
}
