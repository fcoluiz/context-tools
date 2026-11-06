#!/usr/bin/env node
// 📟 Estado da sessão numa linha — "quanto já custou, quanto pesa o contexto e os testes valem?"
//
// A mesma resposta da faixa acima do prompt do Claude Code (`hooks/band/register.tsx`), para quem
// não tem faixa: o Codex, ou um terminal. Lê o transcript da sessão; a única escrita são as
// leituras do limite de uso da conta (lib/limits.mjs), para prever quando ele acaba.
//
//   turnos e mensagens · contexto atual e o multiplicador de custo por mensagem que ele implica
//   (a curva medida de `multiplicadorDeCusto`) · se já compensa dividir a sessão · testes: rodaram
//   depois da última edição de código? passaram? · limite de uso: quanto foi e, no ritmo atual,
//   se acaba antes de renovar
//
// Uso:
//   status.mjs [--json | --band [--usd=] [--last-usd=] [--turns=] [--limits=<json>]] [--session=<id>] [--transcript=<caminho>] [--host=claude|codex] [--root=<dir>]

import { readFileSync, statSync } from 'node:fs';
import { resolveRoot, loadConfig, isMain, safe } from './lib/roots.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import {
  transcriptDaSessao, transcriptsRecentes, transcriptsCodexRecentes, metricasDaSessao, multiplicadorDeCusto,
} from './lib/sessao.mjs';
import { sessionActivity, unverifiedEdits, looksLikeTestRun } from './lib/verification.mjs';
import { sessionId } from './lib/handoff-estado.mjs';
import { fromClaude, samplesFromCodexTranscript, recordAndForecast, kindLabel, when } from './lib/limits.mjs';

/** Mesmo limiar do aviso de divisão do `Stop` (handoff.mjs): acima dele, dividir costuma compensar. */
export const LIMIAR_DIVISAO = 200000;
const MAX_ARQUIVOS = 3;

const flag = (args, nome) => {
  const a = args.find((x) => x.startsWith(`--${nome}=`));
  return a ? a.slice(nome.length + 3) : null;
};

/** O transcript a ler: o pedido explicitamente, o da sessão atual, ou o mais recente desta pasta. */
export function escolherTranscript(root, { transcript, session, host } = {}) {
  if (transcript) return { caminho: transcript, host: host || (/rollout-/.test(transcript) ? 'codex' : 'claude') };
  const sid = session || sessionId();
  if (sid && host !== 'codex') {
    const p = transcriptDaSessao(root, sid);
    if (p) return { caminho: p, host: 'claude' };
  }
  const claude = host === 'codex' ? [] : transcriptsRecentes(root, null, 1);
  const codex = host === 'claude' ? [] : transcriptsCodexRecentes(root, 1);
  const melhor = [...claude.map((c) => ({ ...c, host: 'claude' })), ...codex.map((c) => ({ ...c, host: 'codex' }))]
    .sort((a, b) => b.mtime - a.mtime)[0];
  return melhor ? { caminho: melhor.caminho, host: melhor.host } : null;
}

const textoDe = (v) => Array.isArray(v) ? v.map((x) => (x && x.text) || '').join('\n') : String(v || '');
// Resumo de testes que diz "falhou" mesmo com código de saída 0 (um `| tail` engole o código).
const FALHA_RE = /^#\s*fail\s+[1-9]|\b[1-9]\d*\s+(?:failed|failing)\b|^FAIL\b|\bTests?:\s+[1-9]\d*\s+failed/im;

/**
 * Resultado do ÚLTIMO comando de teste do transcript do Claude: 'pass', 'fail' ou null (nenhum).
 * `is_error` no `tool_result` é o código de saída; o texto pega a falha que um pipe escondeu.
 */
export function ultimoTesteClaude(raw, extra = []) {
  let ultimoId = null;
  const resultados = new Map();
  for (const linha of raw.split('\n')) {
    if (!linha.includes('tool_')) continue;
    const o = safe(() => JSON.parse(linha), null);
    const conteudo = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const c of conteudo) {
      if (c && c.type === 'tool_use' && typeof c.input?.command === 'string' && looksLikeTestRun(c.input.command, extra)) ultimoId = c.id;
      else if (c && c.type === 'tool_result' && c.tool_use_id) resultados.set(c.tool_use_id, c);
    }
  }
  if (!ultimoId) return null;
  const r = resultados.get(ultimoId);
  if (!r) return 'running';
  return r.is_error || FALHA_RE.test(textoDe(r.content)) ? 'fail' : 'pass';
}

/**
 * Edições e comandos do rollout do Codex, na ordem. O formato não é estável (o comando pode vir
 * dentro de um script `exec`), então a leitura é pelo TEXTO da chamada: `*** Update File:` é edição,
 * e a chamada inteira conta como comando para `looksLikeTestRun`. Errar aqui só muda uma linha de status.
 */
export function atividadeCodex(raw) {
  const edits = [];
  const commands = [];
  let seq = 0;
  for (const linha of raw.split('\n')) {
    if (!linha.includes('"response_item"')) continue;
    const o = safe(() => JSON.parse(linha), null);
    const p = o && o.payload;
    if (!p || (p.type !== 'custom_tool_call' && p.type !== 'function_call')) continue;
    const texto = String(p.input || p.arguments || '');
    seq++;
    for (const m of texto.matchAll(/\*\*\* (?:Update|Add) File: ([^\n\\"]+)/g)) edits.push({ seq, path: m[1].trim() });
    commands.push({ seq, command: texto.slice(0, 4000) });
  }
  return { edits, commands, calls: [] };
}

export function buildStatus(root, opts = {}) {
  const cfg = opts.cfg || loadConfig(root);
  const agora = opts.now ?? Date.now();
  // O limite é da conta: a faixa o mostra mesmo antes de achar o transcript desta sessão.
  const doClaude = () => safe(() => recordAndForecast(fromClaude(opts.limits).map((l) => ({ ...l, at: agora })), { now: agora, env: opts.env || process.env }), []);
  const alvo = escolherTranscript(root, opts);
  if (!alvo) return { status: 'no-session', limits: doClaude() };
  const raw = safe(() => readFileSync(alvo.caminho, 'utf8'), '');
  if (!raw) return { status: 'no-session', limits: doClaude() };
  const m = metricasDaSessao(alvo.caminho) || {};
  const extra = Array.isArray(cfg?.verify?.testPatterns) ? cfg.verify.testPatterns.filter((p) => typeof p === 'string') : [];
  const atividade = alvo.host === 'codex' ? atividadeCodex(raw) : sessionActivity(alvo.caminho);
  const pendentes = unverifiedEdits(root, atividade, { extraPatterns: extra });
  const rodouTeste = atividade.commands.some((c) => looksLikeTestRun(c.command, extra));
  const ultimo = alvo.host === 'claude' ? ultimoTesteClaude(raw, extra) : (rodouTeste ? 'unknown' : null);
  const contexto = m.contexto || 0;
  const limits = alvo.host === 'codex'
    ? safe(() => recordAndForecast(samplesFromCodexTranscript(raw), { now: agora, env: opts.env || process.env }), [])
    : doClaude();
  return {
    status: 'ok',
    host: alvo.host,
    transcript: alvo.caminho,
    updatedAt: safe(() => statSync(alvo.caminho).mtimeMs, null),
    messages: m.msgs || 0,
    context: contexto,
    window: m.janela || null,
    costMultiplier: Number(multiplicadorDeCusto(contexto).toFixed(1)),
    splitAdvised: contexto >= LIMIAR_DIVISAO,
    tests: {
      // never: código editado e nenhum teste; stale: editado depois do último teste; none: nada a dizer.
      state: pendentes.length ? (rodouTeste ? 'stale' : 'never') : (ultimo || 'none'),
      lastRun: ultimo,
      unverified: pendentes,
    },
    limits,
  };
}

/** Uma janela em texto curto: `5h 42%`, com a hora de renovar quando se sabe. */
function janela(l, t, now) {
  const base = `${kindLabel(l.kind)} ${Math.round(l.percent)}%`;
  return l.resetsAt ? t('status.limit.resets', { w: base, at: when(l.resetsAt, now) }) : base;
}

const mil = (n) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

export function formatStatus(r, t) {
  if (r.status !== 'ok') return [t('status.none'), linhaLimites(r, t)].filter(Boolean).join('\n');
  const partes = [
    t('status.msgs', { n: r.messages }),
    t('status.ctx', { ctx: mil(r.context), mult: r.costMultiplier.toFixed(1) }),
  ];
  const linhas = [`📟 ${partes.join(' · ')}`];
  if (r.splitAdvised) linhas.push(t('status.split'));
  const tt = r.tests;
  if (tt.state === 'stale' || tt.state === 'never') {
    const mais = tt.unverified.length - MAX_ARQUIVOS;
    linhas.push(t(`status.${tt.state}`, { n: tt.unverified.length, files: tt.unverified.slice(0, MAX_ARQUIVOS).join(', ') + (mais > 0 ? ` (+${mais})` : '') }));
  } else if (tt.state !== 'none') {
    linhas.push(t(`status.tests.${tt.state}`));
  }
  const lim = linhaLimites(r, t);
  if (lim) linhas.push(lim);
  return linhas.join('\n');
}

function linhaLimites(r, t) {
  const lim = r.limits || [];
  if (!lim.length) return '';
  const now = Date.now();
  const acaba = lim.find((l) => l.exhaustAt);
  return `⏳ ${lim.map((l) => janela(l, t, now)).join(' · ')}${acaba ? ` — ${t('status.limit.out', { w: kindLabel(acaba.kind), at: when(acaba.exhaustAt, now) })}` : ''}`;
}

const dolar = (n) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`;
const TESTE_CURTO = { pass: '✓', fail: '✗', running: '…', unknown: '?' };

/**
 * A faixa acima do prompt: uma linha curta e, se houver, um alerta. O custo em dólar e os turnos
 * vêm do Claude Code (`$.session.usage()`, `$.session.turns()`), porque só ele tem a tabela de
 * preços; o resto vem do transcript, aqui.
 */
export function formatBand(r, t, { usd = null, lastUsd = null, turns = null } = {}) {
  const partes = [];
  if (Number.isFinite(usd)) partes.push(Number.isFinite(lastUsd) && lastUsd > 0 ? t('band.cost', { usd: dolar(usd), last: dolar(lastUsd) }) : dolar(usd));
  if (Number.isFinite(turns) && turns > 0) partes.push(t('band.turns', { n: turns }));
  let alerta = null;
  if (r.status === 'ok') {
    partes.push(t('band.ctx', { ctx: mil(r.context), mult: r.costMultiplier.toFixed(1) }));
    const tt = r.tests;
    if (tt.state === 'stale' || tt.state === 'never') partes.push(t(`band.tests.${tt.state}`, { n: tt.unverified.length }));
    else if (TESTE_CURTO[tt.state]) partes.push(`🧪 ${TESTE_CURTO[tt.state]}`);
    if (r.splitAdvised) alerta = t('band.split');
    else if (tt.state === 'fail') alerta = t('band.fail');
  }
  // Limite só aparece quando importa: metade gasta, ou acabando antes de renovar.
  const lim = (r.limits || []).filter((l) => l.exhaustAt || l.percent >= 50);
  for (const l of lim) partes.push(`⏳ ${kindLabel(l.kind)} ${Math.round(l.percent)}%${l.exhaustAt ? ` → ~${when(l.exhaustAt)}` : ''}`);
  const acaba = lim.find((l) => l.exhaustAt);
  if (acaba && !alerta) alerta = t('band.limit', { w: kindLabel(acaba.kind), at: when(acaba.exhaustAt), reset: acaba.resetsAt ? when(acaba.resetsAt) : '?' });
  return { text: partes.join(' · '), warn: alerta };
}

const numFlag = (args, nome) => {
  const v = flag(args, nome);
  return v === null || v === '' ? null : Number(v);
};

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot(args);
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  const host = flag(args, 'host');
  const limits = safe(() => JSON.parse(flag(args, 'limits') || 'null'), null);
  const r = buildStatus(root, { cfg, session: flag(args, 'session'), transcript: flag(args, 'transcript'), host: host === 'codex' || host === 'claude' ? host : null, limits });
  if (args.includes('--band')) console.log(JSON.stringify(formatBand(r, t, { usd: numFlag(args, 'usd'), lastUsd: numFlag(args, 'last-usd'), turns: numFlag(args, 'turns') })));
  else if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else console.log(formatStatus(r, t));
}

if (isMain(import.meta.url)) main();
