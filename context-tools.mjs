#!/usr/bin/env node
// `npx -y github:fcoluiz/context-tools`: o caminho padrão, sem perguntas. Instala ou atualiza o
// context-tools para todo agente cuja CLI existe na máquina (Claude Code e/ou Codex), para o usuário
// inteiro. É o mesmo `setup.mjs`, com `--global --yes` quando a pessoa não pediu outra coisa:
//   - `--project <dir>` ou `--guided` → por projeto, como `context-tools-setup-all`;
//   - `status`, `doctor`, `latest`, `help`… → repassados como estão;
//   - `--mcp`, `--target=…`, `--remove-mcp` → somam-se ao padrão global.

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './scripts/lib/roots.mjs';

const SETUP = resolve(fileURLToPath(new URL('.', import.meta.url)), 'setup.mjs');

export function defaultArgs(args) {
  const out = [...args];
  const porProjeto = out.some((a) => a === '--project' || a.startsWith('--project=') || a === '--guided');
  // O primeiro argumento solto é o comando — menos o valor de `--project <dir>`.
  const comando = out.find((a, i) => !a.startsWith('--') && out[i - 1] !== '--project');
  const instalacao = !comando || comando === 'install' || comando === 'update';
  if (instalacao && !porProjeto && !out.includes('--global')) out.push('--global');
  if (instalacao && !out.includes('--yes') && !out.includes('--guided')) out.push('--yes');
  return out;
}

if (isMain(import.meta.url)) {
  process.argv = [process.argv[0], SETUP, ...defaultArgs(process.argv.slice(2))];
  await import(pathToFileURL(SETUP).href);
}
