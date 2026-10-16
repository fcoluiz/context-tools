// Estado do aviso de handoff por sessão e leitura estrutural do arquivo de handoff.
//
// Separado de `handoff.mjs` para o lembrete do `UserPromptSubmit` (`handoff-lembrete.mjs`), que
// roda em TODO prompt, não carregar índice de símbolos, git e transcript só para ler um JSON.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { safe, statePath, stateDir } from './roots.mjs';

export function sessionId() {
  return process.env.CONTEXT_TOOLS_SESSION_ID
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || null;
}

/** Onde o handoff desta sessão mora. Um por sessão, para não colidir entre janelas abertas. */
export function caminhoDoHandoff(root, sid) {
  return statePath(root, `handoff-${String(sid || 'sem-sessao').slice(0, 8)}.md`);
}

/** Estado do aviso de `(sessão)` em `.handoff-aviso.json`, e como regravá-lo. */
export function estadoDoAviso(root, sid) {
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
  return { estado, salvar };
}

/**
 * O bloco volátil já foi preenchido, ou continua o formulário em branco?
 *
 * Estrutural, como todo o resto que lê este documento: as perguntas saem de `montar` como
 * `- **pergunta** ` e o que vier depois do `**` é a resposta. Nada de reconhecer texto
 * traduzido — o documento pode ter sido gravado em outro idioma ou por outra versão.
 */
export function blocoVolatilPreenchido(doc) {
  if (!doc) return false;
  return doc.split('\n').some((l) => {
    const m = l.match(/^-\s+\*\*.+?\*\*(.*)$/);
    return Boolean(m && m[1].trim());
  });
}
