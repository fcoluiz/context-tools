// Estado do aviso de handoff por sessão e leitura estrutural do arquivo de handoff.
//
// Separado de `handoff.mjs` para o lembrete do `UserPromptSubmit` (`handoff-lembrete.mjs`), que
// roda em TODO prompt, não carregar índice de símbolos, git e transcript só para ler um JSON.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safe, statePath, stateDir } from './roots.mjs';

/** Handoff não usado é apagado depois disto: ninguém retoma trabalho de uma semana atrás por ele. */
export const DIAS_RETENCAO = 7;
const RETENCAO_MS = DIAS_RETENCAO * 24 * 60 * 60 * 1000;
/**
 * Janela em que uma sessão nova carrega sozinha o handoff aceito. Curta de propósito: o `sim` é
 * seguido de `/clear` ou de uma sessão nova em minutos; um pendente de ontem pegaria de surpresa
 * a primeira sessão aberta hoje nesta pasta, para outro assunto.
 */
export const JANELA_AUTO_MS = 2 * 60 * 60 * 1000;
const ARQ_ESTADO = '.handoff-aviso.json';
/** Chave do handoff aceito para retomada, no mesmo arquivo de estado (já coberto pelo `.gitignore`). */
const PENDENTE = '_pendente';
/** Só os arquivos que o próprio hook gera: `handoff-<8 do id>.md` e o `.prompt.md` ao lado. */
const GERADO = /^handoff-[^.]{1,8}(\.prompt)?\.md$/;

export function sessionId() {
  return process.env.CONTEXT_TOOLS_SESSION_ID
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || null;
}

/**
 * O comando que o AGENTE roda para responder à oferta ou retomar, com caminhos absolutos.
 *
 * Absoluto de propósito: o Bash do agente não tem `$CLAUDE_PLUGIN_ROOT` (só o hook tem), e a
 * sessão nova pode abrir noutra pasta de trabalho. `--sessao` amarra a resposta à sessão que
 * recebeu a oferta, em vez de depender da variável de ambiente de quem roda o comando.
 */
export function comandoDoHandoff(root, sid) {
  const script = fileURLToPath(new URL('../handoff.mjs', import.meta.url)).replace(/\\/g, '/');
  const base = `node "${script}" --root="${String(root).replace(/\\/g, '/')}"`;
  return sid ? `${base} --sessao=${sid}` : base;
}

/** Onde o handoff desta sessão mora. Um por sessão, para não colidir entre janelas abertas. */
export function caminhoDoHandoff(root, sid) {
  return statePath(root, `handoff-${String(sid || 'sem-sessao').slice(0, 8)}.md`);
}

function lerStore(root) {
  return safe(() => JSON.parse(readFileSync(statePath(root, ARQ_ESTADO), 'utf8')), null) || {};
}

function gravarStore(root, store) {
  safe(() => {
    mkdirSync(stateDir(root), { recursive: true });
    writeFileSync(statePath(root, ARQ_ESTADO), JSON.stringify(store));
  }, null);
}

function comoEstado(bruto) {
  // Versões até 1.3.1 gravavam um timestamp solto aqui. Ler os dois formatos evita que uma
  // atualização do plugin faça o aviso disparar de novo numa sessão que já foi avisada.
  return typeof bruto === 'number' ? { aviso: bruto } : (bruto || null);
}

/** Estado do aviso de `(sessão)` em `.handoff-aviso.json`, e como regravá-lo. */
export function estadoDoAviso(root, sid) {
  const estado = comoEstado(lerStore(root)[sid]);
  // Relê antes de gravar: entre a leitura e o `salvar`, outro processo pode ter mexido em outra
  // chave (o pendente, outra sessão), e regravar o snapshot antigo apagaria essa mudança.
  const salvar = (novo) => {
    const atual = lerStore(root);
    atual[sid] = novo;
    gravarStore(root, atual);
  };
  return { estado, salvar };
}

/** O handoff aceito para retomada: `{ origem, em }`, ou `null`. */
export function lerPendente(root) {
  const p = lerStore(root)[PENDENTE];
  return p && p.origem ? p : null;
}

export function gravarPendente(root, pendente) {
  const store = lerStore(root);
  if (pendente) store[PENDENTE] = pendente; else delete store[PENDENTE];
  gravarStore(root, store);
}

/** Id completo da sessão cujo handoff tem este prefixo, se o estado souber; senão o próprio prefixo. */
export function origemPorPrefixo(root, prefixo) {
  if (!prefixo) return null;
  const p = String(prefixo).slice(0, 8);
  return Object.keys(lerStore(root)).find((k) => k !== PENDENTE && k.slice(0, 8) === p) || String(prefixo);
}

/**
 * Consome o handoff de `origem`: devolve o texto para a sessão nova e apaga os arquivos.
 *
 * Prefere o `.prompt.md` (o handoff já re-rotulado para colar); sem ele, o próprio handoff. Apagar
 * é a regra porque handoff usado que fica no disco vira ruído, e pode ser retomado de novo por
 * engano numa terceira sessão. O estado da origem guarda quem consumiu, para a mesma sessão nova
 * rodar `--retomar` depois do carregamento automático e ouvir "já carregado" em vez de "nada".
 */
export function consumirHandoff(root, origem, por) {
  const doc = caminhoDoHandoff(root, origem);
  const prompt = doc.replace(/\.md$/, '.prompt.md');
  const texto = safe(() => readFileSync(prompt, 'utf8'), null) || safe(() => readFileSync(doc, 'utf8'), null);
  if (!texto) return null;
  for (const f of [doc, prompt]) safe(() => unlinkSync(f), null);
  const store = lerStore(root);
  store[origem] = { ...(comoEstado(store[origem]) || {}), consumido: Date.now(), consumidoPor: por || null };
  if (store[PENDENTE] && store[PENDENTE].origem === origem) delete store[PENDENTE];
  gravarStore(root, store);
  return texto;
}

/** A sessão `sid` já consumiu algum handoff? */
export function jaConsumidoPor(root, sid) {
  if (!sid) return false;
  return Object.entries(lerStore(root)).some(([k, v]) => k !== PENDENTE && v && v.consumidoPor === sid);
}

/**
 * Apaga handoffs gerados há mais de `DIAS_RETENCAO` dias, o estado deles e um pendente vencido.
 *
 * Sem isto a pasta de estado acumulava um par `.md`/`.prompt.md` por sessão cara, para sempre. Só
 * toca nos nomes que o hook gera (`GERADO`): um `handoff-notas-do-time.md` escrito à mão fica.
 */
export function limparHandoffsAntigos(root, agora = Date.now()) {
  const dir = stateDir(root);
  let apagados = 0;
  for (const nome of safe(() => readdirSync(dir), []) || []) {
    if (!GERADO.test(nome)) continue;
    const f = join(dir, nome);
    const idade = safe(() => agora - statSync(f).mtimeMs, 0);
    if (idade > RETENCAO_MS && safe(() => { unlinkSync(f); return true; }, false)) apagados++;
  }
  const store = lerStore(root);
  let mudou = false;
  for (const [k, v] of Object.entries(store)) {
    const marcas = typeof v === 'number' ? [v] : Object.values(v || {}).filter((x) => typeof x === 'number');
    const ultimo = marcas.length ? Math.max(...marcas) : 0;
    const limite = k === PENDENTE ? JANELA_AUTO_MS : RETENCAO_MS;
    if (agora - ultimo > limite) { delete store[k]; mudou = true; }
  }
  if (mudou) gravarStore(root, store);
  return apagados;
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
