#!/usr/bin/env node
// Aviso de versão nova do context-tools.
//
// O caso que motivou: a máquina do próprio mantenedor ficou na 2.2.0 com a 2.4.0 publicada,
// porque o marketplace do Claude foi adicionado com `ref` fixo na tag instalada — a atualização
// nativa do host nunca enxerga uma versão nova assim. Só o plugin sabe a própria versão.
//
// É o ÚNICO ponto do plugin que usa rede, e por isso tem três travas:
//   - nunca no caminho do hook: o `SessionStart` só lê um cache; quando ele tem mais de 24 h, um
//     processo DESTACADO roda `git ls-remote --tags` e grava o resultado para a próxima sessão;
//   - só tags públicas do repositório saem da rede; nada do projeto, nenhum dado do usuário entra
//     na consulta;
//   - desligável: `"updateCheck": false` na configuração ou `CONTEXT_TOOLS_UPDATE_CHECK=0`. Em CI
//     não roda.
//
// O cache mora na pasta do USUÁRIO, não do projeto: uma consulta por dia na máquina inteira, e o
// mesmo aviso para Claude e Codex.
//
// Uso manual:
//   update-check.mjs            → mostra instalada × última conhecida (atualiza o cache antes)
//   update-check.mjs --refresh  → só atualiza o cache (é o que o processo destacado roda)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, safe, sanitizeModelText, scriptDir } from './lib/roots.mjs';

export const REPOSITORY_URL = 'https://github.com/fcoluiz/context-tools.git';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Quem viu o aviso e não atualizou volta a vê-lo depois disto — uma vez só é fácil de perder. */
export const REMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const LS_REMOTE_TIMEOUT_MS = 15000;
const SELF = fileURLToPath(import.meta.url);

export function compareVersions(a, b) {
  const parse = (value) => String(value).replace(/^v/i, '').split(/[+-]/)[0].split('.').map((n) => Number(n) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  }
  return 0;
}

/** Arquivo de cache, compartilhado por todos os projetos e pelos dois hosts. */
export function cachePath(env = process.env) {
  const base = env.CONTEXT_TOOLS_HOME || join(homedir(), '.context-tools');
  return join(base, 'update-check.json');
}

export function updateCheckEnabled(cfg = {}, env = process.env) {
  if (cfg.updateCheck === false) return false;
  if (env.CONTEXT_TOOLS_UPDATE_CHECK === '0') return false;
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return false;
  return true;
}

/**
 * Versão desta instalação. No plugin e no checkout de desenvolvimento, `package.json` fica ao
 * lado de `scripts/`; numa instalação standalone (`.claude/scripts`, `.codex/scripts`) o
 * instalador grava `context-tools-install.json` nesse mesmo lugar.
 */
export function installedVersion(dir = dirname(scriptDir())) {
  for (const file of ['package.json', 'context-tools-install.json']) {
    const data = safe(() => JSON.parse(readFileSync(join(dir, file), 'utf8')), null);
    if (data?.name === 'context-tools' && typeof data.version === 'string') return data.version;
  }
  return null;
}

function readCache(path) {
  const data = safe(() => JSON.parse(readFileSync(path, 'utf8')), null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function writeCache(path, data) {
  safe(() => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); }, null);
}

export function latestTagFromLsRemote(output) {
  const tags = String(output).split(/\r?\n/)
    .map((line) => line.trim().match(/refs\/tags\/(v\d+\.\d+\.\d+)$/)?.[1])
    .filter(Boolean);
  return tags.sort(compareVersions).at(-1) || null;
}

/** Consulta a rede e grava o cache. Falha de rede grava só o horário: tenta de novo amanhã. */
export function refreshCache(path = cachePath()) {
  const result = spawnSync('git', ['ls-remote', '--tags', '--refs', REPOSITORY_URL], {
    encoding: 'utf8', timeout: LS_REMOTE_TIMEOUT_MS, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const latest = result.status === 0 ? latestTagFromLsRemote(result.stdout) : null;
  const previous = readCache(path);
  writeCache(path, { ...previous, latest: latest ? latest.replace(/^v/, '') : previous.latest || null, checkedAt: Date.now() });
  return latest;
}

function startBackgroundRefresh(path) {
  // Marca o horário ANTES de disparar: duas sessões abertas juntas não disparam duas consultas.
  writeCache(path, { ...readCache(path), checkedAt: Date.now() });
  const child = spawn(process.execPath, [SELF, '--refresh'], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, CONTEXT_TOOLS_UPDATE_CACHE: path },
  });
  child.unref();
}

function updateCommand(env = process.env) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const global = env.CLAUDE_PLUGIN_ROOT || env.PLUGIN_ROOT ? ' --global' : '';
  return `${npx} --yes --package github:fcoluiz/context-tools context-tools-setup-all${global} --yes`;
}

/**
 * Chamado no `SessionStart`. Devolve a linha para o usuário, ou `''`.
 * Nunca espera a rede: lê o cache e, se ele estiver velho, dispara a atualização em segundo plano.
 * Avisa uma vez por versão nova e repete a cada `REMIND_AFTER_MS` enquanto não houver atualização.
 */
export function updateNotice(cfg = {}, {
  env = process.env, now = Date.now(), installed = installedVersion(), path = cachePath(env),
  startRefresh = startBackgroundRefresh, lang = 'en',
} = {}) {
  if (!updateCheckEnabled(cfg, env) || !installed) return '';
  const cache = readCache(path);
  if (!(now - (cache.checkedAt || 0) < CHECK_INTERVAL_MS)) safe(() => startRefresh(path), null);
  const latest = typeof cache.latest === 'string' && /^\d+\.\d+\.\d+$/.test(cache.latest) ? cache.latest : null;
  if (!latest || compareVersions(latest, installed) <= 0) return '';
  if (cache.notified === latest && now - (cache.notifiedAt || 0) < REMIND_AFTER_MS) return '';
  writeCache(path, { ...readCache(path), notified: latest, notifiedAt: now });
  const command = updateCommand(env);
  const version = sanitizeModelText(latest, 20);
  return lang === 'pt'
    ? `⬆️ context-tools ${version} disponível (instalado: ${installed}). Para atualizar: ${command} — depois abra uma sessão nova. (Para não verificar: "updateCheck": false.)`
    : `⬆️ context-tools ${version} is available (installed: ${installed}). To update: ${command} — then open a new session. (To stop checking: "updateCheck": false.)`;
}

if (isMain(import.meta.url)) {
  const path = process.env.CONTEXT_TOOLS_UPDATE_CACHE || cachePath();
  if (process.argv.includes('--refresh')) {
    try { refreshCache(path); } catch { /* processo destacado: ninguém lê o erro */ }
  } else {
    const latest = refreshCache(path);
    const installed = installedVersion();
    console.log(`context-tools — installed: ${installed || 'unknown'} · latest: ${latest ? latest.replace(/^v/, '') : 'unavailable'}`);
    if (existsSync(path)) console.log(`  cache: ${path}`);
  }
}
