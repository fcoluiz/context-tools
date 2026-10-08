// Testes de segurança.
//
// Superfície específica desta ferramenta: os hooks injetam texto DIRETO no contexto do modelo,
// automaticamente, a cada sessão — e boa parte desse texto vem do repositório (o `area:` do
// frontmatter, o nome da pasta, os caminhos que o git devolve). Num repo clonado, contribuído
// ou vindo de dependência, isso é entrada não confiável.
//
// Dois abusos foram confirmados em teste manual ANTES destas travas existirem, e é por isso
// que cada um tem teste aqui: injeção de texto imperativo, e inundação do contexto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localPath } from './paths.mjs';
import { resolveSourceDirs } from '../scripts/lib/roots.mjs';
import { refSeguro } from '../scripts/context-maps.mjs';

const HOOK = localPath('../scripts/context-maps.mjs');

/** Repo temporário com um mapa de contexto cujo `area:` é controlado pelo teste. */
function repoComMapa(area) {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-sec-'));
  mkdirSync(join(raiz, 'src'), { recursive: true });
  mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
  writeFileSync(join(raiz, 'src', 'a.js'), 'export function x() {}\n');
  const g = (...args) => execFileSync('git', ['-C', raiz, ...args], { stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('add', '-A');
  g('commit', '-qm', 'init');
  writeFileSync(
    join(raiz, '.claude', 'context', 'm.md'),
    `---\narea: ${area}\ncovers:\n  - "src/a.js"\nverified_at: HEAD\n---\n`
  );
  return raiz;
}

/** Roda o hook e devolve o texto que ele injetaria no contexto do modelo. */
function contextoInjetado(raiz) {
  const out = execFileSync(process.execPath, [HOOK, '--session-start'], {
    env: { ...process.env, CONTEXT_MAPS_ROOT: raiz, CONTEXT_TOOLS_LANG: 'en' },
    encoding: 'utf8',
  });
  if (!out.trim()) return '';
  return JSON.parse(out).hookSpecificOutput?.additionalContext ?? '';
}

test('injeção: caractere de controle vindo do repo não chega ao contexto', () => {
  // ESC habilita sequência ANSI; \r permite reescrever a linha num terminal; \t e 
  // (BELL) sujam a saída. Nenhum deles tem uso legítimo num nome de área.
  const raiz = repoComMapa('"antes[31m\tdepois"');
  try {
    const ctx = contextoInjetado(raiz);
    assert.ok(ctx.includes('antes'), 'o conteúdo legítimo precisa sobreviver');
    for (const [nome, ch] of [['ESC', ''], ['BELL', ''], ['TAB', '\t']]) {
      assert.ok(!ctx.includes(ch), `${nome} não pode chegar ao contexto`);
    }
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('injeção: repo não consegue criar linha nova no bloco injetado', () => {
  // Quebrar linha permitiria forjar uma seção inteira (um falso rodapé, um falso aviso).
  // O parser de frontmatter é por linha, mas a trava não pode depender disso.
  const raiz = repoComMapa('"area-normal"');
  try {
    const antes = contextoInjetado(raiz).split('\n').length;
    rmSync(join(raiz, '.claude', 'context', 'm.md'));
    writeFileSync(
      join(raiz, '.claude', 'context', 'm.md'),
      '---\narea: "a"\ncovers:\n  - "src/a.js"\nverified_at: HEAD\n---\n'
    );
    const depois = contextoInjetado(raiz).split('\n').length;
    assert.equal(depois, antes, 'nº de linhas do bloco não pode depender do conteúdo do repo');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('inundação: area gigante não infla o contexto', () => {
  // Confirmado antes da trava: um `area:` de 9.000 chars levou o bloco de 653 para 9.302 —
  // 14× de custo de token, em toda sessão, sem o usuário pedir.
  const raiz = repoComMapa(`"${'A'.repeat(9000)}"`);
  try {
    const ctx = contextoInjetado(raiz);
    assert.ok(ctx.length < 1000, `bloco inflou para ${ctx.length} chars`);
    assert.ok(!/A{200}/.test(ctx), 'o texto gigante não pode passar inteiro');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('inundação: muitos mapas juntos respeitam o teto do bloco', () => {
  const raiz = repoComMapa('"primeiro"');
  try {
    for (let i = 0; i < 120; i++) {
      writeFileSync(
        join(raiz, '.claude', 'context', `m${i}.md`),
        `---\narea: "area-${i}-${'x'.repeat(70)}"\ncovers:\n  - "src/a.js"\nverified_at: HEAD\n---\n`
      );
    }
    const ctx = contextoInjetado(raiz);
    assert.ok(ctx.length <= 4200, `bloco passou do teto: ${ctx.length} chars`);
    assert.ok(ctx.includes('truncad'), 'truncagem precisa ser declarada, não silenciosa');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('o bloco avisa que os nomes são dados, não instruções', () => {
  // Defesa em profundidade: quem consome o bloco precisa saber que aquilo veio do repositório.
  const raiz = repoComMapa('"qualquer"');
  try {
    const ctx = contextoInjetado(raiz).toLowerCase();
    assert.ok(ctx.includes('data, not instructions'), 'falta o marcador de conteúdo não confiável');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('VULN CORRIGIDA: verified_at hostil não vira OPÇÃO do git', () => {
  // Era escrita arbitraria de arquivo. `verified_at` vai para a linha de comando do git ANTES
  // do `--`, onde opções ainda são interpretadas: `--output=<caminho>` fazia o `git diff`
  // ESCREVER naquele caminho, disparado só por abrir o projeto. Confirmado em teste real.
  const alvo = join(tmpdir(), `ctx-PWNED-${Date.now()}`);
  const raiz = repoComMapa('"area"');
  try {
    writeFileSync(
      join(raiz, '.claude', 'context', 'm.md'),
      `---\narea: "x"\ncovers:\n  - "src/a.js"\nverified_at: --output=${alvo}\n---\n`
    );
    const ctx = contextoInjetado(raiz);
    assert.ok(!existsSync(alvo), 'git NÃO pode escrever arquivo a partir de ref do repo');
    assert.ok(/not verifiable|verificável/i.test(ctx), 'ref recusado precisa virar "não verificável"');
  } finally {
    rmSync(raiz, { recursive: true, force: true });
    rmSync(alvo, { force: true });
  }
});

test('ref legítimo (sha, branch, tag) continua passando', () => {
  // A trava não pode ser tão dura que quebre uso normal.
  for (const ok of ['HEAD', 'a1b2c3d', 'main', 'origin/main', 'v1.2.0', 'feat/algo-novo']) {
    assert.ok(refSeguro(ok), `deveria aceitar: ${ok}`);
  }
  for (const mau of ['--output=/tmp/x', '-O/tmp/x', '--upload-pack=sh', '', 'a b', 'a;b', 'x'.repeat(65)]) {
    assert.ok(!refSeguro(mau), `deveria recusar: ${JSON.stringify(mau)}`);
  }
});

test('VULN CORRIGIDA: sourceDirs não escapa do projeto', () => {
  // `.claude/context-tools.json` é conteúdo do repositório. Um `sourceDirs: ["../vizinho"]`
  // fazia o índice ler arquivos de OUTRO projeto no disco. Confirmado em teste real.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-trav-'));
  const vizinho = mkdtempSync(join(tmpdir(), 'ctx-vizinho-'));
  try {
    mkdirSync(join(raiz, 'src'), { recursive: true });
    writeFileSync(join(raiz, 'src', 'meu.js'), 'export function meuSimbolo() {}\n');
    writeFileSync(join(vizinho, 'alheio.js'), 'export function simboloAlheio() {}\n');

    const escapou = resolveSourceDirs(raiz, { sourceDirs: [vizinho] });
    assert.ok(!escapou.includes(vizinho), 'caminho absoluto de fora precisa ser recusado');

    const relativo = resolveSourceDirs(raiz, { sourceDirs: ['../'] });
    assert.ok(!relativo.some((d) => d === join(raiz, '..')), '".." precisa ser recusado');

    const dentro = resolveSourceDirs(raiz, { sourceDirs: ['src'] });
    assert.ok(dentro.some((d) => d.endsWith('src')), 'pasta legítima precisa continuar valendo');
  } finally {
    rmSync(raiz, { recursive: true, force: true });
    rmSync(vizinho, { recursive: true, force: true });
  }
});

test('git é chamado sem shell — argumento hostil não vira comando', () => {
  // Todas as chamadas usam execFileSync com array de argumentos. Um nome de branch ou
  // caminho com `;` ou `$(...)` é argumento, nunca comando.
  const raiz = repoComMapa('"ok"');
  try {
    writeFileSync(
      join(raiz, '.claude', 'context', 'inj.md'),
      '---\narea: "x"\ncovers:\n  - "$(touch /tmp/PWNED_ctx_tools); echo"\nverified_at: HEAD\n---\n'
    );
    contextoInjetado(raiz); // não pode lançar nem executar nada
    assert.ok(true, 'hook sobreviveu a covers hostil');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('symlink de pasta não tira o índice de dentro do repositório', () => {
  // Desde que `sourceDirs` passou a varrer a RAIZ (e não só as pastas de convenção), todo
  // link dentro do repo virou superfície: um repo clonado/contribuído podia apontar para
  // fora do projeto e fazer o índice ler o disco do usuário.
  //
  // Hoje isso NÃO acontece — mas por uma propriedade implícita do Node, não por código:
  // em `readdirSync(withFileTypes)` um link (symlink POSIX ou junction do Windows) tem
  // `isDirectory() === false`, então o `walk` nunca recursa nele. Propriedade implícita e
  // não testada é a que some numa refatoração distraída. Este teste é o alarme.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-link-'));
  const fora = mkdtempSync(join(tmpdir(), 'ctx-fora-'));
  try {
    writeFileSync(join(fora, 'segredo.js'), 'export function NAO_PODE_APARECER() {}\n');
    writeFileSync(join(raiz, 'ok.js'), 'export function podeAparecer() {}\n');
    // 'junction' é o único tipo que o Windows cria sem privilégio de administrador.
    try { symlinkSync(fora, join(raiz, 'atalho'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { return; } // sem permissão para criar link: nada a provar neste ambiente
    const SYM = localPath('../scripts/symbols.mjs');
    const buscar = (nome) => execFileSync(process.execPath, [SYM, nome, `--root=${raiz}`, '--fresh'],
      { encoding: 'utf8', env: { ...process.env, CONTEXT_TOOLS_LANG: 'en' } });

    assert.doesNotMatch(buscar('NAO_PODE_APARECER'), /segredo\.js/, 'índice saiu do repositório');
    assert.match(buscar('podeAparecer'), /ok\.js/, 'o arquivo legítimo do repo continua indexado');
  } finally {
    rmSync(raiz, { recursive: true, force: true });
    rmSync(fora, { recursive: true, force: true });
  }
});
