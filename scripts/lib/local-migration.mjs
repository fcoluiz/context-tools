// Migração de uma instalação LOCAL antiga (hooks gravados no projeto) para o plugin global.
//
// O caso que motivou: quem usou versões antigas instalava direto no projeto (`install.mjs`, hooks em
// `.claude/settings.json` apontando para `.claude/scripts/`; no Codex, `.codex/hooks.json` e a skill
// em `.agents/skills/`). Instalando o plugin global depois, as duas cópias rodam em toda sessão: o
// dobro de partidas de Node, avisos que disputam a mesma saída e scripts velhos que nunca atualizam.
//
// Só sai o que o próprio instalador escreveu (hook com o caminho dos nossos scripts, o plugin do
// marketplace antigo, a skill `context-tools`). Configuração (`context-tools.json`), mapas e
// documentação do projeto ficam. Todo arquivo alterado ganha cópia antes, FORA do projeto
// (`~/.context-tools/migrations/<data>/`), para não aparecer no `git status`.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isManagedClaudeHook, isManagedCodexHook, removeManagedHooksFrom, TARGETS } from './setup-targets.mjs';

const BOM = String.fromCharCode(0xfeff);
/** Plugins de marketplaces que o projeto já teve; ligados junto com o atual, rodam em dobro. */
export const LEGACY_CLAUDE_PLUGIN_IDS = TARGETS.claude.legacyMarketplaceNames.map((name) => `context-tools@${name}`);

function readJson(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw);
  } catch { return null; }
}

function countHooks(settings, isManaged) {
  let n = 0;
  for (const groups of Object.values(settings?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) if (isManaged(hook?.command)) n++;
  }
  return n;
}

const enabledLegacy = (settings) => LEGACY_CLAUDE_PLUGIN_IDS.filter((id) => settings?.enabledPlugins?.[id] === true);

function isOurSkill(dir) {
  const text = (() => { try { return readFileSync(join(dir, 'SKILL.md'), 'utf8'); } catch { return ''; } })();
  return /^name:\s*context-tools\s*$/m.test(text);
}

/**
 * O que há de cópia local ativa em `root` para o agente `id` ('claude' | 'codex').
 * `found` é verdadeiro só quando algo dela ainda RODA (hook, plugin antigo ligado, skill duplicada).
 */
export function detectLocalCopy(root, id) {
  const items = [];
  if (id === 'claude') {
    for (const name of ['settings.json', 'settings.local.json']) {
      const path = join(root, '.claude', name);
      const settings = existsSync(path) ? readJson(path) : null;
      if (!settings) continue;
      const hooks = countHooks(settings, isManagedClaudeHook);
      const legacy = enabledLegacy(settings);
      if (hooks || legacy.length) items.push({ path, hooks, legacyPlugins: legacy });
    }
  } else if (id === 'codex') {
    const path = join(root, '.codex', 'hooks.json');
    const settings = existsSync(path) ? readJson(path) : null;
    const hooks = settings ? countHooks(settings, (command) => isManagedCodexHook(command, root)) : 0;
    if (hooks) items.push({ path, hooks, legacyPlugins: [] });
    const skill = join(root, '.agents', 'skills', 'context-tools');
    if (isOurSkill(skill)) items.push({ path: skill, skill: true });
  }
  return { root, id, items, found: items.length > 0 };
}

function stamp(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/** Pasta de cópias desta migração, uma por projeto, fora do projeto. */
export function backupDir(root, { env = process.env, now = Date.now() } = {}) {
  const base = env.CONTEXT_TOOLS_HOME || join(homedir(), '.context-tools');
  const name = resolve(root).replace(/^[A-Za-z]:/, (drive) => drive[0]).replace(/[\\/:]+/g, '_').replace(/^_+/, '') || 'root';
  return join(base, 'migrations', stamp(now), name);
}

function backup(file, root, dir) {
  const rel = resolve(file).slice(resolve(root).length).replace(/^[\\/]+/, '');
  const target = join(dir, rel);
  mkdirSync(join(target, '..'), { recursive: true });
  cpSync(file, target, { recursive: true });
}

function markGlobal(root, stateDir, now) {
  const path = join(root, stateDir, 'context-tools-install.json');
  const marker = existsSync(path) ? readJson(path) : null;
  if (!marker || marker.name !== 'context-tools') return false;
  writeFileSync(path, `${JSON.stringify({ ...marker, mode: 'global', migratedAt: new Date(now).toISOString() }, null, 2)}\n`, 'utf8');
  return true;
}

/**
 * Desativa a cópia local de `root` para o agente `id`. Devolve o que mudou e onde ficou a cópia.
 * Com `dryRun`, só diz o que faria.
 */
export function migrateLocalCopy(root, id, { dryRun = false, env = process.env, now = Date.now() } = {}) {
  const detected = detectLocalCopy(root, id);
  if (!detected.found || dryRun) return { ...detected, changed: [], backup: null };
  const dir = backupDir(root, { env, now });
  const changed = [];
  for (const item of detected.items) {
    backup(item.path, root, dir);
    if (item.skill) {
      rmSync(item.path, { recursive: true, force: true });
      changed.push(item.path);
      continue;
    }
    if (item.hooks) {
      if (id === 'claude') removeManagedHooksFrom(item.path, isManagedClaudeHook);
      else TARGETS.codex.removeManagedProjectHooks(root);
    }
    if (item.legacyPlugins.length) disableLegacyPlugins(item.path);
    changed.push(item.path);
  }
  markGlobal(root, TARGETS[id].stateDir, now);
  return { ...detected, changed, backup: dir };
}

/** `enabledPlugins[<marketplace antigo>] = false`: desliga sem apagar, reversível pela pessoa. */
export function disableLegacyPlugins(path) {
  const settings = readJson(path);
  if (!settings?.enabledPlugins) return false;
  const legacy = enabledLegacy(settings);
  if (!legacy.length) return false;
  for (const pluginId of legacy) settings.enabledPlugins[pluginId] = false;
  const tmp = `${path}.ctmigrate.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return true;
}

/**
 * Projetos que o agente já abriu nesta máquina: o Claude guarda a lista em `~/.claude.json`
 * (`projects`), o Codex em `~/.codex/config.toml` (`[projects.'<pasta>']`). É onde uma cópia local
 * antiga pode estar; varrer o disco seria lento e invasivo.
 */
export function knownProjects(env = process.env) {
  const found = new Map();
  const add = (path) => {
    if (typeof path !== 'string' || !path.trim()) return;
    const full = resolve(path);
    const key = process.platform === 'win32' ? full.toLowerCase() : full;
    if (!found.has(key) && existsSync(full)) found.set(key, full);
  };
  const claudeJson = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
  for (const path of Object.keys(readJson(claudeJson)?.projects || {})) add(path);
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
  let toml = '';
  try { toml = readFileSync(join(codexHome, 'config.toml'), 'utf8'); } catch { /* sem Codex */ }
  for (const match of toml.matchAll(/^\s*\[projects\.(['"])(.+?)\1\]\s*$/gm)) add(match[1] === '"' ? match[2].replace(/\\\\/g, '\\') : match[2]);
  return [...found.values()];
}

/** Usuário: o plugin do marketplace antigo ligado no escopo `user` também roda em dobro. */
export function userSettingsPath(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
}

export function userLegacyPlugins(env = process.env) {
  const path = userSettingsPath(env);
  return existsSync(path) ? enabledLegacy(readJson(path)) : [];
}

/** Desliga no escopo do usuário, com cópia do settings.json antes. */
export function disableUserLegacyPlugins({ env = process.env, now = Date.now() } = {}) {
  const ids = userLegacyPlugins(env);
  if (!ids.length) return { ids, backup: null };
  const path = userSettingsPath(env);
  const dir = backupDir(join(path, '..'), { env, now });
  backup(path, join(path, '..'), dir);
  disableLegacyPlugins(path);
  return { ids, backup: dir };
}

/** Comando para migrar depois, à mão (o mesmo pacote que instala). */
export function migrateCommand({ all = false, root = null, target = null } = {}) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const where = all ? '--all' : `--project "${root}"`;
  return `${npx} --yes --package github:fcoluiz/context-tools context-tools-setup-all migrate ${where}${target ? ` --target=${target}` : ''}`;
}

export const LOCAL_NOTICE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Aviso do `SessionStart` do plugin GLOBAL quando o projeto ainda tem a cópia local ativa. Cobre
 * quem instalou o global antes desta migração existir, ou recusou a pergunta: o instalador não volta
 * a esses projetos, mas o hook passa por eles. Uma vez por dia por projeto; desligável com
 * `CONTEXT_TOOLS_LOCAL_COPY_CHECK=0`. Só avisa: mexer em configuração do projeto no meio da sessão,
 * sem a pessoa pedir, não é papel de hook.
 */
export function localCopyNotice(root, { env = process.env, now = Date.now(), host = 'claude', t } = {}) {
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT || env.PLUGIN_ROOT;
  if (!pluginRoot || !root || env.CONTEXT_TOOLS_LOCAL_COPY_CHECK === '0') return '';
  const detected = detectLocalCopy(root, host);
  if (!detected.found) return '';
  const base = env.CONTEXT_TOOLS_HOME || join(homedir(), '.context-tools');
  const path = join(base, 'local-copy-notice.json');
  const seen = readJson(path) || {};
  const key = `${host}:${process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)}`;
  if (now - (seen[key] || 0) < LOCAL_NOTICE_EVERY_MS) return '';
  try { mkdirSync(base, { recursive: true }); writeFileSync(path, JSON.stringify({ ...seen, [key]: now })); } catch { /* sem disco: avisa mesmo assim */ }
  const setup = join(pluginRoot, 'setup.mjs').replace(/\\/g, '/');
  const comando = `node "${setup}" migrate --project "${resolve(root).replace(/\\/g, '/')}" --target=${host} --yes`;
  return t('ho.localCopy', { detalhe: describeLocalCopy(detected, t), comando });
}

/** Resumo de uma detecção para a pessoa: "3 hook(s) local(is), plugin antigo … ligado". */
export function describeLocalCopy(detected, t) {
  const hooks = detected.items.reduce((n, item) => n + (item.hooks || 0), 0);
  const parts = [];
  if (hooks) parts.push(t('setup.migrate.hooks', { n: hooks }));
  for (const id of new Set(detected.items.flatMap((item) => item.legacyPlugins || []))) parts.push(t('setup.migrate.legacyPlugin', { id }));
  if (detected.items.some((item) => item.skill)) parts.push(t('setup.migrate.skill'));
  return parts.join(', ');
}
