#!/usr/bin/env node
// Instalação standalone para Codex: copia scripts/skill e registra hooks em .codex/hooks.json.
// Não toca em .claude/ nem em configuração do Claude.

import {
  readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const noHooks = args.includes('--no-hooks');
const mode = args.find((value) => value.startsWith('--mode='))?.slice(7) || 'standalone';
if (!['global', 'standalone'].includes(mode)) { console.error('invalid installation mode'); process.exit(1); }
const target = resolve(args.find((a) => !a.startsWith('--')) || process.cwd());

const say = (s) => console.log(s);
const act = (s) => say(`  ${dry ? '[dry] ' : ''}${s}`);

if (!existsSync(target)) {
  say(`projeto não encontrado: ${target}`);
  process.exit(1);
}

say(`\ncontext-tools Codex → ${target}${dry ? '  (simulação)' : ''}\n`);

const codexDir = join(target, '.codex');
const dstScripts = join(codexDir, 'scripts');
const dstLib = join(dstScripts, 'lib');
const dstSkill = join(target, '.agents', 'skills', 'context-tools');
const claudeConfig = join(target, '.claude', 'context-tools.json');
const codexConfig = join(codexDir, 'context-tools.json');
const markerPath = join(codexDir, 'context-tools-install.json');

if (!dry && mode === 'standalone') {
  mkdirSync(dstLib, { recursive: true });
  mkdirSync(dstSkill, { recursive: true });
}

let copied = 0;
if (mode === 'standalone') {
for (const f of readdirSync(join(HERE, 'scripts'))) {
  if (!f.endsWith('.mjs')) continue;
  if (f === 'claude-md-hint.mjs') continue;
  act(`scripts/${f}`);
  if (!dry) copyFileSync(join(HERE, 'scripts', f), join(dstScripts, f));
  copied++;
}
for (const f of readdirSync(join(HERE, 'scripts', 'lib'))) {
  act(`scripts/lib/${f}`);
  if (!dry) copyFileSync(join(HERE, 'scripts', 'lib', f), join(dstLib, f));
  copied++;
}
act('skills/context-tools/SKILL.md');
if (!dry) copyFileSync(join(HERE, 'skills', 'context-tools', 'SKILL.md'), join(dstSkill, 'SKILL.md'));
say(`  → ${copied} script(s) + 1 skill\n`);
}
if (!dry) mkdirSync(codexDir, { recursive: true });

// A primeira instalação leva a configuração já existente do Claude para o Codex, mas só uma
// vez: depois disso, cada host pode evoluir sua configuração sem atravessar o outro.
if (existsSync(claudeConfig) && !existsSync(codexConfig)) {
  act('.codex/context-tools.json (inicializado a partir de .claude/context-tools.json)');
  if (!dry) copyFileSync(claudeConfig, codexConfig);
}

const ignorePath = join(codexDir, '.gitignore');
const ignoreText = '# estado gerado pelo context-tools Codex — não versionar\ncontext-tools/\ncontext-tools-install.json\n';
if (!existsSync(ignorePath)) {
  act('.codex/.gitignore');
  if (!dry) {
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(ignorePath, ignoreText, 'utf8');
  }
} else if (!dry) {
  const currentIgnore = readFileSync(ignorePath, 'utf8');
  if (!currentIgnore.split(/\r?\n/).includes('context-tools-install.json')) {
    writeFileSync(ignorePath, `${currentIgnore.replace(/\s*$/, '')}\ncontext-tools-install.json\n`, 'utf8');
    act('.codex/.gitignore (context-tools-install.json)');
  }
}

if (!dry) {
  const marker = {
    name: 'context-tools',
    version: PACKAGE.version,
    installedAt: new Date().toISOString(),
    source: HERE,
    mode,
  };
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  act('.codex/context-tools-install.json');
}

if (mode === 'global') {
  const { TARGETS } = await import('./scripts/lib/setup-targets.mjs');
  if (!dry) TARGETS.codex.removeManagedProjectHooks(target);
  say('  global: plugin supplies scripts, skill and hooks; no local bootstrap copied.');
} else if (noHooks) {
  say('  hooks: pulado (--no-hooks)\n');
} else {
  const hooksPath = join(codexDir, 'hooks.json');
  let settings = {};
  if (existsSync(hooksPath)) {
    try {
      settings = JSON.parse(readFileSync(hooksPath, 'utf8'));
    } catch {
      say(`  aviso: ${hooksPath} não é JSON válido — hooks não registrados.`);
      settings = null;
    }
  }

  if (settings) {
    if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) {
      say('  aviso: .codex/hooks.json tem "hooks" num formato inesperado — hooks não registrados.');
      settings = null;
    }
    if (settings) {
      const manifesto = JSON.parse(readFileSync(join(HERE, 'hooks', 'codex-hooks.json'), 'utf8'));
      settings.hooks ||= {};
      let added = 0;
      for (const [event, grupos] of Object.entries(manifesto.hooks)) {
        if (!Array.isArray(settings.hooks[event])) {
          if (settings.hooks[event] !== undefined) {
            say(`  aviso: hooks.${event} não é lista — pulado.`);
            continue;
          }
          settings.hooks[event] = [];
        }
        for (const origem of grupos) {
          const matcher = origem.matcher ?? '';
          let grupo = settings.hooks[event].find((g) => g && typeof g === 'object' && (g.matcher ?? '') === matcher);
          if (!grupo) {
            grupo = { matcher, hooks: [] };
            settings.hooks[event].push(grupo);
          }
          if (!Array.isArray(grupo.hooks)) grupo.hooks = [];
          for (const origemHook of origem.hooks) {
            const command = origemHook.command.replace(
              'node "${PLUGIN_ROOT}/scripts/',
              'node ".codex/scripts/',
            );
            const legado = origemHook.command.replace(
              'node "${PLUGIN_ROOT}/scripts/',
              'node "$(git rev-parse --show-toplevel)/.codex/scripts/',
            );
            const antigo = grupo.hooks.find((h) => h && h.command === legado);
            if (antigo) {
              act(`hook ${event}: caminho relativo atualizado`);
              antigo.command = command;
              added++;
              continue;
            }
            if (grupo.hooks.some((h) => h && h.command === command)) continue;
            act(`hook ${event}: ${command}`);
            grupo.hooks.push({ ...origemHook, command });
            added++;
          }
        }
      }
      if (!dry && added) {
        mkdirSync(codexDir, { recursive: true });
        writeFileSync(hooksPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      }
      say(`  → ${added} hook(s) adicionado(s)\n`);
    }
  }
}

const verificationPrefix = mode === 'global' ? `${HERE.replace(/\\/g, '/')}/scripts` : '.codex/scripts';
say('Verificação:');
for (const command of ["symbols.mjs --stats", "coupling.mjs", "audit-docs.mjs", "context-pack.mjs <symbol-or-file> --budget=2000", "providers.mjs --json", "metrics.mjs", "health.mjs --audit", "benchmark-pretool.mjs --samples=5", "benchmark-prompt-audit.mjs --samples=7", "context-docs.mjs status"]) {
  const [file, ...parameters] = command.split(' ');
  say(`  node "${verificationPrefix}/${file}" ${parameters.join(' ')}`);
}
say('');
say('A instalação Codex não altera .claude/.');
