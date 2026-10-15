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
// assume "both" quando nada foi detectado. Com --global e sem --target, é sempre "both".

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  say, isDir, isFile, ask, latestTag, parseArgs, detectProjectRoot, waitBeforeExit, t,
} from './scripts/lib/setup-shared.mjs';
import { TARGETS, resolveTargets } from './scripts/lib/setup-targets.mjs';
import { runSetup, chooseGuidedRoot } from './scripts/lib/setup-engine.mjs';
import { isMain } from './scripts/lib/roots.mjs';

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
  // Global sem --target é o comando "para todos": instala Claude e Codex, inclusive a CLI que
  // faltar (ensureCli). Quem quer um agente só usa --target ou o setup daquele agente.
  if (flags.global) return ['both'];
  const detected = detectExistingTargetIds(root);
  if (detected.length === 1) return detected;
  if (flags.yes || !isInteractive()) return detected.length ? detected : ['both'];
  say(t('setup.target.ask'));
  say(t('setup.target.optClaude'));
  say(t('setup.target.optCodex'));
  say(t('setup.target.optBoth'));
  const answer = (await ask(t('setup.target.prompt'), '3')).trim();
  if (answer === '1') return ['claude'];
  if (answer === '2') return ['codex'];
  return ['both'];
}

function help() {
  say(t('setup.help.unified', { opcoes: t('setup.help.options') }));
}

async function main() {
  const { command, project: explicitProject, flags } = parseArgs();
  if (command === 'help') { help(); return; }
  if (command === 'latest') { say(latestTag(TARGETS.codex.repositoryUrl) || t('setup.run.localFallback', { versao: PACKAGE.version })); return; }

  const detectedRoot = detectProjectRoot(process.cwd(), explicitProject);
  const root = flags.global ? detectedRoot : await chooseGuidedRoot(detectedRoot, flags);
  if (!isDir(root)) throw new Error(t('setup.notFound', { raiz: root }));

  const targetIds = await chooseTargetIds(root, flags);
  const adapters = resolveTargets(targetIds);
  let exitCode = 0;
  for (const adapter of adapters) {
    const code = await runSetup(adapter, ctx, { command, root, flags });
    exitCode = exitCode || code;
  }
  process.exitCode = exitCode;
}

// `isMain` compara o caminho REAL: no Linux/macOS o bin do npm é um symlink, e uma comparação
// direta fazia o instalador sair sem fazer nada.
if (isMain(import.meta.url)) {
  const { flags } = parseArgs();
  main()
    .catch((error) => { console.error(t('setup.error', { mensagem: error.message })); process.exitCode = 1; })
    .finally(() => waitBeforeExit(flags));
}
