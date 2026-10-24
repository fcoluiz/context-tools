#!/usr/bin/env node
// ⏳ Hook `PostToolUse` (Claude): o aviso de sessão cara NO MEIO do turno, quando o contexto cruza
// o limiar entre duas chamadas de ferramenta.
//
// Por que o `Stop` não basta. Ele só dispara no fim do turno, e o agente costuma trabalhar uma
// lista de tarefas inteira num turno só, sem parar para perguntar. Medido em 2026-10-24 nos
// transcripts locais, em 116 sessões dos últimos 30 dias que cruzaram 200k: entre cruzar o limiar e
// o primeiro `Stop`, mediana de +36k, p75 +86k, e em 25 delas +100k ou mais — no pior caso o turno
// cruzou em 204k e só acabou em 703k, depois de 344 chamadas de ferramenta. O aviso chegava quando
// a sessão já tinha custado o que ele existia para evitar.
//
// Mesmo texto, mesmo estado e mesmo handoff da fase 1 do `Stop` (`avisoDaFase1`), mais um pedido
// de interromper a lista no passo atual e perguntar ao usuário. Quem chegar primeiro avisa; o outro
// vê `aviso` gravado e cala, então continua sendo UM aviso por sessão.
//
// Script próprio e leve pelo mesmo motivo do `handoff-lembrete.mjs`, e com mais razão: roda a cada
// chamada de ferramenta. O caminho comum lê um JSON de estado e a cauda do transcript
// (`contextoAtual`), e sai. O `handoff.mjs` inteiro só é carregado na única vez em que avisa.
//
// O Codex fica de fora pelo mesmo motivo do `stopReport`: lá não há aviso operacional de contexto.

import { resolveRoot, isMain, runtimeHost, loadConfig } from './lib/roots.mjs';
import { sessionId, estadoDoAviso, comandoDoHandoff } from './lib/handoff-estado.mjs';
import { transcriptDaSessao, contextoAtual, metricasDaSessao } from './lib/sessao.mjs';

/** Espelho de `LIMIAR_CONTEXTO` do `handoff.mjs`, que não é importado no caminho comum (um teste amarra os dois). */
const LIMIAR = 200000;

async function main() {
  if (runtimeHost() === 'codex') return;
  const sid = sessionId();
  if (!sid) return;
  const root = resolveRoot(process.argv.slice(2));
  const { estado, salvar } = estadoDoAviso(root, sid);
  if (estado) return;                                       // já avisou (aqui ou no Stop)
  const caminho = transcriptDaSessao(root, sid);
  const agora = contextoAtual(caminho);
  if (agora === null || agora < LIMIAR) return;

  const [handoff, { writeHookOutput }, { makeT, detectLang }] = await Promise.all([
    import('./handoff.mjs'), import('./lib/hook-output.mjs'), import('./lib/i18n.mjs'),
  ]);
  const m = metricasDaSessao(caminho);
  if (!m) return;
  const t = makeT(detectLang(loadConfig(root)));
  const linhas = handoff.avisoDaFase1(root, sid, m, t, salvar);
  linhas.push(t('ses.meioTurno', { cmd: comandoDoHandoff(root, sid) }));
  writeHookOutput(root, {
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: linhas.join('\n') },
  });
}

if (isMain(import.meta.url)) {
  // stderr, não stdout: no `PostToolUse`, texto solto no stdout não é JSON e o hook seria ignorado.
  try { await main(); } catch (e) { process.stderr.write(`handoff-meio-turno: ${e && e.message ? e.message : e}\n`); }
}

export { LIMIAR };
