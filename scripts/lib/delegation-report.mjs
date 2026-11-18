// 🧾 Quanto custaram os subagentes de uma sessão, e quanto teria custado fazer o mesmo no contexto
// principal.
//
// Fonte: o Claude Code grava cada subagente em `<pasta-de-transcripts>/<sessionId>/subagents/
// agent-<id>.jsonl`, com um `.meta.json` ao lado (`agentType`, `description`). Cada requisição traz
// o `usage`; como no `metricasDaSessao`, uma requisição aparece em várias linhas (uma por bloco da
// resposta) e é contada uma vez só, pelo id da mensagem.
//
// O custo real é medido. O contrafactual é ESTIMATIVA, e o relatório diz isso: supõe que cada
// requisição do subagente teria relido o contexto principal da hora em que ele foi chamado, e que
// o que ele acumulou de leitura teria ficado no contexto principal até o fim da sessão.
//
// Regra desta lib, a mesma de `sessao.mjs`: nunca lançar. Arquivo ausente ou formato mudado viram
// `null` ou zero.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { safe } from './roots.mjs';
import { pastaDeTranscripts, pastaDeSessoesCodex, metricasDaSessao } from './sessao.mjs';

/**
 * USD por milhão de tokens, preço de lista da API (2026-11). `long` vale quando o prompt da
 * requisição (entrada + cache lido + cache gravado) passa de `longAbove`. Gravar cache custa
 * 1,25× a entrada (TTL de 5 min) ou 2× (TTL de 1 h). Prefixo mais longo primeiro: o primeiro que
 * casar com o id do modelo vence. `delegation.prices` no context-tools.json acrescenta ou troca.
 */
export const PRICES = Object.freeze([
  ['claude-haiku-5-5', { input: 0.10, output: 0.50, cacheRead: 0.01, longAbove: 100000, long: { input: 0.50, output: 2.50, cacheRead: 0.05 } }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.10 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.10 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.20 }],
  ['claude-sonnet-4-6', { input: 3, output: 15, cacheRead: 0.30 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.20 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.50 }],
  ['claude-opus-4', { input: 5, output: 25, cacheRead: 0.50 }],
  ['claude-fable-5-2', { input: 8, output: 40, cacheRead: 0.20 }],
]);

export function priceFor(model, overrides = {}) {
  const id = String(model || '').toLowerCase();
  if (!id) return null;
  const extra = Object.entries(overrides || {}).filter(([, p]) => p && Number.isFinite(Number(p.input)) && Number.isFinite(Number(p.output)));
  const table = [...extra, ...PRICES].sort((a, b) => b[0].length - a[0].length);
  const hit = table.find(([prefix]) => id.startsWith(prefix.toLowerCase()));
  return hit ? hit[1] : null;
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Custo em USD de uma requisição, ou `null` quando o modelo não tem preço conhecido. */
export function requestCost(req, price) {
  if (!price) return null;
  const prompt = req.input + req.cacheRead + req.cacheWrite5m + req.cacheWrite1h;
  const tier = price.long && prompt > price.longAbove ? { ...price, ...price.long } : price;
  const cacheRead = Number.isFinite(Number(tier.cacheRead)) ? tier.cacheRead : tier.input * 0.1;
  return (req.input * tier.input + req.output * tier.output + req.cacheRead * cacheRead
    + req.cacheWrite5m * tier.input * 1.25 + req.cacheWrite1h * tier.input * 2) / 1e6;
}

/** Requisições de um transcript do Claude, uma por id de mensagem, na ordem em que apareceram. */
export function requestsOf(path) {
  const raw = safe(() => readFileSync(path, 'utf8'), '');
  const byId = new Map();
  let lastText = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const o = safe(() => JSON.parse(line), null);
    const msg = o?.message;
    if (o?.type === 'assistant' && Array.isArray(msg?.content)) {
      const text = msg.content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('\n');
      if (text.trim()) lastText = text;
      // A resposta final também pode sair por uma ferramenta de devolução ao agente principal
      // (o Claude Code entrega o relatório do subagente assim), e não como texto.
      for (const c of msg.content) {
        if (c?.type === 'tool_use' && /hand.?back|final.?report/i.test(String(c.name || ''))) {
          const handed = JSON.stringify(c.input || {});
          if (handed.length > 2) lastText = handed;
        }
      }
    }
    const u = msg?.usage;
    // `<synthetic>` é mensagem que o próprio Claude Code escreve (interrupção, erro de API), com
    // uso zerado e sem preço: não é requisição, e contá-la anulava o custo da sessão inteira.
    if (!u || msg.model === '<synthetic>') continue;
    const id = msg.id || `line-${byId.size}`;
    const split = u.cache_creation && typeof u.cache_creation === 'object';
    const next = {
      model: msg.model || null,
      at: o.timestamp ? Date.parse(o.timestamp) : null,
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      cacheWrite5m: split ? n(u.cache_creation.ephemeral_5m_input_tokens) : n(u.cache_creation_input_tokens),
      cacheWrite1h: split ? n(u.cache_creation.ephemeral_1h_input_tokens) : 0,
    };
    // As linhas de uma mesma resposta repetem o `usage`, e a contagem de saída das primeiras pode
    // ser parcial: fica o maior valor de cada campo, e o horário da primeira linha.
    const prev = byId.get(id);
    if (prev) for (const f of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']) next[f] = Math.max(prev[f], next[f]);
    if (prev?.at) next.at = prev.at;
    byId.set(id, next);
  }
  return { requests: [...byId.values()], lastText };
}

const promptOf = (r) => r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
const sum = (list, f) => list.reduce((acc, x) => acc + f(x), 0);
const mostUsed = (list) => {
  const count = {};
  for (const r of list) if (r.model && r.model !== '<synthetic>') count[r.model] = (count[r.model] || 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
};

/** Tokens somados de uma lista de requisições. */
function totals(list) {
  return {
    requests: list.length,
    input: sum(list, (r) => r.input),
    output: sum(list, (r) => r.output),
    cacheRead: sum(list, (r) => r.cacheRead),
    cacheWrite: sum(list, (r) => r.cacheWrite5m + r.cacheWrite1h),
  };
}

/**
 * Estimativa do mesmo trabalho feito na sessão principal: cada requisição do subagente relê o
 * contexto principal da hora (`baseContext`) mais o que ele já acumulou; o acumulado novo entra
 * como gravação de cache; a saída custa o preço de saída do modelo principal. Depois, o que ficou
 * acumulado (menos a resposta, que a principal recebe de qualquer jeito) é relido por cada
 * requisição principal seguinte.
 */
export function counterfactual(sub, { mainPrice, baseContext, laterMainRequests, resultTokens }) {
  if (!mainPrice || !sub.length) return null;
  const p0 = promptOf(sub[0]);
  let previous = 0;
  let work = 0;
  for (const r of sub) {
    const grown = Math.max(0, promptOf(r) - p0);
    const fresh = Math.max(0, grown - previous);
    previous = grown;
    work += requestCost({ input: 0, output: r.output, cacheRead: baseContext + grown - fresh, cacheWrite5m: fresh, cacheWrite1h: 0 }, mainPrice);
  }
  const kept = Math.max(0, previous - resultTokens);
  const carry = requestCost({ input: 0, output: 0, cacheRead: kept * laterMainRequests, cacheWrite5m: 0, cacheWrite1h: 0 }, mainPrice);
  return { usd: work + carry, work, carry, keptTokens: kept };
}

/** Sessões com subagentes, da mais recente para a mais antiga. */
export function sessionsWithSubagents(dir) {
  if (!dir || !existsSync(dir)) return [];
  return (safe(() => readdirSync(dir, { withFileTypes: true }), []) || [])
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'subagents')))
    .map((e) => ({ sid: e.name, mtime: safe(() => statSync(join(dir, e.name, 'subagents')).mtimeMs, 0) }))
    .sort((a, b) => b.mtime - a.mtime);
}

/** Relatório de uma sessão do Claude. */
export function claudeReport(root, { session = null, prices = {}, dir = pastaDeTranscripts(root) } = {}) {
  const sid = session || sessionsWithSubagents(dir)[0]?.sid || null;
  if (!dir || !sid) return { host: 'claude', status: 'no-subagents', session: sid, agents: [] };
  const subDir = join(dir, sid, 'subagents');
  const mainPath = join(dir, `${sid}.jsonl`);
  const main = existsSync(mainPath) ? requestsOf(mainPath).requests : [];
  const mainModel = mostUsed(main);
  const mainPrice = priceFor(mainModel, prices);
  const agents = [];
  for (const file of (safe(() => readdirSync(subDir), []) || []).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort()) {
    const meta = safe(() => JSON.parse(readFileSync(join(subDir, file.replace(/\.jsonl$/, '.meta.json')), 'utf8')), {}) || {};
    const { requests, lastText } = requestsOf(join(subDir, file));
    if (!requests.length) continue;
    const model = mostUsed(requests);
    const costs = requests.map((r) => requestCost(r, priceFor(r.model || model, prices)));
    const known = costs.every((c) => c !== null);
    const start = requests.find((r) => r.at)?.at ?? null;
    const before = start ? main.filter((r) => r.at && r.at <= start) : [];
    const baseContext = before.length ? promptOf(before[before.length - 1]) : (main[0] ? promptOf(main[0]) : 0);
    const end = [...requests].reverse().find((r) => r.at)?.at ?? start;
    const laterMainRequests = end ? main.filter((r) => r.at && r.at > end).length : 0;
    const resultTokens = Math.ceil(lastText.length / 4);
    const realUsd = known ? sum(costs, (c) => c) : null;
    // A resposta entra no contexto principal e é relida pelas requisições seguintes: isso também é
    // custo da delegação, e entra no lado real da comparação.
    const resultCarry = mainPrice ? requestCost({ input: 0, output: 0, cacheRead: resultTokens * laterMainRequests, cacheWrite5m: resultTokens, cacheWrite1h: 0 }, mainPrice) : 0;
    agents.push({
      id: file.replace(/^agent-|\.jsonl$/g, ''),
      agentType: meta.agentType || null,
      description: meta.description || null,
      model,
      tokens: totals(requests),
      peakPrompt: Math.max(...requests.map(promptOf)),
      usd: realUsd,
      usdWithResult: realUsd === null ? null : realUsd + resultCarry,
      resultTokens,
      estimate: counterfactual(requests, { mainPrice, baseContext, laterMainRequests, resultTokens }),
      baseContext,
      laterMainRequests,
    });
  }
  const mainCosts = main.map((r) => requestCost(r, priceFor(r.model || mainModel, prices)));
  return {
    host: 'claude', status: agents.length ? 'ok' : 'no-subagents', session: sid,
    main: { model: mainModel, tokens: totals(main), usd: mainCosts.every((c) => c !== null) ? sum(mainCosts, (c) => c) : null },
    agents,
  };
}

/**
 * Tipo do subagente como dado, não como texto: só passa o que tem formato de id (`Explore`,
 * `context-tools:ct-explorer`); o resto vira `custom`. A `description` nunca sai daqui: é texto
 * livre escrito para o subagente, e pode carregar nome de arquivo, de cliente ou trecho de prompt.
 */
export function agentTypeId(type) {
  if (type === null || type === undefined || type === '') return null;
  return /^[\w.:@/-]{1,80}$/.test(String(type)) ? String(type) : 'custom';
}

/** `plugin` para os papéis `ct-*` deste plugin; `host` para os agentes do host e os do usuário. */
export function agentOrigin(type) {
  return /(^|:)ct-[a-z-]+$/.test(String(type || '')) ? 'plugin' : 'host';
}

/**
 * Subagentes de uma sessão do Claude agrupados por tipo e modelo: só contagens e tokens, para o
 * snapshot. Sem custo (quem consome aplica a própria tabela de preço, como já faz com `tokens` da
 * sessão) e sem descrição. Lista vazia quando a sessão não teve subagente.
 */
export function subagentsOf(dir, sid) {
  const subDir = dir && sid ? join(dir, sid, 'subagents') : null;
  if (!subDir || !existsSync(subDir)) return [];
  const groups = new Map();
  for (const file of (safe(() => readdirSync(subDir), []) || []).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort()) {
    const meta = safe(() => JSON.parse(readFileSync(join(subDir, file.replace(/\.jsonl$/, '.meta.json')), 'utf8')), {}) || {};
    const { requests } = requestsOf(join(subDir, file));
    if (!requests.length) continue;
    const agentType = agentTypeId(meta.agentType);
    const model = mostUsed(requests);
    const key = `${agentType}\u0000${model}`;
    const g = groups.get(key) || { agentType, origin: agentOrigin(agentType), model, count: 0, requests: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const t = totals(requests);
    g.count++;
    g.requests += t.requests;
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite']) g.tokens[f] += t[f];
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.requests - a.requests);
}

/**
 * Agregado do Claude num período: as sessões com subagente cuja pasta `subagents/` mudou nos
 * últimos `days` dias, somadas por tipo e modelo. A fração do custo é sobre essas sessões (principal
 * + subagentes), não sobre todas as sessões do período: ler todos os transcripts custaria caro e
 * diria pouco a mais.
 */
export function periodReport(root, { days = 30, prices = {}, dir = pastaDeTranscripts(root), now = Date.now() } = {}) {
  const since = now - days * 864e5;
  const sessions = sessionsWithSubagents(dir).filter((s) => s.mtime >= since);
  const groups = new Map();
  let mainUsd = 0, subUsd = 0, priced = 0, unpriced = 0, agents = 0;
  for (const { sid } of sessions) {
    const r = claudeReport(root, { session: sid, prices, dir });
    if (r.status !== 'ok') continue;
    const allPriced = r.main?.usd !== null && r.agents.every((a) => a.usd !== null);
    if (allPriced) { priced++; mainUsd += r.main.usd; subUsd += sum(r.agents, (a) => a.usdWithResult); } else unpriced++;
    for (const a of r.agents) {
      agents++;
      const agentType = agentTypeId(a.agentType);
      const key = `${agentType}\u0000${a.model}`;
      const g = groups.get(key) || { agentType, origin: agentOrigin(agentType), model: a.model, count: 0, requests: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usd: 0, usdWithResult: 0, priced: 0, estimateUsd: 0, estimated: 0, measuredVsEstimate: 0 };
      g.count++;
      g.requests += a.tokens.requests;
      for (const f of ['input', 'output', 'cacheRead', 'cacheWrite']) g.tokens[f] += a.tokens[f];
      if (a.usd !== null) { g.priced++; g.usd += a.usd; g.usdWithResult += a.usdWithResult; }
      if (a.estimate && a.usdWithResult !== null) { g.estimated++; g.estimateUsd += a.estimate.usd; g.measuredVsEstimate += a.usdWithResult; }
      groups.set(key, g);
    }
  }
  const byType = [...groups.values()].sort((a, b) => b.usd - a.usd || b.requests - a.requests);
  return {
    host: 'claude', status: agents ? 'ok' : 'no-subagents', days, sessions: sessions.length, agents,
    cost: { sessionsPriced: priced, sessionsUnpriced: unpriced, mainUsd, subagentsUsd: subUsd, subagentShare: mainUsd + subUsd > 0 ? subUsd / (mainUsd + subUsd) : null },
    byOrigin: ['plugin', 'host'].map((origin) => {
      const list = byType.filter((g) => g.origin === origin);
      return { origin, count: sum(list, (g) => g.count), usd: sum(list, (g) => g.usdWithResult) };
    }),
    byType,
  };
}

export function formatPeriod(report, lang = 'en') {
  const pt = lang === 'pt';
  if (report.status !== 'ok') {
    return pt ? `🧾 delegação: nenhum subagente nos últimos ${report.days} dias.` : `🧾 delegation: no subagents in the last ${report.days} days.`;
  }
  const c = report.cost;
  const lines = [pt
    ? `🧾 Subagentes, últimos ${report.days} dias: ${report.agents} em ${report.sessions} sessão(ões)`
    : `🧾 Subagents, last ${report.days} days: ${report.agents} in ${report.sessions} session(s)`];
  if (c.subagentShare !== null) {
    lines.push(pt
      ? `   nessas sessões: principal ${usd(c.mainUsd)} · subagentes ${usd(c.subagentsUsd)} (${Math.round(c.subagentShare * 100)}% do custo)`
      : `   in those sessions: main ${usd(c.mainUsd)} · subagents ${usd(c.subagentsUsd)} (${Math.round(c.subagentShare * 100)}% of the cost)`);
  }
  if (c.sessionsUnpriced) lines.push(pt ? `   ${c.sessionsUnpriced} sessão(ões) com modelo sem preço ficaram fora dos totais.` : `   ${c.sessionsUnpriced} session(s) with an unpriced model left out of the totals.`);
  const origin = Object.fromEntries(report.byOrigin.map((o) => [o.origin, o]));
  lines.push(pt
    ? `   do plugin (ct-*): ${origin.plugin.count} · ${usd(origin.plugin.usd)}   do host: ${origin.host.count} · ${usd(origin.host.usd)}`
    : `   plugin (ct-*): ${origin.plugin.count} · ${usd(origin.plugin.usd)}   host: ${origin.host.count} · ${usd(origin.host.usd)}`);
  for (const g of report.byType) {
    const est = g.estimated ? (pt ? ` · estimado sem delegar ${usd(g.estimateUsd)}` : ` · estimated without delegating ${usd(g.estimateUsd)}`) : '';
    lines.push(`- ${g.agentType || '?'} · ${g.model || '?'} · ${g.count}× · ${g.requests} req · ${pt ? 'saída' : 'output'} ${k(g.tokens.output)} · ${usd(g.priced ? g.usdWithResult : null)}${est}`);
  }
  lines.push(pt
    ? 'Custo medido com a tabela de preço de lista, inclui a resposta relida pela principal. A estimativa sem delegar não é medida.'
    : 'Cost measured with list prices, including the answer re-read by the main session. The estimate without delegating is not measured.');
  return lines.join('\n');
}

/** Primeira linha (`session_meta`) de um rollout do Codex. */
function rolloutMeta(path) {
  const raw = safe(() => readFileSync(path, 'utf8').split('\n', 1)[0], '');
  const o = safe(() => JSON.parse(raw), null);
  return o?.type === 'session_meta' ? o.payload : null;
}

/**
 * Relatório de uma sessão do Codex: os rollouts cujo `parent_thread_id` é a sessão. Só tokens — a
 * tabela de preços aqui é da API da Anthropic. Não verificado com um subagente `ct-*` real.
 */
export function codexReport(root, { session = null, env = process.env } = {}) {
  const base = pastaDeSessoesCodex(env);
  const sid = session || env.CONTEXT_TOOLS_SESSION_ID || null;
  if (!base || !sid) return { host: 'codex', status: sid ? 'no-subagents' : 'no-session', session: sid, agents: [] };
  const files = [];
  const walk = (dir, depth) => {
    for (const e of safe(() => readdirSync(dir, { withFileTypes: true }), []) || []) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) files.push(p);
    }
  };
  walk(base, 0);
  const agents = [];
  for (const file of files) {
    const meta = rolloutMeta(file);
    if (!meta || String(meta.parent_thread_id || '') !== String(sid)) continue;
    const m = metricasDaSessao(file);
    const sub = meta.source?.subagent;
    const agentType = typeof sub === 'object' && sub ? (Object.values(sub).map((v) => (typeof v === 'string' ? v : v?.agent_role || v?.agent_nickname || v?.agent_type)).find(Boolean) || null) : null;
    agents.push({
      id: String(meta.id || ''), agentType, description: null,
      model: Object.keys(m?.modelos || {})[0] || null,
      tokens: m?.tokens ? { requests: m.msgs || 0, ...m.tokens } : null,
      usd: null, usdWithResult: null, estimate: null,
    });
  }
  return { host: 'codex', status: agents.length ? 'ok' : 'no-subagents', session: sid, agents };
}

const k = (v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v));
const usd = (v) => (v === null || v === undefined ? '—' : `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`);

export function formatReport(report, lang = 'en') {
  const pt = lang === 'pt';
  if (report.status !== 'ok') {
    return pt
      ? `🧾 delegação: nenhum subagente encontrado${report.session ? ` na sessão ${report.session}` : ''}.`
      : `🧾 delegation: no subagents found${report.session ? ` in session ${report.session}` : ''}.`;
  }
  const lines = [pt ? `🧾 Subagentes da sessão ${report.session} (${report.host})` : `🧾 Subagents of session ${report.session} (${report.host})`];
  if (report.main) lines.push(pt
    ? `   principal: ${report.main.model || '?'} · ${report.main.tokens.requests} req · ${usd(report.main.usd)}`
    : `   main: ${report.main.model || '?'} · ${report.main.tokens.requests} req · ${usd(report.main.usd)}`);
  let real = 0, est = 0, both = 0;
  for (const a of report.agents) {
    const t = a.tokens || {};
    lines.push(`- ${a.agentType || '?'}${a.description ? ` — ${a.description}` : ''}`);
    lines.push(pt
      ? `   ${a.model || '?'} · ${t.requests ?? '?'} req · entrada ${k(t.input || 0)} · cache lido ${k(t.cacheRead || 0)} · cache gravado ${k(t.cacheWrite || 0)} · saída ${k(t.output || 0)}`
      : `   ${a.model || '?'} · ${t.requests ?? '?'} req · input ${k(t.input || 0)} · cache read ${k(t.cacheRead || 0)} · cache write ${k(t.cacheWrite || 0)} · output ${k(t.output || 0)}`);
    if (a.usd !== null) {
      lines.push(pt
        ? `   custo medido: ${usd(a.usd)} (+ resposta relida na principal: ${usd(a.usdWithResult)})`
        : `   measured cost: ${usd(a.usd)} (+ answer re-read by the main session: ${usd(a.usdWithResult)})`);
    }
    if (a.estimate) {
      lines.push(pt
        ? `   ESTIMATIVA no contexto principal: ${usd(a.estimate.usd)} (trabalho ${usd(a.estimate.work)} + ${k(a.estimate.keptTokens)} tokens relidos por ${a.laterMainRequests} req seguintes ${usd(a.estimate.carry)})`
        : `   ESTIMATE in the main context: ${usd(a.estimate.usd)} (work ${usd(a.estimate.work)} + ${k(a.estimate.keptTokens)} tokens re-read by ${a.laterMainRequests} later req ${usd(a.estimate.carry)})`);
      if (a.usdWithResult !== null) { real += a.usdWithResult; est += a.estimate.usd; both++; }
    }
  }
  if (both) {
    lines.push(pt
      ? `Total: medido ${usd(real)} × estimado sem delegar ${usd(est)}${est > 0 ? ` (${Math.round((1 - real / est) * 100)}% a menos)` : ''}. A estimativa supõe o mesmo trabalho com o contexto principal da hora; não é medida.`
      : `Total: measured ${usd(real)} vs estimated without delegating ${usd(est)}${est > 0 ? ` (${Math.round((1 - real / est) * 100)}% less)` : ''}. The estimate assumes the same work over the main context of the time; it is not measured.`);
  }
  if (report.host === 'codex') lines.push(pt ? 'Codex: só tokens (sem tabela de preço para estes modelos).' : 'Codex: tokens only (no price table for these models).');
  return lines.join('\n');
}
