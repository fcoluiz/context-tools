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
// Os repositórios de fixture fazem commits em pasta temporária; o `git commit` pode disparar
// gc/maintenance automático em segundo plano, que ainda escreve em `.git/objects/pack` quando o
// teste apaga a pasta (ENOTEMPTY no rmSync, intermitente no CI). Desligado para todo git dos testes,
// somando às `GIT_CONFIG_*` que já existirem no ambiente.
const gitConfig = { 'gc.auto': '0', 'maintenance.auto': 'false' };
const base = Number.parseInt(process.env.GIT_CONFIG_COUNT, 10) || 0;
const gitEnv = { GIT_CONFIG_COUNT: String(base + Object.keys(gitConfig).length) };
Object.entries(gitConfig).forEach(([key, value], i) => {
  gitEnv[`GIT_CONFIG_KEY_${base + i}`] = key;
  gitEnv[`GIT_CONFIG_VALUE_${base + i}`] = value;
});

const r = spawnSync(process.execPath, ['--test', ...arquivos], {
  stdio: 'inherit',
  env: { ...process.env, ...gitEnv, CONTEXT_TOOLS_UPDATE_CHECK: '0' },
});
process.exit(r.status ?? 1);
