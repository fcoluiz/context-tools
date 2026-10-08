// Funções genéricas reaproveitadas pelos instaladores guiados (setup-codex.mjs, setup-claude.mjs,
// setup.mjs). Nenhuma função aqui é específica de um agente — quem é específico vive em
// setup-targets.mjs (o adapter) e setup-engine.mjs (o motor que combina as duas coisas).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { dirname, join, relative, resolve } from 'node:path';
import { extraReposDoCodeWorkspace } from './roots.mjs';
import { detectLang, makeT } from './i18n.mjs';

// O setup fala o mesmo idioma que o resto das ferramentas, pela mesma cadeia de resolução:
// CONTEXT_TOOLS_LANG → "lang" no context-tools.json → locale do sistema → inglês. A configuração
// do projeto ainda não foi lida quando as primeiras mensagens saem (é ela que o setup vai
// escrever), então aqui valem a variável de ambiente e o locale; `useSetupConfigLang` reaproveita
// o `lang` do projeto assim que ele é conhecido.
let lang = detectLang({});
let translate = makeT(lang);

export const t = (key, params = {}) => translate(key, params);
export const setupLang = () => lang;

export function useSetupConfigLang(config = {}) {
  if (process.env.CONTEXT_TOOLS_LANG) return lang;
  const next = detectLang(config);
  if (next === lang) return lang;
  lang = next;
  translate = makeT(lang);
  return lang;
}

const KNOWN_COMMANDS = new Set(['install', 'update', 'status', 'doctor', 'latest', 'configure', 'help']);
// No Windows, estas CLIs são chamadas pelo nome via cmd.exe, que resolve a extensão pelo PATHEXT:
// o npm instala `claude.cmd`/`codex.cmd`, mas o instalador nativo do Claude Code instala
// `claude.exe` — forçar ".cmd" quebrava nesse caso.
const WINDOWS_BATCH = new Set(['codex', 'claude', 'npm']);

export const say = (message = '') => console.log(message);
export const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
export const isFile = (path) => existsSync(path) && !isDir(path);
const quoteCmd = (value) => {
  const text = String(value);
  return /^[A-Za-z0-9_./:=+@%-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
};

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body === 'help' || body === 'yes' || body === 'json' || body === 'guided' || body === 'no-workspace' || body === 'no-bootstrap' || body === 'skip-cli-install' || body === 'skip-codex-install' || body === 'dry-run' || body === 'keep-open') {
      flags[body] = true;
      continue;
    }
    const equal = body.indexOf('=');
    if (equal >= 0) {
      flags[body.slice(0, equal)] = body.slice(equal + 1);
      continue;
    }
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[body] = argv[++i];
    } else {
      flags[body] = true;
    }
  }
  let command = positionals[0] || 'install';
  let project = flags.project || null;
  if (!KNOWN_COMMANDS.has(command)) {
    project ||= command;
    command = 'install';
  }
  if (flags.help) command = 'help';
  return { command, project, flags, positionals };
}

function rootMarker(path) {
  return isFile(join(path, '.git')) || isDir(join(path, '.git'))
    || isDir(join(path, '.codex')) || isDir(join(path, '.claude'))
    || isFile(join(path, 'AGENTS.md')) || isFile(join(path, 'CLAUDE.md'));
}

export function detectProjectRoot(start = process.cwd(), explicit = null) {
  if (explicit) return resolve(explicit);
  if (process.env.CONTEXT_TOOLS_PROJECT_DIR && isDir(process.env.CONTEXT_TOOLS_PROJECT_DIR)) {
    return resolve(process.env.CONTEXT_TOOLS_PROJECT_DIR);
  }
  let current = resolve(start);
  for (;;) {
    if (rootMarker(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(start);
}

export function run(command, args, options = {}) {
  const batch = process.platform === 'win32' && WINDOWS_BATCH.has(command);
  const file = batch ? (process.env.ComSpec || 'cmd.exe') : command;
  const commandArgs = batch
    ? ['/d', '/s', '/c', [command, ...args].map(quoteCmd).join(' ')]
    : args;
  const result = spawnSync(file, commandArgs, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

// Saída `--json` das CLIs: o Codex devolve um objeto; o Claude devolve uma LISTA no topo
// (`[{ "id": ... }]`). Procurar só `{` cortava o `[` inicial e o parse falhava calado, então o setup
// nunca enxergava o plugin já instalado. Tenta a partir de cada linha que abre JSON, em ordem.
export function jsonOutput(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[[{]/.test(lines[i])) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* tenta a próxima linha */ }
  }
  return null;
}

export function compareVersions(a, b) {
  const parse = (value) => String(value).replace(/^v/i, '').split(/[+-]/)[0].split('.').map((n) => Number(n) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  }
  return 0;
}

export function latestTagFromLsRemote(output) {
  const tags = String(output).split(/\r?\n/)
    .map((line) => line.trim().match(/refs\/tags\/(v\d+\.\d+\.\d+)$/)?.[1])
    .filter(Boolean);
  return tags.sort(compareVersions).at(-1) || null;
}

export function latestTag(repositoryUrl) {
  const result = run('git', ['ls-remote', '--tags', '--refs', repositoryUrl]);
  return result.status === 0 ? latestTagFromLsRemote(result.stdout) : null;
}

export function relativeExtra(root, candidate) {
  const absolute = resolve(root, candidate);
  if (!isDir(absolute)) return null;
  const rel = relative(resolve(root), absolute).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../../') || rel.startsWith('../..')) return null;
  return rel;
}

export function parseExtraSelection(value, candidates = [], root = process.cwd()) {
  const selected = [];
  const invalid = [];
  for (const raw of String(value || '').split(',').map((item) => item.trim()).filter(Boolean)) {
    if (/^\d+$/.test(raw)) {
      const item = candidates[Number(raw) - 1];
      if (item) selected.push(item);
      else invalid.push(raw);
      continue;
    }
    const item = relativeExtra(root, raw);
    if (item) selected.push(item);
    else invalid.push(raw);
  }
  return { selected: [...new Set(selected)], invalid };
}

const COMBINING_DIACRITICS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');

export function normalizeSetupLanguage(value) {
  const text = String(value ?? '').trim().toLowerCase()
    .normalize('NFD').replace(COMBINING_DIACRITICS, '');
  if (text === 'p' || text.startsWith('pt') || text.startsWith('portugu')) return 'pt';
  if (text === 'e' || text.startsWith('en') || text.startsWith('ingl')) return 'en';
  return null;
}

export function workspaceCandidates(root) {
  const found = [];
  for (const path of extraReposDoCodeWorkspace(root)) {
    const rel = relativeExtra(root, path);
    if (rel && !found.includes(rel)) found.push(rel);
  }
  const parent = resolve(root, '..');
  for (const entry of (readdirSync(parent, { withFileTypes: true }) || [])) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = join(parent, entry.name);
    const rel = relativeExtra(root, candidate);
    if (!rel || found.includes(rel)) continue;
    if (isFile(join(candidate, '.git')) || isDir(join(candidate, '.git')) || entry.name.toLowerCase() === 'shared') found.push(rel);
  }
  return found.sort();
}

export async function ask(question, fallback = '') {
  if (!input.isTTY || !output.isTTY) return fallback;
  const rl = createInterface({ input, output });
  try { return (await rl.question(question)).trim() || fallback; } finally { rl.close(); }
}

export async function confirm(question, fallback = true, yes = false) {
  if (yes) return true;
  const answer = (await ask(`${question} ${t('setup.confirmSuffix', { padrao: fallback })} `, '')).toLowerCase();
  if (!answer) return fallback;
  // Aceita as duas línguas sempre, independentemente do idioma da pergunta: quem digita "s" num
  // prompt em inglês quis dizer sim, e recusar isso só cria confusão.
  return ['s', 'sim', 'y', 'yes'].includes(answer);
}

export function explainFailure(step, result) {
  const detail = [result?.stderr, result?.stdout].map((value) => String(value || '').trim()).find(Boolean);
  say(t('setup.fail.step', { etapa: step }));
  if (/auth|permission|denied|private|repository not found|could not read/i.test(detail || '')) {
    say(t('setup.fail.auth'));
  }
  if (detail) say(t('setup.fail.detail', { detalhe: detail.split(/\r?\n/).slice(-3).join(' ') }));
  say(t('setup.fail.noFurther'));
}

export async function waitBeforeExit(flags) {
  if (!flags['keep-open'] || !input.isTTY || !output.isTTY) return;
  await ask(t('setup.pressEnter'), '');
}
