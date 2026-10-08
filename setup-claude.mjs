#!/usr/bin/env node
// Instalador e atualizador multiplataforma do context-tools para Claude.
// Sem dependências externas: funciona no Windows, Linux e macOS com Node >= 18.
//
// Este arquivo é uma casca fina sobre scripts/lib/setup-engine.mjs (motor genérico) e
// scripts/lib/setup-targets.mjs (adapter Claude). Espelha setup-codex.mjs; toda a lógica de
// instalação é compartilhada entre os dois e com setup.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, detectProjectRoot, compareVersions, latestTagFromLsRemote, relativeExtra,
  parseExtraSelection, normalizeSetupLanguage, waitBeforeExit, isDir, t,
} from './scripts/lib/setup-shared.mjs';
import { TARGETS } from './scripts/lib/setup-targets.mjs';
import { runSetup, chooseGuidedRoot, projectStatus as projectStatusFor } from './scripts/lib/setup-engine.mjs';

export {
  parseArgs, detectProjectRoot, compareVersions, latestTagFromLsRemote, relativeExtra,
  parseExtraSelection, normalizeSetupLanguage,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
const ADAPTER = TARGETS.claude;
const ctx = { repoRoot: HERE, packageVersion: PACKAGE.version };

export function projectStatus(root) {
  return projectStatusFor(ADAPTER, ctx, root);
}

async function main() {
  const { command, project: explicitProject, flags } = parseArgs();
  if (command === 'help' || command === 'latest') {
    process.exitCode = await runSetup(ADAPTER, ctx, { command, root: null, flags });
    return;
  }
  const detectedRoot = detectProjectRoot(process.cwd(), explicitProject);
  const root = await chooseGuidedRoot(detectedRoot, flags);
  if (!isDir(root)) throw new Error(t('setup.notFound', { raiz: root }));
  process.exitCode = await runSetup(ADAPTER, ctx, { command, root, flags });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { flags } = parseArgs();
  main()
    .catch((error) => { console.error(t('setup.error', { mensagem: error.message })); process.exitCode = 1; })
    .finally(() => waitBeforeExit(flags));
}
