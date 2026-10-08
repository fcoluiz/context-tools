#!/usr/bin/env node
// Hook PreToolUse: responde ANTES do Grep, quando o padrão procurado é um símbolo.
//
// Por que existe: as outras ferramentas do plugin são PULL — alguém precisa lembrar de
// chamá-las. Este é o único ponto PUSH, e ele existe porque depender de hábito é frágil.
//
// Dimensionado no histórico real deste workspace (68 sessões, 15.612 chamadas de ferramenta):
//   Grep: 1.633 chamadas, e 649 delas (40%) procuram algo com cara de símbolo
//         (`processIncomingMessage`, `resolutionFlowService|AITriageResolutionFlow`).
//   Read de arquivo grande sem offset: 25 de 3.690 (1%) — medido e DESCARTADO como gatilho.
//         Interceptar Read não valia o custo; a medição impediu metade do trabalho errado.
//
// Regras que este hook herda do resto do plugin:
//   M4  — nunca derruba nem atrasa a sessão: qualquer falha vira exit 0 silencioso.
//   Silêncio é o padrão. Ele só fala quando tem resposta CURTA e ÚTIL; sem acerto, ou com
//   acertos demais, cala e deixa o Grep fazer o trabalho dele — que nesses casos é melhor.
//   Nunca bloqueia a ferramenta. O Grep roda de qualquer jeito; isto é contexto a mais,
//   nunca um veto.

// `symbols.mjs` (que puxa `outline.mjs` e o i18n) é carregado por `await import` mais abaixo,
// não no topo. Motivo medido: este hook roda em TODO Grep, e 60% dos padrões não têm cara de
// símbolo — nesses ele desiste em duas linhas. Import estático carregaria os módulos pesados
// mesmo assim, e o processo custava 167 ms contra os 128 ms de um Node vazio. Carregar só
// quando vai usar devolve esses ~39 ms a cada Grep descartado, e num projeto que o índice nem
// consegue ler devolve 100% deles — que é justamente onde o plugin não pode cobrar nada.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveRoot, safe, loadConfig, isMain, statePath } from './lib/roots.mjs';

// Identificador, ou alternância de identificadores. Qualquer metacaractere de regex
// (`\d`, `^`, `.*`, classe) reprova: aí a intenção é busca textual, não "onde X está".
// Mínimo de 4 caracteres porque nome curto casa com meio mundo e a resposta viraria ruído.
const CARA_DE_SIMBOLO = /^[A-Za-z_$][\w$]{3,}(\s*\|\s*[A-Za-z_$][\w$]{3,})*$/;

const MAX_ACERTOS = 6;          // acima disso o Grep responde melhor que o índice
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BLOCO = 1200;
const PACK_BUDGET = 800;
const PACK_ESCALATION_BUDGET = 2000;
const MAX_PACK_BLOCO = 3200;

function stdin() {
  return safe(() => readFileSync(0, 'utf8'), '');
}

/** Já respondemos este padrão nesta sessão? Repetir gasta token sem informar nada. */
function jaRespondido(root, chave) {
  const arq = statePath(root, '.pre-tool-state.json');
  const agora = Date.now();
  const store = safe(() => JSON.parse(readFileSync(arq, 'utf8')), null) || {};
  for (const k of Object.keys(store)) if (agora - store[k] > TTL_MS) delete store[k];
  if (store[chave]) return true;
  store[chave] = agora;
  safe(() => { mkdirSync(dirname(arq), { recursive: true }); writeFileSync(arq, JSON.stringify(store)); }, null);
  return false;
}

function definicoesExatas(indice, padrao) {
  // Alternation remains on the simple path: it is not one unambiguous pack question.
  if (padrao.includes('|')) return [];
  const nome = padrao.replace(/^[A-Za-z_$][\w$]*\./, '').toLowerCase();
  const out = [];
  for (const [name, locs] of indice.defs) {
    if (name.toLowerCase() !== nome) continue;
    for (const loc of locs) out.push(loc);
  }
  return out;
}

function precisaPack(indice, padrao) {
  const locs = definicoesExatas(indice, padrao);
  const arquivos = new Set(locs.map((loc) => loc.file));
  return { locs, usar: locs.length > 2 || arquivos.size > 1 };
}

export async function executarPreTool(entrada) {
  const handlerStarted = process.hrtime.bigint();
  const handlerDurationMs = () => Math.round(Number(process.hrtime.bigint() - handlerStarted) / 1e5) / 10;
  const evento = typeof entrada === 'string'
    ? safe(() => JSON.parse(entrada), null)
    : entrada;
  if (!evento || typeof evento !== 'object') return '';

  const ferramenta = evento.tool_name;
  let padrao = '';
  if (ferramenta === 'Grep') {
    padrao = String(evento.tool_input?.pattern ?? '').trim();
  } else if (ferramenta === 'Bash') {
    // No Codex, rg/grep são comandos dentro da ferramenta Bash, não uma ferramenta separada.
    // O parser é deliberadamente conservador: se não reconhecer com segurança, deixa o
    // comando passar sem contexto adicional.
    const comando = String(evento.tool_input?.command ?? '');
    const m = comando.match(/(?:^|[;&|]\s*)(?:rg|grep)\s+(?:(?:-[A-Za-z0-9-]+)\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/);
    padrao = m ? String(m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
  } else {
    return '';
  }

  if (!padrao || !CARA_DE_SIMBOLO.test(padrao)) return '';

  const root = resolveRoot();
  if (!root) return '';
  const sid = process.env.CONTEXT_TOOLS_SESSION_ID
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || 'sem-sessao';
  if (jaRespondido(root, `${sid}|${padrao.toLowerCase()}`)) return '';

  // Só a partir daqui vale carregar o índice e o i18n.
  const { buildIndex, reportOne } = await import('./symbols.mjs');
  const { makeT, detectLang } = await import('./lib/i18n.mjs');
  const { recordMetric } = await import('./lib/telemetry.mjs');
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  const t0 = Date.now();
  const indice = buildIndex(root, cfg);
  const linhas = reportOne(padrao, indice, { wantAll: false, ms: Date.now() - t0, t });
  if (!linhas || !linhas.length) {
    recordMetric(root, 'pretool', { host: ferramenta, outcome: 'miss', patternLength: padrao.length, durationMs: handlerDurationMs() });
    return '';
  }

  // Sem acerto, `reportOne` devolve o texto de "não achei" — que aqui não serve: o Grep
  // ia rodar de qualquer jeito e é exatamente a ferramenta certa para o caso.
  const acertos = linhas.filter((l) => /^\s{2}\S/.test(l)).length;
  const busca = ferramenta === 'Bash' ? 'Bash search' : 'Grep';
  const rota = precisaPack(indice, padrao);

  if (rota.usar) {
    try {
      const { buildContextPack } = await import('./context-pack.mjs');
      const { formatEvidence } = await import('./lib/evidence.mjs');
      let budget = PACK_BUDGET;
      let pack = buildContextPack(root, padrao, { budget, history: false, index: indice });
      const temDefinicao = pack.items.some((item) => item.kind === 'definition' && item.confidence === 'exact');
      if (!temDefinicao) {
        budget = PACK_ESCALATION_BUDGET;
        pack = buildContextPack(root, padrao, { budget, history: false, index: indice });
      }
      if (pack.items.length) {
        const corpoPack = [
          t('pre.pack', { busca, budget }),
          ...pack.items.map(formatEvidence),
          ...pack.limitations.map((note) => `! ${note}`),
        ].join('\n').slice(0, MAX_PACK_BLOCO);
        recordMetric(root, 'pretool', {
          host: ferramenta,
          outcome: 'pack',
          patternLength: padrao.length,
          hits: rota.locs.length,
          budget,
          items: pack.items.length,
          durationMs: handlerDurationMs(),
        });
        return JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: corpoPack,
          },
        });
      }
    } catch {
      // M4: se o enriquecimento falhar, cai para o comportamento curto ou silencioso.
    }
  }

  if (!acertos || acertos > MAX_ACERTOS) {
    recordMetric(root, 'pretool', { host: ferramenta, outcome: acertos > MAX_ACERTOS ? 'ambiguous' : 'miss', patternLength: padrao.length, durationMs: handlerDurationMs() });
    return '';
  }

  const corpo = linhas.join('\n').slice(0, MAX_BLOCO);
  recordMetric(root, 'pretool', { host: ferramenta, outcome: 'hit', patternLength: padrao.length, hits: acertos, durationMs: handlerDurationMs() });
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `${t('pre.cabecalho', { busca })}\n${corpo}`,
    },
  });
}

async function main() {
  const saida = await executarPreTool(stdin());
  if (saida) process.stdout.write(saida);
}

if (isMain(import.meta.url)) {
  // `main` virou async por causa do import tardio: sem o `.catch`, uma rejeição escaparia
  // do try e derrubaria o processo com exit != 0 — exatamente o que M4 proíbe.
  try { main().catch(() => {}); } catch { /* M4: silêncio, sempre exit 0 */ }
}

export { CARA_DE_SIMBOLO };
