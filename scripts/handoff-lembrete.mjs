#!/usr/bin/env node
// 📝 Hook `UserPromptSubmit` (Claude): o pedido de preencher o handoff e a oferta de sessão nova,
// cada um lembrado UMA vez quando a mensagem do `Stop` se perdeu.
//
// Por que a fase 1 do `handoff.mjs --stop-report` não basta. Medido em 2026-10-16 nos transcripts
// locais do Claude Code, em 495 `Stop` que emitiram `additionalContext`: quando o turno acaba num
// texto do assistente, o texto vira anexo e o modelo dá mais um turno (492 de 492). Quando o turno
// acaba no resultado de uma ferramenta que encerra o turno (a caixa de próximo passo do app
// desktop), o hook roda, mas o texto é DESCARTADO: nem turno extra, nem entrega adiada para o
// prompt seguinte (3 de 3). O pedido some e a fase 2 nunca sai, porque o bloco fica em branco.
//
// O `UserPromptSubmit` sempre chega ao modelo, então é ali que o pedido sobrevive. Uma vez só,
// registrada em `lembrete`: se o agente recebeu as duas mensagens e mesmo assim não preencheu, uma
// terceira só ensinaria a ignorar a categoria. Quando o aviso CHEGOU, o agente costuma preencher no
// turno extra, e o bloco já não está em branco no prompt seguinte: o lembrete cala.
//
// Script próprio, e não um modo do `handoff.mjs`, por custo: roda em TODO prompt, e os imports do
// `handoff.mjs` (índice de símbolos, fingerprints, transcript) são carregados a cada mensagem para
// quase sempre só ler um JSON e sair. Medido em 2026-10-16 (Windows, 30 rodadas, p10/mediana acima
// de um Node vazio): importar o `handoff.mjs` custa +58/+150 ms; este script inteiro, +27/+60 ms.
// O caminho comum carrega `roots.mjs` e mais nada; saída e i18n só quando há o que dizer.
//
// O Codex fica de fora: ele não emite o aviso de fase 1 (ver `stopReport`), então não há pedido a
// lembrar.

import { readFileSync } from 'node:fs';
import { resolveRoot, safe, isMain, relPath, runtimeHost, loadConfig } from './lib/roots.mjs';
import { sessionId, caminhoDoHandoff, estadoDoAviso, blocoVolatilPreenchido, comandoDoHandoff } from './lib/handoff-estado.mjs';

/**
 * Qual lembrete cabe agora, se algum. Cada um sai UMA vez por sessão:
 * - `lembrete`: a fase 1 avisou, mas o bloco volátil segue em branco;
 * - `ofertaLembrete`: a fase 2 ofereceu a sessão nova, e ninguém respondeu (`--resposta`).
 *   A oferta perdida é o mesmo descarte do aviso perdido: o turno que preenche o bloco costuma
 *   acabar na caixa de próximo passo, e o `Stop` seguinte fala sozinho.
 */
function lembreteDevido(root, sid, estado) {
  if (!estado || !estado.aviso || estado.resposta || estado.consumido) return null;
  if (estado.prompt) return estado.ofertaLembrete ? null : 'oferta';
  if (estado.lembrete) return null;
  const doc = safe(() => readFileSync(caminhoDoHandoff(root, sid), 'utf8'), null);
  return doc && !blocoVolatilPreenchido(doc) ? 'preencher' : null;
}

async function main() {
  if (runtimeHost() === 'codex') return;
  const sid = sessionId();
  if (!sid) return;
  const root = resolveRoot(process.argv.slice(2));
  const { estado, salvar } = estadoDoAviso(root, sid);
  const devido = lembreteDevido(root, sid, estado);
  if (!devido) return;
  const destino = caminhoDoHandoff(root, sid);
  salvar({ ...estado, [devido === 'oferta' ? 'ofertaLembrete' : 'lembrete']: Date.now() });
  const [{ writeHookOutput }, { makeT, detectLang }] = await Promise.all([
    import('./lib/hook-output.mjs'), import('./lib/i18n.mjs'),
  ]);
  const t = makeT(detectLang(loadConfig(root)));
  const texto = devido === 'oferta'
    ? t('ses.ofertaLembrete', { arq: relPath(root, destino.replace(/\.md$/, '.prompt.md')), cmd: comandoDoHandoff(root, sid) })
    : t('ses.lembrete', { arq: relPath(root, destino) });
  writeHookOutput(root, {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: texto },
  });
}

if (isMain(import.meta.url)) {
  // stderr, não stdout: no `UserPromptSubmit`, texto solto no stdout entra no contexto do modelo.
  try { await main(); } catch (e) { process.stderr.write(`handoff-lembrete: ${e && e.message ? e.message : e}\n`); }
}
