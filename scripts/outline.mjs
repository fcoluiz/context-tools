#!/usr/bin/env node
// 🧭 Outline de símbolos — mapa `linha → símbolo` de um arquivo grande, gerado NA HORA.
//
// Por que existe: medição sobre 66 transcripts deste workspace mostrou que 66,7% dos bytes
// puxados pro contexto são código, e que os arquivos-núcleo são lidos SEMPRE por janela
// (triageService.js: 577 leituras, 577 com offset, 0 inteiras). Ou seja: o custo não é ler
// o arquivo — é *procurar onde a coisa está* dentro dele, sessão após sessão.
//
// Como usar:
//   node .claude/scripts/outline.mjs <arquivo>            → mapa completo
//   node .claude/scripts/outline.mjs <arquivo> <filtro>   → só símbolos que casam (regex, case-insensitive)
//
// Depois: Read com offset na linha que interessa. Substitui a caça por janelas de 2 KB.
//
// Sem dependência externa. Gerado na hora ⇒ nunca defasa. Se não reconhecer o formato,
// DIZ que não reconheceu — nunca devolve outline vazio com cara de resposta.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { isMain, lerTexto, EXTENSOES_LIDAS, EXTENSOES_INDICE, EXTENSOES_HISTORICO, resolveRoot } from './lib/roots.mjs';
import { recordMetric } from './lib/telemetry.mjs';
const t = makeT(detectLang());
import { extname, basename } from 'node:path';

// Palavras que parecem chamada de método mas são controle de fluxo.
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'try',
  'function', 'await', 'typeof', 'delete', 'new', 'throw', 'yield', 'case',
  'constructor?.', 'super', 'this',
]);

export function symbolsForCode(lines) {
  const out = [];
  // A regra de "método indentado" só vale em arquivo com classe. Sem isso, em componente
  // React (function + hooks) ela captura CHAMADAS indentadas — ex. `setForm(...)` — como
  // se fossem definições. Falso positivo em outline é pior que símbolo faltando: manda
  // Read pra linha errada.
  const hasClass = lines.some((l) => /^(?:export\s+)?(?:default\s+)?class\s+[A-Za-z_$]/.test(l));

  // --- Chaves de configuração ---------------------------------------------------------
  // `sessionTimeoutMinutes`, `max_restarts`, `enableFallback` são o que se procura num
  // arquivo de config, e o índice não via nenhuma: só definição de topo e método de classe.
  //
  // A regra é DELIBERADAMENTE estreita — literal de objeto aberto no topo do arquivo, e só
  // os filhos DIRETOS. Medido no workspace de referência (1.543 arquivos JS/TS): 1.329 chaves, 832 nomes
  // distintos, média de 1,6 ocorrência por nome. A regra larga (qualquer `x:` em qualquer
  // nível) dava 75.454 — 57× mais, e afogaria a busca exatamente como nome de componente
  // `.dfm` afogaria, que é por isso que `.dfm` está fora do índice.
  //
  // Entram como `key X`, nunca como definição, e `reportOne` as ranqueia ABAIXO de símbolo
  // real: das 832, 31 colidem com um nome já indexado, e nessas a definição tem que vir na
  // frente.
  let emObjeto = false, nivel = 0, emTemplate = false;
  const aninhamento = (s) => (s.match(/[[({]/g) || []).length - (s.match(/[\])}]/g) || []).length;

  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const n = i + 1;

    if (emObjeto) {
      // Template literal atravessa linhas e pode conter `algo: valor`, que viraria chave
      // fantasma. Contagem de crase é heurística: ela erra a favor de PERDER chave (fica
      // "dentro do template" e para de emitir), nunca de inventar. Só vale DENTRO do objeto
      // — aplicá-la ao arquivo inteiro engoliria símbolo real, porque regex com crase
      // (`/\`([^\`]+)\`/g`, caso real deste workspace) tem número ímpar delas.
      const crases = (line.match(/`/g) || []).length;
      if (emTemplate) { if (crases % 2 === 1) emTemplate = false; return; }

      const t = line.trim();
      if (nivel === 0 && /^[}\]]/.test(t)) { emObjeto = false; return; }

      const k = nivel === 0 && line.match(/^\s+['"]?([A-Za-z_$][\w$]*)['"]?\s*:/);
      nivel = Math.max(0, nivel + aninhamento(line));
      if (crases % 2 === 1) emTemplate = true;
      if (k) { out.push({ line: n, name: `key ${k[1]}`, depth: 1 }); return; }
      // Sem `return` de propósito: método abreviado dentro do objeto (`  onFoo() {`)
      // continua caindo nas regras de baixo, exatamente como antes desta mudança.
    }

    // `module.exports = {` e `export default {` também abrem objeto de configuração — e
    // nenhum dos dois casa com a regra de binding mais abaixo, que exige const/let/var.
    if (/^(?:module\.exports|export\s+default)\s*=?\s*\{\s*$/.test(line.trim())) {
      emObjeto = true; nivel = 0; emTemplate = false;
      return;
    }

    // --- Casos de teste ------------------------------------------------------------------
    // `test('…')`, `it('…')`, `describe('…')` no TOPO do arquivo. Entram como `test X`, kind
    // de SEGUNDA CLASSE — mesmo tratamento das chaves de config, e pelo mesmo motivo: são
    // resposta útil, mas nunca devem empurrar uma definição real para baixo do teto de acertos.
    //
    // Existem por uma causa medida: `comIntervalos` fecha um símbolo na linha anterior ao
    // próximo de mesma profundidade, e uma chamada `test(…)` não era símbolo nenhum. Resultado,
    // neste repo: `tests/hooks-e2e.test.mjs` tinha **4 símbolos em 847 linhas**, e um helper de
    // topo engolia 401 delas — o que fazia o handoff anunciar esse helper como "tocado" quando
    // o que mudou foi um teste no meio. Indexar os testes encolhe os intervalos até a verdade,
    // sem tocar em `comIntervalos` (fechar span por contagem de chaves arriscaria ler a MENOS,
    // que é o erro caro e a premissa registrada em `symbols.mjs`).
    //
    // Só no topo (`^`), só com string literal como primeiro argumento: `test` dentro de outro
    // bloco é subteste ou helper, e a coluna 0 é o que separa os dois sem precisar de AST.
    let m = line.match(/^(?:test|it|describe)(?:\.\w+)?\s*\(\s*(['"`])(.+?)\1/);
    if (m) { out.push({ line: n, name: `test ${m[2].trim()}`, depth: 0 }); return; }

    // class X / export class X
    m = line.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (m) { out.push({ line: n, name: `class ${m[1]}`, depth: 0 }); return; }

    // TypeScript puro: interface / type / enum. Sem este branch, TODO tipo exportado ficava
    // invisível ao índice — medido: 817 no frontend do workspace de referência, 10 num projeto de terceiro.
    // Não falhava só visivelmente: como a busca casa parcial, perguntar por `Status` devolvia
    // com confiança `function StatusBadge` enquanto o `export type Status` real seguia oculto.
    // `(?:const\s+)?` cobre `const enum`; exigir `\s+` + identificador depois da palavra-chave
    // é o que impede `type: 'foo'` (propriedade de objeto) de virar símbolo.
    m = line.match(/^(?:export\s+)?(?:declare\s+)?(?:const\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
    if (m) { out.push({ line: n, name: `${m[1]} ${m[2]}`, depth: 0 }); return; }

    // function foo() / export async function foo()
    m = line.match(/^(?:export\s+)?(?:default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/);
    if (m) { out.push({ line: n, name: `${m[1] ? 'async ' : ''}function ${m[2]}`, depth: 0 }); return; }

    // Qualquer binding de topo: `const foo = …`, `export const foo = …`, `let`, `var`.
    // Cobre arrow (`= async (…) =>`), wrapper de ordem superior (`= handleController(async …)`,
    // padrão dominante dos controllers deste repo) e constante simples. Marcar tudo é melhor que
    // perder símbolo: um outline que esconde a função manda de volta pra caça por janela.
    //
    // O RÓTULO, porém, precisa distinguir os dois: `X()` diz "isto é chamável" e `const X` diz
    // "isto é um valor". A regra `^ident(` sozinha chamava de função todo `const HERE =
    // dirname(...)` — 9 dos 14 símbolos de `install.mjs` saíam com `()` mentindo. O que separa
    // o wrapper de ordem superior de uma chamada comum é haver FUNÇÃO dentro dos parênteses:
    // `handleController(async (req,res) => …)` tem `async`/`=>`; `dirname(fileURLToPath(x))`
    // não tem nada. Errar aqui não esconde símbolo nenhum (ele entra no índice dos dois jeitos),
    // só descreve mal o que ele é — mas descrever mal é o bastante para mandar alguém ler a
    // linha errada, e o rótulo é justamente o que o handoff mostra.
    m = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=\s*(.*)$/);
    if (m) {
      const name = m[1];
      const rhs = m[2] || '';
      // Arrow/função DIRETA: o `=>` é do próprio binding, não de um callback lá dentro.
      const arrowDireta = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(rhs);
      const funcaoDireta = /^(?:async\s+)?function\b/.test(rhs);
      // Wrapper de ordem superior: chamada de identificador NU com função dentro. Exigir o nome
      // nu (sem ponto) é o que separa `handleController(async …)` de `STATE_FILES.filter(f => …)`
      // — o segundo tem `=>`, mas devolve um array. Chamada encadeada é quase sempre um valor;
      // wrapper de ordem superior é quase sempre chamado direto.
      //
      // Medido por diff de CONJUNTO antes×depois nos 224 símbolos deste repo (o único oráculo
      // confiável para parser aqui): **0 perdido, 0 inventado, 15 rótulos trocados**. Catorze
      // estavam errados e ficaram certos (`const HERE = dirname(…)`, `const args =
      // process.argv.slice(2)`, `const faltando = STATE_FILES.filter(…)`…). **Um piorou, e fica
      // registrado:** `const t = makeT(detectLang())` é chamável de verdade e agora sai como
      // `const t`. Chamada que DEVOLVE função é indecidível por regex, e trocar 14 acertos por
      // 1 erro é o lado certo do balanço — mas é erro, não detalhe.
      const wrapperDeFuncao = /^[A-Za-z_$][\w$]*\s*\(/.test(rhs) && /=>|\bfunction\b|\basync\b/.test(rhs);
      const isFn = arrowDireta || funcaoDireta || wrapperDeFuncao;
      const isAsync = /\basync\b/.test(rhs);
      out.push({ line: n, name: isFn ? `${isAsync ? 'async ' : ''}${name}()` : `const ${name}`, depth: 0 });
      // `const X = {` (nada mais na linha) abre literal de objeto: os filhos diretos viram
      // chaves. Exigir o fim da linha é o que separa config de `const x = { a: 1 }` inline,
      // que não tem filho em linha própria para indexar.
      if (/^\{$/.test(rhs.trim())) { emObjeto = true; nivel = 0; emTemplate = false; }
      return;
    }

    // método de classe indentado: "  foo(", "  async foo(", "  static get foo("
    if (!hasClass) return;
    m = line.match(/^(\s{2,6})(?:(static)\s+)?(?:(async)\s+)?(?:(get|set)\s+)?([A-Za-z_$#][\w$]*)\s*\(/);
    if (m) {
      const name = m[5];
      if (KEYWORDS.has(name)) return;
      const prefix = [m[2], m[3], m[4]].filter(Boolean).join(' ');
      out.push({ line: n, name: `${prefix ? prefix + ' ' : ''}${name}()`, depth: 1 });
    }
  });
  return out;
}

// Pascal/Delphi. Três diferenças que quebram a intuição de quem vem de JS:
//   1. A linguagem é CASE-INSENSITIVE — `PROCEDURE`, `Procedure` e `procedure` são a mesma coisa.
//   2. Todo método aparece DUAS vezes: declarado no `interface`, definido no `implementation`.
//      A definição é a forma qualificada (`procedure TFoo.Bar`) — é ela que interessa em
//      "onde X está definido". A declaração entra como `depth 1` para o outline mostrar
//      a estrutura da classe sem confundir com a definição.
//   3. Não há chave nem indentação obrigatória; `end;` fecha tudo. Por isso o parser é por
//      linha e conservador: perder símbolo é melhor que apontar linha errada.
// Pascal tem TRES formas de comentario: `//` ate o fim da linha, e `{ }` / `(* *)`, que
// atravessam linhas. Ignorar as duas ultimas nao produz "simbolo faltando" — produz simbolo
// INVENTADO: prosa de doc vira `function is`, e bloco de codigo comentado vira definicao com
// cara de real, que e o disfarce pior. Medido em 1.164 arquivos reais (HeidiSQL, Delphi/VCL +
// Double Commander, FPC/Lazarus): 168 simbolos fantasma em 72.179, e 84 NOMES so existiam
// dentro de comentario — consultar qualquer um devolvia 100% lixo. Os caros estavam entre eles
// (`ContentGetValueW`, `FsNetworkGetSupportedProtocols`: API de plugin em bloco comentado).
//
// Duas armadilhas, as duas confirmadas no corpus (nao sao hipotese):
//   1. `{$IFDEF}` NAO e comentario, e diretiva de compilador. O codigo dentro dela compila e
//      precisa continuar indexado. (`{%H-}` do FPC tambem e diretiva, mas essa POdE ser apagada:
//      some da linha e revela o simbolo que ela escondia — recuperou 3 que o parser antigo perdia.)
//   2. `{` dentro de string ('...') nao abre comentario. Sem essa guarda, uma linha real como
//      `if (c^ <> '{') then Break;` engoliria o resto do arquivo ate a proxima `}` — trocaria
//      falso positivo por perda de simbolo real, que e o erro pior dos dois.
// Substitui comentario por ESPACO em vez de remover, preservando as colunas.
function semComentariosPascal(lines) {
  let aberto = null; // '}' | '*)'
  return lines.map((raw) => {
    const s = raw.replace(/\r$/, '');
    let out = '', i = 0;
    while (i < s.length) {
      if (aberto) {
        const fim = aberto === '}' ? '}' : '*)';
        const f = s.indexOf(fim, i);
        if (f === -1) { out += ' '.repeat(s.length - i); i = s.length; }
        else { out += ' '.repeat(f - i + fim.length); i = f + fim.length; aberto = null; }
        continue;
      }
      const c = s[i];
      if (c === "'") { // string: copia inteira, nada dentro dela e comentario
        let j = i + 1;
        while (j < s.length && s[j] !== "'") j++;
        out += s.slice(i, j + 1); i = j + 1;
      } else if (c === '/' && s[i + 1] === '/') {
        out += ' '.repeat(s.length - i); i = s.length;
      } else if (c === '{' && s[i + 1] !== '$') {
        aberto = '}'; out += ' '; i += 1;
      } else if (c === '(' && s[i + 1] === '*' && s[i + 2] !== '$') {
        aberto = '*)'; out += '  '; i += 2;
      } else { out += c; i += 1; }
    }
    return out;
  });
}

export function symbolsForPascal(lines) {
  const out = [];
  const semCom = semComentariosPascal(lines);
  semCom.forEach((line, i) => {
    const t = line.trim();
    const n = i + 1;
    if (!t) return;
    // O recuo sai da linha ORIGINAL: comentario virou espaco e falsearia o depth de
    // `{ nota } procedure Foo;`, que e membro global e nao de classe.
    const cru = (lines[i] || '').replace(/\r$/, '');

    // unit / program / library — identifica o arquivo
    let m = t.match(/^(unit|program|library)\s+([A-Za-z_][\w.]*)/i);
    if (m) { out.push({ line: n, name: `${m[1].toLowerCase()} ${m[2]}`, depth: 0 }); return; }

    // TFoo = class(TBar) / = record / = interface / = object
    m = t.match(/^([A-Za-z_]\w*)\s*=\s*(class|record|interface|object)\b/i);
    if (m) { out.push({ line: n, name: `${m[2].toLowerCase()} ${m[1]}`, depth: 0 }); return; }

    // DEFINIÇÃO qualificada: procedure TFoo.Bar / function TFoo.Baz / constructor TFoo.Create
    m = t.match(/^(procedure|function|constructor|destructor)\s+([A-Za-z_]\w*)\.([A-Za-z_]\w*)/i);
    if (m) {
      out.push({ line: n, name: `${m[1].toLowerCase()} ${m[2]}.${m[3]}`, depth: 0 });
      return;
    }

    // Declaração ou rotina global. Indentada ⇒ é membro de classe (depth 1).
    m = t.match(/^(procedure|function|constructor|destructor)\s+([A-Za-z_]\w*)/i);
    if (m) {
      out.push({ line: n, name: `${m[1].toLowerCase()} ${m[2]}`, depth: /^\s/.test(cru) ? 1 : 0 });
      return;
    }

    m = t.match(/^property\s+([A-Za-z_]\w*)/i);
    if (m) out.push({ line: n, name: `property ${m[1]}`, depth: 1 });
  });
  return out;
}

// Rust. Três coisas que quebram a intuição de quem vem de JS:
//   1. Visibilidade é prefixo variável: `pub`, `pub(crate)`, `pub(super)`. Tudo opcional.
//   2. `impl` é onde os métodos vivem, e existe em duas formas — `impl Foo` (inerente) e
//      `impl Trait for Foo`. Nas duas o que se procura é o TIPO, não o trait; quem resolve
//      isso é o `bareName` em symbols.mjs.
//   3. `fn` minúsculo é definição; `Fn`/`FnMut` maiúsculos são traits em cláusula `where` e
//      NÃO podem virar símbolo. A distinção é só a caixa, então nada de flag `i` aqui.
// A ordem importa: `fn` é testado ANTES de `impl`, senão `fn f() -> impl Iterator` viraria impl.
export function symbolsForRust(lines) {
  const out = [];
  const PUB = String.raw`(?:pub(?:\([^)]*\))?\s+)?`;
  const reFn = new RegExp(`^${PUB}(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+([A-Za-z_][\\w]*)`);
  const reTipo = new RegExp(`^${PUB}(?:unsafe\\s+)?(struct|enum|trait|union)\\s+([A-Za-z_][\\w]*)`);
  const reAlias = new RegExp(`^${PUB}type\\s+([A-Za-z_][\\w]*)`);
  const reMod = new RegExp(`^${PUB}mod\\s+([A-Za-z_][\\w]*)`);
  const reConst = new RegExp(`^${PUB}(const|static)\\s+(?:mut\\s+)?([A-Za-z_][\\w]*)\\s*:`);

  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    const n = i + 1;
    if (!t || t.startsWith('//') || t.startsWith('#[') || t.startsWith('#!')) return;
    // Indentado ⇒ está dentro de um impl/trait/mod: é membro, não definição de topo.
    const depth = /^\s/.test(line) ? 1 : 0;

    let m = t.match(reFn);
    if (m) { out.push({ line: n, name: `fn ${m[1]}`, depth }); return; }

    m = t.match(reTipo);
    if (m) { out.push({ line: n, name: `${m[1]} ${m[2]}`, depth }); return; }

    // impl Foo / impl<T> Foo<T> / impl Trait for Foo
    m = t.match(/^impl(?:\s*<[^>]*>)?\s+([A-Za-z_][\w:]*)(?:\s*<[^>]*>)?(?:\s+for\s+([A-Za-z_][\w:]*))?/);
    if (m) {
      out.push({ line: n, name: m[2] ? `impl ${m[1]} for ${m[2]}` : `impl ${m[1]}`, depth: 0 });
      return;
    }

    m = t.match(/^macro_rules!\s*([A-Za-z_][\w]*)/);
    if (m) { out.push({ line: n, name: `macro ${m[1]}`, depth: 0 }); return; }

    m = t.match(reAlias);
    if (m) { out.push({ line: n, name: `type ${m[1]}`, depth }); return; }

    m = t.match(reMod);
    if (m) { out.push({ line: n, name: `mod ${m[1]}`, depth }); return; }

    m = t.match(reConst);
    if (m) out.push({ line: n, name: `${m[1]} ${m[2]}`, depth });
  });
  return out;
}

// Python. A armadilha é a MESMA do Pascal com outra roupa: docstring `"""..."""` atravessa
// linhas e quase sempre contém EXEMPLO DE CÓDIGO. Sem tratá-la, um `def foo():` de exemplo
// dentro do docstring vira definição com arquivo e linha exatos, apontando para documentação —
// e em Python isso não é caso raro, é o estilo dominante de doc.
// Prefixo de string (f, r, b, u, rb, fr…) importa: `f"""` precisa abrir docstring igual, senão
// o parser não vê o fechamento e engole o resto do arquivo.
function semTextoPython(lines) {
  let fim = null; // '"""' | "'''" — aberto atravessando linhas
  return lines.map((raw) => {
    const s = raw.replace(/\r$/, '');
    let out = '', i = 0;
    while (i < s.length) {
      if (fim) {
        const f = s.indexOf(fim, i);
        if (f === -1) { out += ' '.repeat(s.length - i); i = s.length; }
        else { out += ' '.repeat(f + 3 - i); i = f + 3; fim = null; }
        continue;
      }
      const c = s[i];
      if (c === '#') { out += ' '.repeat(s.length - i); i = s.length; continue; }
      const tri = s.startsWith('"""', i) ? '"""' : s.startsWith("'''", i) ? "'''" : null;
      if (tri) {
        const f = s.indexOf(tri, i + 3);
        if (f === -1) { fim = tri; out += ' '.repeat(s.length - i); i = s.length; }
        else { out += ' '.repeat(f + 3 - i); i = f + 3; }
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; }
        out += ' '.repeat(Math.min(j, s.length - 1) + 1 - i);
        i = j + 1;
        continue;
      }
      out += c; i++;
    }
    return out;
  });
}

export function symbolsForPython(lines) {
  const out = [];
  const limpo = semTextoPython(lines);
  limpo.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    // Recuo vem da linha ORIGINAL: docstring virou espaço e falsearia o depth.
    const cru = (lines[i] || '').replace(/\r$/, '');
    const depth = /^\s/.test(cru) ? 1 : 0;
    const n = i + 1;

    let m = t.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/);
    if (m) { out.push({ line: n, name: `def ${m[1]}`, depth }); return; }

    m = t.match(/^class\s+([A-Za-z_]\w*)/);
    if (m) out.push({ line: n, name: `class ${m[1]}`, depth });
  });
  return out;
}

// Go. Duas coisas atravessam linhas e precisam sair antes da busca: `/* */` e a RAW STRING
// com crase, que pode conter qualquer coisa (SQL, template, JSON — e código Go de exemplo).
// O método carrega o receptor no rótulo (`func Server.Start`), igual ao Pascal qualificado:
// é assim que se procura, e o `bareName` corta o prefixo para indexar por `Start`.
function semTextoGo(lines) {
  let aberto = null; // '*/' | '`'
  return lines.map((raw) => {
    const s = raw.replace(/\r$/, '');
    let out = '', i = 0;
    while (i < s.length) {
      if (aberto) {
        const f = s.indexOf(aberto, i);
        if (f === -1) { out += ' '.repeat(s.length - i); i = s.length; }
        else { out += ' '.repeat(f + aberto.length - i); i = f + aberto.length; aberto = null; }
        continue;
      }
      const c = s[i];
      if (c === '/' && s[i + 1] === '/') { out += ' '.repeat(s.length - i); i = s.length; continue; }
      if (c === '/' && s[i + 1] === '*') {
        const f = s.indexOf('*/', i + 2);
        if (f === -1) { aberto = '*/'; out += ' '.repeat(s.length - i); i = s.length; }
        else { out += ' '.repeat(f + 2 - i); i = f + 2; }
        continue;
      }
      if (c === '`') {
        const f = s.indexOf('`', i + 1);
        if (f === -1) { aberto = '`'; out += ' '.repeat(s.length - i); i = s.length; }
        else { out += ' '.repeat(f + 1 - i); i = f + 1; }
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; }
        out += ' '.repeat(Math.min(j, s.length - 1) + 1 - i);
        i = j + 1;
        continue;
      }
      out += c; i++;
    }
    return out;
  });
}

export function symbolsForGo(lines) {
  const out = [];
  const limpo = semTextoGo(lines);
  // `type (` / `const (` / `var (` abrem bloco agrupado — muito comum em Go para enum e para
  // declarar tipos juntos. Sem estado aqui, TODO membro de bloco agrupado ficaria invisível.
  //
  // `nivel` NÃO é enfeite: dentro do grupo um valor pode abrir literal aninhado que atravessa
  // linhas, e aí os CAMPOS do literal virariam declaração. Caso real (prometheus/main.go):
  //   var ( x = prometheus.NewGauge(prometheus.GaugeOpts{ Name: "…", Help: "…" }) )
  // sem contar aninhamento, `Name:` e `Help:` viravam `var Name` e `var Help` — 613 símbolos
  // falsos no corpus medido. Só emite quando o aninhamento está zerado.
  let grupo = null, nivel = 0;
  limpo.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const n = i + 1;
    const delta = (t.match(/[[({]/g) || []).length - (t.match(/[\])}]/g) || []).length;

    if (grupo) {
      if (nivel === 0 && t === ')') { grupo = null; return; }
      if (nivel === 0) {
        let g = t.match(/^([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\b/);
        if (g && grupo === 'type') { out.push({ line: n, name: `${g[2]} ${g[1]}`, depth: 1 }); }
        else {
          // `a, b = f()` e `x, y, z string` declaram VÁRIOS nomes numa linha. Indexar só o
          // primeiro deixaria os outros inencontráveis — mesmo tipo de buraco silencioso
          // que os tipos do TypeScript tinham.
          g = t.match(/^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/);
          if (g) for (const nome of g[1].split(',').map((x) => x.trim())) {
            out.push({ line: n, name: `${grupo} ${nome}`, depth: 1 });
          }
        }
      }
      nivel = Math.max(0, nivel + delta);
      return;
    }
    if (/^(type|const|var)\s*\($/.test(t)) { grupo = t.split(/\s|\(/)[0]; nivel = 0; return; }

    // Método com receptor: `func (s *Server) Start(` / `func (Server) Name(` /
    // `func (b Bucket[BC]) String(` — o `[…]` do receptor genérico é obrigatório aqui:
    // sem ele todo método de tipo genérico some do índice (medido no prometheus).
    let m = t.match(/^func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)/);
    if (m) { out.push({ line: n, name: `func ${m[1]}.${m[2]}`, depth: 0 }); return; }

    m = t.match(/^func\s+([A-Za-z_]\w*)/);
    if (m) { out.push({ line: n, name: `func ${m[1]}`, depth: 0 }); return; }

    m = t.match(/^type\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?(struct|interface)\b/);
    if (m) { out.push({ line: n, name: `${m[2]} ${m[1]}`, depth: 0 }); return; }

    m = t.match(/^type\s+([A-Za-z_]\w*)/);
    if (m) { out.push({ line: n, name: `type ${m[1]}`, depth: 0 }); return; }

    m = t.match(/^(const|var)\s+([A-Za-z_]\w*)/);
    if (m) { out.push({ line: n, name: `${m[1]} ${m[2]}`, depth: 0 }); return; }

    m = t.match(/^package\s+([A-Za-z_]\w*)/);
    if (m) out.push({ line: n, name: `package ${m[1]}`, depth: 0 });
  });
  return out;
}

// C#, Java e PHP: a família de chaves. Mesmo princípio do Pascal, do Python e do Go — comentário
// e literal de texto viram espaço ANTES de procurar declaração, preservando colunas e quebras de
// linha. Cada dialeto tem a sua armadilha de texto que atravessa linhas:
//   C#   — verbatim `@"…"` (aspas dobradas escapam, quebra de linha vale) e raw `"""…"""`;
//   Java — text block `"""…"""`;
//   PHP  — heredoc/nowdoc `<<<EOT … EOT`, string comum que atravessa linhas, comentário `#`
//          (mas `#[` é atributo) e o HTML fora de `<?php … ?>`.
// Literal de caractere (`'{'`) importa mais do que parece: o parser conta chaves para saber se
// está dentro de um corpo, e um `'{'` solto desalinharia o resto do arquivo.
function semTextoCLike(lines, dialeto) {
  let aberto = dialeto === 'php' ? { tipo: 'html' } : null;
  return lines.map((raw) => {
    const s = raw.replace(/\r$/, '');
    let out = '', i = 0;
    const branco = (ate) => { out += ' '.repeat(Math.max(0, ate - i)); i = ate; };
    if (aberto?.tipo === 'heredoc') {
      // PHP 7.3+: o fechamento pode vir recuado, e o resto da linha (`;`, `)`) é código.
      const m = s.match(new RegExp(`^(\\s*)${aberto.id}\\b`));
      if (!m) return ' '.repeat(s.length);
      branco(m[0].length);
      aberto = null;
    }
    while (i < s.length) {
      if (aberto) {
        if (aberto.tipo === 'html') {
          const f = s.indexOf('<?', i);
          if (f === -1) { branco(s.length); continue; }
          const tag = s.startsWith('<?php', f) ? 5 : s.startsWith('<?=', f) ? 3 : 2;
          branco(f + tag); aberto = null; continue;
        }
        if (aberto.tipo === 'bloco' || aberto.tipo === 'raw') {
          const f = s.indexOf(aberto.fim, i);
          if (f === -1) { branco(s.length); continue; }
          branco(f + aberto.fim.length); aberto = null; continue;
        }
        if (aberto.tipo === 'verbatim') {
          let j = i;
          while (j < s.length && !(s[j] === '"' && s[j + 1] !== '"')) j += s[j] === '"' ? 2 : 1;
          if (j >= s.length) { branco(s.length); continue; }
          branco(j + 1); aberto = null; continue;
        }
        if (aberto.tipo === 'str') {
          let j = i;
          while (j < s.length && s[j] !== aberto.aspa) j += s[j] === '\\' ? 2 : 1;
          if (j >= s.length) { branco(s.length); continue; }
          branco(j + 1); aberto = null; continue;
        }
      }
      const c = s[i];
      if (c === '/' && s[i + 1] === '/') { branco(s.length); continue; }
      if (dialeto === 'php' && c === '#' && s[i + 1] !== '[') { branco(s.length); continue; }
      if (c === '/' && s[i + 1] === '*') { aberto = { tipo: 'bloco', fim: '*/' }; branco(i + 2); continue; }
      if (dialeto === 'php' && s.startsWith('?>', i)) { aberto = { tipo: 'html' }; branco(i + 2); continue; }
      if (dialeto === 'php' && s.startsWith('<<<', i)) {
        const m = s.slice(i).match(/^<<<\s*(["']?)([A-Za-z_]\w*)\1/);
        if (m) { aberto = { tipo: 'heredoc', id: m[2] }; branco(s.length); continue; }
      }
      const prefixoCs = dialeto === 'cs' && (c === '@' || c === '$') ? s.slice(i).match(/^([$@]{1,3})"/) : null;
      // `@` nunca prefixa raw string: `@"""…` é verbatim que começa com aspa escapada (`""`).
      if (prefixoCs && prefixoCs[1].includes('@')) {
        aberto = { tipo: 'verbatim' }; branco(i + prefixoCs[0].length); continue;
      }
      if (dialeto === 'cs' && c === '$' && s[i + 1] === '"') { out += ' '; i += 1; continue; }
      if (c === '"' && s.startsWith('"""', i) && (dialeto === 'cs' || dialeto === 'java')) {
        let n = 3;
        while (s[i + n] === '"') n++;
        const fim = dialeto === 'java' ? '"""' : '"'.repeat(n);
        const f = s.indexOf(fim, i + n);
        if (f === -1) { aberto = { tipo: 'raw', fim }; branco(s.length); continue; }
        branco(f + fim.length); continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
        if (j >= s.length && dialeto === 'php') { aberto = { tipo: 'str', aspa: c }; branco(s.length); continue; }
        branco(Math.min(j + 1, s.length)); continue;
      }
      out += c; i++;
    }
    return out;
  });
}

/**
 * Motor comum dos três dialetos. A decisão que separa definição de chamada não é regex: é ONDE a
 * linha está. Cada `{` empilha um contexto — namespace, corpo de tipo, corpo de membro, bloco solto
 * — e só se procura declaração de membro DENTRO DE TIPO, e de tipo fora de qualquer corpo. Dentro
 * de um método nada é procurado, então `var x = Foo(a);`, `return new Bar();` e lambdas nunca viram
 * símbolo, sem precisar enumerar os jeitos de escrever uma chamada.
 *
 * O fim do símbolo também sai das chaves: é a linha da `}` que fecha o corpo (ou do `;` de um
 * membro abstrato/expression-bodied). Mais exato que o fechamento por "próximo símbolo" que os
 * parsers por indentação usam.
 *
 * Linha de continuação (a anterior terminou em `,`, `(`, `=`…) não é início de declaração: é o
 * segundo parâmetro de uma assinatura quebrada, e `string nome,` não pode virar membro.
 */
function declaracoesCLike(lines, dialeto, declarar) {
  const limpo = semTextoCLike(lines, dialeto);
  const out = [];
  const pilha = [];
  let pendente = null;
  let continua = false;
  const temCorpo = () => pilha.some((c) => c.kind === 'body');
  const topo = () => (pilha.length ? pilha[pilha.length - 1].kind : 'top');
  const classe = () => { for (let k = pilha.length - 1; k >= 0; k--) if (pilha[k].kind === 'type') return pilha[k].name; return null; };
  const tipos = () => pilha.filter((c) => c.kind === 'type').length;

  limpo.forEach((line, i) => {
    const n = i + 1;
    const t = line.trim();
    if (!t) return;
    if (dialeto === 'cs' && t.startsWith('#')) return;   // #region, #if: diretiva, não código

    if (!temCorpo() && !continua) {
      const r = declarar(t, { topo: topo(), classe: classe(), tipos: tipos() });
      if (r) {
        let sym = null;
        if (r.name) { sym = { line: n, name: r.name, depth: r.depth }; out.push(sym); }
        pendente = { kind: r.abre, name: r.nome || null, sym };
      }
    }
    for (const c of line) {
      if (c === '{') {
        const kind = pendente ? pendente.kind : (temCorpo() || topo() === 'type' ? 'body' : 'block');
        pilha.push({ kind, name: pendente?.name || null, sym: pendente?.sym || null });
        pendente = null;
      } else if (c === '}') {
        const ctx = pilha.pop();
        if (ctx?.sym) ctx.sym.end = n;
      } else if (c === ';' && pendente) {
        if (pendente.sym) pendente.sym.end = n;
        pendente = null;
      }
    }
    continua = !temCorpo() && /(?:[,(=+\-*/?:&|.]|=>)$/.test(t);
  });
  return out;
}

const CS_MOD = String.raw`(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial|readonly|volatile|required|file|ref|scoped)\s+)*`;
const CS_TIPO = String.raw`(?:\([^()]*\)|(?:[A-Za-z_]\w*::)?[A-Za-z_][\w.]*(?:\s*<[^;(){}=]*?>)?(?:\s*\[[\s,]*\])*\??\*?)`;
const CS_IFACE = String.raw`(?:[A-Za-z_][\w.]*(?:<[^()]*?>)?\.)?`;
const CS_TIPO_RE = new RegExp(String.raw`^${CS_MOD}(class|struct|interface|enum|record)(?:\s+(?:class|struct))?\s+([A-Za-z_]\w*)`);
const CS_DELEGATE_RE = new RegExp(String.raw`^${CS_MOD}delegate\s+${CS_TIPO}\s+([A-Za-z_]\w*)`);
const CS_CONST_RE = new RegExp(String.raw`^${CS_MOD}const\s+${CS_TIPO}\s+([A-Za-z_]\w*)\s*=`);
const CS_EVENT_RE = new RegExp(String.raw`^${CS_MOD}event\s+${CS_TIPO}\s+([A-Za-z_]\w*)`);
const CS_CTOR_RE = new RegExp(String.raw`^${CS_MOD}([A-Za-z_]\w*)\s*\(`);
const CS_METODO_RE = new RegExp(String.raw`^${CS_MOD}(${CS_TIPO})\s+${CS_IFACE}([A-Za-z_]\w*)\s*(?:<[^()]*?>)?\s*\(`);
const CS_PROP_RE = new RegExp(String.raw`^${CS_MOD}(${CS_TIPO})\s+${CS_IFACE}([A-Za-z_]\w*)\s*(?:\{|=>|$)`);
const CS_NAO_TIPO = new Set(['return', 'new', 'await', 'throw', 'yield', 'else', 'case', 'using', 'goto', 'operator', 'implicit', 'explicit', 'var', 'const', 'event', 'delegate', 'namespace', 'class', 'struct', 'interface', 'enum', 'record']);
const semAtributosCs = (t) => t.replace(/^(?:\[[^\]]*\]\s*)+/, '');

export function symbolsForCSharp(lines) {
  return declaracoesCLike(lines, 'cs', (linha, ctx) => {
    const t = semAtributosCs(linha);
    if (!t) return null;
    let m = t.match(/^namespace\s+[\w.]+\s*(;)?/);
    if (m) return m[1] ? null : { abre: 'ns' };
    if (ctx.topo === 'block') return null;
    m = t.match(CS_TIPO_RE);
    if (m) return { name: `${m[1]} ${m[2]}`, depth: ctx.tipos, abre: 'type', nome: m[2] };
    m = t.match(CS_DELEGATE_RE);
    if (m) return { name: `delegate ${m[1]}`, depth: ctx.tipos, abre: 'body' };
    if (ctx.topo !== 'type') return null;
    m = t.match(CS_CONST_RE);
    if (m) return { name: `const ${m[1]}`, depth: ctx.tipos, abre: 'body' };
    m = t.match(CS_EVENT_RE);
    if (m) return { name: `event ${m[1]}`, depth: ctx.tipos, abre: 'body' };
    m = t.match(CS_CTOR_RE);
    if (m && m[1] === ctx.classe) return { name: `${ctx.classe}.${m[1]}()`, depth: ctx.tipos, abre: 'body' };
    m = t.match(CS_METODO_RE);
    if (m && !CS_NAO_TIPO.has(m[1]) && m[2] !== 'operator') {
      return { name: `${ctx.classe}.${m[2]}()`, depth: ctx.tipos, abre: 'body' };
    }
    m = t.match(CS_PROP_RE);
    if (m && !CS_NAO_TIPO.has(m[1]) && m[2] !== 'operator' && m[2] !== 'this') {
      return { name: `property ${m[2]}`, depth: ctx.tipos, abre: 'body' };
    }
    return null;
  });
}

const JAVA_MODS = ['public', 'private', 'protected', 'static', 'final', 'abstract', 'sealed', 'non-sealed', 'strictfp', 'default', 'synchronized', 'native', 'transient', 'volatile'];
const JAVA_MOD = String.raw`((?:(?:${JAVA_MODS.join('|')})\s+)*)`;
const JAVA_TIPO = String.raw`(?:[A-Za-z_$][\w$.]*(?:\s*<[^;(){}=]*?>)?(?:\s*\[\s*\])*)`;
const JAVA_TIPO_RE = new RegExp(String.raw`^${JAVA_MOD}(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)`);
const JAVA_CTOR_RE = new RegExp(String.raw`^${JAVA_MOD}(?:<[^()]*?>\s*)?([A-Za-z_$][\w$]*)\s*\(`);
const JAVA_METODO_RE = new RegExp(String.raw`^${JAVA_MOD}(?:<[^()]*?>\s*)?(${JAVA_TIPO})\s+([A-Za-z_$][\w$]*)\s*\(`);
const JAVA_CONST_RE = new RegExp(String.raw`^${JAVA_MOD}${JAVA_TIPO}\s+([A-Za-z_$][\w$]*)\s*(?:=|;)`);
const JAVA_NAO_TIPO = new Set(['return', 'new', 'throw', 'else', 'case', 'assert', 'yield', 'class', 'interface', 'enum', 'record', 'package', 'import']);
// Anotação sai de QUALQUER posição, não só do começo: anotação de tipo (`public @Nullable String
// get(`, `Map.@Nullable Entry<…> scan(`) fica entre o modificador e o tipo, e é o estilo dominante
// em projeto com análise de nulidade — sem isto, todo método assim sumia do índice.
const semAnotacoesJava = (t) => t.replace(/@(?!interface\b)[A-Za-z_$][\w$.]*(?:\s*\([^()]*\))?\s*/g, '');

export function symbolsForJava(lines) {
  return declaracoesCLike(lines, 'java', (linha, ctx) => {
    const t = semAnotacoesJava(linha);
    if (!t || ctx.topo === 'block') return null;
    let m = t.match(JAVA_TIPO_RE);
    if (m) {
      const kw = m[2] === '@interface' ? 'annotation' : m[2];
      return { name: `${kw} ${m[3]}`, depth: ctx.tipos, abre: 'type', nome: m[3] };
    }
    if (ctx.topo !== 'type') return null;
    m = t.match(JAVA_CTOR_RE);
    if (m && m[2] === ctx.classe) return { name: `${ctx.classe}.${m[2]}()`, depth: ctx.tipos, abre: 'body' };
    m = t.match(JAVA_METODO_RE);
    if (m && !JAVA_NAO_TIPO.has(m[2])) return { name: `${ctx.classe}.${m[3]}()`, depth: ctx.tipos, abre: 'body' };
    // Constante: só `static final` explícito. Campo comum de instância é estado, não definição que
    // se procura entre arquivos — o mesmo critério que deixa variável local fora do índice.
    m = t.match(JAVA_CONST_RE);
    if (m && /\bstatic\b/.test(m[1]) && /\bfinal\b/.test(m[1])) return { name: `const ${m[2]}`, depth: ctx.tipos, abre: 'body' };
    return null;
  });
}

const PHP_TIPO_RE = /^(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/i;
const PHP_METODO_RE = /^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/i;
const PHP_CONST_RE = /^(?:(?:public|private|protected|final)\s+)*const\s+(?:[A-Za-z_\\?][\w\\|?]*\s+)?([A-Za-z_]\w*)\s*=/i;
const semAtributosPhp = (t) => t.replace(/^(?:#\[[^\]]*\]\s*)+/, '');

export function symbolsForPhp(lines) {
  return declaracoesCLike(lines, 'php', (linha, ctx) => {
    const t = semAtributosPhp(linha);
    if (!t) return null;
    let m = t.match(/^namespace\s+[\w\\]+\s*(;)?/i);
    if (m) return m[1] ? null : { abre: 'ns' };
    m = t.match(PHP_TIPO_RE);
    if (m) return { name: `${m[1].toLowerCase()} ${m[2]}`, depth: ctx.tipos, abre: 'type', nome: m[2] };
    m = t.match(PHP_METODO_RE);
    // Função de topo também vale dentro de bloco solto: `if (!function_exists('x')) { function x() }`
    // é o jeito idiomático de declarar helper global, e ali o contexto é `block`, não `top`.
    if (m && ctx.topo === 'type') return { name: `${ctx.classe}.${m[1]}()`, depth: ctx.tipos, abre: 'body' };
    if (m && /^function\b/i.test(t)) return { name: `function ${m[1]}`, depth: 0, abre: 'body' };
    m = t.match(PHP_CONST_RE);
    if (m && (ctx.topo === 'type' || /^const\b/i.test(t))) return { name: `const ${m[1]}`, depth: ctx.tipos, abre: 'body' };
    return null;
  });
}

// .dfm — recurso de formulário, não código. Estrutura é `object Nome: TTipo` aninhado por
// indentação, fechado com `end`. Serve para navegar um formulário grande; NÃO entra no índice
// cross-file (ver symbols.mjs), porque nome de componente (`Button1`, `Panel2`) é genérico
// demais e afogaria a busca por símbolo de verdade.
export function symbolsForDfm(lines) {
  const out = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^(\s*)(?:inherited|inline\s+)?object\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)/i);
    if (m) {
      out.push({ line: i + 1, name: `${m[2]}: ${m[3]}`, depth: Math.floor(m[1].length / 2) });
    }
  });
  return out;
}

export function symbolsForMarkdown(lines) {
  const out = [];
  let inFence = false;
  lines.forEach((raw, i) => {
    // Tirar o \r ANTES de casar: em regex JS `.` não casa `\r`, então em arquivo CRLF
    // o `(.*)$` falhava e o outline devolvia "nenhum símbolo" num .md cheio de headings.
    const line = raw.replace(/\r$/, '');
    // Bloco de código: `# comentário` de shell dentro de ``` não é seção. Sem isso o outline
    // manda Read pra uma "seção" que é comentário bash no meio de um exemplo de deploy.
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) out.push({ line: i + 1, name: m[2].trim().slice(0, 90), depth: m[1].length - 1 });
  });
  return out;
}

/**
 * `(?i)`/`(?-i)` é sintaxe de modificador inline de Python/PCRE, não de regex JS — quem vem de
 * lá (ou de um LLM treinado nesses dialetos) escreve isso por hábito e o `RegExp` nativo rejeita
 * a construção inteira, mesmo que o resto do padrão fosse válido. Como o filtro já é
 * case-insensitive por padrão (flag `i` fixa em quem chama), o prefixo é sempre redundante
 * quando presente — descartá-lo antes de montar o `RegExp` recupera o padrão sem mudar o
 * resultado de quem já o escreveu certo.
 */
export function stripInlineRegexFlags(filter) {
  return filter.replace(/^\(\?-?[a-zA-Z]+\)/, '');
}

// SQL. Cobre o ponto cego "coluna de banco": tabelas, colunas, views, procedures, funções,
// triggers, índices, sequences/generators e domains declarados em scripts `.sql`/migrations.
// Comentário (`--`, `/* */`) e literal de string viram espaço antes da busca, preservando as
// quebras de linha — senão um `CREATE TABLE` dentro de comentário viraria tabela fantasma.
function semTextoSql(texto) {
  let out = '', i = 0;
  while (i < texto.length) {
    const c = texto[i];
    if (c === '-' && texto[i + 1] === '-') {
      const f = texto.indexOf('\n', i);
      const fim = f === -1 ? texto.length : f;
      out += ' '.repeat(fim - i); i = fim; continue;
    }
    if (c === '/' && texto[i + 1] === '*') {
      const f = texto.indexOf('*/', i + 2);
      const fim = f === -1 ? texto.length : f + 2;
      out += texto.slice(i, fim).replace(/[^\n]/g, ' '); i = fim; continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < texto.length && !(texto[j] === "'" && texto[j + 1] !== "'")) j += texto[j] === "'" ? 2 : 1;
      const fim = Math.min(j + 1, texto.length);
      out += texto.slice(i, fim).replace(/[^\n]/g, ' '); i = fim; continue;
    }
    out += c; i++;
  }
  return out;
}

const SQL_NOME = String.raw`(?:[\x60"\[]?[A-Za-z_][\w$#]*[\x60"\]]?\.)?[\x60"\[]?([A-Za-z_][\w$#]*)[\x60"\]]?`;
const SQL_OBJETO_RE = new RegExp(String.raw`\bCREATE\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?(?:MATERIALIZED\s+)?(TABLE|VIEW|PROCEDURE|PROC|FUNCTION|TRIGGER|INDEX|SEQUENCE|GENERATOR|DOMAIN|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?${SQL_NOME}`, 'gi');
const SQL_ALTER_ADD_RE = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:ONLY\s+)?${SQL_NOME}\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[\x60"\[]?([A-Za-z_][\w$#]*)`, 'gi');
const SQL_NAO_COLUNA = new Set(['constraint', 'primary', 'foreign', 'unique', 'check', 'index', 'key', 'exclude', 'like', 'period', 'fulltext', 'spatial']);
const SQL_ROTULO = { proc: 'procedure', generator: 'sequence' };

export function symbolsForSql(lines) {
  const texto = semTextoSql(lines.join('\n'));
  const inicioDeLinha = [0];
  for (let i = 0; i < texto.length; i++) if (texto[i] === '\n') inicioDeLinha.push(i + 1);
  const linhaDe = (pos) => {
    let lo = 0, hi = inicioDeLinha.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (inicioDeLinha[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const out = [];
  for (const m of texto.matchAll(SQL_OBJETO_RE)) {
    const tipo = m[1].toLowerCase();
    const nome = m[2];
    out.push({ line: linhaDe(m.index), name: `${SQL_ROTULO[tipo] || tipo} ${nome}`, depth: 0, pos: m.index });
    if (tipo !== 'table') continue;
    // Colunas: identificador no início de cada item de nível 1 da lista entre parênteses.
    let i = m.index + m[0].length;
    while (i < texto.length && /\s/.test(texto[i])) i++;
    if (texto[i] !== '(') continue;               // CREATE TABLE … AS SELECT: sem lista
    let nivel = 1, esperaColuna = true;
    for (i++; i < texto.length && nivel > 0; i++) {
      const c = texto[i];
      if (c === '(') { nivel++; continue; }
      if (c === ')') { nivel--; continue; }
      if (c === ',' && nivel === 1) { esperaColuna = true; continue; }
      if (!esperaColuna || nivel !== 1 || /\s/.test(c)) continue;
      const col = texto.slice(i).match(/^[\x60"\[]?([A-Za-z_][\w$#]*)[\x60"\]]?/);
      esperaColuna = false;
      if (!col || SQL_NAO_COLUNA.has(col[1].toLowerCase())) continue;
      out.push({ line: linhaDe(i), name: `column ${nome}.${col[1]}`, depth: 1, pos: i });
      i += col[0].length - 1;
    }
  }
  for (const m of texto.matchAll(SQL_ALTER_ADD_RE)) {
    if (SQL_NAO_COLUNA.has(m[2].toLowerCase())) continue;
    out.push({ line: linhaDe(m.index), name: `column ${m[1]}.${m[2]}`, depth: 1, pos: m.index });
  }
  return out.sort((a, b) => a.pos - b.pos).map(({ pos, ...s }) => s);
}
// Dump de dados pode ter centenas de MB e nenhuma definição útil: acima disso, não indexa.
symbolsForSql.maxBytes = 8 * 1024 * 1024;

/**
 * Só o CÓDIGO de um arquivo: comentário e literal de texto viram espaço, colunas e linhas
 * preservadas. Serve a quem procura USO de um nome (`refs`), onde uma menção num comentário ou numa
 * mensagem de erro não é referência. Reaproveita os mesmos removedores dos parsers — um por
 * linguagem, com as armadilhas já medidas. JS/TS usa o motor C-like sem tocar template literal
 * (`${chamada()}` dentro dele é código). Devolve `null` quando não sabe limpar a linguagem.
 */
export function codeOnlyLines(lines, ext) {
  const e = String(ext || '').toLowerCase();
  const semStringPascal = (l) => l.replace(/'(?:[^'\n]|'')*'/g, (m) => ' '.repeat(m.length));
  if (/^\.(pas|dpr|dpk|inc)$/.test(e)) return semComentariosPascal(lines).map(semStringPascal);
  if (e === '.dfm' || e === '.fmx') return lines.map((l) => semStringPascal(l.replace(/\r$/, '')));
  if (e === '.py' || e === '.pyi') return semTextoPython(lines);
  if (e === '.go') return semTextoGo(lines);
  if (e === '.cs') return semTextoCLike(lines, 'cs');
  if (e === '.java') return semTextoCLike(lines, 'java');
  if (e === '.php') return semTextoCLike(lines, 'php');
  if (/^\.(js|jsx|ts|tsx|mjs|cjs)$/.test(e)) return semTextoCLike(lines, 'js');
  if (e === '.sql') return semTextoSql(lines.join('\n')).split('\n');
  return null;
}

/**
 * Escolhe o parser pela extensão. Fonte ÚNICA do despacho — `symbols.mjs` importa daqui, para
 * que adicionar uma linguagem nova não exija lembrar de mexer nos dois arquivos.
 * Devolve `null` quando não reconhece, para o chamador poder dizer que não reconheceu em vez
 * de devolver outline vazio com cara de resposta.
 */
export function parserForExt(ext) {
  const e = ext.toLowerCase();
  if (e === '.md') return symbolsForMarkdown;
  if (e === '.pas' || e === '.dpr' || e === '.dpk' || e === '.inc') return symbolsForPascal;
  if (e === '.dfm' || e === '.fmx') return symbolsForDfm;
  if (e === '.rs') return symbolsForRust;
  if (e === '.py' || e === '.pyi') return symbolsForPython;
  if (e === '.go') return symbolsForGo;
  if (e === '.sql') return symbolsForSql;
  if (e === '.cs') return symbolsForCSharp;
  if (e === '.java') return symbolsForJava;
  if (e === '.php') return symbolsForPhp;
  if (/^\.(js|jsx|ts|tsx|mjs|cjs)$/.test(e)) return symbolsForCode;
  return null;
}

function main() {
  const [target, filter] = process.argv.slice(2);
  if (!target) {
    console.log(t('out.usage'));
    process.exit(0);
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    console.log(t('out.notFound', { f: target }));
    process.exit(0);
  }

  const content = lerTexto(target);
  if (content === null) { console.log(t('out.naoLeu', { f: target })); process.exit(0); }
  const lines = content.split('\n');
  const ext = extname(target).toLowerCase();
  const parser = parserForExt(ext);

  if (!parser) {
    const extension = ext.replace(/^\./, '');
    if (EXTENSOES_HISTORICO.includes(extension) && !EXTENSOES_INDICE.includes(extension)) {
      recordMetric(resolveRoot(process.argv.slice(2)), 'language-demand', { extension, source: 'outline-unsupported-file' });
    }
    console.log(t('out.unsupported', { f: basename(target), ext, lines: lines.length }));
    console.log(t('out.unsupported.list', { lidas: EXTENSOES_LIDAS }));
    console.log(t('out.unsupported.hint'));
    process.exit(0);
  }

  const all = parser(lines);

  if (all.length === 0) {
    console.log(t('out.noSymbols', { f: basename(target), ext, lines: lines.length }));
    console.log(t('out.noSymbols.hint'));
    process.exit(0);
  }

  let shown = all;
  let note = '';
  if (filter) {
    let re;
    try { re = new RegExp(stripInlineRegexFlags(filter), 'i'); } catch { console.log(t('out.badFilter', { f: filter })); process.exit(0); }
    shown = all.filter((s) => re.test(s.name));
    note = t('out.filterNote', { filter, shown: shown.length, total: all.length });
    if (shown.length === 0) {
      console.log(t('out.header', { f: basename(target), lines: lines.length, n: all.length, note: '' }));
      console.log(t('out.filterEmpty', { filter }));
      process.exit(0);
    }
  }

  console.log(t('out.header', { f: target, lines: lines.length, n: all.length, note }));
  console.log(t('out.header.hint'));
  for (const s of shown) {
    console.log(`${String(s.line).padStart(6)}  ${'  '.repeat(s.depth)}${s.name}`);
  }
}

// Só executa quando chamado direto. Sem esta guarda, importar as funções acima
// (symbols.mjs faz isso) dispararia main() e process.exit(0) como efeito colateral.
//
// Usa `isMain`, que compara o caminho RESOLVIDO. A guarda daqui comparava só o basename —
// existem duas cópias de cada script (a fonte e a instalada em `.claude/scripts/`), e nome
// de arquivo não distingue as duas. Era a única no plugin fora do padrão.
if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot(process.argv.slice(2));
  process.once('exit', () => recordMetric(root, 'outline', {
    filtered: process.argv.slice(2).length > 1,
    durationMs: Date.now() - started,
  }));
  try { main(); } catch (e) {
    console.log(t('out.fail', { err: e && e.message }));
  }
  process.exit(0);
}
