// Leitura do transcript da SESSÃO ATUAL — a única fonte que sabe o que uma sessão está
// custando enquanto ela acontece.
//
// O Claude Code grava cada sessão em `~/.claude/projects/<projeto>/<sessionId>.jsonl`, com o
// `usage` de cada requisição. Foi daí que saiu toda a análise de custo deste plugin; aqui a
// mesma leitura serve em tempo real, para o aviso e para o handoff.
//
// Regra desta lib: nunca lançar. Transcript ausente, formato mudado, permissão negada — tudo
// vira `null` ou zero. Ela alimenta um hook, e hook que quebra derruba a sessão do usuário.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
// `statSync` e `readdirSync` já vinham do topo — `transcriptsRecentes` reusa os dois.
import { homedir } from 'node:os';
import { safe, sanitizeModelText } from './roots.mjs';

/**
 * Pasta de transcripts do projeto. O Claude Code codifica a raiz no nome: `C:\Meus Projetos`
 * vira `C--Meus-Projetos`. Como a regra exata pode mudar entre versões, tenta a codificação
 * conhecida e cai para "a pasta com o transcript mais recente" — que é quase sempre a certa,
 * e é melhor que desistir.
 *
 * `base` é parâmetro só para o teste poder montar um `~/.claude/projects` de mentira. Em
 * produção ninguém passa: um teste que escrevesse na pasta real de transcripts do usuário para
 * exercitar a codificação seria pior que o bug que ele guarda.
 */
export function pastaDeTranscripts(root, base = join(homedir(), '.claude', 'projects')) {
  // Escotilha explícita: aponta DIRETO para a pasta que contém os `<sessionId>.jsonl`, pulando
  // a codificação. Existe pelo mesmo motivo de `CONTEXT_MAPS_ROOT` — sem ela, todo o bloco de
  // custo de sessão era intestável ponta a ponta, e o que não se testa é o que quebra calado
  // (foi assim que o bug do worktree passou despercebido). Serve também a quem tenha o diretório
  // de dados do Claude Code fora do lugar padrão.
  const forcada = process.env.CONTEXT_TOOLS_TRANSCRIPTS;
  if (forcada && existsSync(forcada)) return forcada;
  if (!existsSync(base)) return null;
  // Cada separador vira UM traço, sem colapsar runs, e espaço e PONTO contam como separador:
  // `C:\Meus Projetos` → `C--Meus-Projetos` (o `:` e a `\` viram dois traços seguidos), e
  // `...\.claude\worktrees\x` → `...--claude-worktrees-x` (a `\` e o `.` também).
  //
  // O ponto foi esquecido até 2026-08-04 e o efeito era grande e calado: TODO worktree tem
  // `.claude/worktrees/` no caminho, então dentro de worktree esta função devolvia `null` e o
  // bloco de custo de sessão inteiro — veredito da divisão, aviso do `Stop`, métricas do
  // handoff — ficava morto sem dizer por quê.
  const codificado = String(root).replace(/[\\/:\s.]/g, '-');
  const direto = join(base, codificado);
  if (existsSync(direto)) return direto;
  // A regra de codificação é do Claude Code e pode mudar entre versões. Em vez de desistir,
  // procura a pasta cujo nome mais se pareça — errar aqui só custa o bloco de métricas.
  //
  // A frouxidão aqui é DELIBERADA e mais larga que a regra acima: reduz qualquer caractere não
  // alfanumérico a traço e colapsa runs dos dois lados. É o que faz este fallback cumprir o que
  // promete — na versão anterior ele normalizava só os traços, então uma regra nova (o ponto,
  // exatamente) passava batido pelos dois caminhos e a função desistia.
  const frouxo = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const cand = safe(() => readdirSync(base), []) || [];
  const alvo = frouxo(codificado);
  const achado = cand.find((c) => frouxo(c) === alvo);
  return achado ? join(base, achado) : null;
}

/** Caminho do transcript de uma sessão, ou null. */
export function transcriptDaSessao(root, sessionId) {
  const direto = process.env.CONTEXT_TOOLS_TRANSCRIPT_PATH;
  if (direto && existsSync(direto)) return direto;
  const dir = pastaDeTranscripts(root);
  if (!dir || !sessionId) return null;
  const p = join(dir, `${sessionId}.jsonl`);
  return existsSync(p) ? p : null;
}

const numero = (valor) => Number.isFinite(Number(valor)) ? Number(valor) : 0;

function usoCodexDaLinha(o) {
  const info = o && o.type === 'event_msg' && o.payload && o.payload.type === 'token_count'
    ? o.payload.info
    : null;
  if (!info || typeof info !== 'object') return null;
  return {
    total: info.total_token_usage && typeof info.total_token_usage === 'object'
      ? info.total_token_usage : {},
    ultimo: info.last_token_usage && typeof info.last_token_usage === 'object'
      ? info.last_token_usage : {},
    janela: numero(info.model_context_window) || null,
    limites: o.payload && o.payload.rate_limits ? o.payload.rate_limits : null,
  };
}

function metricasCodex(usos, inicio, fim, turnos, compactacoes) {
  const ultimo = usos[usos.length - 1];
  const atual = ultimo.ultimo;
  const total = ultimo.total;
  const contextos = usos
    .map((u) => numero(u.ultimo.input_tokens) || numero(u.total.input_tokens))
    .filter((n) => n > 0);
  const contexto = contextos.length ? Math.max(...contextos) : 0;
  const janela = ultimo.janela;

  // O Codex registra tanto o delta da última requisição quanto o acumulado da sessão.
  // Guardamos os dois: o primeiro mede pressão na janela; o segundo permite análises futuras
  // de consumo sem precisar reprocessar o transcript.
  return {
    host: 'codex',
    msgs: turnos || usos.length,
    contexto,
    janela,
    percentualContexto: janela ? contexto / janela : null,
    reescritas: 0,
    gravado: numero(total.cache_write_input_tokens),
    msgsAteEdit: null,
    inicio,
    fim,
    horas: inicio && fim ? (fim - inicio) / 3600000 : 0,
    inputTokens: numero(atual.input_tokens),
    cachedInputTokens: numero(atual.cached_input_tokens),
    cacheWriteInputTokens: numero(atual.cache_write_input_tokens),
    outputTokens: numero(atual.output_tokens),
    reasoningOutputTokens: numero(atual.reasoning_output_tokens),
    totalInputTokens: numero(total.input_tokens),
    totalCachedInputTokens: numero(total.cached_input_tokens),
    totalCacheWriteInputTokens: numero(total.cache_write_input_tokens),
    totalOutputTokens: numero(total.output_tokens),
    totalReasoningOutputTokens: numero(total.reasoning_output_tokens),
    totalTokens: numero(total.total_tokens),
    compactacoes,
    rateLimits: ultimo.limites,
  };
}

/** Ferramentas que caracterizam "parou de explorar e começou a produzir". */
const FERRAMENTAS_DE_EDICAO = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * Métricas de custo da sessão, lidas do `usage` de cada requisição.
 *
 * `contexto` é o maior `cache_read` visto: é literalmente quantos tokens são relidos a cada
 * mensagem, e é o que faz o custo por mensagem crescer. `reescritas` conta os eventos em que
 * o prefixo cacheado morreu e foi regravado inteiro — medido em 65 sessões reais: sessão
 * abaixo de 1 h tem ZERO; acima de 12 h, mediana de 5, e cada uma grava 275k-445k tokens.
 *
 * `msgsAteEdit` é o AQUECIMENTO: quantas mensagens até a primeira edição de arquivo. É a régua
 * que decide se dividir a sessão valeu a pena — ver `vereditoDaDivisao`. Fica `null` quando a
 * sessão não editou nada, que é diferente de zero e não pode ser confundido com ele.
 */
export function metricasDaSessao(caminho) {
  if (!caminho) return null;
  const bruto = safe(() => readFileSync(caminho, 'utf8'), null);
  if (!bruto) return null;

  const usosCodex = [];
  let inicioCodex = null, fimCodex = null, turnosCodex = 0, compactacoesCodex = 0;
  let msgs = 0, contexto = 0, reescritas = 0, gravado = 0, anterior = 0;
  let primeiro = null, ultimo = null, msgsAteEdit = null;
  for (const linha of bruto.split('\n')) {
    if (!linha.trim()) continue;
    const o = safe(() => JSON.parse(linha), null);
    if (!o) continue;

    const tipoCodex = String(o.payload && o.payload.type || '').toLowerCase();
    if (tipoCodex === 'task_started') turnosCodex++;
    if (tipoCodex.includes('compact')) compactacoesCodex++;
    const usoCodex = usoCodexDaLinha(o);
    if (usoCodex) usosCodex.push(usoCodex);
    if (o.type === 'session_meta' || usoCodex || tipoCodex === 'task_started') {
      const tCodex = o.timestamp ? Date.parse(o.timestamp) : null;
      if (tCodex) {
        if (inicioCodex === null) inicioCodex = tCodex;
        fimCodex = tCodex;
      }
    }

    // Primeira edição: marca o fim do aquecimento. Lido antes do `usage` porque a mensagem que
    // CONTÉM a edição já conta como aquecida.
    if (msgsAteEdit === null && o.type === 'assistant' && Array.isArray(o.message && o.message.content)) {
      for (const c of o.message.content) {
        if (c && c.type === 'tool_use' && FERRAMENTAS_DE_EDICAO.has(c.name)) { msgsAteEdit = msgs; break; }
      }
    }
    const u = o.message && o.message.usage;
    if (!u) continue;
    msgs++;
    const le = u.cache_read_input_tokens || 0;
    const cria = u.cache_creation_input_tokens || 0;
    gravado += cria;
    // Reescrita: gravou muito E o contexto lido despencou — o prefixo foi perdido.
    if (msgs > 1 && cria > 20000 && anterior > 0 && le < anterior * 0.7) reescritas++;
    anterior = le;
    contexto = Math.max(contexto, le);
    const t = o.timestamp ? Date.parse(o.timestamp) : null;
    if (t) { if (primeiro === null) primeiro = t; ultimo = t; }
  }
  if (usosCodex.length) return metricasCodex(usosCodex, inicioCodex, fimCodex, turnosCodex, compactacoesCodex);
  if (!msgs) return null;
  return {
    host: 'claude',
    msgs,
    contexto,
    reescritas,
    gravado,
    msgsAteEdit,
    inicio: primeiro,
    fim: ultimo,
    horas: primeiro && ultimo ? (ultimo - primeiro) / 3600000 : 0,
  };
}

/** Fatos mecânicos do transcript; não interpreta intenção nem tenta preencher hipóteses. */
export function fatosDaSessao(caminho) {
  if (!caminho) return null;
  const bruto = safe(() => readFileSync(caminho, 'utf8'), null);
  if (!bruto) return null;
  const ferramentas = new Set();
  const edicoes = new Set();
  const falhas = [];
  let comandos = 0;
  let mensagens = 0;
  const registrarConteudo = (content) => {
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const nome = c.name || c.tool_name;
      if (nome) ferramentas.add(sanitizeModelText(nome, 60));
      const entrada = c.input || c.tool_input || {};
      if (nome === 'Bash' || nome === 'bash' || nome === 'shell_command') comandos++;
      const arq = entrada.file_path || entrada.path || entrada.file;
      if (arq && /edit|write|notebook|multi/i.test(String(nome || ''))) edicoes.add(sanitizeModelText(arq, 180));
    }
  };
  for (const linha of bruto.split('\n')) {
    if (!linha.trim()) continue;
    const o = safe(() => JSON.parse(linha), null);
    if (!o) continue;
    if (o.type === 'assistant') {
      mensagens++;
      registrarConteudo(o.message && o.message.content);
    }
    const result = o.tool_result || (o.type === 'tool_result' ? o : null);
    if (result && (result.is_error || result.isError || result.error)) {
      const texto = result.error || result.content || 'tool failure';
      falhas.push(sanitizeModelText(Array.isArray(texto) ? texto.map((x) => x?.text || '').join(' ') : texto, 180));
    }
  }
  return {
    mensagens,
    ferramentas: [...ferramentas].sort().slice(0, 30),
    edicoes: [...edicoes].sort().slice(0, 40),
    comandos,
    falhas: [...new Set(falhas)].slice(0, 12),
  };
}

/**
 * Transcripts do projeto, do mais recente para o mais antigo, exceto o da sessão atual.
 *
 * Ordena por mtime e não por nome: o nome é um UUID, que não ordena por nada. Excluir a sessão
 * corrente é obrigatório — ela está sendo escrita agora e seria sempre a "mais recente",
 * fazendo a ferramenta comparar a sessão consigo mesma.
 */
export function transcriptsRecentes(root, sidAtual, limite = 4) {
  const dir = pastaDeTranscripts(root);
  if (!dir) return [];
  const arquivos = safe(() => readdirSync(dir), []) || [];
  return arquivos
    .filter((f) => f.endsWith('.jsonl') && (!sidAtual || !f.startsWith(sidAtual)))
    .map((f) => ({ sid: f.replace(/\.jsonl$/, ''), caminho: join(dir, f), mtime: safe(() => statSync(join(dir, f)).mtimeMs, 0) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limite);
}

/**
 * O AQUECIMENTO MEDIANO medido em 69 sessões reais deste workspace: 52 mensagens até a primeira
 * edição de arquivo. É a unidade em que o veredito abaixo é expresso — `1,0×` significa "reabrir
 * custou o mesmo que o começo original custou".
 */
export const AQUECIMENTO_MEDIANO_MSGS = 52;

/**
 * PONTO DE EQUILÍBRIO da divisão de sessão, de simulação contrafactual sobre as 69 sessões:
 *
 *   0,7× → ganha 27,0%    1,0× → ganha 19,2%    1,5× → ganha 6,3%
 *   1,75× → EMPATA         2,0× → perde 6,6%     3,0× → perde 32,5%
 *
 * Acima de 1,75× do aquecimento original, dividir custa mais do que economiza.
 */
const CURVA_DIVISAO = [[0.7, 27.0], [1.0, 19.2], [1.5, 6.3], [1.75, 0], [2.0, -6.6], [3.0, -32.5]];

/** Interpola a curva acima. Fora das pontas, não extrapola: devolve a ponta, sem prometer mais. */
export function economiaEstimada(razao) {
  if (razao <= CURVA_DIVISAO[0][0]) return CURVA_DIVISAO[0][1];
  const ult = CURVA_DIVISAO[CURVA_DIVISAO.length - 1];
  if (razao >= ult[0]) return ult[1];
  for (let i = 1; i < CURVA_DIVISAO.length; i++) {
    if (razao <= CURVA_DIVISAO[i][0]) {
      const [x0, y0] = CURVA_DIVISAO[i - 1], [x1, y1] = CURVA_DIVISAO[i];
      return y0 + (y1 - y0) * ((razao - x0) / (x1 - x0));
    }
  }
  return ult[1];
}

/**
 * O par (sessão que fechou cara, sessão que a sucedeu) VALEU A PENA?
 *
 * Este é o único lugar do plugin que fecha o laço: ele avisa para dividir, e até agora ninguém
 * sabia se dividir tinha funcionado. Roda no SessionStart de uma terceira sessão, porque é aí
 * que o par anterior já está COMPLETO — julgar no início da sessão B o aquecimento que B ainda
 * não teve seria inventar.
 *
 * Devolve `null` (silêncio) quando não há o que julgar, e essa é a resposta certa na maioria das
 * vezes: sessão anterior que não era cara não foi "dividida", e reportar veredito sobre uma
 * divisão que não houve seria ruído com cara de medida.
 */
export function vereditoDaDivisao(anterior, sucessora, limiarContexto) {
  if (!anterior || !sucessora) return null;
  if (anterior.contexto < limiarContexto) return null;          // não havia nada para dividir
  if (sucessora.msgsAteEdit === null) return null;              // a sucessora não produziu nada
  if (!anterior.fim || !sucessora.inicio) return null;
  const gapH = (sucessora.inicio - anterior.fim) / 3600000;
  if (gapH > 12) return null;                                   // não é continuação, é outro trabalho
  const razao = sucessora.msgsAteEdit / AQUECIMENTO_MEDIANO_MSGS;
  return {
    razao,
    msgsAteEdit: sucessora.msgsAteEdit,
    contextoAnterior: anterior.contexto,
    economia: economiaEstimada(razao),
    veredito: razao < 1.6 ? 'ganhou' : (razao <= 1.9 ? 'empatou' : 'perdeu'),
  };
}

/**
 * O custo por mensagem cresce com o contexto, e a curva foi MEDIDA em 65 sessões reais
 * (unidades ponderadas: cache_read 0,1× · cache_creation 1,25× · output 5×):
 *
 *   contexto  119k  →  16k por mensagem   (sessões de até 1 h, ZERO reescritas)
 *   contexto  273k  →  32k   (2,0×)
 *   contexto  438k  →  39k   (2,5×)
 *   contexto  494k  →  45k   (2,9×)
 *   contexto  573k  →  54k   (3,4×, mediana de 5 reescritas)
 *
 * Devolve o multiplicador aproximado em relação a uma sessão curta.
 */
export function multiplicadorDeCusto(contexto) {
  const curva = [[119000, 1.0], [273000, 2.0], [438000, 2.5], [494000, 2.9], [573000, 3.4]];
  if (contexto <= curva[0][0]) return 1.0;
  for (let i = 1; i < curva.length; i++) {
    if (contexto <= curva[i][0]) {
      const [x0, y0] = curva[i - 1], [x1, y1] = curva[i];
      return y0 + (y1 - y0) * ((contexto - x0) / (x1 - x0));
    }
  }
  return 3.4 + (contexto - 573000) / 573000;   // extrapola devagar, sem prometer precisão
}
