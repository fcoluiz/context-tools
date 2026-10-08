// O agente APROVEITOU a resposta do índice? Até aqui o health só sabia que a resposta foi
// oferecida — disponibilidade, não proveito. Este módulo fecha a pergunta com o mesmo critério
// da validação retroativa do README: a resposta conta como aproveitada se o agente abriu ou
// editou um dos arquivos indicados nas 6 chamadas de ferramenta seguintes.
//
// Fluxo: o PreToolUse anota (sessão, instante, arquivos indicados); o Stop do Claude lê o
// transcript, julga as respostas que já têm 6 chamadas depois delas e registra só o veredito
// (`pretool-followup`: used|ignored). Nenhum caminho, termo ou conteúdo vai para as métricas.
// No Codex não há transcript estável para isso: as anotações expiram sem julgamento.

import { createHash } from 'node:crypto';
import { statePath } from './roots.mjs';
import { readState, transactState } from './state-store.mjs';

export const FOLLOW_WINDOW = 6;
const MAX_ANSWERS = 200;
const ANSWER_TTL_MS = 24 * 60 * 60 * 1000;
const FILE = (root) => statePath(root, '.pre-tool-answers.json');
const initial = () => ({ format: 1, answers: [] });
const sessionKey = (sid) => createHash('sha256').update(String(sid)).digest('hex').slice(0, 24);
const norm = (path) => String(path).replace(/\\/g, '/').toLowerCase();

/** Arquivos citados numa resposta do índice: linhas `  caminho:linha` ou `  caminho:ini-fim`. */
export function filesFromAnswer(lines) {
  const files = new Set();
  for (const line of lines) {
    const m = String(line).match(/^\s{2}(\S.*?):\d+(?:-\d+)?\s*$/);
    if (m) files.add(m[1]);
  }
  return [...files].slice(0, 20);
}

export function recordAnswer(root, sid, files, now = Date.now()) {
  if (!root || !sid || !files?.length) return;
  transactState(FILE(root), initial, (state) => {
    if (state.format !== 1 || !Array.isArray(state.answers)) throw new Error('unsupported answers state');
    state.answers = [...state.answers.filter((a) => now - a.at < ANSWER_TTL_MS), { s: sessionKey(sid), at: now, files }].slice(-MAX_ANSWERS);
    return true;
  });
}

export function hasPendingAnswers(root, sid) {
  const loaded = readState(FILE(root), initial);
  if (!loaded.ok || !Array.isArray(loaded.value.answers)) return false;
  const key = sessionKey(sid);
  return loaded.value.answers.some((a) => a.s === key);
}

const touches = (call, files) => call.paths.some((path) => {
  const p = norm(path);
  return files.some((file) => { const f = norm(file); return p === f || p.endsWith(`/${f}`); });
});

/**
 * Julga as respostas desta sessão que já têm `FOLLOW_WINDOW` chamadas depois delas.
 * `calls`: [{ at: ms, paths: [...] }] em ordem. Devolve os vereditos; as não julgáveis ficam.
 */
export function evaluateFollowThrough(root, sid, calls, now = Date.now()) {
  const key = sessionKey(sid);
  const verdicts = [];
  transactState(FILE(root), initial, (state) => {
    if (state.format !== 1 || !Array.isArray(state.answers)) throw new Error('unsupported answers state');
    state.answers = state.answers.filter((answer) => {
      if (now - answer.at >= ANSWER_TTL_MS) return false;
      if (answer.s !== key) return true;
      const after = calls.filter((call) => call.at > answer.at).slice(0, FOLLOW_WINDOW);
      if (after.length < FOLLOW_WINDOW) return true;
      verdicts.push(after.some((call) => touches(call, answer.files)) ? 'used' : 'ignored');
      return false;
    });
    return true;
  });
  return verdicts;
}
