// C#, Java e PHP de ponta a ponta: o parser certo não basta — a consulta pelo nome nu precisa achar
// a definição (o passo do `bareName` que o CONTRIBUTING diz que "morde"), e o laço de verificação
// precisa saber qual comando roda os testes desses ecossistemas.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { localPath } from './paths.mjs';
import { detectTestCommand } from '../scripts/lib/verification.mjs';
import { EXTENSOES_INDICE, CODE_RE } from '../scripts/lib/roots.mjs';

const SCRIPTS = localPath('../scripts', import.meta.url);

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-lang-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function symbols(root, ...queries) {
  return spawnSync(process.execPath, [join(SCRIPTS, 'symbols.mjs'), ...queries, `--root=${root}`], {
    encoding: 'utf8', env: { ...process.env, CONTEXT_TOOLS_LANG: 'en', CONTEXT_TOOLS_STATE_DIR: join(root, '.state') },
  }).stdout;
}

test('C#, Java e PHP entram no índice e são código para mapas e coupling', () => {
  for (const ext of ['cs', 'java', 'php']) {
    assert.ok(EXTENSOES_INDICE.includes(ext), `${ext} fora do índice`);
    assert.ok(CODE_RE.test(`a.${ext}`), `${ext} não conta como código`);
  }
});

test('consulta pelo nome nu acha método qualificado, propriedade e constante, com intervalo exato', () => {
  const root = project({
    'src/Pedido.cs': 'namespace Loja;\n\npublic class Pedido\n{\n    public int Total { get; set; }\n    public void Confirmar()\n    {\n        Salvar();\n    }\n}\n',
    'src/Fila.java': 'class Fila {\n    static final int LIMITE = 3;\n    void enfileirar(int x) {\n        processar(x);\n    }\n}\n',
    'src/Rota.php': '<?php\nclass Rota\n{\n    public function despachar(): void\n    {\n    }\n}\n',
  });
  try {
    const out = symbols(root, 'Confirmar', 'Total', 'LIMITE', 'despachar', 'Salvar');
    assert.match(out, /src\/Pedido\.cs:6-9\s+Pedido\.Confirmar\(\)/, 'método C# com o fim na chave que fecha');
    assert.match(out, /src\/Pedido\.cs:5\s+property Total/);
    assert.match(out, /src\/Fila\.java:2\s+const LIMITE/);
    assert.match(out, /src\/Rota\.php:4-6\s+Rota\.despachar\(\)/);
    assert.match(out, /"Salvar" — no DEFINITION/, 'chamada dentro de corpo nunca vira definição');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('comando de teste de .NET e PHP', () => {
  const dotnet = project({ 'App.sln': '' });
  const composer = project({ 'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }) });
  const phpunit = project({ 'phpunit.xml.dist': '<phpunit/>' });
  try {
    assert.equal(detectTestCommand(dotnet), 'dotnet test');
    assert.equal(detectTestCommand(composer), 'composer test');
    assert.equal(detectTestCommand(phpunit), 'vendor/bin/phpunit');
  } finally {
    for (const dir of [dotnet, composer, phpunit]) rmSync(dir, { recursive: true, force: true });
  }
});
