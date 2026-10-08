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
    if (item.pluginId === `${plugin}@${marketplace}`) return true;
    const name = item.name ?? item.plugin;
    const mkt = item.marketplace ?? item.marketplaceName ?? item.source?.marketplace;
    return name === plugin && (mkt === marketplace || mkt === undefined);
  });
}

function pluginListArray(data) {
  if (Array.isArray(data)) return data;
  return data?.plugins ?? data?.installed ?? data?.results ?? null;
}

function marketplaceListArray(data) {
  if (Array.isArray(data)) return data;
  return data?.marketplaces ?? data?.results ?? null;
}

// A remoção de hooks locais duplicados só existe no lado Codex hoje: a instalação standalone do
// Codex (`install-codex.mjs`) grava `.codex/hooks.json`, e quando o plugin passa a fornecer os
// mesmos hooks o setup guiado limpa a cópia local para não rodar duas vezes. O plugin Claude não
// tem esse cenário de duplicação (a instalação standalone do Claude nunca escreveu hooks que o
// plugin também declara sob o mesmo nome de arquivo), então o adapter Claude não define esta
// função e o motor pula a etapa.
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
    marketplaceAddArgs: (repo, ref) => ['plugin', 'marketplace', 'add', `${repo}@${ref}`, '--scope', 'project'],
    marketplaceRemoveArgs: (name) => ['plugin', 'marketplace', 'remove', name, '--scope', 'project'],
    pluginInstallArgs: (plugin, marketplace) => ['plugin', 'install', `${plugin}@${marketplace}`, '--scope', 'project'],
    findInstalled: (data, plugin, marketplace) => findByNameAndMarketplace(pluginListArray(data), plugin, marketplace),
    findMarketplace: (data, marketplace) => marketplaceListArray(data)?.find((item) => item?.name === marketplace),
    bootstrapArgs: (repoRoot, projectRoot) => [join(repoRoot, 'install.mjs'), projectRoot, '--target=claude', '--no-hooks'],
    removeManagedProjectHooks: null,
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
