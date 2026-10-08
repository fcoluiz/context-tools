#!/usr/bin/env node
// 🔀 Handoff de sessão — o que a próxima sessão precisa saber para não recomeçar do zero.
//
// POR QUE ISTO EXISTE, medido em 65 sessões reais deste workspace:
//   O custo por mensagem cresce 3,4× com o tamanho do contexto (16k numa sessão de até 1 h,
//   54k numa de 12 h+), porque cada mensagem RELÊ o contexto inteiro. E o prefixo cacheado
//   morre e é regravado: zero vezes abaixo de 1 h, mediana de 5 acima de 12 h, a 275k-445k
//   tokens por vez. As 33 sessões de 6 h+ consumiram 83% de todo o custo medido.
//
//   Fechar a sessão e abrir outra economizaria até 58% — mas só se o começo seguinte não
//   refizer a exploração toda. O ponto de equilíbrio é generoso (dá para gastar 3,4× mais
//   mensagens em blocos curtos e ainda empatar), e é esse espaço que este comando compra.
//
// O QUE ELE FAZ e o que NÃO faz:
//   Monta o que é MECÂNICO — arquivos tocados na sessão, mapas de contexto que cobrem essa
//   área, e acoplamentos históricos que ficaram sem tocar. Isso é o que dá para derivar.
//   O que ele NÃO inventa é o estado VOLÁTIL: o que foi tentado, o que falhou e por quê, qual
//   hipótese está de pé. Isso não está em lugar nenhum além da cabeça de quem trabalhou, e
//   preencher com palpite seria pior que deixar em branco — vira handoff que mente.
//
// Uso:
//   handoff.mjs                → imprime o handoff
//   handoff.mjs --salvar       → grava em .claude/handoff-<data>.md
//   handoff.mjs --root=<dir>

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoot, findRepos, safe, loadConfig, isMain, relPath, stateDir, statePath, stateRelPrefix, runtimeHost } from './lib/roots.mjs';
import { buildIndex } from './symbols.mjs';
import {
  transcriptDaSessao, metricasDaSessao, multiplicadorDeCusto,
  transcriptsRecentes, vereditoDaDivisao, fatosDaSessao,
} from './lib/sessao.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { recordMetric } from './lib/telemetry.mjs';
import { fingerprintSourcesInRoot, parseSourceFingerprints } from './lib/source-fingerprints.mjs';

const git = (repo, args) => safe(() => execFileSync('git', args, {
  cwd: repo, encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'],
}), '');

/** Entrada gravada no SessionStart para (sessão, repo): HEAD e a sujeira que já existia. */
function entradaDaSessao(root, sid, repoPath) {
  const arq = statePath(root, '.context-maps-session-baseline.json');
  const store = safe(() => JSON.parse(readFileSync(arq, 'utf8')), null);
  return (store && sid && store[sid] && store[sid][repoPath]) || null;
}

/** HEAD gravado no SessionStart, para saber o que ESTA sessão mexeu. */
function baselineDaSessao(root, sid, repoPath) {
  const e = entradaDaSessao(root, sid, repoPath);
  return e && e.head ? e.head : null;
}

/**
 * Tira da lista o que já estava sujo quando a sessão abriu E não foi tocado desde então.
 *
 * `git diff <baseline>` compara commit contra working tree, então arruma sujeira antiga junto:
 * medido em 2026-08-04, dois arquivos modificados 20 h ANTES da sessão foram anunciados como
 * "tocados nesta sessão", e continuariam aparecendo em todo handoff até alguém commitar.
 *
 * O critério é o `mtime` gravado no SessionStart (ver `sujosNoInicio`): igual ⇒ ninguém escreveu,
 * é sujeira herdada, sai. Diferente ou ausente ⇒ fica. Erra deliberadamente para o lado de
 * MOSTRAR: handoff que esconde trabalho feito é pior que handoff com uma linha a mais, e sem
 * registro de sujeira (versão antiga do hook, sessão sem id) o comportamento é o de antes.
 */
function semSujeiraHerdada(arquivos, repoPath, entrada) {
  const sujos = entrada && entrada.sujos;
  if (!sujos || typeof sujos !== 'object') return arquivos;
  return arquivos.filter((rel) => {
    if (!(rel in sujos)) return true;
    const st = safe(() => statSync(join(repoPath, rel)), null);
    if (!st) return true;                       // sumiu/foi renomeado desde então: mudou, fica
    return st.mtimeMs !== sujos[rel];
  });
}

/**
 * Estado interno do próprio plugin. Cache de símbolos, baseline de sessão e travas mudam a
 * toda chamada — reportá-los como "trabalho desta sessão" seria a ferramenta se confundindo
 * com o trabalho. Os MAPAS (`.claude/context/*.md`) ficam de fora do filtro de propósito:
 * esses são conteúdo de verdade, e mexer neles é trabalho real.
 */
const ESTADO_DO_PLUGIN = /^\.claude\/(?!context\/)|\.symbols-cache\.json$|\.context-maps-|\.pre-tool-state|\.stop-|\.mtime-probe|\.context-tools-metrics/;

function sessionId() {
  return process.env.CONTEXT_TOOLS_SESSION_ID
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || null;
}

function isPluginState(root, rel) {
  if (ESTADO_DO_PLUGIN.test(rel)) return true;
  const prefix = stateRelPrefix(root);
  // No Claude, `.claude/context/` é conteúdo real e a regex acima preserva-o. O prefixo
  // inteiro só é seguro para o estado Codex (`.codex/context-tools/`) ou para um diretório de
  // estado explicitamente configurado; aplicar `.claude/` inteiro apagaria mapas do handoff.
  if (prefix && (runtimeHost() === 'codex' || process.env.CONTEXT_TOOLS_STATE_DIR)
    && rel.startsWith(prefix)) return true;
  return rel.startsWith('.codex/scripts/');
}

/**
 * SÍMBOLOS tocados, não só arquivos — e é aqui que o índice paga o próprio custo.
 *
 * "Você mexeu em `triageService.js`" quase não informa: são 14.249 linhas. "Você mexeu em
 * `registerFeedback` e `_routeUnreadableMedia`" diz onde retomar. Cruza os intervalos de linha
 * do `git diff -U0` com os intervalos que o índice já guarda para cada símbolo (`line`..`end`).
 *
 * Usa o cache: em projeto acima do limiar, `buildIndex` custa ~130 ms com cache quente contra
 * 1,7 s reconstruindo. Como isto roda no `Stop`, sem cache não valeria a pena.
 */
/**
 * Acima disto o nome do símbolo para de informar mais que o nome do arquivo — e o handoff já
 * imprime o arquivo na linha de cima. Não é detector de artefato: é teto de UTILIDADE.
 *
 * Medido nos 224 símbolos deste repo: mediana **11** linhas, p75 24, p90 59, p95 106, p99 287.
 * O maior símbolo REAL é `symbolsForCode`, com 127. Acima de 200 sobram 5 (2,2%) e os cinco são
 * o mesmo artefato: `comIntervalos` fecha um símbolo na linha anterior ao próximo de mesma
 * profundidade, então um helper de topo seguido de 30 chamadas `test(…)` — que não viram
 * símbolo — engole as 400 linhas de todas elas. Foi exatamente o que fez o handoff desta sessão
 * anunciar `function rodar` e `function preTool` como tocados, quando o que mudou foram testes
 * no meio delas.
 *
 * O teto trata o SINTOMA no lugar onde ele mente. A causa (a absorção em `comIntervalos`) segue
 * de pé e é intencional lá — para o `outline`, ler a mais é o erro barato.
 */
const MAX_SPAN_ATRIBUIVEL = 200;

function simbolosTocados(repoPath, ref, arquivos, indice) {
  if (!indice) return new Map();
  // Índice por arquivo → lista de {nome, ini, fim}, para não varrer `defs` por arquivo.
  const porArquivo = new Map();
  for (const [nome, locs] of indice.defs) {
    for (const l of locs) {
      const f = String(l.file).replace(/\\/g, '/');
      if (!porArquivo.has(f)) porArquivo.set(f, []);
      porArquivo.get(f).push({ nome, ini: l.line, fim: l.end || l.line, kind: l.kind });
    }
  }
  const out = new Map();
  for (const arq of arquivos) {
    // `-U0`: só as linhas que mudaram, sem contexto — senão o intervalo incha e pega vizinho.
    const patch = git(repoPath, ['-C', repoPath, 'diff', '-U0', ref, '--', arq]);
    if (!patch) continue;
    const faixas = [];
    for (const m of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const ini = parseInt(m[1], 10);
      // `@@ +2 @@` (sem contagem) é UMA linha: [2,2], não [2,3]. Errar aqui por um faz o
      // intervalo encostar no símbolo seguinte e o handoff acusa quem não foi tocado —
      // exatamente o tipo de falso positivo que manda a próxima sessão para o lugar errado.
      // Contagem 0 é remoção pura: a posição ainda importa, então vira [ini, ini].
      const n = m[2] === undefined ? 1 : parseInt(m[2], 10);
      faixas.push([ini, ini + Math.max(0, n - 1)]);
    }
    if (!faixas.length) continue;
    // O `file` do índice pode vir prefixado pelo nome do repo (workspace multi-repo).
    const cands = porArquivo.get(arq) || porArquivo.get([...porArquivo.keys()].find((k) => k.endsWith('/' + arq)) || '') || [];
    const nomes = new Set();
    for (const [a, b] of faixas) {
      // Só símbolos de tamanho ÚTIL, e entre os que sobram o MENOR — que é o mais interno e
      // portanto o mais específico (numa classe, o método vence a classe).
      const cobrem = cands.filter((s) => s.ini <= b && s.fim >= a && s.fim - s.ini + 1 <= MAX_SPAN_ATRIBUIVEL);
      if (!cobrem.length) continue;
      let melhor = cobrem[0];
      for (const s of cobrem) if (s.fim - s.ini < melhor.fim - melhor.ini) melhor = s;
      nomes.add(melhor.kind || melhor.nome);
    }
    if (nomes.size) out.set(arq, [...nomes].slice(0, 12));
  }
  return out;
}

/** Arquivos tocados desde o baseline: commitados na sessão + ainda sujos + não rastreados. */
function tocados(root, sid, repo) {
  const entrada = entradaDaSessao(root, sid, repo.path);
  const ref = (entrada && entrada.head) || 'HEAD';
  const diff = git(repo.path, ['-C', repo.path, 'diff', '--name-only', ref]);
  const novos = git(repo.path, ['-C', repo.path, 'ls-files', '--others', '--exclude-standard']);
  const brutos = [...new Set((diff + '\n' + novos).split('\n').map((s) => s.trim()).filter(Boolean))]
    .filter((f) => !isPluginState(root, f));
  return semSujeiraHerdada(brutos, repo.path, entrada);
}

/**
 * Mapas de contexto que cobrem os arquivos tocados — e se cada um está DEFASADO.
 *
 * Com `source_digest`, compara o fingerprint atual de todos os arquivos em `covers` com o
 * digest revisado, incluindo alterações ainda sem commit. Mapas legados sem esse campo usam
 * `verified_at` como referência Git. O handoff sinaliza a diferença para a próxima sessão
 * conferir o mapa antes de confiar nele.
 */
function mapasRelevantes(repoPath, arquivos) {
  const dir = join(repoPath, '.claude', 'context');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of safe(() => readdirSync(dir), []) || []) {
    if (!f.endsWith('.md')) continue;
    const txt = safe(() => readFileSync(join(dir, f), 'utf8'), '');
    const frontmatter = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
    const cobre = [];
    let inCovers = false;
    for (const raw of frontmatter.split(/\r?\n/)) {
      const line = raw.trim();
      if (/^covers\s*:/i.test(line)) { inCovers = true; continue; }
      if (inCovers && /^-\s+/.test(line)) {
        cobre.push(line.slice(2).trim().replace(/^['"]|['"]$/g, ''));
        continue;
      }
      if (inCovers && line) inCovers = false;
    }
    const casa = cobre.filter((c) => arquivos.some((a) => a === c || a.startsWith(c.replace(/\*$/, ''))));
    if (!casa.length) continue;
    const ver = (txt.match(/^verified_at:\s*(\S+)/m) || [])[1];
    const sourceDigest = (frontmatter.match(/^source_digest:\s*(\S+)/m) || [])[1];
    const sourceFingerprintsValue = (frontmatter.match(/^source_fingerprints:\s*(.+)$/m) || [])[1];
    const sourceFingerprints = parseSourceFingerprints(sourceFingerprintsValue);
    let defasado = false;
    if (sourceDigest) {
      const current = fingerprintSourcesInRoot(repoPath, cobre);
      if (sourceDigest !== current.digest) {
        if (sourceFingerprints.present && sourceFingerprints.valid) {
          defasado = casa.some((file) => sourceFingerprints.sources[file.replace(/\\/g, '/')] !== current.sources[file.replace(/\\/g, '/')]);
        } else defasado = true;
      }
    } else if (ver && /^[0-9a-fA-F]{7,40}$|^HEAD$/.test(ver)) {
      const mudou = git(repoPath, ['-C', repoPath, 'diff', '--name-only', ver, '--', ...casa]);
      defasado = Boolean(mudou && mudou.trim());
    }
    out.push({ nome: f.replace(/\.md$/, ''), defasado });
  }
  return out;
}

/**
 * Modo hook (`--stop-report`): avisa quando a sessão fica cara, e cala no resto do tempo.
 *
 * Limiar em 200k de contexto porque foi ali que o custo por mensagem JÁ DOBROU na curva
 * medida (119k → 16k/msg; 273k → 32k/msg). Avisar antes seria ruído; muito depois, tarde.
 *
 * Uma vez só por sessão: quem decidiu seguir já decidiu, e repetir não traz informação nova.
 * Insistir só ensina a ignorar a categoria inteira.
 */
const LIMIAR_CONTEXTO = 200000;
// No Codex, tempo Ã© apenas um sinal operacional para sugerir uma nova sessÃ£o. NÃ£o Ã© um
// multiplicador de cobranÃ§a: a mÃ©trica de crÃ©ditos depende dos tokens e do modelo ativo.

/** Onde o handoff desta sessão mora. Um por sessão, para não colidir entre janelas abertas. */
function caminhoDoHandoff(root, sid) {
  return statePath(root, `handoff-${String(sid || 'sem-sessao').slice(0, 8)}.md`);
}

/**
 * Modo hook (`--stop-report`): avisa UMA VEZ por sessão e já deixa o handoff pronto em disco.
 *
 * Limiar em 200k de contexto porque foi ali que o custo por mensagem JÁ DOBROU na curva
 * medida (119k → 16k/msg; 273k → 32k/msg). Avisar antes seria ruído; muito depois, tarde.
 *
 * Uma vez só, de propósito. Chegou a reavisar a cada +250k, e está errado: quem decidiu seguir
 * na mesma sessão já decidiu, e repetir o mesmo aviso não traz informação nova — só ensina a
 * ignorar a categoria inteira, que é o mesmo raciocínio que faz o aviso de "sem mapa" calar.
 *
 * O handoff é GERADO junto, uma vez. Assim, quando o usuário decidir fechar, ele já está lá:
 * gerar depois custaria uma volta inteira. Se o trabalho continuar e ele quiser um atualizado,
 * `--salvar` regrava sob demanda — nunca automaticamente, senão o arquivo mudaria sozinho
 * embaixo de quem já o estava lendo.
 */
/**
 * O bloco volátil já foi preenchido, ou continua o formulário em branco?
 *
 * Estrutural, como todo o resto que lê este documento: as perguntas saem de `montar` como
 * `- **pergunta** ` e o que vier depois do `**` é a resposta. Nada de reconhecer texto
 * traduzido — o documento pode ter sido gravado em outro idioma ou por outra versão.
 */
/**
 * Onde começa o bloco volátil: o ÚLTIMO cabeçalho `##` do documento, por construção de `montar`.
 * Estrutural de propósito — o arquivo pode ter sido gravado em outro idioma ou por outra versão.
 */
function inicioDoVolatil(linhas) {
  for (let i = linhas.length - 1; i >= 0; i--) if (linhas[i].startsWith('## ')) return i;
  return -1;
}

/**
 * O documento FRESCO, com o bloco volátil do documento SALVO enxertado no lugar.
 *
 * Sem `salvo`, ou com o bloco dele ainda em branco, devolve o fresco intacto: não há nada a
 * preservar, e enxertar um formulário vazio por cima de outro só perderia tempo.
 */
function comVolatilDe(fresco, salvo) {
  if (!salvo || !blocoVolatilPreenchido(salvo)) return fresco;
  const lf = fresco.split('\n');
  const ls = salvo.split('\n');
  const iF = inicioDoVolatil(lf);
  const iS = inicioDoVolatil(ls);
  if (iF < 0 || iS < 0) return fresco;          // formato inesperado: não inventa, usa o fresco
  return [...lf.slice(0, iF), ...ls.slice(iS)].join('\n');
}

function blocoVolatilPreenchido(doc) {
  if (!doc) return false;
  return doc.split('\n').some((l) => {
    const m = l.match(/^-\s+\*\*.+?\*\*(.*)$/);
    return Boolean(m && m[1].trim());
  });
}

function stopReport(root, t) {
  const sid = sessionId();
  const m = metricasDaSessao(transcriptDaSessao(root, sid));
  const codex = runtimeHost() === 'codex';
  // Codex mantém as métricas no handoff, mas não recebe aviso operacional de contexto/tempo:
  // a política de janela e custo depende do modelo ativo e não compensa uma regra fixa.
  if (codex) return;
  const elegivel = m && m.contexto >= LIMIAR_CONTEXTO;
  if (!elegivel) return;

  const arq = statePath(root, '.handoff-aviso.json');
  const store = safe(() => JSON.parse(readFileSync(arq, 'utf8')), null) || {};
  // Versões até 1.3.1 gravavam um timestamp solto aqui. Ler os dois formatos evita que uma
  // atualização do plugin faça o aviso disparar de novo numa sessão que já foi avisada.
  const bruto = store[sid];
  const estado = typeof bruto === 'number' ? { aviso: bruto } : (bruto || null);

  const salvar = (novo) => {
    store[sid] = novo;
    safe(() => { mkdirSync(stateDir(root), { recursive: true }); writeFileSync(arq, JSON.stringify(store)); }, null);
  };
  const emitir = (texto) => process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: texto },
  }));

  const destino = caminhoDoHandoff(root, sid);

  // ---- FASE 2: o prompt, quando ele finalmente vale alguma coisa ------------------------
  //
  // O prompt NÃO pode sair junto do aviso, e isso não é economia: na hora do aviso o bloco
  // volátil acabou de ser gerado em branco, e o bloco volátil é a única parte que faz o prompt
  // valer a pena colar. Entregá-lo ali seria entregar exatamente a versão inútil — a mesma que
  // já existiu em disco e não ajudou ninguém.
  //
  // Então espera-se o agente preencher. O `Stop` dispara a cada turno, então o turno seguinte
  // ao preenchimento é o momento certo: o dado existe, e ninguém precisou lembrar de nada.
  // Mesma doutrina do veredito de divisão, que julga o par anterior porque é o único completo.
  if (estado) {
    if (estado.prompt) return;                               // já entregue: silêncio
    const doc = safe(() => readFileSync(destino, 'utf8'), null);
    // Ainda em branco: cala. Insistir a cada turno ensinaria a ignorar a categoria inteira,
    // que é a mesma assimetria que faz o aviso de "sem mapa" ser generoso ao calar.
    if (!blocoVolatilPreenchido(doc)) return;
    const prompt = safe(() => montarPrompt(root, sid, t), null);
    if (!prompt) return;
    // Também vai para disco: entregar só pelo contexto faria o prompt depender de alguém
    // repassá-lo. O nome cai no `handoff-*.md` que o `.gitignore` já cobre.
    const pArq = destino.replace(/\.md$/, '.prompt.md');
    const salvo = safe(() => { writeFileSync(pArq, prompt); return true; }, false);
    salvar({ ...estado, prompt: Date.now() });
    emitir(`${t('ses.promptPronto', { arq: salvo ? relPath(root, pArq) : null })}\n\n${prompt}`);
    return;
  }

  // ---- FASE 1: o aviso, uma vez por sessão ---------------------------------------------
  //
  // `mkdirSync` ANTES de gravar, e a ordem é load-bearing: em projeto que ainda não tem
  // `.claude/`, o `writeFileSync` falha, o `safe` engole e o handoff nunca é escrito — morto em
  // silêncio, exatamente nos projetos que acabaram de instalar o plugin. Este bug já existiu
  // uma vez no baseline de sessão; foi reintroduzido aqui ao separar as fases e pego pelo teste.
  const gerado = safe(() => {
    mkdirSync(stateDir(root), { recursive: true });
    writeFileSync(destino, montar(root, sid, t));
    return true;
  }, false);
  salvar({ aviso: Date.now() });

  const linhas = [t('ses.aviso', {
    ctx: Math.round(m.contexto / 1000),
    msgs: m.msgs,
    horas: m.horas.toFixed(1),
    mult: multiplicadorDeCusto(m.contexto).toFixed(1),
    re: m.reescritas,
    arq: gerado ? relPath(root, destino) : null,
    cmd: 'node .claude/scripts/handoff.mjs --salvar',
  })];
  // O pedido de preencher vai junto do aviso, e é dirigido ao AGENTE. Medido: o bloco volátil
  // é o que mantém o recomeço abaixo do ponto de equilíbrio de 1,75x, e o único handoff
  // auto-gerado que existiu em disco estava com ele em branco. Depender de alguém lembrar era
  // apostar o ganho inteiro na memória de quem volta.
  if (gerado) linhas.push(t('ses.preencha', { arq: relPath(root, destino) }));

  emitir(linhas.join('\n'));
}

/**
 * Como o usuário invoca este script — DERIVADO de onde ele realmente está, não adivinhado.
 *
 * Conhecia só dois mundos (plugin e cópia em `.claude/scripts/`) e caía no segundo por padrão.
 * Existe um terceiro: um repositório que aponta os hooks para o `scripts/` da própria fonte —
 * é o caso deste repo desde 2026-08-04. Ali o aviso mandava rodar `.claude/scripts/handoff.mjs`,
 * caminho que não existe. **Numa ferramenta cuja tese é "falha visível", errar na própria
 * instrução é o pior lugar possível**, e adivinhar entre N casos sempre volta a errar quando
 * aparece o N+1. `import.meta.url` sabe a resposta sem chutar.
 *
 * `eu` é parâmetro para o teste conseguir simular os três layouts sem copiar o script.
 */
function comandoDoPlugin(root, eu = safe(() => fileURLToPath(import.meta.url), null)) {
  // Rodando como plugin, a variável é a forma portátil: o caminho real fica dentro da
  // instalação do plugin e não diz nada a quem lê.
  if (process.env.PLUGIN_ROOT) return '"$PLUGIN_ROOT/scripts/handoff.mjs"';
  if (process.env.CLAUDE_PLUGIN_ROOT) return '"$CLAUDE_PLUGIN_ROOT/scripts/handoff.mjs"';
  if (!eu) return '.claude/scripts/handoff.mjs';
  const rel = relative(root, eu).replace(/\\/g, '/');
  // Fora da raiz (`..`) não há caminho relativo útil — melhor o absoluto que uma mentira curta.
  return rel && !rel.startsWith('..') ? rel : `"${eu.replace(/\\/g, '/')}"`;
}

/**
 * SessionStart: o laço que faltava — dizer se a ÚLTIMA divisão de sessão compensou.
 *
 * O plugin manda dividir desde que existe, e até agora ninguém sabia se dividir funcionou. Isto
 * julga o par (sessão que fechou cara → sessão que a sucedeu), que só está completo agora: no
 * início da sucessora, o aquecimento dela ainda não tinha acontecido, e julgar o que não
 * aconteceu seria inventar.
 *
 * Uma vez por sessão, informativo, sem LLM e sem rede. Cala quando não há divisão para julgar,
 * que é o caso mais comum — veredito sobre divisão que não houve seria ruído com cara de medida.
 */
function relatorioDeDivisao(root, t) {
  // O veredito de divisÃ£o usa a curva medida do Claude. No Codex, o modo operacional Ã© um
  // lembrete por tempo; nÃ£o devemos publicar uma conclusÃ£o de custo que nÃ£o foi medida nele.
  if (runtimeHost() === 'codex') return;
  const sid = sessionId();
  const recentes = transcriptsRecentes(root, sid, 2);
  if (recentes.length < 2) return;
  // [0] é a mais recente (a sucessora), [1] a que veio antes dela (a que fechou cara).
  const sucessora = metricasDaSessao(recentes[0].caminho);
  const anterior = metricasDaSessao(recentes[1].caminho);
  const v = vereditoDaDivisao(anterior, sucessora, LIMIAR_CONTEXTO);
  if (!v) return;

  const chave = { ganhou: 'ses.verGanhou', empatou: 'ses.verEmpatou', perdeu: 'ses.verPerdeu' }[v.veredito];
  const texto = [
    t(chave, {
      ctx: Math.round(v.contextoAnterior / 1000),
      msgs: v.msgsAteEdit,
      razao: v.razao.toFixed(1),
      eco: Math.abs(v.economia).toFixed(0),
    }),
    t('ses.verFonte'),
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: texto },
  }));
}

/**
 * O handoff como PROMPT para colar, não como arquivo para ler.
 *
 * O arquivo serve a quem abre o repositório; o prompt serve a quem abre uma sessão nova, que é
 * o momento em que o handoff vale alguma coisa. Sem isto, "copiar e colar" significava o usuário
 * abrir o arquivo, selecionar o pedaço certo e montar o enquadramento à mão — atrito bastante
 * para o hábito não pegar, e o hábito é a variável de que os 19-27% dependem.
 */
function montarPrompt(root, sid, t) {
  // PREFERE O ARQUIVO SALVO. Regenerar aqui apagaria o bloco volátil que alguém acabou de
  // preencher — e o bloco volátil é a única parte que faz o prompt valer alguma coisa.
  // Regenerar só quando não há arquivo, que é o caso de quem pede o prompt sem ter salvado.
  // MESCLA, não escolhe. O bloco volátil vem do arquivo salvo — regenerá-lo apagaria o que
  // alguém acabou de escrever, e ele é a única parte que faz o prompt valer. O bloco MECÂNICO
  // vem fresco do git, sempre: ele é derivável, e congelá-lo junto foi um erro de desenho
  // pego em produção no mesmo dia. Numa sessão longa, o handoff preenchido cedo entregava no
  // fim uma lista de arquivos velha, com símbolos de antes de uma correção de rótulo e um
  // "próximo passo" que já tinha sido feito três vezes.
  //
  // Preservar o que ninguém consegue derivar e regenerar o que se deriva sozinho é a mesma
  // divisão que o resto deste arquivo já faz — ela só não estava sendo aplicada aqui.
  const salvo = safe(() => readFileSync(caminhoDoHandoff(root, sid), 'utf8'), null);
  const doc = comVolatilDe(montar(root, sid, t), salvo);
  // Tira o cabeçalho e o bloco de métricas: quem cola quer o ESTADO, não o custo da sessão que
  // já acabou. O que sobra é o que a sessão nova precisa para não recomeçar do zero.
  //
  // O bloco volátil também é RE-ROTULADO aqui. No arquivo ele se chama "preencha antes de
  // fechar" e vem com o aviso de que está em branco de propósito — as duas coisas certas para
  // quem vai preencher, e as duas ERRADAS num prompt onde ele já está preenchido: o documento
  // mandava fazer o que ele mesmo já mostrava feito, na cara de quem acabou de colá-lo.
  //
  // TUDO aqui é ESTRUTURAL — nenhuma comparação de texto traduzido sobrou nesta função.
  //
  // O documento tem uma forma fixa, garantida por `montar`: título `#`, bloco de métricas, e
  // daí em diante só seções `##`, sendo o bloco volátil a última. Então "cabeçalho" é
  // exatamente "o que vem antes do primeiro `##`", e o bloco volátil é "o último `##`".
  //
  // Isto já era regex de texto traduzido (`^Esta sessão:|^This session:`) e o modo de falha era
  // silencioso e chato de achar: idioma novo no i18n, ou handoff gerado por outra versão, e o
  // bloco de métricas vazava para o prompt sem ninguém perceber. A primeira tentativa de
  // consertar o re-rótulo do bloco volátil comparando string traduzida FALHOU no teste, com um
  // documento em português lido com config em inglês — a mesma armadilha, um nível acima.
  const linhas = doc.split('\n');
  const iVol = inicioDoVolatil(linhas);
  if (iVol >= 0) {
    linhas[iVol] = `## ${t('ho.volatilPrompt')}`;
    // Só apaga se ali houver mesmo prosa: num documento sem o aviso, a linha seguinte já é uma
    // das perguntas (`- **…**`) ou está vazia, e engoli-la perderia conteúdo real.
    const seguinte = linhas[iVol + 1];
    if (seguinte && seguinte.trim() && !seguinte.startsWith('-')) linhas[iVol + 1] = '';
  }
  // O cabeçalho é tudo que vem antes da primeira seção. Sem `##` no documento (formato futuro,
  // arquivo truncado), preserva tudo: cortar às cegas perderia conteúdo, e a regra deste
  // projeto é errar para o lado de MOSTRAR.
  const iPrimeiraSecao = linhas.findIndex((l) => l.startsWith('## '));
  const corpo = (iPrimeiraSecao >= 0 ? linhas.slice(iPrimeiraSecao) : linhas).join('\n').trim();
  return [t('ho.promptCabecalho'), '', corpo, '', t('ho.promptRodape')].join('\n');
}

/**
 * Monta o handoff. Separado do `main` porque o hook de `Stop` também o gera — e gerar duas
 * versões diferentes do mesmo documento seria pior que não ter nenhuma.
 */
function montar(root, sid, t) {
  const linhas = [];
  linhas.push(`# ${t('ho.titulo')} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);

  const m = metricasDaSessao(transcriptDaSessao(root, sid));
  if (m) {
    linhas.push('');
    linhas.push(t(m.host === 'codex' ? 'ho.porqueCodex' : 'ho.porque', {
      msgs: m.msgs,
      ctx: Math.round(m.contexto / 1000),
      horas: m.horas.toFixed(1),
      mult: multiplicadorDeCusto(m.contexto).toFixed(1),
      re: m.reescritas,
      janela: m.janela ? Math.round(m.janela / 1000) : null,
      percentual: m.percentualContexto == null ? null : (m.percentualContexto * 100).toFixed(0),
      input: m.totalInputTokens,
      cached: m.totalCachedInputTokens,
      output: m.totalOutputTokens,
      compactacoes: m.compactacoes,
      rate: m.rateLimits && m.rateLimits.primary ? m.rateLimits.primary.used_percent : null,
    }));
  }

  const fatos = fatosDaSessao(transcriptDaSessao(root, sid));
  if (fatos && (fatos.ferramentas.length || fatos.edicoes.length || fatos.comandos || fatos.falhas.length)) {
    linhas.push('');
    linhas.push(`## ${t('ho.fatos')}`);
    linhas.push(t('ho.fatosAviso'));
    if (fatos.ferramentas.length) linhas.push(t('ho.ferramentas', { lista: fatos.ferramentas.join(', ') }));
    if (fatos.edicoes.length) linhas.push(t('ho.edicoes', { lista: fatos.edicoes.join(', ') }));
    if (fatos.comandos) linhas.push(t('ho.comandos', { n: fatos.comandos }));
    if (fatos.falhas.length) linhas.push(t('ho.falhas', { lista: fatos.falhas.join(' | ') }));
  }

  // Índice construído UMA vez para todos os repos: o custo é construir, não consultar.
  // Com cache quente são ~130 ms; sem, seria proibitivo para algo que roda no Stop.
  const indice = safe(() => buildIndex(root, loadConfig(root)), null);

  let algumArquivo = false;
  for (const repo of findRepos(root, { requireGit: true })) {
    const arquivos = tocados(root, sid, repo);
    if (!arquivos.length) continue;
    algumArquivo = true;
    const ref = baselineDaSessao(root, sid, repo.path) || 'HEAD';
    const simbolos = safe(() => simbolosTocados(repo.path, ref, arquivos, indice), new Map());

    linhas.push('');
    linhas.push(`## ${repo.name === '.' ? t('ho.repo') : repo.name} — ${arquivos.length} ${t('ho.arquivos')}`);
    for (const a of arquivos.slice(0, 40)) {
      const s = simbolos.get(a);
      // O símbolo é o que faz este bloco valer: dizer "mexeu no arquivo de 14 mil linhas"
      // não ajuda a retomar; dizer QUAL função, sim.
      linhas.push(s && s.length ? `- \`${a}\` → ${s.map((x) => `\`${x}\``).join(', ')}` : `- \`${a}\``);
    }
    if (arquivos.length > 40) linhas.push(`- … +${arquivos.length - 40}`);

    const mapas = mapasRelevantes(repo.path, arquivos);
    if (mapas.length) {
      linhas.push('');
      linhas.push(t('ho.mapas', {
        lista: mapas.map((x) => `\`${x.nome}\`${x.defasado ? ` ${t('ho.defasado')}` : ''}`).join(', '),
      }));
      if (mapas.some((x) => x.defasado)) linhas.push(t('ho.defasadoAviso'));
    }
  }
  // Sob um `##`, e não solto. O `montarPrompt` corta o cabeçalho pela ESTRUTURA — tudo antes do
  // primeiro `##` — e esta linha era a única coisa do documento que ficava fora de qualquer
  // seção. Deixá-la solta obrigaria o corte a voltar a reconhecer texto traduzido, que é
  // exatamente o acoplamento que a onda 4 veio remover.
  if (!algumArquivo) {
    linhas.push('');
    linhas.push(`## ${t('ho.repo')}`);
    linhas.push(t('ho.semArquivo'));
  }

  // O pedaço que a ferramenta NÃO tem como saber, e que é justamente o que mais encurta o
  // começo da próxima sessão. Fica como formulário, nunca preenchido por palpite.
  linhas.push('');
  linhas.push(`## ${t('ho.volatil')}`);
  linhas.push(t('ho.volatilAviso'));
  linhas.push('');
  for (const k of ['ho.q1', 'ho.q2', 'ho.q3', 'ho.q4']) linhas.push(`- **${t(k)}** `);
  return linhas.join('\n') + '\n';
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot(args);
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  if (args.includes('--stop-report')) { stopReport(root, t); return; }
  if (args.includes('--session-start')) { relatorioDeDivisao(root, t); return; }
  const sid = sessionId();

  if (args.includes('--prompt')) { console.log(montarPrompt(root, sid, t)); return; }

  const texto = montar(root, sid, t);
  if (args.includes('--salvar')) {
    const destino = caminhoDoHandoff(root, sid);
    safe(() => { mkdirSync(stateDir(root), { recursive: true }); writeFileSync(destino, texto); }, null);
    console.log(t('ho.salvo', { f: relPath(root, destino) }));
    console.log('');
  }
  console.log(texto);
}

if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot(process.argv.slice(2));
  try { main(); } catch (e) { console.log(`handoff: ${e && e.message ? e.message : e}`); }
  finally {
    const args = process.argv.slice(2);
    recordMetric(root, 'handoff', {
      mode: args.includes('--stop-report') ? 'stop-report' : args.includes('--session-start') ? 'session-start' : args.includes('--prompt') ? 'prompt' : args.includes('--salvar') ? 'save' : 'preview',
      durationMs: Date.now() - started,
    });
  }
}

// Exportado para teste; o resto do módulo é CLI e hook.
export { comandoDoPlugin, MAX_SPAN_ATRIBUIVEL, mapasRelevantes };
