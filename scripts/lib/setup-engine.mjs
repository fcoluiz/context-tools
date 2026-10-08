// Motor compartilhado dos instaladores guiados. Recebe um `adapter` (de setup-targets.mjs) e um
// `ctx` ({ repoRoot, packageVersion }) e implementa o fluxo install/update/status/doctor/latest/
// configure/help igual para Codex e Claude — só o que o adapter fornece muda de um para o outro.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { installedRef, isManagedCodexHook } from './setup-targets.mjs';
import {
  say, isDir, isFile, run, jsonOutput, latestTag, relativeExtra, parseExtraSelection, t, useSetupConfigLang,
  normalizeSetupLanguage, ask, confirm, explainFailure, workspaceCandidates,
} from './setup-shared.mjs';

const BOM = String.fromCharCode(0xfeff);

function readConfig(adapter, root) {
  const path = join(root, adapter.stateDir, 'context-tools.json');
  if (!isFile(path)) return { path, config: {} };
  try {
    const raw = readFileSync(path, 'utf8');
    return { path, config: JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw) };
  } catch { return { path, config: {} }; }
}

function writeConfig(adapter, root, config) {
  const { path } = readConfig(adapter, root);
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return path;
}

function pluginInfo(adapter) {
  const result = run(adapter.bin, adapter.pluginListArgs);
  const data = jsonOutput(result.stdout);
  const installed = adapter.findInstalled(data, 'context-tools', adapter.marketplaceName);
  return { available: result.status === 0, installed, result };
}

function marketplaceInfo(adapter) {
  const result = run(adapter.bin, adapter.marketplaceListArgs);
  const data = jsonOutput(result.stdout);
  const marketplace = adapter.findMarketplace(data, adapter.marketplaceName);
  return { available: result.status === 0, marketplace, result };
}

async function ensureCli(adapter, flags) {
  const version = run(adapter.bin, ['--version']);
  if (version.status === 0) return true;
  if (flags['skip-cli-install'] || flags['skip-codex-install']) {
    say(t('setup.cli.autoDisabled', { agente: adapter.label }));
    return false;
  }
  const ok = await confirm(t('setup.cli.installAsk', { agente: adapter.label, pacote: adapter.npmPackage }), true, flags.yes);
  if (!ok) return false;
  const installed = run('npm', ['install', '--global', adapter.npmPackage], { stdio: 'inherit' });
  if (installed.status !== 0) explainFailure(t('setup.cli.installStep', { agente: adapter.label }), installed);
  return installed.status === 0;
}

// `--global` instala para o usuário (todos os projetos) em vez de só no projeto atual. O Codex já é
// sempre global; no Claude isso escolhe o escopo `user`.
const scopeOpts = (flags) => ({ global: Boolean(flags.global) });

// Um plugin listado em OUTRO escopo (ex.: projeto, quando se pede global) não conta como instalado
// aqui. O Codex não informa escopo — para ele, listado é instalado.
function installedHere(adapter, flags) {
  const installed = pluginInfo(adapter).installed;
  if (!installed) return undefined;
  if (installed.scope && installed.scope !== (flags.global ? 'user' : 'project')) return undefined;
  return installed;
}

async function ensureMarketplace(adapter, ref, flags) {
  const opts = scopeOpts(flags);
  if (installedRef(installedHere(adapter, flags)) === ref) return true;

  const marketplace = marketplaceInfo(adapter).marketplace;
  if (marketplace) {
    const replace = await confirm(t('setup.mkt.replaceAsk', { nome: adapter.marketplaceName, ref }), true, flags.yes);
    if (!replace) return false;
    // O Claude sobrescreve o marketplace ao adicioná-lo de novo, então não remove antes (é um passo
    // a menos que pode falhar). O Codex exige a remoção para trocar de tag.
    if (!adapter.marketplaceAddReplaces) {
      const removed = run(adapter.bin, adapter.marketplaceRemoveArgs(adapter.marketplaceName, opts), { stdio: 'inherit' });
      if (removed.status !== 0) { explainFailure(t('setup.mkt.removeStep', { nome: adapter.marketplaceName }), removed); return false; }
    }
  }
  const added = run(adapter.bin, adapter.marketplaceAddArgs(adapter.repository, ref, opts), { stdio: 'inherit' });
  if (added.status !== 0) { explainFailure(t('setup.mkt.addStep', { nome: adapter.marketplaceName }), added); return false; }
  say(t('setup.mkt.done', { nome: adapter.marketplaceName, ref }));
  warnLegacyMarketplaces(adapter);
  return true;
}

// O marketplace foi renomeado na 2.0.0 (o repositório mudou de endereço). Quem instalou antes
// fica com o marketplace antigo E o novo, e os hooks rodariam em dobro. Só avisa, com o comando
// exato: remover configuração do usuário sem perguntar não é papel do setup.
function warnLegacyMarketplaces(adapter) {
  const legacy = adapter.legacyMarketplaceNames || [];
  if (!legacy.length) return;
  const data = jsonOutput(run(adapter.bin, adapter.marketplaceListArgs).stdout);
  for (const name of legacy) {
    if (!adapter.findMarketplace(data, name)) continue;
    say(t('setup.mkt.legacy', { nome: name }));
    say(`  ${adapter.bin} ${adapter.marketplaceRemoveArgs(name).join(' ')}`);
  }
}

function installPlugin(adapter, flags) {
  const opts = scopeOpts(flags);
  // Plugin já instalado: no Claude, `install` só responde "already installed" e não atualiza —
  // é `update` que traz a versão nova. O Codex não tem `update`: `add` reinstala da tag atual.
  const update = Boolean(installedHere(adapter, flags) && adapter.pluginUpdateArgs);
  const args = update
    ? adapter.pluginUpdateArgs('context-tools', adapter.marketplaceName, opts)
    : adapter.pluginInstallArgs('context-tools', adapter.marketplaceName, opts);
  const result = run(adapter.bin, args, { stdio: 'inherit' });
  if (result.status !== 0) { explainFailure(t('setup.plugin.installStep'), result); return false; }
  say(t('setup.plugin.done', { agente: adapter.label }));
  return true;
}

function bootstrap(adapter, ctx, root, flags) {
  if (flags['no-bootstrap']) return true;
  const args = adapter.bootstrapArgs(ctx.repoRoot, root);
  const result = run(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) { explainFailure(t('setup.bootstrap.step'), result); return false; }
  adapter.removeManagedProjectHooks?.(root);
  return true;
}

async function configure(adapter, root, flags, forcePrompt = false) {
  const { path, config } = readConfig(adapter, root);
  const requested = flags['extra-repos']
    ? String(flags['extra-repos']).split(',').map((value) => value.trim()).filter(Boolean)
    : null;
  const remove = flags['remove-extra-repos']
    ? String(flags['remove-extra-repos']).split(',').map((value) => value.trim()).filter(Boolean)
    : [];
  const existingIndexLanguage = isFile(join(root, 'ai-context', '00-indice.md'))
    ? 'pt'
    : isFile(join(root, 'ai-context', '00-index.md')) ? 'en' : null;
  const configuredLanguage = normalizeSetupLanguage(config.lang)
    || normalizeSetupLanguage(config.documentation?.language)
    || existingIndexLanguage;
  let language = normalizeSetupLanguage(flags.lang);
  if (flags.lang !== undefined && !language) {
    say(t('setup.lang.invalid'));
    language = 'pt';
  }
  if (!language) language = configuredLanguage;
  if (!language) {
    if (flags.yes) language = 'pt';
    else {
      const answer = await ask(t('setup.lang.ask'), 'pt');
      language = normalizeSetupLanguage(answer) || 'pt';
      if (!normalizeSetupLanguage(answer) && answer) say(t('setup.lang.unknown'));
    }
  }
  let selected = null;
  let candidates = [];
  if (requested) {
    const parsed = parseExtraSelection(requested.join(','), [], root);
    selected = parsed.selected;
    if (parsed.invalid.length) say(t('setup.extra.ignored', { lista: parsed.invalid.join(', ') }));
  }
  const current = Array.isArray(config.extraRepos) ? config.extraRepos : [];
  if (!selected && (forcePrompt || !flags['no-workspace'])) {
    candidates = workspaceCandidates(root);
    if (candidates.length && (flags.yes || await confirm(t('setup.extra.foundAsk', { n: candidates.length }), false, false))) {
      if (flags.yes) selected = candidates;
      else {
        say(candidates.map((item, index) => `  ${index + 1}. ${item}`).join('\n'));
        const answer = await ask(t('setup.extra.ask'), '');
        if (answer) {
          const parsed = parseExtraSelection(answer, candidates, root);
          selected = parsed.selected;
          if (parsed.invalid.length) say(t('setup.extra.ignored', { lista: parsed.invalid.join(', ') }));
        }
      }
    } else if (forcePrompt) {
      const answer = await ask(t('setup.extra.askManual'), '');
      if (answer) {
        const parsed = parseExtraSelection(answer, candidates, root);
        selected = parsed.selected;
        if (parsed.invalid.length) say(t('setup.extra.ignored', { lista: parsed.invalid.join(', ') }));
      }
    }
  }
  const languageChanged = language && config.lang !== language;
  if (!selected && !remove.length && !languageChanged) return { changed: false, path, config };
  const next = { ...config };
  if (language) next.lang = language;
  const base = [...current, ...(selected || [])];
  const removed = new Set(remove.map((value) => relativeExtra(root, value) || value));
  next.extraRepos = [...new Set(base)].filter((value) => !removed.has(value));
  writeConfig(adapter, root, next);
  say(t('setup.config.saved', { caminho: path }));
  return { changed: true, path, config: next };
}

function readMarker(adapter, root) {
  const path = join(root, adapter.stateDir, 'context-tools-install.json');
  if (!isFile(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// `skill` só existe como arquivo separado no lado Codex (`install-codex.mjs` copia
// `.agents/skills/context-tools/SKILL.md`); no Claude o plugin embute skill/agent, então não há
// arquivo local equivalente para checar — considerado sempre presente.
function skillFilePresent(adapter, root) {
  if (adapter.id !== 'codex') return true;
  return isFile(join(root, '.agents', 'skills', 'context-tools', 'SKILL.md'));
}

// `hooks.json` só existe como arquivo dedicado no Codex; a instalação standalone do Claude
// registra hooks dentro de `.claude/settings.json` junto com o resto da configuração do usuário.
function localHooksPresent(adapter, root) {
  if (adapter.id === 'codex') return isFile(join(root, adapter.stateDir, 'hooks.json'));
  return isFile(join(root, adapter.stateDir, 'settings.json'));
}

export function projectStatus(adapter, ctx, root) {
  const marker = readMarker(adapter, root);
  const plugin = pluginInfo(adapter);
  const files = {
    scripts: isDir(join(root, adapter.stateDir, 'scripts')),
    skill: skillFilePresent(adapter, root),
    hooks: localHooksPresent(adapter, root),
    pluginHooks: Boolean(plugin.installed && plugin.installed.enabled !== false),
    docs: isFile(join(root, 'ai-context', '00-indice.md')) || isFile(join(root, 'ai-context', '00-index.md')),
  };
  const issues = [];
  const mode = marker?.mode || (files.pluginHooks && adapter.id === 'codex' ? 'global' : 'standalone');
  if (mode === 'global' && !plugin.available) issues.push(t('setup.issue.cliMissingGlobal', { agente: adapter.label }));
  if (mode === 'global' && !plugin.installed) issues.push(t('setup.issue.notInstalled'));
  if (mode === 'standalone' && (!files.scripts || !files.skill || !files.hooks)) issues.push(t('setup.issue.bootstrap'));
  if (mode === 'global' && !files.pluginHooks) issues.push(t('setup.issue.globalInactive'));
  if (mode === 'global' && files.skill) issues.push(t('setup.issue.localSkill'));
  if (mode === 'global' && files.hooks) {
    let settings = null;
    try { settings = JSON.parse(readFileSync(join(root, adapter.stateDir, 'hooks.json'), 'utf8')); } catch { issues.push(t('setup.issue.hooksUnreadable')); }
    const duplicate = Object.values(settings?.hooks || {}).some((groups) => Array.isArray(groups) && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => isManagedCodexHook(hook?.command, root))));
    if (duplicate) issues.push(t('setup.issue.duplicateHooks'));
  }
  if (marker && mode === 'standalone' && marker.version !== ctx.packageVersion) issues.push(t('setup.issue.stale', { local: marker.version, fonte: ctx.packageVersion }));
  return {
    agent: adapter.label,
    projectRoot: root,
    plugin: plugin.installed ? { version: plugin.installed.version, ref: plugin.installed.source?.ref || plugin.installed.ref || null, enabled: plugin.installed.enabled } : null,
    project: { mode, hookTrust: adapter.id === 'codex' ? 'unknown' : 'not-applicable', version: marker?.version || null, installedAt: marker?.installedAt || null, files, docs: files.docs },
    issues,
  };
}

export function printStatus(status, json = false) {
  if (json) { console.log(JSON.stringify(status, null, 2)); return; }
  const okOuFalta = (valor) => t(valor ? 'setup.value.ok' : 'setup.value.missing');
  say(t('setup.status.agent', { agente: status.agent }));
  say(t('setup.status.project', { raiz: status.projectRoot }));
  say(t('setup.status.plugin', {
    valor: status.plugin
      ? `${status.plugin.version}${status.plugin.ref ? ` (${status.plugin.ref})` : ''}`
      : t('setup.value.notInstalled'),
  }));
  say(t('setup.status.bootstrap', { valor: status.project.version || t('setup.value.notRecorded') }));
  const global = status.project.mode === 'global';
  const viaPlugin = t('setup.value.plugin');
  say(t('setup.status.files', {
    modo: status.project.mode,
    scripts: global ? viaPlugin : okOuFalta(status.project.files.scripts),
    skill: global ? viaPlugin : okOuFalta(status.project.files.skill),
    hooks: global
      ? (status.project.files.pluginHooks ? viaPlugin : t('setup.value.missing'))
      : (status.project.files.hooks ? t('setup.value.local') : t('setup.value.missing')),
    docs: status.project.docs ? t('setup.value.ok') : t('setup.value.notCreated'),
  }));
  if (status.issues.length) status.issues.forEach((issue) => say(t('setup.status.warning', { aviso: issue })));
  else say(t('setup.status.allGood'));
  if (status.project.hookTrust === 'unknown') say(t('setup.status.hookTrustUnknown'));
}

export function help(adapter) {
  say(t('setup.help.agent', { agente: adapter.label, id: adapter.id, opcoes: t('setup.help.options') }));
}

async function chooseGuidedRoot(root, flags) {
  if (!flags.guided || flags.yes) return root;
  say(t('setup.guided.detected', { raiz: root }));
  const answer = await ask(t('setup.guided.ask'), root);
  return resolve(answer);
}

export async function runSetup(adapter, ctx, { command, root, flags }) {
  // Um projeto que já declarou `lang` fala nesse idioma daqui em diante — inclusive nas mensagens
  // do próprio setup, não só no ai-context que ele gera.
  if (root) useSetupConfigLang(readConfig(adapter, root).config);
  if (command === 'help') { help(adapter); return 0; }
  if (command === 'latest') { say(latestTag(adapter.repositoryUrl) || t('setup.run.localFallback', { versao: ctx.packageVersion })); return 0; }
  if (command === 'status' || command === 'doctor') {
    const status = projectStatus(adapter, ctx, root);
    printStatus(status, flags.json);
    if (command === 'doctor' && status.issues.length) return 1;
    return 0;
  }
  if (command === 'configure') { await configure(adapter, root, flags, true); return 0; }
  if (flags['dry-run']) {
    say(flags.global ? t('setup.run.global', { agente: adapter.label }) : t('setup.run.detected', { agente: adapter.label, raiz: root }));
    say(t('setup.run.version', {
      agente: adapter.label,
      ref: flags.ref || t('setup.run.localSim', { versao: ctx.packageVersion }),
    }));
    say(t('setup.run.dryRun', { agente: adapter.label }));
    return 0;
  }
  if (!(await ensureCli(adapter, flags))) return 1;

  const ref = flags.ref || latestTag(adapter.repositoryUrl) || `v${ctx.packageVersion}`;
  const global = Boolean(flags.global);
  say(global ? t('setup.run.global', { agente: adapter.label }) : t('setup.run.detected', { agente: adapter.label, raiz: root }));
  say(t('setup.run.version', { agente: adapter.label, ref }));
  // Global não prepara nenhum projeto: nada é escrito na pasta onde o comando foi rodado.
  if (!(await ensureMarketplace(adapter, ref, flags)) || !installPlugin(adapter, flags)
    || (!global && !bootstrap(adapter, ctx, root, flags))) {
    say(t('setup.run.failed', { agente: adapter.label }));
    return 1;
  }
  if (!global && !flags['no-workspace']) await configure(adapter, root, flags);
  say(t('setup.run.done', { agente: adapter.label }));
  say(t('setup.run.newSession', { agente: adapter.label }));
  if (adapter.needsHookTrustReminder) say(t('setup.run.hookTrust'));
  return 0;
}

export { chooseGuidedRoot };
