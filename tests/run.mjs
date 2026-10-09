#!/usr/bin/env node
// Descobre os arquivos de teste e chama `node --test` com a lista explícita.
//
// Existe porque a forma de invocar o test runner do Node mudou entre versões:
//   - glob (`tests/*.test.mjs`) só passou a funcionar no Node 21+;
//   - passar o diretório (`tests/`) é interpretado de formas diferentes conforme a versão.
// Listar os arquivos explicitamente é a única forma que vale em todas — e descobri-los aqui
// evita o modo de falha pior: alguém adicionar um teste novo e ele nunca rodar, em silêncio.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const arquivos = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => join(dir, f));

if (!arquivos.length) {
  console.error('❌ nenhum arquivo *.test.mjs encontrado em tests/ — falhando em vez de passar vazio.');
  process.exit(1);
}

// Os testes nunca consultam a rede nem gravam na pasta do usuário: a verificação de versão nova
// fica desligada para todo hook que um teste dispara. `update-check.test.mjs` religa por chamada.
const r = spawnSync(process.execPath, ['--test', ...arquivos], {
  stdio: 'inherit',
  env: { ...process.env, CONTEXT_TOOLS_UPDATE_CHECK: '0' },
});
process.exit(r.status ?? 1);
