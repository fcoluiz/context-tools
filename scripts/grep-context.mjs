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

import { readFileSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { resolveRoot, safe, loadConfig, isMain, lerTexto, sanitizeModelText } from './lib/roots.mjs';
import { writeHookOutput } from './lib/hook-output.mjs';

const MAX_ARQUIVOS = 8;
const MAX_LINHAS_POR_ARQUIVO = 40;
const MAX_BLOCO = 1200;

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
      if (porArquivo.size >= MAX_ARQUIVOS) continue;
      porArquivo.set(arquivo, []);
    }
    const lista = porArquivo.get(arquivo);
    if (lista.length < MAX_LINHAS_POR_ARQUIVO && !lista.includes(n)) lista.push(n);
  }
  return porArquivo;
}

/** Junta linhas seguidas do mesmo símbolo: `356-359 JsonReader.Push() (337-362)`. */
function agrupar(usos) {
  const grupos = [];
  for (const u of usos.sort((a, b) => a.line - b.line)) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.in === u.in) { ultimo.to = u.line; continue; }
    grupos.push({ from: u.line, to: u.line, in: u.in, range: u.range });
  }
  return grupos;
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

  const blocos = [];
  for (const [arquivo, linhas] of porArquivo) {
    const parser = parserForExt(extname(arquivo));
    if (!parser) continue;
    const abs = isAbsolute(arquivo) ? arquivo : resolve(cwd, arquivo);
    const rel = relative(root, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    const texto = lerTexto(abs);
    if (texto === null) continue;
    const todas = texto.split('\n');
    const intervalos = comIntervalos(parser(todas), todas.length);
    const usos = linhas.filter((n) => n <= todas.length).map((line) => {
      const dentro = simboloDaLinha(abs, todas, intervalos, line);
      return { line, in: dentro?.name ?? null, range: dentro ? `${dentro.start}-${dentro.end}` : null };
    });
    if (!usos.some((u) => u.in)) continue;
    const partes = agrupar(usos).map((g) => {
      const onde = g.from === g.to ? `${g.from}` : `${g.from}-${g.to}`;
      return g.in ? `${onde} ${sanitizeModelText(g.in, 120)} (${g.range})` : `${onde} ${t('grepctx.topLevel')}`;
    });
    blocos.push(`${sanitizeModelText(rel.replace(/\\/g, '/'), 200)}: ${partes.join('; ')}`);
  }
  if (!blocos.length) return '';
  const corpo = [t('grepctx.header'), ...blocos].join('\n').slice(0, MAX_BLOCO);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: corpo } });
}

async function main() {
  const saida = await executarGrepContext(safe(() => readFileSync(0, 'utf8'), ''));
  if (saida) writeHookOutput(resolveRoot(), saida);
}

if (isMain(import.meta.url)) {
  try { main().catch(() => {}); } catch { /* M4: silêncio, sempre exit 0 */ }
}
