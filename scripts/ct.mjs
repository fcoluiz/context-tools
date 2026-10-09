#!/usr/bin/env node
// 🧰 Um comando, verbos curtos — a porta de entrada das ferramentas do context-tools.
//
//   ct.mjs find <nome>…          onde está definido            (symbols.mjs)
//   ct.mjs refs <nome>           quem usa, e de qual função    (refs.mjs)
//   ct.mjs impact <alvo>         o que está em jogo antes de mudar (impact.mjs)
//   ct.mjs outline <arquivo>     mapa linha → símbolo          (outline.mjs)
//   …  `ct.mjs help` lista todos.
//
// Por que existe: a skill e as instruções do agente repetiam `node "<caminho>/scripts/x.mjs"` para
// cada ferramenta — texto pago toda vez que a skill é carregada. Um ponto de entrada com verbos
// encurta isso, e os scripts antigos continuam funcionando exatamente como antes.
//
// O script escolhido roda NESTE processo: `process.argv[1]` passa a ser ele, e o `isMain` dele vê
// a si mesmo como chamado direto. Sem uma segunda partida de Node (~130 ms), sem mudar nenhum
// script.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './lib/roots.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Fonte única dos verbos. `script` é relativo a esta pasta; `en`/`pt` descrevem o verbo no `help`.
export const VERBS = Object.freeze({
  find: { script: 'symbols.mjs', en: 'where is it defined', pt: 'onde está definido' },
  refs: { script: 'refs.mjs', en: 'who uses it, from which function', pt: 'quem usa, de qual função' },
  impact: { script: 'impact.mjs', en: 'what is at stake before changing it', pt: 'o que está em jogo antes de mudar' },
  outline: { script: 'outline.mjs', en: 'line → symbol map of one file', pt: 'mapa linha → símbolo de um arquivo' },
  overview: { script: 'overview.mjs', en: 'panorama of the project', pt: 'panorama do projeto' },
  pack: { script: 'context-pack.mjs', en: 'bounded evidence pack', pt: 'pacote de evidências com orçamento' },
  coupling: { script: 'coupling.mjs', en: 'what changes together (git)', pt: 'o que muda junto (git)' },
  why: { script: 'why.mjs', en: 'commits that shaped a symbol', pt: 'commits que moldaram um símbolo' },
  verify: { script: 'verify.mjs', en: 'related tests and test command', pt: 'testes relacionados e comando' },
  docs: { script: 'context-docs.mjs', en: 'ai-context: init, create, status, audit', pt: 'ai-context: init, create, status, audit' },
  ack: { script: 'ack.mjs', en: 'record a reviewed map/doc', pt: 'registrar revisão de mapa/documento' },
  check: { script: 'audit-docs.mjs', en: 'rotten pointers and claims in docs', pt: 'ponteiros e alegações podres na doc' },
  health: { script: 'health.mjs', en: 'local health, freshness and usage', pt: 'saúde local, atualidade e uso' },
  handoff: { script: 'handoff.mjs', en: 'what the next session needs', pt: 'o que a próxima sessão precisa' },
  explain: { script: 'explain.mjs', en: 'why a file is (not) up for review', pt: 'por que um arquivo entra (ou não) em revisão' },
  review: { script: 'review.mjs', en: 'local review queue', pt: 'fila local de revisão' },
  providers: { script: 'providers.mjs', en: 'optional semantic providers', pt: 'provedores semânticos opcionais' },
});

function lang() {
  const raw = `${process.env.CONTEXT_TOOLS_LANG || ''} ${process.env.LC_ALL || ''} ${process.env.LANG || ''}`.toLowerCase();
  return /\bpt/.test(raw) ? 'pt' : 'en';
}

export function helpText(l = lang()) {
  const linhas = Object.entries(VERBS)
    .filter(([, v]) => existsSync(join(HERE, v.script)))
    .map(([verbo, v]) => `  ${verbo.padEnd(9)} ${v[l]}`);
  const topo = l === 'pt'
    ? 'uso: ct.mjs <verbo> [argumentos] — cada verbo aceita os mesmos argumentos do script de antes'
    : 'usage: ct.mjs <verb> [arguments] — each verb takes the same arguments as its script';
  return [topo, ...linhas].join('\n');
}

async function main() {
  const [verbo, ...resto] = process.argv.slice(2);
  if (!verbo || verbo === 'help' || verbo === '--help' || verbo === '-h') { console.log(helpText()); return; }
  const v = VERBS[verbo];
  const script = v && join(HERE, v.script);
  if (!v || !existsSync(script)) {
    console.log(lang() === 'pt' ? `ct: verbo desconhecido "${verbo}".` : `ct: unknown verb "${verbo}".`);
    console.log(helpText());
    process.exitCode = 1;
    return;
  }
  process.argv = [process.argv[0], script, ...resto];
  await import(pathToFileURL(script).href);
}

if (isMain(import.meta.url)) await main();
