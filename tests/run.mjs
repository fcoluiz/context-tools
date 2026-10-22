#!/usr/bin/env node
// Descobre os arquivos de teste e chama `node --test` com a lista explícita.
//
// Existe porque a forma de invocar o test runner do Node mudou entre versões:
//   - glob (`tests/*.test.mjs`) só passou a funcionar no Node 21+;
//   - passar o diretório (`tests/`) é interpretado de formas diferentes conforme a versão.
// Listar os arquivos explicitamente é a única forma que vale em todas — e descobri-los aqui
// evita o modo de falha pior: alguém adicionar um teste novo e ele nunca rodar, em silêncio.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// O aviso de cópia local antiga também (grava em `~/.context-tools`); `local-migration.test.mjs`
// chama a função direto, com pasta temporária.
// E as configurações de usuário dos agentes apontam para uma pasta vazia: o setup global lê dali a
// lista de projetos para migrar, e um teste já chegou a migrar um projeto real da máquina assim.
const isolated = mkdtempSync(join(tmpdir(), 'ct-tests-home-'));
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
  env: {
    ...process.env, ...gitEnv, CONTEXT_TOOLS_UPDATE_CHECK: '0', CONTEXT_TOOLS_LOCAL_COPY_CHECK: '0',
    CODEX_HOME: join(isolated, 'codex'), CLAUDE_CONFIG_DIR: join(isolated, 'claude'), CONTEXT_TOOLS_HOME: join(isolated, 'context-tools'),
  },
});
rmSync(isolated, { recursive: true, force: true });
process.exit(r.status ?? 1);
