// Métricas locais e opcionais. Nunca grava conteúdo de arquivo, prompt ou comando completo.
// O objetivo é medir adoção e resultado, não observar o trabalho do usuário.

import { unlinkSync } from 'node:fs';
import { safe, statePath, sanitizeModelText } from './roots.mjs';
import { readState, transactState } from './state-store.mjs';

export const MAX_EVENTS = 2000;
const FILE = (root) => statePath(root, '.context-tools-metrics.json');

/** Sessão do host, para o `health --session` separar o que rodou nesta conversa. Não é conteúdo. */
function currentSession(env = process.env) {
  const sid = env.CONTEXT_TOOLS_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || '';
  return sid ? sanitizeModelText(sid, 64) : undefined;
}

export function recordMetric(root, type, data = {}) {
  if (!root || !type) return;
  const session = currentSession();
  const event = {
    at: Date.now(),
    type: sanitizeModelText(type, 60),
    ...(session ? { session } : {}),
    ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? sanitizeModelText(v, 120) : v])),
  };
  return transactState(FILE(root), () => ({ version: 1, events: [] }), (current) => {
    if (current.version !== 1 || !Array.isArray(current.events)) throw new Error('invalid metrics state');
    current.events = [...current.events, event].slice(-MAX_EVENTS);
    return true;
  });
}

export function readMetrics(root) {
  const loaded = readState(FILE(root), () => ({ version: 1, events: [] }));
  if (!loaded.ok) return { version: 1, events: [], status: loaded.reason };
  const data = loaded.value;
  if (data.version !== 1 || !Array.isArray(data.events)) return { version: 1, events: [], status: 'unsupported-state' };
  return { version: 1, events: data.events, status: 'ready' };
}

export function clearMetrics(root) {
  safe(() => unlinkSync(FILE(root)), null);
}

if (process.argv[1] && process.argv[1].endsWith('telemetry.mjs')) {
  const root = process.argv.find((x) => x.startsWith('--root='))?.slice(7) || process.cwd();
  if (process.argv.includes('--clear')) clearMetrics(root);
  else process.stdout.write(JSON.stringify(readMetrics(root), null, 2) + '\n');
}

