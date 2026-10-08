// Adapters por agente: tudo que setup-engine.mjs precisa saber para instalar o context-tools no
// Codex ou no Claude, sem duplicar o motor genérico. Cada adapter descreve os comandos de CLI,
// os caminhos de estado e os textos que mudam entre os dois.
//
// A forma de `claude plugin list --json` / `claude plugin marketplace list --json` não está
// documentada publicamente com um exemplo de JSON (só a forma do Codex foi validada em uso real).
// `findInstalled`/`findMarketplace` do adapter Claude tentam várias formas plausíveis de resposta
// de propósito — se a CLI real devolver outra coisa, o pior caso é reinstalar/re-adicionar em vez
// de pular, nunca corromper configuração.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { t } from './setup-shared.mjs';

const REPOSITORY = 'fcoluiz/context-tools';
const REPOSITORY_URL = 'https://github.com/fcoluiz/context-tools.git';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function findByNameAndMarketplace(list, plugin, marketplace) {
  if (!Array.isArray(list)) return undefined;
  return list.find((item) => {
    if (!item || typeof item !== 'object') return false;
    // Codex lista `pluginId`; o Claude lista `id` (ambos "plugin@marketplace").
    if (item.pluginId === `${plugin}@${marketplace}` || item.id === `${plugin}@${marketplace}`) return true;
    const name = item.name ?? item.plugin;
    const mkt = item.marketplace ?? item.marketplaceName ?? item.source?.marketplace;
    return name === plugin && (mkt === marketplace || mkt === undefined);
  });
}

// Tag instalada, no formato de cada CLI: o Codex informa `source.ref`; o Claude só informa a
// `version` do plugin, que é a mesma da tag (o teste de invariantes garante isso).
export function installedRef(item) {
  if (!item || typeof item !== 'object') return undefined;
  return item.source?.ref ?? item.ref ?? (item.version ? `v${item.version}` : undefined);
}

function pluginListArray(data) {
  if (Array.isArray(data)) return data;
  return data?.plugins ?? data?.installed ?? data?.results ?? null;
}

function marketplaceListArray(data) {
  if (Array.isArray(data)) return data;
  return data?.marketplaces ?? data?.results ?? null;
}

// Remoção de hooks locais duplicados. A instalação standalone grava hooks no projeto
// (`.codex/hooks.json` no Codex, `.claude/settings.json` no Claude); quando o plugin passa a
// fornecer os mesmos hooks, o setup guiado limpa a cópia local para não rodar tudo duas vezes —
// o dobro de partidas de Node e, sem a deduplicação de saída, o dobro de contexto.
// Só sai o que o próprio instalador escreveu: hook do usuário ou de outra ferramenta fica.
const CLAUDE_STANDALONE_HOOK = /^node\s+"?\$(?:\{CLAUDE_PROJECT_DIR\}|CLAUDE_PROJECT_DIR)\/\.claude\/scripts\/(?:context-maps|context-docs|coupling|handoff|pre-tool|verify|claude-md-hint)\.mjs"?(?:\s|$)/;

export function isManagedClaudeHook(command) {
  return typeof command === 'string' && CLAUDE_STANDALONE_HOOK.test(command.trim());
}

function removeManagedHooksFrom(path, isManaged) {
  if (!existsSync(path)) return false;
  let settings;
  try { settings = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
  if (!settings || !settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return false;
  let changed = false;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((hook) => !isManaged(hook?.command));
      changed ||= group.hooks.length !== before;
    }
    const next = groups.filter((group) => Array.isArray(group?.hooks) ? group.hooks.length : true);
    changed ||= next.length !== groups.length;
    if (next.length) settings.hooks[event] = next;
    else { delete settings.hooks[event]; changed = true; }
  }
  if (changed) writeJson(path, settings);
  return changed;
}

function removeManagedClaudeProjectHooks(root) {
  return removeManagedHooksFrom(join(root, '.claude', 'settings.json'), isManagedClaudeHook);
}

function removeManagedCodexProjectHooks(root) {
  const path = join(root, '.codex', 'hooks.json');
  if (!existsSync(path)) return false;
  let settings;
  try { settings = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
  if (!settings || !settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return false;
  let changed = false;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((hook) => !isManagedCodexHook(hook?.command, root));
      changed ||= group.hooks.length !== before;
    }
    const next = groups.filter((group) => Array.isArray(group?.hooks) ? group.hooks.length : true);
    changed ||= next.length !== groups.length;
    settings.hooks[event] = next;
  }
  if (changed) writeJson(path, settings);
  return changed;
}

export function isManagedCodexHook(command, root = null) {
  if (typeof command !== 'string') return false;
  const match = command.match(/^node\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))(?:\s|$)/i);
  if (!match) return false;
  const script = (match[1] || match[2] || match[3]).replace(/\\/g, '/');
  if (!/(?:^|\/)\.codex\/scripts\/(?:codex-hook|context-maps|context-docs|coupling|handoff|pre-tool|codex-md-hint|session-write-journal)\.mjs$/i.test(script)) return false;
  if (script.startsWith('.codex/') || script.startsWith('./.codex/') || script.startsWith('$(git rev-parse --show-toplevel)/.codex/')) return true;
  if (!root) return true;
  const normalize = (value) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(script) === normalize(join(root, '.codex', 'scripts', script.split('/').at(-1)));
}

const claudeScope = (opts) => (opts.global ? 'user' : 'project');

export const TARGETS = {
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    npmPackage: '@openai/codex',
    stateDir: '.codex',
    marketplaceName: 'context-tools-codex',
    legacyMarketplaceNames: ['context-tools-team'],
    repository: REPOSITORY,
    repositoryUrl: REPOSITORY_URL,
    pluginListArgs: ['plugin', 'list', '--json'],
    marketplaceListArgs: ['plugin', 'marketplace', 'list', '--json'],
    // O Codex é sempre global (por usuário). Um marketplace preso a uma tag não muda de tag com
    // `add` nem com `upgrade` ("already added from a different source"): trocar de versão exige
    // remover e adicionar de novo, e então `plugin add` instala a versão nova. Medido no CLI real.
    marketplaceAddArgs: (repo, ref) => ['plugin', 'marketplace', 'add', repo, '--ref', ref],
    marketplaceRemoveArgs: (name) => ['plugin', 'marketplace', 'remove', name],
    pluginInstallArgs: (plugin, marketplace) => ['plugin', 'add', `${plugin}@${marketplace}`],
    findInstalled: (data, plugin, marketplace) => findByNameAndMarketplace(pluginListArray(data), plugin, marketplace),
    findMarketplace: (data, marketplace) => marketplaceListArray(data)?.find((item) => item?.name === marketplace),
    bootstrapArgs: (repoRoot, projectRoot) => [join(repoRoot, 'install-codex.mjs'), projectRoot, '--mode=global'],
    removeManagedProjectHooks: removeManagedCodexProjectHooks,
    needsHookTrustReminder: true,
    verifyCommands: [
      'symbols.mjs --stats',
      'coupling.mjs',
      'audit-docs.mjs',
      'context-pack.mjs <symbol-or-file> --budget=2000',
      'providers.mjs --json',
      'metrics.mjs',
      'context-docs.mjs status',
    ],
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    bin: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    stateDir: '.claude',
    marketplaceName: 'context-tools',
    legacyMarketplaceNames: ['luiz-context-tools'],
    repository: REPOSITORY,
    repositoryUrl: REPOSITORY_URL,
    pluginListArgs: ['plugin', 'list', '--json'],
    marketplaceListArgs: ['plugin', 'marketplace', 'list', '--json'],
    // O CLI do Claude não aceita `--ref` (isso é só do Codex): a tag entra como sufixo
    // `owner/repo@vX.Y.Z` no próprio source. Confirmado batendo de frente com o CLI real —
    // `--ref` deu "error: unknown option '--ref'".
    //
    // `--global` usa o escopo `user` (todos os projetos); sem ele, `project`. Medido no CLI real:
    // `marketplace add` com uma tag nova SOBRESCREVE o marketplace existente (sem remover), e
    // `plugin install` num plugin já instalado só diz "already installed" — atualizar exige
    // `plugin update`.
    marketplaceAddArgs: (repo, ref, opts = {}) => ['plugin', 'marketplace', 'add', `${repo}@${ref}`, '--scope', claudeScope(opts)],
    marketplaceRemoveArgs: (name, opts = {}) => ['plugin', 'marketplace', 'remove', name, '--scope', claudeScope(opts)],
    marketplaceAddReplaces: true,
    pluginInstallArgs: (plugin, marketplace, opts = {}) => ['plugin', 'install', `${plugin}@${marketplace}`, '--scope', claudeScope(opts)],
    pluginUpdateArgs: (plugin, marketplace, opts = {}) => ['plugin', 'update', `${plugin}@${marketplace}`, '--scope', claudeScope(opts)],
    findInstalled: (data, plugin, marketplace) => findByNameAndMarketplace(pluginListArray(data), plugin, marketplace),
    findMarketplace: (data, marketplace) => marketplaceListArray(data)?.find((item) => item?.name === marketplace),
    bootstrapArgs: (repoRoot, projectRoot) => [join(repoRoot, 'install.mjs'), projectRoot, '--target=claude', '--no-hooks'],
    removeManagedProjectHooks: removeManagedClaudeProjectHooks,
    needsHookTrustReminder: false,
    verifyCommands: [
      'symbols.mjs --stats',
      'coupling.mjs',
      'audit-docs.mjs',
      'context-pack.mjs <symbol-or-file> --budget=2000',
      'providers.mjs --json',
      'metrics.mjs',
    ],
  },
};

export function resolveTargets(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).flatMap((id) => id === 'both' ? ['codex', 'claude'] : [id]);
  const unknown = list.filter((id) => !TARGETS[id]);
  if (unknown.length) throw new Error(t('setup.target.invalid', { lista: unknown.join(', ') }));
  return [...new Set(list)].map((id) => TARGETS[id]);
}
