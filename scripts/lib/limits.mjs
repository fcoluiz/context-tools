// ⏳ "No ritmo atual, o limite de uso acaba antes de renovar?" — para quem está programando.
//
// As leituras vêm do próprio agente: o Claude Code passa as janelas de `$.session.usage()` para a
// faixa (`--limits=`), e o Codex grava `rate_limits` a cada `token_count` do transcript. O limite é
// da conta, não da sessão: as leituras ficam numa pasta do usuário (CONTEXT_TOOLS_HOME), e o ritmo
// sai de todas as leituras da janela atual, de qualquer projeto. Nada sai da máquina.
//
// A previsão é linear de propósito: a mais simples que diz algo útil. Ela só fala com pelo menos
// 10 min de leituras na janela e uso subindo; senão diz o uso e cala sobre o futuro.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { safe } from './roots.mjs';

const MIN_INTERVALO_MS = 10 * 60 * 1000;
const MAX_AMOSTRAS = 60;
const NOMES = { 300: 'five_hour', 10080: 'seven_day' };

export function limitsFile(env = process.env) {
  return join(env.CONTEXT_TOOLS_HOME || join(homedir(), '.context-tools'), 'limit-samples.json');
}

const ms = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  const d = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(d) ? d : null;
};

/** Janelas do Claude Code (`[{ kind, percentUsed, resetsAt }]`) no formato comum. */
export function fromClaude(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((l) => l && typeof l.kind === 'string' && Number.isFinite(l.percentUsed))
    .map((l) => ({ kind: l.kind.slice(0, 40), percent: l.percentUsed, resetsAt: ms(l.resetsAt) }));
}

/** `rate_limits` do Codex (`primary`/`secondary` com `used_percent`, `window_minutes`, `resets_at`). */
export function fromCodex(rl) {
  if (!rl || typeof rl !== 'object') return [];
  const out = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || !Number.isFinite(w.used_percent)) continue;
    const kind = NOMES[w.window_minutes] || `${Number(w.window_minutes) || 0}m`;
    out.push({ kind, percent: w.used_percent, resetsAt: ms(w.resets_at) });
  }
  return out;
}

/** Todas as leituras de limite de um transcript do Codex, com a hora de cada uma. */
export function samplesFromCodexTranscript(raw) {
  const out = [];
  for (const linha of String(raw || '').split('\n')) {
    if (!linha.includes('"rate_limits"')) continue;
    const o = safe(() => JSON.parse(linha), null);
    const at = ms(o?.timestamp);
    if (!at || o?.payload?.type !== 'token_count') continue;
    for (const w of fromCodex(o.payload.rate_limits)) out.push({ ...w, at });
  }
  return out;
}

const mesmaJanela = (a, b) => (a == null || b == null) ? a === b : Math.abs(a - b) < 5 * 60 * 1000;

/**
 * Junta leituras novas às guardadas e devolve o estado: por janela, só as leituras da janela atual
 * (um `resetsAt` novo descarta as anteriores), até MAX_AMOSTRAS.
 */
export function mergeSamples(store, samples) {
  const out = store && typeof store === 'object' && !Array.isArray(store) ? { ...store } : {};
  for (const s of [...samples].sort((a, b) => a.at - b.at)) {
    if (!s || !s.kind || !Number.isFinite(s.at) || !Number.isFinite(s.percent)) continue;
    let lista = Array.isArray(out[s.kind]) ? out[s.kind] : [];
    const ultima = lista.at(-1);
    if (ultima && !mesmaJanela(ultima.resetsAt, s.resetsAt)) {
      if (s.at < ultima.at) continue; // leitura velha de uma janela que já passou
      lista = [];
    }
    if (lista.some((x) => x.at === s.at)) continue;
    lista = [...lista, { at: s.at, percent: s.percent, resetsAt: s.resetsAt ?? null }].sort((a, b) => a.at - b.at).slice(-MAX_AMOSTRAS);
    out[s.kind] = lista;
  }
  return out;
}

export function loadSamples(env = process.env) {
  return safe(() => JSON.parse(readFileSync(limitsFile(env), 'utf8')), null) || {};
}

export function saveSamples(store, env = process.env) {
  const file = limitsFile(env);
  safe(() => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, file);
  }, null);
}

/** Guarda as leituras e devolve a previsão de cada janela. Falha de disco só tira o histórico. */
export function recordAndForecast(samples, { now = Date.now(), env = process.env } = {}) {
  let store = loadSamples(env);
  if (samples.length) {
    store = mergeSamples(store, samples);
    saveSamples(store, env);
  }
  // Sem leitura nova (o `ct status` no terminal do Claude): as guardadas, se tiverem menos de 1 h.
  const kinds = samples.length
    ? [...new Set(samples.map((s) => s.kind))]
    : Object.keys(store).filter((k) => Array.isArray(store[k]) && now - (store[k].at(-1)?.at ?? 0) < 60 * 60 * 1000);
  return kinds.map((k) => forecastWindow(k, store[k] || [], now)).filter(Boolean);
}

/**
 * `{ kind, percent, resetsAt, exhaustAt }`: `exhaustAt` é quando o uso chega a 100% no ritmo da
 * janela, e só existe se isso acontecer ANTES de ela renovar. Null sem leitura.
 */
export function forecastWindow(kind, lista, now = Date.now()) {
  const atual = lista.at(-1);
  if (!atual) return null;
  // Janela que já renovou: a leitura não diz mais nada sobre o uso de agora.
  if (atual.resetsAt && atual.resetsAt <= now) return null;
  const base = { kind, percent: atual.percent, resetsAt: atual.resetsAt ?? null, exhaustAt: null };
  if (atual.percent >= 100) return { ...base, exhaustAt: atual.at };
  const primeira = lista.find((x) => atual.at - x.at >= MIN_INTERVALO_MS && x.percent < atual.percent);
  if (!primeira) return base;
  const ritmo = (atual.percent - primeira.percent) / (atual.at - primeira.at); // % por ms
  const fim = atual.at + (100 - atual.percent) / ritmo;
  if (fim <= now) return base; // leitura velha: não prever o passado
  if (base.resetsAt && fim >= base.resetsAt) return base;
  return { ...base, exhaustAt: Math.round(fim) };
}

const ROTULO = { five_hour: '5h', seven_day: '7d', spend_limit: '$' };
export const kindLabel = (k) => ROTULO[k] || k;
export const clock = (at) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** Hora curta, ou dia e hora quando não é hoje (a janela de 7 dias). */
export function when(at, now = Date.now()) {
  const d = new Date(at);
  const hoje = new Date(now);
  if (d.toDateString() === hoje.toDateString()) return clock(at);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${clock(at)}`;
}
