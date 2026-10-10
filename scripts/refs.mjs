#!/usr/bin/env node
// 🔗 Quem usa X? — os usos de um nome no projeto, cada um com o símbolo que o contém.
//
// `symbols` responde "onde X está DEFINIDO". A pergunta seguinte, antes de mudar X, é "quem
// depende dele" — e com Grep ela custa dezenas de linhas misturando definição, comentário,
// mensagem de erro e uso real. Aqui:
//   - comentário e literal de texto não contam (mesmos removedores dos parsers, por linguagem);
//     são só somados à parte, porque uma rota em string pode ser uso de verdade;
//   - a própria definição sai da lista;
//   - cada uso diz em qual função/método está, então a resposta já é "quem chama".
//
// O que ela NÃO é, e diz na saída: um grafo de chamadas por tipo. Dois símbolos com o mesmo nome
// não são distinguidos, e chamada dinâmica (reflexão, string montada, outro repositório) não
// aparece. Para isso existe o provedor semântico opcional (`providers.mjs`).
//
// Uso:
//   refs.mjs <nome>            → usos agrupados por arquivo, com o símbolo que contém cada um
//   refs.mjs <nome> --all      → sem o corte de arquivos mostrados
//   refs.mjs <nome> --json     → estrutura completa (consumida por impact.mjs e pelo servidor MCP)

import { extname } from 'node:path';
import {
  resolveRoot, loadConfig, isMain, lerTexto, relPath, sanitizeModelText, findRepos, walk,
} from './lib/roots.mjs';
import { buildIndex, comIntervalos, escopoLabel, QUALIFICADOR_RE } from './symbols.mjs';
import { parserForExt, codeOnlyLines } from './outline.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { recordMetric } from './lib/telemetry.mjs';

// Linguagens que não diferenciam caixa no nome: `Confirmar` e `confirmar` são o mesmo símbolo.
const SEM_CAIXA = /\.(pas|dpr|dpk|inc|dfm|fmx|sql|php)$/i;
const FORMULARIO = /\.(dfm|fmx)$/i;
const FIM_ESTIMADO = /\.(js|jsx|ts|tsx|mjs|cjs|py|pyi|go|rs)$/i;
const IDENTIFICADOR = /^[A-Za-z_$][\w$]*$/;
const MAX_ARQUIVOS = 15;
const MAX_ARQUIVOS_ALL = 60;
const MAX_LINHAS_POR_ARQUIVO = 200;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** O símbolo mais interno cujo intervalo contém a linha: o que começa mais tarde. */
function simboloQueContem(intervalos, linha) {
  let melhor = null;
  for (const [inicio, nome, fim] of intervalos) {
    if (inicio <= linha && linha <= fim && (!melhor || inicio >= melhor[0])) melhor = [inicio, nome, fim];
  }
  return melhor;
}

/**
 * `{ name, start, end }` do símbolo que contém a linha (1-based) de `abs`, ou null no topo do arquivo.
 * Nas linguagens em que o fim do símbolo é estimado pelo próximo símbolo (não por chave), uma linha
 * sem recuo depois do último símbolo seria atribuída a ele — o `export { … }` do fim de um arquivo JS
 * aparecia "dentro" da última função. Sem recuo, ali, é topo do arquivo.
 */
export function simboloDaLinha(abs, linhas, intervalos, line) {
  const dentro = simboloQueContem(intervalos, line);
  if (!dentro) return null;
  const topo = FIM_ESTIMADO.test(abs) && !/^\s/.test(linhas[line - 1] || '') && !intervalos.some(([inicio]) => inicio === line);
  return topo ? null : { name: dentro[1], start: dentro[0], end: dentro[2] };
}

/**
 * Formulários Delphi ligam evento a método pelo nome (`OnClick = BtnSalvarClick`) — é uso real e
 * o único lugar onde ele aparece. Ficam fora do índice de símbolos (nome de componente afogaria a
 * busca), mas entram aqui, só quando o projeto tem Pascal.
 */
function formularios(root, cfg, indexFiles) {
  if (!indexFiles.some((f) => /\.(pas|dpr|dpk|inc)$/i.test(f))) return [];
  const out = [];
  for (const repo of findRepos(root, { requireGit: false, cfg })) walk(repo.path, FORMULARIO, out);
  return out;
}

/**
 * Usos de `nome` no projeto. Nunca lança: nome inválido ou índice vazio viram `status` próprio,
 * para quem chama poder dizer "não consegui olhar" em vez de "não há uso".
 */
export function findReferences(root, nome, opts = {}) {
  const started = Date.now();
  const cfg = opts.cfg || loadConfig(root);
  const alvo = String(nome || '').replace(QUALIFICADOR_RE, '');
  if (!IDENTIFICADOR.test(alvo)) return { status: 'invalid', name: alvo };
  const index = opts.index || buildIndex(root, cfg, {});
  if (!index.fileCount) return { status: 'no-files', name: alvo };

  const definitions = [];
  for (const [n, locs] of index.defs) {
    if (n.toLowerCase() !== alvo.toLowerCase()) continue;
    for (const l of locs) if (!/^(key|test) /.test(l.kind)) definitions.push({ file: l.file, line: l.line, end: l.end, kind: l.kind });
  }
  const linhasDeDefinicao = new Set(definitions.map((d) => `${d.file}:${d.line}`));
  const caixa = new RegExp(`(?<![\\w$])${esc(alvo)}(?![\\w$])`);
  const semCaixa = new RegExp(caixa.source, 'i');
  const alvoMinusculo = alvo.toLowerCase();

  const references = [];
  let total = 0;
  let inText = 0;
  for (const abs of [...index.files, ...formularios(root, cfg, index.files)]) {
    const texto = lerTexto(abs);
    if (texto === null) continue;
    const ignoraCaixa = SEM_CAIXA.test(abs);
    if (ignoraCaixa ? !texto.toLowerCase().includes(alvoMinusculo) : !texto.includes(alvo)) continue;
    const re = ignoraCaixa ? semCaixa : caixa;
    const linhas = texto.split('\n');
    const codigo = codeOnlyLines(linhas, extname(abs)) || linhas;
    const rel = relPath(root, abs);
    const usos = [];
    for (let i = 0; i < linhas.length && usos.length < MAX_LINHAS_POR_ARQUIVO; i++) {
      if (!re.test(linhas[i])) continue;
      if (!re.test(codigo[i] || '')) { inText++; continue; }
      if (linhasDeDefinicao.has(`${rel}:${i + 1}`)) continue;
      usos.push(i + 1);
    }
    if (!usos.length) continue;
    const parser = parserForExt(extname(abs));
    const intervalos = parser ? comIntervalos(parser(linhas), linhas.length) : [];
    references.push({
      file: rel,
      form: FORMULARIO.test(abs),
      uses: usos.map((line) => ({ line, in: simboloDaLinha(abs, linhas, intervalos, line)?.name ?? null })),
    });
    total += usos.length;
  }
  references.sort((a, b) => b.uses.length - a.uses.length || a.file.localeCompare(b.file));
  return {
    status: 'ok', name: alvo, definitions, references, total, files: references.length, inText,
    scanned: index.fileCount, repos: index.repos, ms: Date.now() - started,
  };
}

/** `Tela.Salvar() :12 :18, Tela.Ok() :40` — usos agrupados pelo símbolo que os contém. */
export function resumoDoArquivo(ref, t, maxGrupos = 3) {
  const grupos = new Map();
  for (const u of ref.uses) {
    const chave = u.in || t('refs.topLevel');
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(u.line);
  }
  const partes = [...grupos.entries()].slice(0, maxGrupos)
    .map(([nome, linhas]) => `${sanitizeModelText(nome, 60)} ${linhas.slice(0, 4).map((l) => `:${l}`).join(' ')}${linhas.length > 4 ? ' …' : ''}`);
  if (grupos.size > maxGrupos) partes.push(t('refs.moreGroups', { n: grupos.size - maxGrupos }));
  return partes.join(', ');
}

export function formatReferences(result, t, { all = false } = {}) {
  if (result.status === 'invalid') return [t('refs.invalid', { q: sanitizeModelText(result.name, 80) })];
  if (result.status === 'no-files') return [t('refs.noFiles')];
  const out = [];
  const escopo = escopoLabel(result.repos);
  const nome = sanitizeModelText(result.name, 80);
  if (!result.total) {
    out.push(t('refs.none', { q: nome, files: result.scanned, ms: result.ms, escopo }));
    out.push(t('refs.none.hint', { q: result.name }));
    return out;
  }
  out.push(t('refs.header', { q: nome, n: result.total, files: result.files, ms: result.ms, escopo }));
  for (const d of result.definitions.slice(0, 3)) {
    out.push(t('refs.defined', { loc: `${sanitizeModelText(d.file, 160)}:${d.end > d.line ? `${d.line}-${d.end}` : d.line}`, kind: sanitizeModelText(d.kind, 100) }));
  }
  if (!result.definitions.length) out.push(t('refs.noDefinition'));
  else if (new Set(result.definitions.map((d) => d.file)).size > 1) out.push(t('refs.ambiguous', { n: result.definitions.length }));
  out.push('');
  const cap = all ? MAX_ARQUIVOS_ALL : MAX_ARQUIVOS;
  for (const ref of result.references.slice(0, cap)) {
    out.push(`  ${sanitizeModelText(ref.file, 160)} (${ref.uses.length})${ref.form ? ` ${t('refs.form')}` : ''} — ${resumoDoArquivo(ref, t)}`);
  }
  if (result.references.length > cap) out.push(t('refs.moreFiles', { n: result.references.length - cap }));
  out.push('');
  if (result.inText) out.push(t('refs.inText', { n: result.inText }));
  out.push(t('refs.caveat'));
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot(args);
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  const nome = args.find((a) => !a.startsWith('--'));
  if (!nome) { console.log(t('refs.usage')); return null; }
  const result = findReferences(root, nome, { cfg });
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReferences(result, t, { all: args.includes('--all') }).join('\n'));
  return result;
}

if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot(process.argv.slice(2));
  let result = null;
  try { result = main(); } catch (e) {
    console.log(makeT(detectLang())('refs.fail', { err: e && e.message }));
  } finally {
    recordMetric(root, 'refs', {
      durationMs: Date.now() - started,
      status: result?.status || 'none',
      found: result?.status === 'ok' ? result.total > 0 : null,
    });
  }
  process.exit(0);
}
