// Snapshot compartilhado de descoberta/índice. É uma camada de metadados, não uma segunda fonte
// de verdade: o cache de símbolos continua validando mtime, tamanho e assinatura do parser.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { safe, stateDir, statePath } from './roots.mjs';

const FORMAT = 1;
const file = (root) => statePath(root, '.context-tools-snapshot.json');

function configKey(cfg) {
  return JSON.stringify(cfg || {}, Object.keys(cfg || {}).sort());
}

export function loadSnapshot(root, cfg = {}) {
  const value = safe(() => JSON.parse(readFileSync(file(root), 'utf8')), null);
  if (!value || value.format !== FORMAT || value.root !== root || value.config !== configKey(cfg)) return null;
  return value;
}

export function saveSnapshot(root, cfg, data) {
  const value = {
    format: FORMAT,
    root,
    config: configKey(cfg),
    generatedAt: Date.now(),
    ...data,
  };
  safe(() => {
    mkdirSync(stateDir(root), { recursive: true });
    const tmp = join(stateDir(root), `.context-tools-snapshot.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file(root));
  }, null);
  return value;
}

export function snapshotPath(root) { return file(root); }

