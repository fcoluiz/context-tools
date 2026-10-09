// refs (quem usa X) e impact (o que está em jogo antes de mudar X), num projeto montado aqui:
// uma função, quem a chama, menções que NÃO são uso (comentário, string), um teste que a importa,
// histórico de git em que dois arquivos mudam juntos e um mapa de contexto que cobre a definição.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { localPath } from './paths.mjs';
import { findReferences, formatReferences } from '../scripts/refs.mjs';
import { buildImpact, formatImpact } from '../scripts/impact.mjs';
import { makeT } from '../scripts/lib/i18n.mjs';

const SCRIPTS = localPath('../scripts', import.meta.url);
const t = makeT('en');

function git(dir, ...args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
}

function projeto() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-imp-'));
  const w = (rel, content) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), content); };
  w('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  w('src/pedido.js', 'export function confirmar(p) {\n  return p;\n}\n');
  w('src/tela.js', "import { confirmar } from './pedido.js';\nexport function salvar() {\n  // confirmar aqui é comentário\n  return confirmar(1);\n}\n");
  w('src/msg.js', 'export const m = "confirmar";\n');
  w('tests/pedido.test.js', "import { confirmar } from '../src/pedido.js';\ntest('x', () => confirmar(1));\n");
  w('.claude/context/pedido.md', '---\narea: pedido\ncovers:\n  - "src/pedido.js"\nverified_at: HEAD\nverified_date: 2026-10-09\n---\n# Pedido\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'inicio');
  // Quatro commits em que pedido.js e tela.js mudam juntos: o limiar mínimo de co-mudança.
  for (let i = 0; i < 4; i++) {
    appendFileSync(join(dir, 'src/pedido.js'), `// v${i}\n`);
    appendFileSync(join(dir, 'src/tela.js'), `// v${i}\n`);
    git(dir, 'commit', '-q', '-am', `junto ${i}`);
  }
  return dir;
}

const env = (dir) => ({ ...process.env, CONTEXT_TOOLS_LANG: 'en', CONTEXT_TOOLS_HOST: 'claude', CONTEXT_TOOLS_STATE_DIR: join(dir, '.state') });

test('refs: uso real fora da definição, com o símbolo que o contém; comentário e string ficam de fora', () => {
  const dir = projeto();
  const antes = process.env.CONTEXT_TOOLS_STATE_DIR;
  process.env.CONTEXT_TOOLS_STATE_DIR = join(dir, '.state');
  try {
    const r = findReferences(dir, 'confirmar');
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.definitions.map((d) => d.file), ['src/pedido.js']);
    const tela = r.references.find((x) => x.file === 'src/tela.js');
    assert.deepEqual(tela.uses, [{ line: 1, in: null }, { line: 4, in: 'function salvar' }]);
    assert.ok(r.references.some((x) => x.file === 'tests/pedido.test.js'));
    assert.ok(!r.references.some((x) => x.file === 'src/pedido.js'), 'a própria definição não é uso');
    assert.ok(!r.references.some((x) => x.file === 'src/msg.js'), 'string não é uso');
    assert.equal(r.inText, 2, 'comentário e string são contados à parte');
    const texto = formatReferences(r, t).join('\n');
    assert.match(texto, /4 use\(s\) in 2 file\(s\)/);
    assert.match(texto, /by name, not by type/, 'a saída diz o que não sabe');
  } finally {
    if (antes === undefined) delete process.env.CONTEXT_TOOLS_STATE_DIR; else process.env.CONTEXT_TOOLS_STATE_DIR = antes;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refs: nome sem uso diz que pode ser código morto OU uso dinâmico; nome inválido manda para rg', () => {
  const dir = projeto();
  try {
    const sem = spawnSync(process.execPath, [join(SCRIPTS, 'refs.mjs'), 'salvar', `--root=${dir}`], { encoding: 'utf8', env: env(dir) }).stdout;
    assert.match(sem, /no use outside its definition/);
    assert.match(sem, /used dynamically/);
    const invalido = spawnSync(process.execPath, [join(SCRIPTS, 'refs.mjs'), 'a b', `--root=${dir}`], { encoding: 'utf8', env: env(dir) }).stdout;
    assert.match(invalido, /not one\. For text search use rg/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('impact: usos, co-mudança direcional, testes e mapa que cobre a definição', () => {
  const dir = projeto();
  const antes = process.env.CONTEXT_TOOLS_STATE_DIR;
  process.env.CONTEXT_TOOLS_STATE_DIR = join(dir, '.state');
  try {
    const r = buildImpact(dir, 'confirmar');
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.target.files, ['src/pedido.js']);
    assert.ok(r.coupling.links.some((l) => l.other === 'src/tela.js' && l.confidence >= 0.8), JSON.stringify(r.coupling));
    const testes = r.tests.flatMap((g) => g.files.flatMap((f) => f.related.map((x) => x.file)));
    assert.ok(testes.includes('tests/pedido.test.js'));
    assert.ok(r.knowledge.maps.some((m) => m.path.endsWith('.claude/context/pedido.md')));
    const texto = formatImpact(r, t).join('\n');
    for (const secao of [/🎯 impact of "confirmar"/, /🔗 used 4x/, /🔁 historically changes together/, /src\/tela\.js/, /🧪 related tests/, /run: npm test/, /📚 written knowledge/, /why\.mjs confirmar/]) {
      assert.match(texto, secao);
    }
    const curto = formatImpact(r, t, 200).join('\n');
    assert.match(curto, /cut at the 200-char budget/, 'orçamento estourado é dito, não engolido');
  } finally {
    if (antes === undefined) delete process.env.CONTEXT_TOOLS_STATE_DIR; else process.env.CONTEXT_TOOLS_STATE_DIR = antes;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('impact: arquivo como alvo e nome inexistente', () => {
  const dir = projeto();
  try {
    const arquivo = spawnSync(process.execPath, [join(SCRIPTS, 'impact.mjs'), 'src/pedido.js', `--root=${dir}`], { encoding: 'utf8', env: env(dir) }).stdout;
    assert.match(arquivo, /🎯 impact of src\/pedido\.js/);
    assert.match(arquivo, /git log --oneline -10 -- src\/pedido\.js/);
    const nada = spawnSync(process.execPath, [join(SCRIPTS, 'impact.mjs'), 'naoExiste', `--root=${dir}`], { encoding: 'utf8', env: env(dir) }).stdout;
    assert.match(nada, /no definition and no project file/);
    const fora = spawnSync(process.execPath, [join(SCRIPTS, 'impact.mjs'), '../fora.js', `--root=${dir}`], { encoding: 'utf8', env: env(dir) }).stdout;
    assert.match(fora, /no definition and no project file/, 'caminho fora do projeto não é aceito como alvo');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
