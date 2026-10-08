// Motor compartilhado dos instaladores guiados. Recebe um `adapter` (de setup-targets.mjs) e um
// `ctx` ({ repoRoot, packageVersion }) e implementa o fluxo install/update/status/doctor/latest/
// configure/help igual para Codex e Claude — só o que o adapter fornece muda de um para o outro.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isManagedCodexHook } from './setup-targets.mjs';
import {
  say, isDir, isFile, run, jsonOutput, latestTag, relativeExtra, parseExtraSelection,
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
    say(`${adapter.label} CLI não encontrado; instalação automática desativada.`);
    return false;
  }
  const ok = await confirm(`${adapter.label} CLI não encontrado. Instalar ${adapter.npmPackage} globalmente?`, true, flags.yes);
  if (!ok) return false;
  const installed = run('npm', ['install', '--global', adapter.npmPackage], { stdio: 'inherit' });
  if (installed.status !== 0) explainFailure(`instalar o ${adapter.label} CLI`, installed);
  return installed.status === 0;
}

async function ensureMarketplace(adapter, ref, flags) {
  const installed = pluginInfo(adapter).installed;
  if (installed?.source?.ref === ref || installed?.ref === ref) return true;

  const marketplace = marketplaceInfo(adapter).marketplace;
  if (marketplace) {
    const replace = await confirm(`O marketplace ${adapter.marketplaceName} já existe. Atualizar para ${ref}?`, true, flags.yes);
    if (!replace) return false;
    const removed = run(adapter.bin, adapter.marketplaceRemoveArgs(adapter.marketplaceName), { stdio: 'inherit' });
    if (removed.status !== 0) { explainFailure(`remover o marketplace antigo ${adapter.marketplaceName}`, removed); return false; }
  }
  const added = run(adapter.bin, adapter.marketplaceAddArgs(adapter.repository, ref), { stdio: 'inherit' });
  if (added.status !== 0) { explainFailure(`adicionar o marketplace ${adapter.marketplaceName}`, added); return false; }
  say(`Marketplace ${adapter.marketplaceName} configurado em ${ref}.`);
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
    say(`Aviso: o marketplace antigo ${name} ainda está configurado. Para não rodar os hooks em dobro, remova-o:`);
    say(`  ${adapter.bin} ${adapter.marketplaceRemoveArgs(name).join(' ')}`);
  }
}

function installPlugin(adapter) {
  const result = run(adapter.bin, adapter.pluginInstallArgs('context-tools', adapter.marketplaceName), { stdio: 'inherit' });
  if (result.status !== 0) { explainFailure(`instalar o plugin context-tools`, result); return false; }
  say(`Plugin context-tools instalado/atualizado para ${adapter.label}.`);
  return true;
}

function bootstrap(adapter, ctx, root, flags) {
  if (flags['no-bootstrap']) return true;
  const args = adapter.bootstrapArgs(ctx.repoRoot, root);
  const result = run(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) { explainFailure('preparar os scripts locais do projeto', result); return false; }
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
    say('Idioma inválido; use pt/português ou en/inglês. Português será usado.');
    language = 'pt';
  }
  if (!language) language = configuredLanguage;
  if (!language) {
    if (flags.yes) language = 'pt';
    else {
      const answer = await ask('Idioma do ai-context [P]ortuguês/[E]nglish (Enter = Português): ', 'pt');
      language = normalizeSetupLanguage(answer) || 'pt';
      if (!normalizeSetupLanguage(answer) && answer) say('Idioma não reconhecido; Português será usado.');
    }
  }
  let selected = null;
  let candidates = [];
  if (requested) {
    const parsed = parseExtraSelection(requested.join(','), [], root);
    selected = parsed.selected;
    if (parsed.invalid.length) say(`Caminho(s) ignorado(s): ${parsed.invalid.join(', ')}`);
  }
  const current = Array.isArray(config.extraRepos) ? config.extraRepos : [];
  if (!selected && (forcePrompt || !flags['no-workspace'])) {
    candidates = workspaceCandidates(root);
    if (candidates.length && (flags.yes || await confirm(`Foram encontrados ${candidates.length} repositório(s) próximo(s). Configurar extraRepos agora?`, false, false))) {
      if (flags.yes) selected = candidates;
      else {
        say(candidates.map((item, index) => `  ${index + 1}. ${item}`).join('\n'));
        const answer = await ask('Digite números e/ou caminhos separados por vírgula (Enter para nenhum): ', '');
        if (answer) {
          const parsed = parseExtraSelection(answer, candidates, root);
          selected = parsed.selected;
          if (parsed.invalid.length) say(`Caminho(s) ignorado(s): ${parsed.invalid.join(', ')}`);
        }
      }
    } else if (forcePrompt) {
      const answer = await ask('Informe caminhos adicionais separados por vírgula (Enter para nenhum): ', '');
      if (answer) {
        const parsed = parseExtraSelection(answer, candidates, root);
        selected = parsed.selected;
        if (parsed.invalid.length) say(`Caminho(s) ignorado(s): ${parsed.invalid.join(', ')}`);
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
  say(`Configuração salva em ${path}`);
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
  if (mode === 'global' && !plugin.available) issues.push(`${adapter.label} CLI não está disponível no PATH; versão global não verificada.`);
  if (mode === 'global' && !plugin.installed) issues.push(`Plugin context-tools não está instalado no marketplace configurado.`);
  if (mode === 'standalone' && (!files.scripts || !files.skill || !files.hooks)) issues.push('Bootstrap/hook do projeto está incompleto.');
  if (mode === 'global' && !files.pluginHooks) issues.push('Plugin global não está ativo.');
  if (mode === 'global' && files.skill) issues.push('Skill local context-tools pode ocultar a skill do plugin global; confira a cópia antes de removê-la.');
  if (mode === 'global' && files.hooks) {
    let settings = null;
    try { settings = JSON.parse(readFileSync(join(root, adapter.stateDir, 'hooks.json'), 'utf8')); } catch { issues.push('Hooks locais não puderam ser analisados.'); }
    const duplicate = Object.values(settings?.hooks || {}).some((groups) => Array.isArray(groups) && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => isManagedCodexHook(hook?.command, root))));
    if (duplicate) issues.push('Hooks locais context-tools coexistem com o plugin global.');
  }
  if (marker && mode === 'standalone' && marker.version !== ctx.packageVersion) issues.push(`Bootstrap local está em ${marker.version}; fonte atual ${ctx.packageVersion}.`);
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
  say(`Agente: ${status.agent}`);
  say(`Projeto: ${status.projectRoot}`);
  say(`Plugin: ${status.plugin ? `${status.plugin.version}${status.plugin.ref ? ` (${status.plugin.ref})` : ''}` : 'não instalado'}`);
  say(`Bootstrap: ${status.project.version || 'não registrado'}`);
  const global = status.project.mode === 'global';
  const hookStatus = global ? (status.project.files.pluginHooks ? 'plugin' : 'faltando') : status.project.files.hooks ? 'local' : 'faltando';
  say(`Modo: ${status.project.mode}; scripts=${global ? 'plugin' : status.project.files.scripts ? 'ok' : 'faltando'}, skill=${global ? 'plugin' : status.project.files.skill ? 'ok' : 'faltando'}, hooks=${hookStatus}, ai-context=${status.project.docs ? 'ok' : 'ainda não criado'}`);
  if (status.issues.length) status.issues.forEach((issue) => say(`Aviso: ${issue}`));
  else say('Diagnóstico: instalação disponível.');
  if (status.project.hookTrust === 'unknown') say('Confiança dos hooks: não verificada; confira /hooks no Codex.');
}

export function help(adapter) {
  say(`context-tools setup — instalação e manutenção do plugin ${adapter.label}

Uso:
  node setup-${adapter.id}.mjs [install|update] [--project <diretório>]
  node setup-${adapter.id}.mjs status [--project <diretório>] [--json]
  node setup-${adapter.id}.mjs doctor [--project <diretório>] [--json]
  node setup-${adapter.id}.mjs latest
  node setup-${adapter.id}.mjs configure [--project <diretório>]

Opções:
  --yes                 aceita os padrões e inclui repositórios detectados
  --guided              solicita/confirma a pasta do projeto automaticamente
  --no-workspace        não pergunta sobre extraRepos
  --no-bootstrap        atualiza o plugin sem copiar arquivos para o projeto
  --extra-repos=...     grava caminhos separados por vírgula em extraRepos
  --remove-extra-repos=... remove caminhos de extraRepos
  --lang=pt|en         define o idioma do ai-context (novo projeto usa português)
  --ref=vX.Y.Z          usa uma tag específica
  --dry-run             simula sem alterar projeto, instalar dependências ou acessar a rede
  --keep-open           mantém o launcher guiado aberto ao terminar
`);
}

async function chooseGuidedRoot(root, flags) {
  if (!flags.guided || flags.yes) return root;
  say(`\nProjeto detectado: ${root}`);
  const answer = await ask('Pressione Enter para usar este projeto ou informe outro caminho: ', root);
  return resolve(answer);
}

export async function runSetup(adapter, ctx, { command, root, flags }) {
  if (command === 'help') { help(adapter); return 0; }
  if (command === 'latest') { say(latestTag(adapter.repositoryUrl) || `v${ctx.packageVersion} (fallback local)`); return 0; }
  if (command === 'status' || command === 'doctor') {
    const status = projectStatus(adapter, ctx, root);
    printStatus(status, flags.json);
    if (command === 'doctor' && status.issues.length) return 1;
    return 0;
  }
  if (command === 'configure') { await configure(adapter, root, flags, true); return 0; }
  if (flags['dry-run']) {
    say(`[${adapter.label}] Projeto detectado automaticamente: ${root}`);
    say(`[${adapter.label}] Versão selecionada: ${flags.ref || `v${ctx.packageVersion} (simulação local)`}`);
    say(`[${adapter.label}] Simulação: nenhuma alteração foi feita e nenhuma dependência/rede foi acionada.`);
    return 0;
  }
  if (!(await ensureCli(adapter, flags))) return 1;

  const ref = flags.ref || latestTag(adapter.repositoryUrl) || `v${ctx.packageVersion}`;
  say(`[${adapter.label}] Projeto detectado automaticamente: ${root}`);
  say(`[${adapter.label}] Versão selecionada: ${ref}`);
  if (!(await ensureMarketplace(adapter, ref, flags)) || !installPlugin(adapter) || !bootstrap(adapter, ctx, root, flags)) {
    say(`\n[${adapter.label}] Instalação não concluída. Corrija o problema indicado e execute o mesmo arquivo novamente.`);
    return 1;
  }
  if (!flags['no-workspace']) await configure(adapter, root, flags);
  say(`\n[${adapter.label}] Instalação concluída com sucesso.`);
  say(`Abra uma nova sessão do ${adapter.label} para carregar a versão atualizada.`);
  if (adapter.needsHookTrustReminder) {
    say('Se o Codex solicitar confiança dos hooks, abra /hooks e aprove os hooks do context-tools uma vez nesta máquina.');
  }
  return 0;
}

export { chooseGuidedRoot };
