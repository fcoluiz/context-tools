#!/usr/bin/env node
// Instalador unificado do context-tools: escolhe Claude, Codex ou os dois e delega para o mesmo
// motor de scripts/lib/setup-engine.mjs usado por setup-codex.mjs e setup-claude.mjs.
//
// Uso:
//   node setup.mjs [install|update] [--project <dir>] [--target=claude|codex|both]
//   node setup.mjs status|doctor [--project <dir>] [--json] [--target=...]
//   node setup.mjs latest
//   node setup.mjs configure [--project <dir>] [--target=...]
//
// Sem --target, detecta o que já existe no projeto (.codex/AGENTS.md, .claude/CLAUDE.md); se
// achar os dois ou nenhum e a sessão for interativa, pergunta; sem terminal (--yes ou não-TTY),
// assume "both" quando nada foi detectado.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  say, isDir, isFile, ask, latestTag, parseArgs, detectProjectRoot, waitBeforeExit,
} from './scripts/lib/setup-shared.mjs';
import { TARGETS, resolveTargets } from './scripts/lib/setup-targets.mjs';
import { runSetup, chooseGuidedRoot } from './scripts/lib/setup-engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
const ctx = { repoRoot: HERE, packageVersion: PACKAGE.version };
const isInteractive = () => process.stdin.isTTY && process.stdout.isTTY;

function detectExistingTargetIds(root) {
  const found = [];
  if (isDir(join(root, '.codex')) || isFile(join(root, 'AGENTS.md'))) found.push('codex');
  if (isDir(join(root, '.claude')) || isFile(join(root, 'CLAUDE.md'))) found.push('claude');
  return found;
}

async function chooseTargetIds(root, flags) {
  if (flags.target) return String(flags.target).split(',').map((value) => value.trim()).filter(Boolean);
  const detected = detectExistingTargetIds(root);
  if (detected.length === 1) return detected;
  if (flags.yes || !isInteractive()) return detected.length ? detected : ['both'];
  say('\nPara quais agentes instalar o context-tools?');
  say('  1. Claude');
  say('  2. Codex');
  say('  3. Ambos');
  const answer = (await ask('Escolha [1/2/3] (Enter = ambos): ', '3')).trim();
  if (answer === '1') return ['claude'];
  if (answer === '2') return ['codex'];
  return ['both'];
}

function help() {
  say(`context-tools setup — instalação e manutenção unificada (Claude e/ou Codex)

Uso:
  node setup.mjs [install|update] [--project <diretório>] [--target=claude|codex|both]
  node setup.mjs status [--project <diretório>] [--json] [--target=...]
  node setup.mjs doctor [--project <diretório>] [--json] [--target=...]
  node setup.mjs latest
  node setup.mjs configure [--project <diretório>] [--target=...]

Sem --target, o agente é detectado pelo projeto (.codex/AGENTS.md, .claude/CLAUDE.md); se achar
os dois ou nenhum e o terminal for interativo, a escolha é perguntada. As demais opções são as
mesmas de setup-codex.mjs/setup-claude.mjs: --yes, --guided, --no-workspace, --no-bootstrap,
--extra-repos=..., --remove-extra-repos=..., --lang=pt|en, --ref=vX.Y.Z, --dry-run, --keep-open.
`);
}

async function main() {
  const { command, project: explicitProject, flags } = parseArgs();
  if (command === 'help') { help(); return; }
  if (command === 'latest') { say(latestTag(TARGETS.codex.repositoryUrl) || `v${PACKAGE.version} (fallback local)`); return; }

  const detectedRoot = detectProjectRoot(process.cwd(), explicitProject);
  const root = await chooseGuidedRoot(detectedRoot, flags);
  if (!isDir(root)) throw new Error(`Projeto não encontrado: ${root}`);

  const targetIds = await chooseTargetIds(root, flags);
  const adapters = resolveTargets(targetIds);
  let exitCode = 0;
  for (const adapter of adapters) {
    const code = await runSetup(adapter, ctx, { command, root, flags });
    exitCode = exitCode || code;
  }
  process.exitCode = exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { flags } = parseArgs();
  main()
    .catch((error) => { console.error(`context-tools setup: ${error.message}`); process.exitCode = 1; })
    .finally(() => waitBeforeExit(flags));
}
