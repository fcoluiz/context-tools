#!/usr/bin/env node
// 🖥️ Onde na tela fica X? — do texto que o usuário vê até o código que lê e grava o campo.
//
// A pergunta "onde no sistema eu informo o código do vendedor?" chega com palavras da TELA, não
// com nome de símbolo. `find`/`refs` partem de um nome (`EdtCodigoVendedor`), que é justamente o
// que ainda não se sabe; e o texto da tela mora em string de formulário, que eles ignoram de
// propósito. Sem isto o agente refaz à mão: grep do rótulo (com acento escrito como `#237` no
// .dfm), achar o componente, subir até a aba e o grupo, abrir o .pas e caçar onde o campo é lido e
// gravado. Aqui, num passo:
//   - procura o texto em Caption/Hint/Text/DisplayLabel/Items… dos .dfm/.fmx, sem acento nem caixa
//     e aceitando abreviação (`Cód.` casa com "código");
//   - de um rótulo, segue `FocusControl`; sem ele, o controle mais próximo à direita ou abaixo,
//     marcado como provável;
//   - diz onde está na tela (aba › grupo) e, no .pas do mesmo nome, as linhas que usam o controle
//     com o método que as contém — a linha costuma mostrar o campo do banco.
//
// O que ela NÃO é: execução da tela. Controle criado em código, texto vindo de recurso/banco e
// herança visual de outro formulário não aparecem — a saída diz isso.
//
// Uso:
//   ui.mjs <texto da tela>     → controles cujo texto casa, com localização e uso no código
//   ui.mjs <texto> --all       → sem o corte de resultados mostrados
//   ui.mjs <texto> --json      → estrutura completa

import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  resolveRoot, loadConfig, isMain, lerTexto, relPath, sanitizeModelText, findRepos, walk,
} from './lib/roots.mjs';
import { comIntervalos } from './symbols.mjs';
import { parserForExt, codeOnlyLines } from './outline.mjs';
import { simboloDaLinha } from './refs.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { recordMetric } from './lib/telemetry.mjs';

const FORMULARIO = /\.(dfm|fmx)$/i;
const PROP_DE_TEXTO = /(^|\.)(Caption|Hint|Text|TextHint|DisplayLabel|Strings|Items|Title|Lines|Tabs|Description)$/i;
const ROTULO = /(Label|StaticText)$/i;
const MAX_RESULTADOS = 5;
const MAX_RESULTADOS_ALL = 20;
const MAX_USOS = 6;
const MAX_CANDIDATOS = 2000;
const PALAVRAS_VAZIAS = new Set(['de', 'do', 'da', 'dos', 'das', 'o', 'a', 'os', 'as', 'e', 'em', 'no', 'na', 'nos', 'nas',
  'um', 'uma', 'para', 'por', 'com', 'onde', 'qual', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'an', 'where', 'is']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Sem acento, sem caixa, só letras e números separados por espaço. */
export function normalizar(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Valor de string de formulário Delphi → texto. `'C'#243'd. Vendedor'` é como o .dfm guarda
 * "Cód. Vendedor"; `''` é aspa; partes podem vir concatenadas com `+`. Null se não for string.
 */
export function decodificarStringDfm(valor) {
  const v = String(valor ?? '').trim();
  if (!/^['#]/.test(v)) return null;
  let out = '';
  const re = /'((?:[^']|'')*)'|#(\$[0-9a-f]+|\d+)|\s*\+\s*|\s+/giy;
  let m;
  let pos = 0;
  while (pos < v.length && (m = re.exec(v))) {
    if (m[1] !== undefined) out += m[1].replace(/''/g, "'");
    else if (m[2] !== undefined) {
      const cod = m[2].startsWith('$') ? parseInt(m[2].slice(1), 16) : parseInt(m[2], 10);
      if (Number.isFinite(cod) && cod > 0 && cod < 0x110000) out += String.fromCodePoint(cod);
    }
    pos = re.lastIndex;
  }
  return pos >= v.length ? out : (out || null);
}

/**
 * Árvore de um formulário em texto: `{ name, type, line, props, parent, children }`. Propriedade
 * de string que continua com `+` ou lista `( … )` é juntada numa só. Formulário binário (`TPF0`)
 * devolve null — quem chama conta à parte.
 */
export function lerFormulario(texto) {
  if (texto.startsWith('TPF0') || texto.includes('\0')) return null;
  const linhas = texto.split('\n').map((l) => l.replace(/\r$/, ''));
  const raiz = { name: '', type: '', line: 0, props: {}, propLines: {}, parent: null, children: [] };
  let atual = raiz;
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    const obj = linha.match(/^\s*(?:object|inherited|inline)\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)/i);
    if (obj) {
      const no = { name: obj[1], type: obj[2], line: i + 1, props: {}, propLines: {}, parent: atual, children: [] };
      atual.children.push(no);
      atual = no;
      continue;
    }
    if (/^\s*end\s*$/i.test(linha)) { if (atual.parent) atual = atual.parent; continue; }
    const prop = linha.match(/^\s*([A-Za-z_][\w.]*)\s*=\s*(.*)$/);
    if (!prop) continue;
    let valor = prop[2];
    const inicio = i;
    if (valor.trim() === '(') {
      // Lista de strings: um item por linha até `)`.
      const itens = [];
      while (++i < linhas.length) {
        const t = linhas[i].trim();
        const fecha = t.endsWith(')');
        const item = decodificarStringDfm(fecha ? t.slice(0, -1) : t);
        if (item !== null) itens.push(item);
        if (fecha) break;
      }
      atual.props[prop[1]] = itens.join(' | ');
      atual.propLines[prop[1]] = 'string';
    } else {
      while ((valor.trim() === '' || /\+\s*$/.test(valor)) && i + 1 < linhas.length && /^\s*['#]/.test(linhas[i + 1])) {
        valor = `${valor.replace(/\+\s*$/, '')}${linhas[++i].trim()}`;
      }
      const s = decodificarStringDfm(valor);
      atual.props[prop[1]] = s !== null ? s : valor.trim();
      if (s !== null) atual.propLines[prop[1]] = 'string';
    }
    atual.propLines[`@${prop[1]}`] = inicio + 1;
  }
  return raiz;
}

/** Palavras da consulta que importam; se todas forem vazias, usa todas. */
function termos(consulta) {
  const todos = normalizar(consulta).split(' ').filter(Boolean);
  const uteis = todos.filter((t) => !PALAVRAS_VAZIAS.has(t));
  return uteis.length ? uteis : todos;
}

/** `cod` (abreviação na tela) casa com "codigo" na pergunta, e vice-versa; mínimo 3 letras. */
function casaTermo(q, palavras) {
  return palavras.some((p) => p === q || (p.length >= 3 && q.startsWith(p)) || (q.length >= 3 && p.startsWith(q)));
}

const numero = (no, prop) => {
  const n = parseInt(no.props[prop], 10);
  return Number.isFinite(n) ? n : null;
};

function* percorrer(no) {
  for (const filho of no.children) { yield filho; yield* percorrer(filho); }
}

function buscarPorNome(raiz, nome) {
  const alvo = nome.toLowerCase();
  for (const no of percorrer(raiz)) if (no.name.toLowerCase() === alvo) return no;
  return null;
}

/**
 * O controle que um rótulo descreve. `FocusControl` é declarado; sem ele, o irmão não-rótulo mais
 * perto na mesma linha à direita ou logo abaixo — marcado `likely`, porque é posição, não ligação.
 */
export function controleDoRotulo(raiz, rotulo) {
  const foco = rotulo.props.FocusControl;
  if (foco) {
    const no = buscarPorNome(raiz, foco);
    if (no) return { node: no, how: 'focus' };
  }
  if (!ROTULO.test(rotulo.type) || !rotulo.parent) return null;
  const L = numero(rotulo, 'Left'); const T = numero(rotulo, 'Top');
  if (L === null || T === null) return null;
  const W = numero(rotulo, 'Width') ?? 0;
  let melhor = null;
  for (const irmao of rotulo.parent.children) {
    if (irmao === rotulo || ROTULO.test(irmao.type)) continue;
    const l = numero(irmao, 'Left'); const t = numero(irmao, 'Top');
    if (l === null || t === null) continue;
    let dist = null;
    if (Math.abs(t - T) <= 12 && l >= L + W - 4) dist = l - (L + W);
    else if (t >= T && t - T <= 40 && Math.abs(l - L) <= 30) dist = (t - T) + Math.abs(l - L);
    if (dist !== null && dist <= 200 && (!melhor || dist < melhor.dist)) melhor = { node: irmao, dist };
  }
  return melhor ? { node: melhor.node, how: 'likely' } : null;
}

/** `Dados do Cliente › Dados Adicionais` — legendas dos contêineres acima, sem o formulário. */
function caminhoNaTela(no) {
  const partes = [];
  for (let p = no.parent; p && p.parent && p.parent.parent; p = p.parent) {
    const legenda = p.props.Caption;
    if (legenda && p.propLines.Caption === 'string') partes.unshift(legenda);
  }
  return partes;
}

function legendaDoFormulario(raiz) {
  const form = raiz.children[0];
  if (!form) return null;
  return { name: form.name, type: form.type, caption: form.propLines.Caption === 'string' ? form.props.Caption : null };
}

/** O .pas ao lado do formulário (mesmo nome, qualquer caixa na extensão). */
function unidadeDoFormulario(abs) {
  const base = basename(abs, extname(abs));
  for (const ext of ['.pas', '.PAS', '.Pas']) {
    const p = join(dirname(abs), base + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Linhas de código (sem comentário/string) da unidade que citam o controle, com o método. */
function usosNaUnidade(pas, nome) {
  const texto = lerTexto(pas);
  if (texto === null) return { total: 0, uses: [] };
  const linhas = texto.split('\n');
  const codigo = codeOnlyLines(linhas, '.pas') || linhas;
  const re = new RegExp(`(?<![\\w$])${esc(nome)}(?![\\w$])`, 'i');
  const intervalos = comIntervalos(parserForExt('.pas')(linhas), linhas.length);
  const uses = [];
  let total = 0;
  for (let i = 0; i < linhas.length; i++) {
    if (!re.test(codigo[i] || '')) continue;
    // A declaração do campo no `type` do formulário não diz nada que o .dfm já não disse.
    if (/^\s*[A-Za-z_]\w*\s*:\s*T\w+\s*;\s*$/.test(codigo[i])) continue;
    total++;
    if (uses.length < MAX_USOS) {
      uses.push({ line: i + 1, in: simboloDaLinha(pas, linhas, intervalos, i + 1)?.name ?? null, code: linhas[i].trim() });
    }
  }
  return { total, uses };
}

/**
 * Controles cujo texto de tela casa com `consulta`. Nunca lança: consulta vazia ou projeto sem
 * formulário viram `status` próprio.
 */
export function findUiLabel(root, consulta, opts = {}) {
  const started = Date.now();
  const cfg = opts.cfg || loadConfig(root);
  const q = termos(consulta);
  if (!q.length) return { status: 'invalid', query: String(consulta ?? '') };
  const arquivos = [];
  for (const repo of findRepos(root, { requireGit: false, cfg })) walk(repo.path, FORMULARIO, arquivos);
  if (!arquivos.length) return { status: 'no-forms', query: consulta };

  const candidatos = [];
  let binarios = 0;
  varredura: for (const abs of arquivos) {
    const texto = lerTexto(abs);
    if (texto === null) continue;
    // Atalho barato antes de montar a árvore: o começo de algum termo aparece no arquivo, com o
    // acento escrito como `'C'#243'd'` já desfeito? Só 3 letras, para a abreviação também passar.
    const bruto = normalizar(texto.replace(/'?((?:#\d+)+)'?/g, (_, g) => g.split('#').filter(Boolean)
      .map((n) => (Number(n) > 0 && Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : '')).join('')));
    if (!q.some((t) => bruto.includes(t.slice(0, 3)))) continue;
    const raiz = lerFormulario(texto);
    if (!raiz) { binarios++; continue; }
    for (const no of percorrer(raiz)) {
      for (const [prop, valor] of Object.entries(no.props)) {
        if (no.propLines[prop] !== 'string' || !PROP_DE_TEXTO.test(prop) || !valor) continue;
        const palavras = normalizar(valor).split(' ').filter(Boolean);
        const casados = q.filter((t) => casaTermo(t, palavras));
        if (!casados.length) continue;
        candidatos.push({ abs, raiz, no, prop, valor, casados, line: no.propLines[`@${prop}`] });
        if (candidatos.length >= MAX_CANDIDATOS) break varredura;
      }
    }
  }
  // Palavra da pergunta que não aparece em tela nenhuma ("onde INFORMO o código…") não pode
  // exigir nada: sai da conta, e a saída diz que saiu.
  const vistos = new Set(candidatos.flatMap((c) => c.casados));
  const efetivos = q.filter((t) => vistos.has(t));
  for (const c of candidatos) c.score = efetivos.length ? c.casados.length / efetivos.length : 0;
  const completos = candidatos.filter((c) => c.score === 1);
  const escolhidos = (completos.length ? completos : candidatos.filter((c) => c.score >= 0.5))
    .sort((a, b) => b.score - a.score || a.valor.length - b.valor.length || a.abs.localeCompare(b.abs) || a.line - b.line);

  // Uso no código só para o que pode ser mostrado: ler a unit de cada candidato custaria caro.
  const hits = escolhidos.slice(0, MAX_RESULTADOS_ALL).map((c) => {
    const ligado = controleDoRotulo(c.raiz, c.no);
    const controle = ligado ? ligado.node : c.no;
    const eventos = Object.entries(controle.props).filter(([k]) => /^On[A-Z]/.test(k)).map(([k, v]) => `${k}=${v}`);
    const pas = unidadeDoFormulario(c.abs);
    const usos = pas ? usosNaUnidade(pas, controle.name) : null;
    return {
      file: relPath(root, c.abs),
      line: c.line,
      text: c.valor,
      prop: c.prop,
      component: { name: c.no.name, type: c.no.type },
      control: ligado ? { name: controle.name, type: controle.type, line: controle.line, how: ligado.how } : null,
      path: caminhoNaTela(c.no),
      form: legendaDoFormulario(c.raiz),
      dataField: controle.props.DataField || null,
      dataSource: controle.props.DataSource || null,
      events: eventos,
      unit: pas ? relPath(root, pas) : null,
      unitUses: usos,
    };
  });
  return {
    status: 'ok', query: consulta, terms: efetivos, ignored: q.filter((t) => !vistos.has(t)),
    partial: !completos.length && hits.length > 0, total: escolhidos.length,
    hits, forms: arquivos.length, binary: binarios, ms: Date.now() - started,
  };
}

const s = (v, n = 100) => sanitizeModelText(v, n);

export function formatUiLabel(result, t, { all = false } = {}) {
  if (result.status === 'invalid') return [t('ui.invalid')];
  if (result.status === 'no-forms') return [t('ui.noForms')];
  const q = s(result.query, 80);
  if (!result.hits.length) {
    const out = [t('ui.none', { q, files: result.forms, ms: result.ms })];
    if (result.binary) out.push(t('ui.binary', { n: result.binary }));
    out.push(t('ui.none.hint'));
    return out;
  }
  const cap = all ? MAX_RESULTADOS_ALL : MAX_RESULTADOS;
  const out = [t('ui.header', { q, n: result.total, files: result.forms, ms: result.ms })];
  if (result.ignored?.length) out.push(t('ui.ignored', { words: result.ignored.map((w) => s(w, 30)).join(', ') }));
  if (result.partial) out.push(t('ui.partial'));
  for (const h of result.hits.slice(0, cap)) {
    out.push('');
    out.push(`  "${s(h.text, 80)}" — ${s(h.file, 160)}:${h.line}  ${s(h.component.name, 60)}: ${s(h.component.type, 40)}.${s(h.prop, 40)}`);
    const tela = [h.form?.caption || h.form?.name, ...h.path].filter(Boolean).map((p) => s(p, 50));
    if (tela.length) out.push(`    ${t('ui.where')}: ${tela.join(' › ')}`);
    if (h.control) {
      out.push(`    ${t(h.control.how === 'focus' ? 'ui.control.focus' : 'ui.control.likely')}: ${s(h.control.name, 60)}: ${s(h.control.type, 40)} (:${h.control.line})`);
    }
    if (h.dataField) out.push(`    ${t('ui.dataField')}: ${s(h.dataField, 60)}${h.dataSource ? ` (${s(h.dataSource, 60)})` : ''}`);
    if (h.events.length) out.push(`    ${t('ui.events')}: ${h.events.slice(0, 4).map((e) => s(e, 60)).join(', ')}`);
    if (h.unitUses && h.unitUses.total) {
      out.push(`    ${t('ui.uses', { unit: s(h.unit, 160), n: h.unitUses.total })}`);
      for (const u of h.unitUses.uses) out.push(`      :${u.line}${u.in ? ` ${s(u.in, 60)}` : ''} — ${s(u.code, 110)}`);
      if (h.unitUses.total > h.unitUses.uses.length) out.push(`      ${t('ui.moreUses', { n: h.unitUses.total - h.unitUses.uses.length, name: s((h.control || h.component).name, 60) })}`);
    } else if (h.unit) out.push(`    ${t('ui.noUses', { unit: s(h.unit, 160) })}`);
  }
  const mostrados = Math.min(cap, result.hits.length);
  if (result.total > mostrados) { out.push(''); out.push(t(all ? 'ui.moreHitsAll' : 'ui.moreHits', { n: result.total - mostrados })); }
  out.push('');
  if (result.binary) out.push(t('ui.binary', { n: result.binary }));
  out.push(t('ui.caveat'));
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot(args);
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  const consulta = args.filter((a) => !a.startsWith('--')).join(' ');
  if (!consulta.trim()) { console.log(t('ui.usage')); return null; }
  const result = findUiLabel(root, consulta, { cfg });
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(formatUiLabel(result, t, { all: args.includes('--all') }).join('\n'));
  return result;
}

if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot(process.argv.slice(2));
  let result = null;
  try { result = main(); } catch (e) {
    console.log(makeT(detectLang())('ui.fail', { err: e && e.message }));
  } finally {
    recordMetric(root, 'ui', {
      durationMs: Date.now() - started,
      status: result?.status || 'none',
      found: result?.status === 'ok' ? result.hits.length > 0 : null,
    });
  }
  process.exit(0);
}
