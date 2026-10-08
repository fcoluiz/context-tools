#!/usr/bin/env node
// Relatório local de adoção; não lê conteúdo de arquivos do projeto.

import { resolveRoot, isMain, sanitizeModelText } from './lib/roots.mjs';
import { readMetrics, clearMetrics } from './lib/telemetry.mjs';

function main() {
  const root = resolveRoot();
  if (process.argv.includes('--clear')) {
    clearMetrics(root);
    console.log('context-tools metrics cleared');
    return;
  }
  const data = readMetrics(root);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ root, ...data }, null, 2));
    return;
  }
  const counts = new Map();
  for (const e of data.events) counts.set(e.type, (counts.get(e.type) || 0) + 1);
  console.log(`context-tools metrics — ${sanitizeModelText(root, 180)}`);
  console.log(`events: ${data.events.length}`);
  for (const [type, count] of counts) console.log(`- ${type}: ${count}`);
  console.log('Only local counters and bounded metadata are stored; file contents and prompts are not recorded.');
}

if (isMain(import.meta.url)) {
  try { main(); } catch { process.exitCode = 0; }
}
