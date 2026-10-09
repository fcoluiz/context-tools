// Registro OPCIONAL do servidor MCP no Claude Code e no Codex, pelo próprio setup (`--mcp`).
//
// O plugin roda de uma pasta que muda a cada versão (cache do marketplace, ou o cache do npx de onde
// o setup foi chamado). Registrar o servidor apontando para ali quebraria na primeira atualização.
// Por isso o setup copia os scripts para uma pasta estável do usuário — `~/.context-tools/runtime`,
// a mesma base que a verificação de versão já usa — e registra `node <runtime>/scripts/mcp-server.mjs`.
// Rodar o setup de novo atualiza a cópia; o registro continua apontando para o mesmo caminho.
//
// Nada disso acontece sem `--mcp`: a definição das ferramentas MCP entra no contexto de cada
// requisição do cliente, e esse custo é escolha de quem instala.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MCP_NAME = 'context-tools';

export function runtimeDir(env = process.env) {
  return join(env.CONTEXT_TOOLS_HOME || join(homedir(), '.context-tools'), 'runtime');
}

export function serverPath(env = process.env) {
  return join(runtimeDir(env), 'scripts', 'mcp-server.mjs');
}

/**
 * Copia `scripts/` e `package.json` da versão sendo instalada para a pasta estável. Apaga a cópia
 * anterior antes: um script removido numa versão nova não pode continuar sendo importado.
 */
export function installRuntime(repoRoot, version, env = process.env) {
  const destino = runtimeDir(env);
  rmSync(join(destino, 'scripts'), { recursive: true, force: true });
  mkdirSync(destino, { recursive: true });
  cpSync(join(repoRoot, 'scripts'), join(destino, 'scripts'), { recursive: true });
  cpSync(join(repoRoot, 'package.json'), join(destino, 'package.json'));
  writeFileSync(join(destino, 'VERSION'), `${version}\n`);
  return serverPath(env);
}

/** `claude mcp add` aceita escopo; o Codex é sempre global. */
export function mcpAddArgs(adapterId, path, { global = false } = {}) {
  // `node` pelo PATH, como os hooks: um caminho absoluto do Node quebraria na próxima troca de versão.
  const comando = ['--', 'node', path];
  return adapterId === 'claude'
    ? ['mcp', 'add', MCP_NAME, '--scope', global ? 'user' : 'local', ...comando]
    : ['mcp', 'add', MCP_NAME, ...comando];
}

export function mcpRemoveArgs(adapterId, { global = false } = {}) {
  return adapterId === 'claude'
    ? ['mcp', 'remove', MCP_NAME, '--scope', global ? 'user' : 'local']
    : ['mcp', 'remove', MCP_NAME];
}

export function mcpGetArgs() {
  return ['mcp', 'get', MCP_NAME];
}

export function runtimeInstalled(env = process.env) {
  return existsSync(serverPath(env));
}
