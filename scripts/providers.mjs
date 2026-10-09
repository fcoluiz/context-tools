#!/usr/bin/env node
// Descoberta de provedores semânticos opcionais.
// Nunca instala nada durante hooks ou consultas normais; --install-plan apenas mostra o comando.

import { spawnSync } from 'node:child_process';
import { resolveRoot, capabilityForExtension, LANGUAGE_CAPABILITIES, sanitizeModelText, isMain, loadConfig } from './lib/roots.mjs';
import { recordMetric } from './lib/telemetry.mjs';

const PROVIDERS = Object.freeze({
  javascript: {
    id: 'typescript', language: 'JavaScript/TypeScript', command: 'tsserver',
    install: 'npm install --save-dev typescript', protocol: 'lsp-or-json',
  },
  python: {
    id: 'pyright', language: 'Python', command: 'pyright-langserver',
    install: 'npm install --save-dev pyright', protocol: 'lsp',
  },
  go: {
    id: 'gopls', language: 'Go', command: 'gopls',
    install: 'go install golang.org/x/tools/gopls@latest', protocol: 'lsp',
  },
  rust: {
    id: 'rust-analyzer', language: 'Rust', command: 'rust-analyzer',
    install: 'rustup component add rust-analyzer', protocol: 'lsp',
  },
  csharp: {
    id: 'csharp-ls', language: 'C#', command: 'csharp-ls',
    install: 'dotnet tool install --global csharp-ls', protocol: 'lsp',
  },
  java: {
    id: 'jdtls', language: 'Java', command: 'jdtls',
    install: 'https://github.com/eclipse-jdtls/eclipse.jdt.ls#installation', protocol: 'lsp',
  },
  php: {
    id: 'intelephense', language: 'PHP', command: 'intelephense',
    install: 'npm install --global intelephense', protocol: 'lsp',
  },
});

function executableExists(command) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const r = spawnSync(probe, [command], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0;
}

export function providerForExtension(ext) {
  const cap = capabilityForExtension(ext);
  return cap ? PROVIDERS[cap.id] || null : null;
}

export function discoverProviders(root, cfg = {}) {
  const enabled = cfg.semanticProviders === false ? false : true;
  return Object.values(PROVIDERS).map((p) => ({
    ...p,
    available: enabled && executableExists(p.command),
    enabled,
    command: sanitizeModelText(p.command, 80),
    install: sanitizeModelText(p.install, 220),
  }));
}

export function suggestionsForExtensions(extensions, root, cfg = {}) {
  const found = new Map();
  for (const ext of extensions) {
    const p = providerForExtension(ext);
    if (p && !found.has(p.id)) found.set(p.id, { ...p, available: executableExists(p.command) });
  }
  return [...found.values()].filter((p) => !p.available && cfg.semanticProviders !== false);
}

function main() {
  const root = resolveRoot();
  const cfg = loadConfig(root);
  const rows = discoverProviders(root, cfg);
  const plan = process.argv.includes('--install-plan');
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ root, providers: rows.map((p) => ({ ...p, ...(plan ? {} : { install: undefined }) })) }, null, 2) + '\n');
    return;
  }
  console.log(`context-tools semantic providers — root: ${sanitizeModelText(root, 180)}`);
  for (const p of rows) {
    console.log(`- ${p.language}: ${p.id} — ${p.available ? 'available' : 'not found'}${plan && !p.available ? ` — plan: ${p.install}` : ''}`);
  }
  if (!rows.some((p) => p.available)) console.log('No optional semantic provider is available; local parsers remain active.');
  console.log('Nothing was installed. Run the suggested command explicitly after reviewing it.');
}

if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot();
  try { main(); } catch { process.exitCode = 0; }
  finally {
    recordMetric(root, 'providers', {
      installPlan: process.argv.includes('--install-plan'),
      json: process.argv.includes('--json'),
      durationMs: Date.now() - started,
    });
  }
}

export { PROVIDERS, LANGUAGE_CAPABILITIES };
