#!/usr/bin/env node
// Hook PostToolUse: diz em qual função/método/classe cai cada linha que o Grep devolveu.
//
// Por que existe: medido no benchmark de resultado (docs/benchmarks/outcome-pilot-2026-10-09.pt-BR.md).
// Nas perguntas de leitura o agente costuma responder depois de UM Grep, que devolve linhas soltas
// (`356: if (_maxDepth != null && …`) sem o método que as contém. Quando ele não abre o arquivo, o
// nome do método é inferido — e no piloto foi inferido errado. O outline sabe a resposta; aqui ela
// chega junto com o resultado, sem índice: só os arquivos que apareceram são lidos.
//
// Regras herdadas do resto do plugin:
//   M4 — nunca derruba nem atrasa a sessão: qualquer falha vira exit 0 silencioso.
//   Silêncio é o padrão: sem número de linha, sem parser para a extensão ou sem símbolo que
//   contenha alguma linha, não diz nada.
//   Só arquivos dentro do projeto.
//   Corte nunca é silencioso. Na rodada 2 do benchmark, a lista parava em 8 arquivos sem avisar, e
//   o agente tratou como completa uma lista sem os 4 chamadores de um dos arquivos cortados.

import { readFileSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { resolveRoot, safe, loadConfig, isMain, lerTexto, sanitizeModelText } from './lib/roots.mjs';
import { writeHookOutput } from './lib/hook-output.mjs';
import { isTestFile } from './lib/verification.mjs';

const MAX_ARQUIVOS_LIDOS = 20;     // arquivos anotados; os demais são nomeados como não anotados
const MAX_ARQUIVOS_VISTOS = 200;   // limite de memória para saídas enormes
const MAX_LINHAS_POR_ARQUIVO = 40;
const MAX_BLOCO = 2000;
const MAX_ASSINATURA = 140;
const MAX_OMITIDOS_NOMEADOS = 8;

// `caminho:linha:texto` (grep -n, rg, Grep com vários arquivos; `-` em vez de `:` nas linhas de
// contexto) ou `linha:texto` quando a busca foi num arquivo só. O caminho termina numa extensão
// para que o `C:` de um caminho Windows não seja lido como separador.
const COM_CAMINHO = /^(.+?\.[A-Za-z0-9]{1,8}):(\d+)[:-]/;
const SO_LINHA = /^(\d+)[:-]/;

/** Texto que a ferramenta devolveu, qualquer que seja o formato do evento. */
function saidaDaFerramenta(evento) {
  const r = evento.tool_response;
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return '';
  for (const k of ['content', 'stdout', 'output']) if (typeof r[k] === 'string') return r[k];
  return '';
}

function ehBuscaNoBash(comando) {
  return /(?:^|[;&|]\s*)(?:rg|grep)\s/.test(comando);
}

/** Teste pelo nome do arquivo ou da pasta — inclusive o projeto `.Tests` de uma solução .NET. */
function ehTeste(arquivo) {
  return isTestFile(arquivo) || /(?:^|[\\/])[^\\/]+\.Tests?[\\/]/i.test(arquivo);
}

/** Pares arquivo → linhas, na ordem em que apareceram. */
export function linhasPorArquivo(saida, arquivoUnico = null) {
  const porArquivo = new Map();
  for (const bruta of String(saida || '').split('\n')) {
    const linha = bruta.replace(/\r$/, '');
    let arquivo = null;
    let n = null;
    const m = linha.match(COM_CAMINHO);
    if (m) { arquivo = m[1]; n = Number(m[2]); }
    else if (arquivoUnico) {
      const s = linha.match(SO_LINHA);
      if (s) { arquivo = arquivoUnico; n = Number(s[1]); }
    }
    if (!arquivo || !n) continue;
    if (!porArquivo.has(arquivo)) {
      if (porArquivo.size >= MAX_ARQUIVOS_VISTOS) continue;
      porArquivo.set(arquivo, []);
    }
    const lista = porArquivo.get(arquivo);
    if (lista.length < MAX_LINHAS_POR_ARQUIVO && !lista.includes(n)) lista.push(n);
  }
  return porArquivo;
}

/**
 * Junta linhas seguidas do mesmo símbolo: `356-359 JsonReader.Push() (337-362)`. "Mesmo" é nome E
 * intervalo: sobrecargas têm o mesmo nome, e juntá-las punha a linha de uma no intervalo da outra.
 */
function agrupar(usos) {
  const grupos = [];
  for (const u of usos.sort((a, b) => a.line - b.line)) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.in === u.in && ultimo.range === u.range) { ultimo.to = u.line; continue; }
    grupos.push({ from: u.line, to: u.line, in: u.in, range: u.range, sig: u.sig });
  }
  return grupos;
}

/** A linha da declaração, sem recuo nem `{`: diz os parâmetros sem abrir o arquivo. */
function assinatura(todas, inicio) {
  const texto = String(todas[inicio - 1] || '').replace(/\s+/g, ' ').replace(/\s*\{\s*$/, '').trim();
  return texto.length > MAX_ASSINATURA ? `${texto.slice(0, MAX_ASSINATURA - 1)}…` : texto;
}

function montar(t, blocos, omitidos, comAssinatura) {
  const linhas = [t('grepctx.header')];
  const fora = [...omitidos];
  let tamanho = linhas[0].length;
  for (const b of blocos) {
    const texto = `${b.rel}: ${b.grupos.map((g) => (comAssinatura && g.sig ? `${g.parte} \`${g.sig}\`` : g.parte)).join('; ')}`;
    // Reserva espaço para a linha dos não anotados: ela nunca pode ser o que fica de fora.
    if (tamanho + texto.length + 1 > MAX_BLOCO - 300) { fora.push(b.rel); continue; }
    linhas.push(texto);
    tamanho += texto.length + 1;
  }
  if (fora.length) {
    const nomes = fora.slice(0, MAX_OMITIDOS_NOMEADOS).join(', ') + (fora.length > MAX_OMITIDOS_NOMEADOS ? ', …' : '');
    linhas.push(t('grepctx.omitted', { n: fora.length, list: nomes }));
  }
  return { texto: linhas.join('\n'), cabe: !fora.length || fora.length === omitidos.length };
}

export async function executarGrepContext(entrada) {
  const evento = typeof entrada === 'string' ? safe(() => JSON.parse(entrada), null) : entrada;
  if (!evento || typeof evento !== 'object') return '';
  const ferramenta = evento.tool_name;
  if (ferramenta === 'Bash' && !ehBuscaNoBash(String(evento.tool_input?.command ?? ''))) return '';
  if (ferramenta !== 'Grep' && ferramenta !== 'Bash') return '';

  const saida = saidaDaFerramenta(evento);
  if (!saida || !/\d[:-]/.test(saida)) return '';
  const root = resolveRoot();
  if (!root) return '';
  const cwd = typeof evento.cwd === 'string' && evento.cwd ? evento.cwd : root;
  // Grep num arquivo só não repete o caminho em cada linha.
  const alvo = ferramenta === 'Grep' ? String(evento.tool_input?.path ?? '') : '';
  const arquivoUnico = alvo && extname(alvo) ? alvo : null;
  const porArquivo = linhasPorArquivo(saida, arquivoUnico);
  if (!porArquivo.size) return '';

  const { parserForExt } = await import('./outline.mjs');
  const { comIntervalos } = await import('./symbols.mjs');
  const { simboloDaLinha } = await import('./refs.mjs');
  const { makeT, detectLang } = await import('./lib/i18n.mjs');
  const t = makeT(detectLang(loadConfig(root)));

  // Código de produção antes de teste: se algo tiver de ficar de fora, que seja o teste.
  const candidatos = [...porArquivo]
    .filter(([arquivo]) => parserForExt(extname(arquivo)))
    .map(([arquivo, linhas]) => {
      const abs = isAbsolute(arquivo) ? arquivo : resolve(cwd, arquivo);
      return { abs, rel: relative(root, abs), linhas };
    })
    .filter((c) => c.rel && !c.rel.startsWith('..') && !isAbsolute(c.rel))
    .map((c) => ({ ...c, rel: sanitizeModelText(c.rel.replace(/\\/g, '/'), 200) }))
    .sort((a, b) => Number(ehTeste(a.rel)) - Number(ehTeste(b.rel)));

  const blocos = [];
  const omitidos = candidatos.slice(MAX_ARQUIVOS_LIDOS).map((c) => c.rel);
  for (const c of candidatos.slice(0, MAX_ARQUIVOS_LIDOS)) {
    const texto = lerTexto(c.abs);
    if (texto === null) continue;
    const todas = texto.split('\n');
    const intervalos = comIntervalos(parserForExt(extname(c.abs))(todas), todas.length);
    const usos = c.linhas.filter((n) => n <= todas.length).map((line) => {
      const dentro = simboloDaLinha(c.abs, todas, intervalos, line);
      return {
        line, in: dentro?.name ?? null,
        range: dentro ? `${dentro.start}-${dentro.end}` : null,
        sig: dentro ? sanitizeModelText(assinatura(todas, dentro.start), MAX_ASSINATURA + 2) : '',
      };
    });
    if (!usos.some((u) => u.in)) continue;
    const grupos = agrupar(usos).map((g) => {
      const onde = g.from === g.to ? `${g.from}` : `${g.from}-${g.to}`;
      return { parte: g.in ? `${onde} ${sanitizeModelText(g.in, 120)} (${g.range})` : `${onde} ${t('grepctx.topLevel')}`, sig: g.in ? g.sig : '' };
    });
    blocos.push({ rel: c.rel, grupos });
  }
  if (!blocos.length) return '';
  // Com assinatura quando cabe tudo; senão, sem ela — perder o parâmetro custa menos que perder o arquivo.
  let { texto, cabe } = montar(t, blocos, omitidos, true);
  if (!cabe) texto = montar(t, blocos, omitidos, false).texto;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: texto } });
}

async function main() {
  const saida = await executarGrepContext(safe(() => readFileSync(0, 'utf8'), ''));
  if (saida) writeHookOutput(resolveRoot(), saida);
}

if (isMain(import.meta.url)) {
  try { main().catch(() => {}); } catch { /* M4: silêncio, sempre exit 0 */ }
}
