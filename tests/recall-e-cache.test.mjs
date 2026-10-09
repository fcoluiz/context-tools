// Dois testes que não são unitários: medem propriedades do sistema inteiro.
//
// 1. RECALL — o índice acha os símbolos que existem? É a métrica que diz se vale adicionar
//    padrão novo ao parser. Medir antes de codar evitou inchar o parser com regex que ninguém
//    usa: a medição real (10 buscas) mostrou que as 2 falhas eram do MESMO tipo (nome de
//    módulo), resolvido com fallback barato em vez de mais regex.
//
// 2. CACHE — o tier B pode ficar mais rápido, nunca pode MENTIR. Cada cenário aqui é um jeito
//    do cache servir dado velho sem ninguém perceber.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

import { buildIndex, CACHE_TIER_MIN_FILES, escopoLabel, reportOne, irmaosPorPrefixo } from '../scripts/symbols.mjs';
import { findRepos, resolveExtraRepos, extraReposDoCodeWorkspace } from '../scripts/lib/roots.mjs';
import { spawnSync } from 'node:child_process';

// Importado, nunca copiado: com o número à mão, baixar o limiar no código deixaria estes
// testes gerando arquivos demais e medindo outra coisa — sem falhar, que é o pior jeito.
const LIMIAR_CACHE = CACHE_TIER_MIN_FILES;

function projetoVazio() {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-recall-'));
  mkdirSync(join(raiz, 'src'), { recursive: true });
  return raiz;
}

// ------------------------------------------------------------------ recall

test('recall: índice acha os padrões de declaração que aparecem em código real', () => {
  const raiz = projetoVazio();
  // Cada par é [código, símbolo que PRECISA ser encontrado].
  const casos = [
    ['export function declarada() {}', 'declarada'],
    ['export const arrow = () => {};', 'arrow'],
    ['export const assincrona = async () => {};', 'assincrona'],
    ['const ctrl = handleController(async (req) => {});', 'ctrl'],
    ['export class MinhaClasse {}', 'MinhaClasse'],
    ['class ComMetodo {\n  meuMetodo() {}\n}', 'meuMetodo'],
    ['export const CONSTANTE = 42;', 'CONSTANTE'],
    ['export default function padrao() {}', 'padrao'],
    ['export async function assinc2() {}', 'assinc2'],
    ['function* gerador() {}', 'gerador'],
  ];
  casos.forEach(([src], i) => writeFileSync(join(raiz, 'src', `c${i}.js`), src + '\n'));

  try {
    const idx = buildIndex(raiz, {});
    const perdidos = casos.filter(([, nome]) => !idx.defs.has(nome)).map(([, n]) => n);
    // Falha COM a lista: se um padrão novo passar a ser perdido, o teste diz qual.
    assert.deepEqual(perdidos, [], `padrões perdidos pelo índice: ${perdidos.join(', ')}`);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('recall: o que o índice NÃO vê está documentado e continua não visto', () => {
  // Estes são limites de desenho (regex, não AST). O teste existe para que virem decisão
  // consciente: se um dia passarem a ser vistos, alguém mudou o parser de propósito.
  const raiz = projetoVazio();
  writeFileSync(join(raiz, 'src', 'x.js'), [
    'function externa() {',
    '  const variavelLocal = 1;',
    '  return variavelLocal;',
    '}',
    'const config = { chaveDeConfig: true };',
  ].join('\n'));
  try {
    const idx = buildIndex(raiz, {});
    assert.ok(idx.defs.has('externa'), 'função de topo precisa ser vista');
    assert.ok(!idx.defs.has('variavelLocal'), 'variável local: fora do escopo por desenho');
    assert.ok(!idx.defs.has('chaveDeConfig'), 'chave de objeto: fora do escopo por desenho');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('recall: cópias do IDE do Delphi (__history, __recovery) não entram no índice', () => {
  // Caso real: a cópia em `__recovery` saía como definição exata ao lado da unit oficial.
  const raiz = projetoVazio();
  const unit = 'unit UCadX;\ninterface\nprocedure Gravar;\nimplementation\nprocedure Gravar;\nbegin\nend;\nend.\n';
  writeFileSync(join(raiz, 'src', 'UCadX.pas'), unit);
  for (const copia of ['__history', '__recovery']) {
    mkdirSync(join(raiz, 'src', copia), { recursive: true });
    writeFileSync(join(raiz, 'src', copia, 'UCadX.pas'), unit);
  }
  try {
    const idx = buildIndex(raiz, {});
    const indexados = idx.files.map((f) => f.replace(/\\/g, '/'));
    assert.deepEqual(indexados.filter((f) => /__history|__recovery/.test(f)), [],
      `cópia do IDE indexada: ${indexados.join(', ')}`);
    assert.ok(indexados.some((f) => f.endsWith('src/UCadX.pas')), 'a unit oficial continua indexada');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ escopo

test('escopoLabel: vazio, um repo, e mais de três repos trunca com contador', () => {
  assert.equal(escopoLabel([]), '');
  assert.equal(escopoLabel(undefined), '');
  assert.equal(escopoLabel(['AppServer']), 'AppServer');
  assert.equal(escopoLabel(['a', 'b', 'c']), 'a, b, c');
  assert.equal(escopoLabel(['a', 'b', 'c', 'd', 'e']), 'a, b, c, +2');
});

test('buildIndex: repos varridos aparecem em .repos, e a resposta de reportOne nomeia o escopo', () => {
  // Caso real que motivou isto: um projeto Delphi (AppServer) tem uma dependência num
  // repo IRMÃO (AppConnection), referenciada só por caminho relativo num .dpr — fora da
  // raiz que o índice varre. O índice não pode "ver" o repo irmão (findRepos nunca sobe para
  // fora de `root` — mesma fronteira que a correção de `sourceDirs: "../vizinho"` fixou como
  // intencional). O que ele PODE fazer é dizer qual foi o escopo realmente varrido, para quem
  // lê a resposta perceber a fronteira em vez de confiar cegamente num acerto de outro módulo.
  const raiz = projetoVazio();
  writeFileSync(join(raiz, 'src', 'a.js'), 'export function alfa() {}\n');
  try {
    const idx = buildIndex(raiz, {});
    assert.deepEqual(idx.repos, [basename(raiz)]);

    const acerto = reportOne('alfa', idx, { wantAll: false, ms: 1 }).join('\n');
    assert.match(acerto, /scope:/, `resposta de acerto precisa nomear o escopo: ${acerto}`);

    const semAcerto = reportOne('NaoExisteEmLugarNenhum', idx, { wantAll: false, ms: 1 }).join('\n');
    assert.match(semAcerto, /scope:/, `resposta de "não achei" também precisa nomear o escopo: ${semAcerto}`);
    assert.match(semAcerto, /sibling repo/i, 'miss precisa admitir que não descarta um repo fora do escopo');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('reportOne: busca qualificada (Classe.Metodo) acha o mesmo símbolo que a busca nua', () => {
  // Caso real que motivou isto: `symbols.mjs TExporter.RegistroABC` voltava vazio mesmo com
  // `procedure TExporter.RegistroABC` existindo no índice — porque `bareName` já indexa só
  // `RegistroABC` (ver QUALIFICADOR_RE), e a busca não fazia o mesmo corte do lado da query.
  const raiz = projetoVazio();
  writeFileSync(join(raiz, 'src', 'fiscal.pas'), [
    'unit fiscal;',
    'interface',
    '  procedure TExporter.RegistroABC;',
    'implementation',
    '  procedure TExporter.RegistroABC;',
    '  begin',
    '  end;',
    'end.',
    '',
  ].join('\n'));
  try {
    const idx = buildIndex(raiz, {});
    const nua = reportOne('RegistroABC', idx, { wantAll: false, ms: 1 }).join('\n');
    const qualificada = reportOne('TExporter.RegistroABC', idx, { wantAll: false, ms: 1 }).join('\n');
    assert.match(nua, /RegistroABC/);
    assert.match(qualificada, /RegistroABC/, `busca qualificada devia achar o mesmo símbolo: ${qualificada}`);
    assert.doesNotMatch(qualificada, /no DEFINITION|nenhuma DEFINIÇÃO/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ irmãos por prefixo

test('irmaosPorPrefixo: acha nome parecido no MESMO arquivo, ordenado pelo prefixo mais longo', () => {
  const byFilePos = new Map([
    ['fiscal.pas', [
      { name: 'RegistroABC' }, { name: 'RegistroXYZ' }, { name: 'RegistroLMNO' },
      { name: 'ValidaCampo' }, { name: 'RegistroABC' }, // duplicata (decl+impl) não pode duplicar na lista
    ]],
    ['outro.pas', [{ name: 'RegistroXYZ' }]], // arquivo diferente não pode entrar
  ]);
  const r = irmaosPorPrefixo('RegistroABC', 'fiscal.pas', byFilePos);
  assert.deepEqual(r.nomes.sort(), ['RegistroLMNO', 'RegistroXYZ']);
  assert.equal(r.total, 2);
});

test('irmaosPorPrefixo: prefixo curto demais (abaixo do limiar) não conta como irmão', () => {
  const byFilePos = new Map([['a.js', [{ name: 'get' }, { name: 'getUserById' }]]]);
  // "get" tem só 3 chars de prefixo com "getUserById" — abaixo do limiar de 6, não é irmão.
  const r = irmaosPorPrefixo('getUserById', 'a.js', byFilePos);
  assert.deepEqual(r.nomes, []);
});

test('irmaosPorPrefixo: corta em 5 e informa o resto', () => {
  const nomes = ['RegistroA', 'RegistroB', 'RegistroC', 'RegistroD', 'RegistroE', 'RegistroF', 'RegistroG'];
  const byFilePos = new Map([['f.pas', nomes.map((name) => ({ name }))]]);
  const r = irmaosPorPrefixo('RegistroZ', 'f.pas', byFilePos);
  assert.equal(r.nomes.length, 5);
  assert.equal(r.total, 7);
});

test('symbols.mjs: acerto real mostra os irmãos por prefixo, sem quebrar nem inflar o total de linhas', () => {
  // Caso real que motivou isto: TExporter.RegistroABC tinha irmãos óbvios (RegistroXYZ,
  // RegistroLMNO) que só apareceram numa busca de subagente bem mais cara. A ferramenta
  // pontual devia ter mostrado isso de graça, com dado que já estava no índice.
  const raiz = projetoVazio();
  writeFileSync(join(raiz, 'src', 'fiscal.js'), [
    'export function registroPNC() {}',
    'export function registroNVC() {}',
    'export function registroNFME() {}',
    'export function outraCoisaQualquer() {}',
  ].join('\n') + '\n');
  try {
    const idx = buildIndex(raiz, {});
    const linhas = reportOne('registroPNC', idx, { wantAll: false, ms: 1 });
    const texto = linhas.join('\n');
    assert.match(texto, /registroNVC/, `precisa listar o irmão: ${texto}`);
    assert.match(texto, /registroNFME/, `precisa listar o irmão: ${texto}`);
    assert.doesNotMatch(texto, /outraCoisaQualquer/, 'símbolo sem prefixo parecido não pode aparecer como irmão');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('findRepos: workspace MISTO — subpasta sem .git não some quando outra subpasta tem', () => {
  // Caso real (2026-08-05): raiz sem `.git` própria, `AppServer` com `.git`,
  // `AppConnection`/`AppDesktop`/`shared` sem `.git` próprio (pastas soltas do mesmo
  // workspace). Antes do fix, o laço só empurrava subpasta pra lista quando ELA tinha `.git`,
  // e o fallback "trata tudo sem git" só disparava quando NENHUMA subpasta em lugar nenhum
  // tivesse `.git` — bastava UM repo git existir para apagar os vizinhos sem versionamento em
  // silêncio, mesmo com requireGit:false.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-misto-'));
  try {
    mkdirSync(join(raiz, 'AppServer'), { recursive: true });
    mkdirSync(join(raiz, 'AppServer', '.git'));
    mkdirSync(join(raiz, 'AppConnection'), { recursive: true });
    writeFileSync(join(raiz, 'AppConnection', 'uExporter.pas'), 'procedure TExporter.RegistroXYZ;\nbegin\nend;\n');
    mkdirSync(join(raiz, 'shared'), { recursive: true });

    const appServer = join(raiz, 'AppServer');
    const repos = findRepos(raiz, {
      requireGit: false,
      gitProbe: (p) => p === appServer,
    });
    const nomes = repos.map((r) => r.name).sort();
    assert.deepEqual(nomes, ['AppConnection', 'AppServer', 'shared'], `pasta sem .git não pode sumir: ${nomes.join(', ')}`);
    const conn = repos.find((r) => r.name === 'AppConnection');
    assert.equal(conn.git, false, 'sem .git próprio, tem que vir marcada git:false');

    // Efeito ponta a ponta: o índice de símbolos agora ENXERGA o método dentro da pasta sem git.
    const idx = buildIndex(raiz, {});
    assert.ok(idx.defs.has('RegistroXYZ'), 'symbols.mjs precisa achar o símbolo da pasta sem .git');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('findRepos: raiz COM .git não duplica arquivo de subpasta sem .git', () => {
  // Quando a raiz TEM `.git`, ela já é varrida inteira (sourceDirs devolve a raiz, walk é
  // recursivo) — subpasta sem `.git` não pode virar uma segunda entrada em `findRepos`, ou o
  // mesmo arquivo seria contado duas vezes.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-comgit-'));
  try {
    spawnSync('git', ['-C', raiz, 'init', '-q'], { stdio: 'ignore' });
    mkdirSync(join(raiz, 'sub'), { recursive: true });
    writeFileSync(join(raiz, 'sub', 'a.js'), 'export function unica() {}\n');

    const repos = findRepos(raiz, { requireGit: false });
    assert.deepEqual(repos.map((r) => r.name), ['.'], 'subpasta sem .git não vira repo separado quando a raiz já tem .git');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('findRepos: nenhuma subpasta com .git continua caindo no fallback antigo (raiz inteira = 1 projeto)', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-semgit-'));
  try {
    mkdirSync(join(raiz, 'a'), { recursive: true });
    mkdirSync(join(raiz, 'b'), { recursive: true });
    const repos = findRepos(raiz, { requireGit: false });
    assert.deepEqual(repos, [{ name: '.', path: raiz, git: false }], 'sem git em lugar nenhum, comportamento antigo precisa continuar');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('findRepos: .git invalido nao bloqueia o fallback sem Git', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-git-invalido-'));
  try {
    // Um marcador .git sozinho nao transforma a pasta em repositorio utilizavel.
    mkdirSync(join(raiz, '.git'));
    mkdirSync(join(raiz, 'src'));
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function semGitReal() {}\n');

    const semGit = findRepos(raiz, { requireGit: false });
    assert.deepEqual(semGit, [{ name: '.', path: raiz, git: false }]);
    assert.deepEqual(findRepos(raiz), [], 'consumidor que exige Git nao deve aceitar .git invalido');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ extraRepos

test('resolveExtraRepos: aceita pasta irmã (um nível acima), recusa mais fundo, recusa inexistente', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-extra-'));
  try {
    mkdirSync(join(raiz, 'AppServer'), { recursive: true });
    mkdirSync(join(raiz, 'AppConnection'), { recursive: true });
    const root = join(raiz, 'AppServer');

    const ok = resolveExtraRepos(root, { extraRepos: ['../AppConnection'] });
    assert.deepEqual(ok, [join(raiz, 'AppConnection')]);

    const fundoDemais = resolveExtraRepos(root, { extraRepos: ['../../fora-do-workspace'] });
    assert.deepEqual(fundoDemais, [], 'mais de um nível acima da raiz precisa ser recusado');

    const inexistente = resolveExtraRepos(root, { extraRepos: ['../NaoExiste'] });
    assert.deepEqual(inexistente, [], 'pasta que não existe precisa ser recusada, não inventada');

    assert.deepEqual(resolveExtraRepos(root, {}), [], 'sem extraRepos na config, lista vazia');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('findRepos: extraRepos entra mesmo com a raiz tendo .git próprio (caso real: sessão fixa em AppServer)', () => {
  // Caso real (2026-08-05): sessão PRECISA continuar em AppServer (workspace pai tem
  // dezenas de outros projetos que não interessam), mas AppConnection — sem `.git`
  // próprio — precisa ser indexado também. Nem o workspace-misto (raiz sem git) nem o
  // findRepos padrão (raiz com git só varre a si mesma) resolvem isso sozinhos.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-extra-git-'));
  try {
    mkdirSync(join(raiz, 'AppServer'), { recursive: true });
    spawnSync('git', ['-C', join(raiz, 'AppServer'), 'init', '-q'], { stdio: 'ignore' });
    mkdirSync(join(raiz, 'AppConnection'), { recursive: true });

    const root = join(raiz, 'AppServer');
    const repos = findRepos(root, { requireGit: false, cfg: { extraRepos: ['../AppConnection'] } });
    const nomes = repos.map((r) => r.name).sort();
    assert.deepEqual(nomes, ['.', 'AppConnection']);
    const extra = repos.find((r) => r.name === 'AppConnection');
    assert.equal(extra.git, false);
    assert.equal(extra.path, join(raiz, 'AppConnection'));
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('findRepos: raiz sem .git permanece quando extraRepos fixa o projeto atual', () => {
  const pai = mkdtempSync(join(tmpdir(), 'ctx-extra-semgit-'));
  try {
    const raiz = join(pai, 'AppServer');
    const shared = join(pai, 'shared');
    mkdirSync(raiz, { recursive: true });
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(raiz, 'uGerenciador.pas'), 'procedure TGerenciador.Consultar;\nbegin\nend;\n');
    writeFileSync(join(shared, 'uNFSeService.pas'), 'procedure TNFSeService.Consultar;\nbegin\nend;\n');

    const cfg = { extraRepos: ['../shared'] };
    const repos = findRepos(raiz, { requireGit: false, cfg });
    assert.deepEqual(repos.map((r) => r.name).sort(), ['.', 'shared']);

    const idx = buildIndex(raiz, cfg);
    assert.ok(idx.defs.has('Consultar'), 'o índice precisa manter o código da raiz junto do extraRepo');
    assert.ok(idx.byFile.has('uNFSeService'), 'o extraRepo também precisa continuar indexado');
  } finally { rmSync(pai, { recursive: true, force: true }); }
});

test('findRepos: extraRepos não duplica se a pasta já foi achada pelo laço normal', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-extra-dup-'));
  try {
    mkdirSync(join(raiz, 'sub'), { recursive: true });
    spawnSync('git', ['-C', join(raiz, 'sub'), 'init', '-q'], { stdio: 'ignore' });
    // "sub" já tem .git próprio — é achada pelo laço normal. Citá-la de novo em extraRepos
    // (redundante, mas pode acontecer) não pode gerar entrada duplicada.
    const repos = findRepos(raiz, { requireGit: false, cfg: { extraRepos: ['sub'] } });
    const subs = repos.filter((r) => r.path === join(raiz, 'sub'));
    assert.equal(subs.length, 1, 'não pode duplicar a mesma pasta só porque também foi citada em extraRepos');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('extraReposDoCodeWorkspace: deriva sozinho de um .code-workspace na pasta pai, sem config nenhuma', () => {
  // Caso real: usuário já tem o workspace do VS Code com as pastas curadas — não devia
  // precisar repetir essa decisão numa segunda config editada à mão.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-vscode-'));
  try {
    mkdirSync(join(raiz, 'AppServer'), { recursive: true });
    mkdirSync(join(raiz, 'AppConnection'), { recursive: true });
    writeFileSync(join(raiz, 'workspace.code-workspace'), JSON.stringify({
      folders: [{ path: 'AppServer' }, { path: 'AppConnection' }],
    }));
    const root = join(raiz, 'AppServer');

    const extras = extraReposDoCodeWorkspace(root);
    assert.deepEqual(extras, [join(raiz, 'AppConnection')], 'a própria raiz não conta como "extra"');

    // Ponta a ponta: resolveExtraRepos (sem cfg.extraRepos nenhum) já acha sozinho.
    assert.deepEqual(resolveExtraRepos(root, {}), [join(raiz, 'AppConnection')]);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('resolveExtraRepos: config explícita (mesmo vazia) desliga a detecção automática do .code-workspace', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-vscode-off-'));
  try {
    mkdirSync(join(raiz, 'AppServer'), { recursive: true });
    mkdirSync(join(raiz, 'AppConnection'), { recursive: true });
    mkdirSync(join(raiz, 'shared'), { recursive: true });
    writeFileSync(join(raiz, 'workspace.code-workspace'), JSON.stringify({
      folders: [{ path: 'AppServer' }, { path: 'AppConnection' }],
    }));
    const root = join(raiz, 'AppServer');

    assert.deepEqual(resolveExtraRepos(root, { extraRepos: [] }), [], 'extraRepos:[] é "decidi não usar nenhum", não "detecte sozinho"');

    // Config explícita com uma pasta DIFERENTE da que o .code-workspace listaria — se a
    // detecção automática vazasse por cima, "AppConnection" apareceria também.
    const explicita = resolveExtraRepos(root, { extraRepos: ['../shared'] });
    assert.deepEqual(explicita, [join(raiz, 'shared')], 'config explícita vence — não mistura com o que o .code-workspace listaria');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('extraReposDoCodeWorkspace: pasta citada no .code-workspace mas fora da subárvore do pai é ignorada', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-vscode-fora-'));
  try {
    mkdirSync(join(raiz, 'AppServer'), { recursive: true });
    writeFileSync(join(raiz, 'workspace.code-workspace'), JSON.stringify({
      folders: [{ path: 'AppServer' }, { path: '../../fora-do-workspace' }],
    }));
    const root = join(raiz, 'AppServer');
    assert.deepEqual(extraReposDoCodeWorkspace(root), [], 'entrada fora da subárvore do pai não pode passar, mesmo vindo do .code-workspace');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ cache

/** Projeto grande o bastante para acionar o tier B. */
function projetoGrande() {
  const raiz = projetoVazio();
  for (let i = 0; i < LIMIAR_CACHE + 10; i++) {
    writeFileSync(join(raiz, 'src', `f${i}.js`), `export function fn${i}() {}\n`);
  }
  return raiz;
}

test('cache: acima do limiar entra em tier B e reaproveita na 2ª chamada', () => {
  const raiz = projetoGrande();
  try {
    const a = buildIndex(raiz, {});
    assert.equal(a.tier, 'B', 'acima do limiar precisa cachear');
    assert.ok(a.reread > 0 && a.reused === 0, '1ª chamada lê tudo');

    const b = buildIndex(raiz, {});
    assert.equal(b.tier, 'B');
    assert.ok(b.reused > 0, '2ª chamada precisa reaproveitar');
    assert.equal(b.reread, 0, 'nada mudou: não pode reler nada');
    assert.equal(b.defs.size, a.defs.size, 'cache não pode alterar o resultado');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('cache: NÃO pode mentir quando um arquivo muda', () => {
  const raiz = projetoGrande();
  try {
    buildIndex(raiz, {});                       // popula
    appendFileSync(join(raiz, 'src', 'f7.js'), 'export function simboloNovo() {}\n');
    const idx = buildIndex(raiz, {});
    assert.ok(idx.defs.has('simboloNovo'), 'símbolo novo em arquivo alterado precisa aparecer');
    assert.equal(idx.reread, 1, 'só o arquivo alterado deve ser relido');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('cache: NÃO pode mentir quando um arquivo é criado ou removido', () => {
  const raiz = projetoGrande();
  try {
    buildIndex(raiz, {});
    writeFileSync(join(raiz, 'src', 'zNovo.js'), 'export function nascido() {}\n');
    assert.ok(buildIndex(raiz, {}).defs.has('nascido'), 'arquivo novo precisa entrar');

    unlinkSync(join(raiz, 'src', 'zNovo.js'));
    assert.ok(!buildIndex(raiz, {}).defs.has('nascido'), 'arquivo removido precisa sair');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('cache: --fresh ignora o cache e reconstrói tudo', () => {
  const raiz = projetoGrande();
  try {
    buildIndex(raiz, {});
    const f = buildIndex(raiz, {}, { fresh: true });
    assert.equal(f.tier, 'A', '--fresh precisa sair do modo cache');
    assert.equal(f.reused, 0, '--fresh não pode reaproveitar nada');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('cache: arquivo corrompido não derruba nada — reconstrói', () => {
  const raiz = projetoGrande();
  try {
    buildIndex(raiz, {});
    writeFileSync(join(raiz, '.claude', '.symbols-cache.json'), 'isto nao e json {{{');
    const idx = buildIndex(raiz, {});
    assert.ok(idx.defs.size > 0, 'cache corrompido precisa virar rebuild, não erro');
    assert.ok(idx.reread > 0, 'precisa ter relido de verdade');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('cache: não vaza entre projetos diferentes', () => {
  // O cache guarda `root`. Copiar a pasta .claude para outro projeto apontaria símbolos
  // para caminhos que não existem lá.
  const a = projetoGrande();
  const b = projetoGrande();
  try {
    buildIndex(a, {});
    const cacheA = join(a, '.claude', '.symbols-cache.json');
    mkdirSync(join(b, '.claude'), { recursive: true });
    writeFileSync(join(b, '.claude', '.symbols-cache.json'), readFileSync(cacheA, 'utf8'));
    const idx = buildIndex(b, {});
    assert.ok(idx.reread > 0, 'cache de outro projeto precisa ser descartado');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
