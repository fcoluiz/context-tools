// Testes de comportamento: cache, exclusões de mapa e heurísticas da auditoria.
//
// Foco no que falha em SILÊNCIO — cache que serve dado velho, aviso que some quando não devia,
// heurística que acusa símbolo que existe. Erro barulhento o usuário vê; estes não.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localPath } from './paths.mjs';

import { bareName, buildIndex } from '../scripts/symbols.mjs';
import { lerTexto, CODE_RE, EXTENSOES_CODIGO, EXTENSOES_LIDAS } from '../scripts/lib/roots.mjs';
import { symbolsForCode, parserForExt } from '../scripts/outline.mjs';
import { isDefaultUnmapped, isIntentionallyUnmapped, parseFrontmatter } from '../scripts/context-maps.mjs';
import { plausible, ehCandidato, collectCandidates, resolveExistence } from '../scripts/audit-docs.mjs';

/** Projeto temporário descartável, com pasta src/. */
function projeto(arquivos) {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-tools-test-'));
  mkdirSync(join(raiz, 'src'), { recursive: true });
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    writeFileSync(join(raiz, nome), conteudo);
  }
  return raiz;
}

// ---------------------------------------------------------------- bareName

test('bareName: extrai nome pesquisável de JS e de Pascal', () => {
  assert.equal(bareName('async fetchUser()'), 'fetchUser');
  assert.equal(bareName('function alpha'), 'alpha');
  assert.equal(bareName('class TFoo'), 'TFoo');
  assert.equal(bareName('const CONFIG'), 'CONFIG');
  // Pascal: indexa pelo método, que é como se procura
  assert.equal(bareName('procedure TPedido.Confirmar'), 'Confirmar');
  assert.equal(bareName('constructor TPedido.Create'), 'Create');
  assert.equal(bareName('property Total'), 'Total');
});

// ---------------------------------------------------------------- índice

test('buildIndex: acha símbolo e não cacheia abaixo do limiar', () => {
  const raiz = projeto({ 'src/a.js': 'export function alvo() {}\n' });
  try {
    const idx = buildIndex(raiz, {});
    assert.equal(idx.tier, 'A', 'projeto pequeno não pode entrar em modo cache');
    assert.ok(idx.defs.has('alvo'), 'símbolo precisa estar no índice');
    assert.equal(idx.defs.get('alvo')[0].line, 1);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('buildIndex: indexa Pascal junto com JS, e NÃO indexa .dfm', () => {
  const raiz = projeto({
    'src/a.js': 'export function doJs() {}\n',
    'src/b.pas': 'procedure DoPascal;\nbegin\nend;\n',
    'src/b.dfm': 'object Botao1: TButton\nend\n',
  });
  try {
    const idx = buildIndex(raiz, {});
    assert.ok(idx.defs.has('doJs'), 'JS precisa entrar');
    assert.ok(idx.defs.has('DoPascal'), 'Pascal precisa entrar');
    assert.ok(!idx.defs.has('Botao1'), '.dfm NÃO pode poluir o índice cross-file');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('buildIndex: cada símbolo carrega onde TERMINA, respeitando aninhamento', () => {
  // O fim é a linha antes do próximo símbolo de nível igual ou superior. Isso é o que
  // permite ler exatamente o necessário em vez de chutar 40 linhas.
  const raiz = projeto({
    'src/a.js': [
      'export function primeira() {',   // 1
      '  return 1;',                    // 2
      '}',                              // 3
      'export function segunda() {',    // 4
      '  return 2;',                    // 5
      '}',                              // 6
      '',                               // 7
    ].join('\n'),
  });
  try {
    const idx = buildIndex(raiz, {});
    const p = idx.defs.get('primeira')[0];
    assert.equal(p.line, 1);
    assert.equal(p.end, 3, 'precisa terminar na linha antes da próxima função');
    const s = idx.defs.get('segunda')[0];
    assert.equal(s.line, 4);
    assert.ok(s.end >= 6, 'último símbolo vai até o fim do arquivo');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('buildIndex: classe abrange seus métodos, não para no primeiro', () => {
  const raiz = projeto({
    'src/c.js': [
      'class Servico {',      // 1
      '  um() {}',            // 2
      '  dois() {}',          // 3
      '}',                    // 4
      'function fora() {}',   // 5
    ].join('\n'),
  });
  try {
    const idx = buildIndex(raiz, {});
    const classe = idx.defs.get('Servico')[0];
    // depth 0: só termina no próximo depth 0 (a função `fora`), não no método `um`.
    assert.equal(classe.end, 4, `classe deveria ir até 4, foi até ${classe.end}`);
    const metodo = idx.defs.get('um')[0];
    assert.equal(metodo.end, 2, 'método termina antes do método seguinte');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('REGRESSÃO: arquivo solto na RAIZ do repo entra no índice', () => {
  // Bug real e grave: `sourceDirs` só devolve a raiz quando NENHUMA pasta de convenção
  // existe. Num projeto com src/, tudo solto na raiz ficava invisível — no backend do
  // workspace de referência isso escondia o próprio index.js, e o índice respondia "não existe".
  const raiz = projeto({
    'src/dentro.js': 'export function dentroDeSrc() {}\n',
    'index.js': 'export function entrypointNaRaiz() {}\n',
  });
  try {
    const idx = buildIndex(raiz, {});
    assert.ok(idx.defs.has('dentroDeSrc'), 'src/ precisa continuar indexado');
    assert.ok(idx.defs.has('entrypointNaRaiz'), 'arquivo da raiz NÃO pode ficar invisível');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('REGRESSÃO: pasta funda continua sendo indexada', () => {
  // O limite antigo de 10 níveis escondia arquivo de monorepo — um caminho como
  // packages/app/src/features/x/components/forms/fields/Input.tsx já usa 9.
  const raiz = projeto({});
  const fundo = join(raiz, 'src', 'a/b/c/d/e/f/g/h/i/j/k/l');
  mkdirSync(fundo, { recursive: true });
  writeFileSync(join(fundo, 'fundo.js'), 'export function laNoFundo() {}\n');
  try {
    const idx = buildIndex(raiz, {});
    assert.ok(idx.defs.has('laNoFundo'), '13 níveis precisa ser alcançável');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('buildIndex: fallback por nome de ARQUIVO fica disponível', () => {
  const raiz = projeto({ 'src/meuServico.js': 'const x = 1;\n' });
  try {
    const idx = buildIndex(raiz, {});
    assert.ok(idx.byFile.has('meuServico'), 'basename precisa estar em byFile');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- exclusões de mapa

test('isDefaultUnmapped: config, teste e gerado saem sozinhos; código normal não', () => {
  for (const f of [
    'vite.config.ts', 'jest.config.js', 'src/foo.test.ts', 'src/bar.spec.jsx',
    'tipos.d.ts', 'src/__mocks__/api.js', 'src/__tests__/x.js', 'src/api.generated.ts',
    // `.mjs`/`.cjs`/`.mts` são a convenção de todo projeto ESM — inclusive a DESTE plugin,
    // cujos 130 testes moram em `.test.mjs` e apareciam no aviso de "sem mapa" toda sessão.
    // O padrão era `[jt]sx?`, que cobre `.test.js` e ignora `.test.mjs`: o filtro nasceu cego
    // para a própria convenção do repositório que o escreveu.
    'tests/hooks-e2e.test.mjs', 'x.spec.cjs', 'y.test.mts',
    // Os próprios scripts do plugin instalados no projeto. Achado instalando do zero: sem esta
    // linha, a PRIMEIRA sessão depois de instalar abre acusando 11 arquivos sem mapa, todos
    // dele mesmo — aviso impossível de atender, logo na primeira impressão.
    '.claude/scripts/symbols.mjs', '.claude/scripts/lib/roots.mjs',
    'sub/.claude/scripts/handoff.mjs',
    '.codex/scripts/codex-hook.mjs', '.codex/scripts/lib/roots.mjs',
    'sub/.codex/scripts/handoff.mjs',
  ]) {
    assert.ok(isDefaultUnmapped(f), `deveria ser excluído por padrão: ${f}`);
  }
  for (const f of [
    'src/services/pedido.js', 'src/index.ts', 'scripts/deploy.mjs',
    // A poda é de `.claude/scripts/` — a pasta do plugin —, não de `scripts/` em geral nem de
    // qualquer coisa sob `.claude/`. Alargar esconderia código de verdade em silêncio.
    '.claude/meu-codigo.js', '.codex/meu-codigo.js',
    'app/claude/scripts/x.js', 'app/codex/scripts/x.js',
  ]) {
    assert.ok(!isDefaultUnmapped(f), `NÃO deveria ser excluído: ${f}`);
  }
});

test('isIntentionallyUnmapped: caminho exato e prefixo de pasta, sem glob', () => {
  const lista = ['install.mjs', 'scripts/legacy/'];
  assert.ok(isIntentionallyUnmapped('install.mjs', lista));
  assert.ok(isIntentionallyUnmapped('scripts/legacy/velho.js', lista));
  assert.ok(!isIntentionallyUnmapped('outro/install.mjs', lista), 'match é do caminho todo');
  assert.ok(!isIntentionallyUnmapped('scripts/novo.js', lista));
  // Documentado como limitação: glob não funciona.
  assert.ok(!isIntentionallyUnmapped('a.config.js', ['*.config.js']));
});

test('parseFrontmatter: lê covers e escalares; rejeita arquivo sem frontmatter', () => {
  const fm = parseFrontmatter([
    '---', 'area: minha-area', 'covers:', '  - "src/a.js"', '  - src/b.js',
    'verified_at: abc1234', '---', '', '# corpo',
  ].join('\n'));
  assert.equal(fm.area, 'minha-area');
  assert.equal(fm.verified_at, 'abc1234');
  assert.deepEqual(fm.covers, ['src/a.js', 'src/b.js']);
  assert.equal(parseFrontmatter('# só um título\n'), null, 'sem frontmatter precisa devolver null');
});

// ---------------------------------------------------------------- auditoria de docs

test('plausible: aceita identificador de verdade, recusa palavra comum', () => {
  for (const s of ['minhaFuncao', 'TPedido', 'buildIndex']) {
    assert.ok(plausible(s), `deveria ser plausível: ${s}`);
  }
  for (const s of ['true', 'npm', 'main', 'node', 'abc']) {
    assert.ok(!plausible(s), `NÃO deveria ser plausível: ${s}`);
  }
});

test('ehCandidato: descarta trecho com espaço/pontuação e hash de commit', () => {
  assert.ok(ehCandidato('minhaFuncao'));
  assert.ok(!ehCandidato('foo bar'), 'com espaço não é símbolo');
  assert.ok(!ehCandidato('obj.prop'), 'com ponto não é símbolo');
  assert.ok(!ehCandidato('a1b2c3d'), 'hash de commit não é símbolo');
});

test('auditoria em duas fases: acha o que existe e acusa só o fantasma', () => {
  const raiz = projeto({
    'src/codigo.js': 'export function existeDeVerdade() {}\n',
  });
  mkdirSync(join(raiz, 'docs'), { recursive: true });
  const doc = join(raiz, 'docs', 'guia.md');
  writeFileSync(doc, 'Ver `existeDeVerdade` e também `sumiuHaTempos`.\n');
  try {
    const { textos, tokens } = collectCandidates([doc]);
    assert.ok(tokens.has('existeDeVerdade'));
    assert.ok(tokens.has('sumiuHaTempos'));
    assert.ok(textos.has(doc), 'texto do doc precisa ser reaproveitado, não relido');

    const { encontrados } = resolveExistence(raiz, {}, tokens);
    assert.ok(encontrados.has('existeDeVerdade'), 'símbolo real precisa ser encontrado');
    assert.ok(!encontrados.has('sumiuHaTempos'), 'símbolo inexistente não pode aparecer');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('auditoria: token que só existe na EMENDA entre dois arquivos não conta', () => {
  // O blob antigo concatenava tudo: um arquivo terminando em "Fo" seguido de outro
  // começando com "oBar" fazia "FooBar" parecer existir. Artefato, nunca resultado legítimo.
  const raiz = projeto({
    'src/a.js': 'const x = 1; // termina em Fo',
    'src/b.js': 'oBar();',
  });
  try {
    const { encontrados } = resolveExistence(raiz, {}, new Set(['FooBar']));
    assert.ok(!encontrados.has('FooBar'), 'não pode casar através da emenda entre arquivos');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('as duas versões do plugin não podem divergir', () => {
  // Elas JÁ divergiram: em 2026-08-04 o plugin.json dizia 1.2.0 e o package.json 1.1.0.
  // O Claude Code lê a do plugin.json; `npm` e qualquer publicação leem a do package.json.
  // Divergência aqui não quebra nada na hora — só faz o usuário reportar bug de uma versão
  // que não é a que está rodando. Este teste é o alarme que faltava.
  const raiz = localPath('..');
  const pkg = JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8'));
  const plug = JSON.parse(readFileSync(join(raiz, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plug.version, pkg.version, 'plugin.json e package.json precisam da mesma versão');
});

// ---- Leitura de arquivo real: o que existe no projeto dos OUTROS.
// Achados numa fixture hostil, os dois falhavam em SILENCIO — o simbolo simplesmente nao
// entrava no indice e a busca respondia "nao existe".
test('lerTexto: BOM não pode esconder o primeiro símbolo do arquivo', () => {
  // Editor da Microsoft grava com BOM por padrao. Sao 25 arquivos assim so no workspace
  // do workspace de referência. O `\uFEFF` cola na primeira linha e `^export function` deixa de casar.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-bom-'));
  try {
    const arq = join(raiz, 'comBom.ts');
    writeFileSync(arq, Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from('export function primeiraLinha() {}\n', 'utf8'),
    ]));
    assert.equal(readFileSync(arq, 'utf8').charCodeAt(0), 0xFEFF, 'a fixture precisa mesmo ter BOM');
    assert.equal(lerTexto(arq).charCodeAt(0), 'e'.charCodeAt(0), 'lerTexto tem que entregar sem BOM');
    assert.deepEqual(symbolsForCode(lerTexto(arq).split('\n')).map((s) => s.name), ['function primeiraLinha']);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('lerTexto: arquivo que não é UTF-8 não vira caractere de substituição', () => {
  // Delphi/Pascal legado e quase sempre cp1252 — a linguagem com mais codigo antigo e a mais
  // atingida. Como utf8 estrito, `Endereço` virava `Endere<FFFD>o` e a busca nao achava nada.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-latin-'));
  try {
    const arq = join(raiz, 'legado.pas');
    writeFileSync(arq, Buffer.from('unit Legado;\nfunction Endere\xE7o: string;\n', 'latin1'));
    assert.ok(readFileSync(arq, 'utf8').includes('\uFFFD'), 'a fixture precisa mesmo ser latin-1');
    const texto = lerTexto(arq);
    assert.ok(!texto.includes('\uFFFD'), 'lerTexto não pode devolver caractere de substituição');
    assert.ok(texto.includes('Endereço'), `o acento tem que sobreviver: ${JSON.stringify(texto)}`);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('lerTexto: arquivo binário e ilegível não derrubam nada', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-bin-'));
  try {
    const bin = join(raiz, 'binario.js');
    writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x1A, 0xFF, 0xFE]));
    assert.equal(typeof lerTexto(bin), 'string', 'binário tem que virar string, não exceção');
    assert.equal(lerTexto(join(raiz, 'nao-existe.js')), null, 'inexistente devolve null, não lança');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('a mensagem de "não leio essa linguagem" não pode mentir', () => {
  // Ela JA mentiu: Python e Go entraram no indice em 2026-08-04 e o texto seguiu dizendo
  // "Le: js/.../rs" — o diagnostico afirmava nao ler a linguagem que acabara de passar a
  // ler, e mandava o usuario embora sem motivo. Numa ferramenta cuja tese e "falha visivel",
  // errar na propria mensagem de falha e o pior lugar possivel.
  // A lista agora e GERADA de EXTENSOES_CODIGO; este teste garante que continue assim.
  for (const ext of EXTENSOES_CODIGO) {
    assert.ok(CODE_RE.test(`arquivo.${ext}`), `CODE_RE precisa casar .${ext}`);
    assert.ok(EXTENSOES_LIDAS.includes(ext), `a mensagem precisa citar .${ext}`);
    assert.ok(parserForExt(`.${ext}`), `parserForExt precisa ter parser para .${ext}`);
  }
  assert.ok(!CODE_RE.test('form.dfm'), '.dfm fica fora do índice cross-file de propósito');
});
