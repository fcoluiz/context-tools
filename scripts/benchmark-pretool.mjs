#!/usr/bin/env node
// Mede sob demanda o custo ponta a ponta do processo Codex PreToolUse.
// Usa entradas sintéticas, não executa os comandos e não imprime nem persiste seus textos.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolveRoot, isMain } from './lib/roots.mjs';

const adapter = fileURLToPath(new URL('./codex-hook.mjs', import.meta.url));

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function sampleCount(args) {
  const value = args.find((arg) => arg.startsWith('--samples='))?.slice('--samples='.length);
  const count = value === undefined ? 5 : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('--samples must be an integer from 1 to 50');
  return count;
}

function runOnce(root, stateDir, caseId, command, serial) {
  const event = {
    hook_event_name: 'PreToolUse',
    session_id: `context-tools-benchmark-${caseId}-${serial}`,
    cwd: root,
    tool_name: 'Bash',
    tool_input: { command },
  };
  const started = performance.now();
  const result = spawnSync(process.execPath, [adapter, 'pre-tool.mjs'], {
    cwd: root,
    env: { ...process.env, CONTEXT_TOOLS_STATE_DIR: stateDir },
    input: JSON.stringify(event),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const elapsed = performance.now() - started;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Codex hook exited with status ${result.status}`);
  return elapsed;
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !arg.startsWith('--samples='));
  if (unknown.length) throw new Error(`unknown option(s): ${unknown.join(', ')}`);
  const samples = sampleCount(args);
  const root = resolveRoot();
  const stateDir = mkdtempSync(join(tmpdir(), 'context-tools-pretool-bench-'));
  const cases = [
    { id: 'unrelated Bash', command: 'git status --short' },
    { id: 'text regex Bash', command: 'rg "TODO.*" .' },
    { id: 'symbol-like Bash', command: 'rg "contextMapsStopReport" scripts/context-maps.mjs' },
  ];

  try {
    console.log(`Codex PreToolUse end-to-end timing — ${root}`);
    console.log(`Each sample starts a fresh Node process; ${samples} measured sample(s) per case.`);
    for (const item of cases) {
      const initialMs = runOnce(root, stateDir, item.id, item.command, 'warmup');
      const values = [];
      for (let i = 0; i < samples; i++) values.push(runOnce(root, stateDir, item.id, item.command, i));
      console.log(`${item.id}: initial ${initialMs.toFixed(1)} ms · p50 ${percentile(values, 0.50).toFixed(1)} ms · p95 ${percentile(values, 0.95).toFixed(1)} ms`);
    }
    console.log('Inputs are synthetic; no shell command is executed. Timings include Node startup, hook work and local metric I/O.');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`benchmark-pretool: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
