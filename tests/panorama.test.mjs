// ct.mjs (um comando, verbos curtos) e overview.mjs (panorama do primeiro minuto).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { localPath } from './paths.mjs';
import { buildOverview, formatOverview } from '../scripts/overview.mjs';
import { makeT } from '../scripts/lib/i18n.mjs';

const SCRIPTS = localPath('../scripts', import.meta.url);
const git = (dir, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });

function projeto() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-ov-'));
  const w = (rel, content) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), content); };
  w('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  w('src/pedidos/pedido.js', 'export function confirmar() {}\n');
  w('src/pedidos/fila.js', 'export function enfileirar() {}\n');
  w('src/clientes/cliente.js', 'export function cadastrar() {}\n');
  w('src/grande.js', Array.from({ length: 1600 }, (_, i) => `export const c${i} = ${i};`).join('\n'));
  w('tests/pedido.test.js', "test('x', () => {});\n");
  w('.claude/context/pedidos.md', '---\narea: pedidos\ncovers:\n  - "src/pedidos/pedido.js"\nverified_at: HEAD\nverified_date: 2026-10-09\n---\n# Pedidos\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'inicio');
  for (let i = 0; i < 3; i++) {
    appendFileSync(join(dir, 'src/pedidos/pedido.js'), `// ${i}\n`);
    appendFileSync(join(dir, 'src/clientes/cliente.js'), `// ${i}\n`);
    git(dir, 'commit', '-q', '-am', `muda ${i}`);
  }
  return dir;
}

test('overview: áreas, arquivos quentes com marca de conhecimento, arquivo grande, testes e convite a registrar', () => {
  const dir = projeto();
  const antes = process.env.CONTEXT_TOOLS_STATE_DIR;
  process.env.CONTEXT_TOOLS_STATE_DIR = join(dir, '.state');
  try {
    const r = buildOverview(dir);
    assert.equal(r.status, 'ok');
    assert.ok(r.areas.some((a) => a.area === 'src/pedidos' && a.files === 2), JSON.stringify(r.areas));
    const quentes = Object.fromEntries(r.hotFiles.files.map((h) => [h.file, h]));
    assert.equal(quentes['src/pedidos/pedido.js'].documented, true, 'coberto por mapa');
    assert.equal(quentes['src/clientes/cliente.js'].documented, false);
    assert.deepEqual(r.largeFiles.map((f) => f.file), ['src/grande.js']);
    assert.equal(r.tests.command, 'npm test');
    const texto = formatOverview(r, makeT('en')).join('\n');
    assert.match(texto, /📚 src\/pedidos\/pedido\.js \(4\)/);
    assert.match(texto, /1 hot file\(s\) above have nothing written — after investigating one, say "save this to context"/);
    assert.match(texto, /outline <file>/);
  } finally {
    if (antes === undefined) delete process.env.CONTEXT_TOOLS_STATE_DIR; else process.env.CONTEXT_TOOLS_STATE_DIR = antes;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ct.mjs: o verbo roda o script de antes no mesmo processo, com os mesmos argumentos', () => {
  const dir = projeto();
  const env = { ...process.env, CONTEXT_TOOLS_LANG: 'en', CONTEXT_TOOLS_STATE_DIR: join(dir, '.state') };
  try {
    const viaCt = spawnSync(process.execPath, [join(SCRIPTS, 'ct.mjs'), 'find', 'confirmar', `--root=${dir}`], { encoding: 'utf8', env }).stdout;
    const direto = spawnSync(process.execPath, [join(SCRIPTS, 'symbols.mjs'), 'confirmar', `--root=${dir}`], { encoding: 'utf8', env }).stdout;
    const semTempo = (s) => s.replace(/\(\d+ms\)/g, '');
    assert.equal(semTempo(viaCt), semTempo(direto));
    assert.match(viaCt, /src\/pedidos\/pedido\.js:1/);
    const desconhecido = spawnSync(process.execPath, [join(SCRIPTS, 'ct.mjs'), 'nada'], { encoding: 'utf8', env });
    assert.equal(desconhecido.status, 1);
    assert.match(desconhecido.stdout, /unknown verb "nada"/);
    assert.match(desconhecido.stdout, /find\s+where is it defined/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
