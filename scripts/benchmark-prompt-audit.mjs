#!/usr/bin/env node
// Mede sob demanda o custo ponta a ponta do preflight Codex UserPromptSubmit.
// Usa um projeto temporário e prompts sintéticos; não lê nem grava dados do projeto atual.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/roots.mjs';
import { fingerprintSourcesInRoot } from './lib/source-fingerprints.mjs';

const adapter = fileURLToPath(new URL('./codex-hook.mjs', import.meta.url));

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function sampleCount(args) {
  const value = args.find((arg) => arg.startsWith('--samples='))?.slice('--samples='.length);
  const count = value === undefined ? 7 : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('--samples must be an integer from 1 to 50');
  return count;
}

function runOnce(root, prompt, serial) {
  const event = {
    hook_event_name: 'UserPromptSubmit',
    session_id: `context-tools-prompt-benchmark-${serial}`,
    cwd: root,
    prompt,
  };
  const started = performance.now();
  const result = spawnSync(process.execPath, [adapter, 'context-docs.mjs', '--prompt-audit'], {
    cwd: root,
    input: JSON.stringify(event),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const elapsed = performance.now() - started;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Codex prompt hook exited with status ${result.status}`);
  return elapsed;
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !arg.startsWith('--samples='));
  if (unknown.length) throw new Error(`unknown option(s): ${unknown.join(', ')}`);
  const samples = sampleCount(args);
  const root = mkdtempSync(join(tmpdir(), 'context-tools-prompt-audit-bench-'));
  try {
    const source = join(root, 'src', 'target.mjs');
    const map = join(root, '.claude', 'context', 'sample.md');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.claude', 'context'), { recursive: true });
    writeFileSync(source, 'export const benchmarkFixture = true;\n');
    const digest = fingerprintSourcesInRoot(root, ['src/target.mjs']).digest;
    writeFileSync(map, `---\narea: benchmark-fixture\ncovers:\n  - "src/target.mjs"\nverified_at: 2026-01-01\nsource_digest: ${digest}\n---\n`);

    const cases = [
      { id: 'ordinary prompt (no named file)', prompt: 'Explain the project structure briefly.' },
      { id: 'explicit mapped path', prompt: 'Review `src/target.mjs`.' },
      { id: 'bare basename (workspace walk)', prompt: 'Review `target.mjs`.' },
    ];
    console.log(`Codex UserPromptSubmit preflight timing — synthetic project · ${samples} measured sample(s) per case`);
    for (const item of cases) {
      const initialMs = runOnce(root, item.prompt, `${item.id}-warmup`);
      const values = [];
      for (let index = 0; index < samples; index++) values.push(runOnce(root, item.prompt, `${item.id}-${index}`));
      console.log(`${item.id}: initial ${initialMs.toFixed(1)} ms · p50 ${percentile(values, 0.50).toFixed(1)} ms · p95 ${percentile(values, 0.95).toFixed(1)} ms`);
    }
    console.log('Synthetic prompts only; no project prompts, source contents, paths or timings are persisted. Includes Node startup and local hook work.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`benchmark-prompt-audit: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
