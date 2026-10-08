#!/usr/bin/env node
// 🧪 Quais testes cobrem este arquivo, e a sessão rodou teste depois de editar código?
//
// Uso:
//   verify.mjs <arquivo> [<arquivo>…] [--json]   → testes relacionados + comando sugerido
//   verify.mjs --stop-report                       → hook Stop (Claude): aviso único por sessão
//
// Não executa teste nenhum: só diz qual rodar. Quem decide e executa é o agente.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { isMain, loadConfig, resolveRoot, runtimeHost, safe, statePath } from './lib/roots.mjs';
import { writeHookOutput } from './lib/hook-output.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { recordMetric } from './lib/telemetry.mjs';
import { transcriptDaSessao } from './lib/sessao.mjs';
import { evaluateFollowThrough, hasPendingAnswers } from './lib/follow-through.mjs';
import {
  detectTestCommand, listTestFiles, relatedTests, sessionActivity, unverifiedEdits,
} from './lib/verification.mjs';

const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILES_IN_MESSAGE = 6;

function sessionId() {
  return process.env.CONTEXT_TOOLS_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
}

/** Projeto do arquivo: a pasta mais próxima (até a raiz) que declara um comando de teste. */
function projectFor(root, relFile, cfg, cache) {
  let dir = dirname(resolve(root, relFile));
  const top = resolve(root);
  while (true) {
    if (!cache.has(dir)) cache.set(dir, detectTestCommand(dir, dir === top ? cfg : {}));
    if (cache.get(dir)) return { dir, command: cache.get(dir) };
    if (dir === top || dirname(dir) === dir || !dir.startsWith(top)) break;
    dir = dirname(dir);
  }
  if (!cache.has(top)) cache.set(top, detectTestCommand(top, cfg));
  return { dir: top, command: cache.get(top) };
}

export function verificationReport(root, files, cfg = loadConfig(root)) {
  const commands = new Map();
  const testFiles = new Map();
  const groups = new Map();
  for (const file of files) {
    const project = projectFor(root, file, cfg, commands);
    if (!testFiles.has(project.dir)) testFiles.set(project.dir, listTestFiles(project.dir));
    const rel = relative(project.dir, resolve(root, file));
    const related = relatedTests(project.dir, rel, testFiles.get(project.dir)).map((t) => ({
      ...t, file: relative(root, resolve(project.dir, t.file)).split(sep).join('/'),
    }));
    const key = project.dir;
    if (!groups.has(key)) groups.set(key, { project: relative(root, key).split(sep).join('/') || '.', command: project.command, hasTests: testFiles.get(key).length > 0, files: [] });
    groups.get(key).files.push({ file, related });
  }
  return [...groups.values()];
}

function stopReport(root, cfg, t) {
  if (runtimeHost() === 'codex') return;          // transcript Codex não tem formato estável
  const sid = sessionId();
  if (!sid) return;
  const transcript = transcriptDaSessao(root, sid);
  let parsed = null;
  const activityOnce = () => (parsed ||= sessionActivity(transcript));
  // Proveito das respostas do PreToolUse: só lê o transcript se houver resposta a julgar.
  if (hasPendingAnswers(root, sid)) {
    for (const outcome of evaluateFollowThrough(root, sid, activityOnce().calls)) recordMetric(root, 'pretool-followup', { outcome });
  }
  if (cfg?.verify?.enabled === false) return;
  const statePathFile = statePath(root, '.verify-state.json');
  const store = safe(() => JSON.parse(readFileSync(statePathFile, 'utf8')), null) || {};
  if (store[sid]) return;

  const activity = activityOnce();
  if (!activity.edits.length) return;
  const commands = new Map();
  // O comando de cada projeto também conta como "rodou teste" quando aparece literalmente.
  const known = new Set();
  for (const edit of activity.edits.slice(-50)) {
    const rel = relative(root, resolve(root, edit.path));
    if (rel.startsWith('..')) continue;
    const cmd = projectFor(root, rel, cfg, commands).command;
    if (cmd) known.add(cmd);
  }
  const extra = Array.isArray(cfg?.verify?.testPatterns) ? cfg.verify.testPatterns.filter((p) => typeof p === 'string') : [];
  const files = unverifiedEdits(root, activity, { extraPatterns: [...known, ...extra] });
  if (!files.length) return;

  const groups = verificationReport(root, files.slice(0, MAX_FILES_IN_MESSAGE * 2), cfg)
    .filter((g) => g.command || g.hasTests);
  if (!groups.length) return;                      // projeto sem teste: nada a cobrar

  const lines = [t('ver.header', { n: files.length, files: files.slice(0, MAX_FILES_IN_MESSAGE).join(', '), more: Math.max(0, files.length - MAX_FILES_IN_MESSAGE) })];
  for (const g of groups) {
    const related = [...new Set(g.files.flatMap((f) => f.related.map((r) => r.file)))].slice(0, 6);
    if (related.length) lines.push(t('ver.related', { list: related.join(', ') }));
    if (g.command) lines.push(t('ver.command', { cmd: g.command, project: g.project === '.' ? '' : g.project }));
  }

  const now = Date.now();
  for (const [key, at] of Object.entries(store)) if (now - at > STATE_TTL_MS) delete store[key];
  store[sid] = now;
  safe(() => { mkdirSync(dirname(statePathFile), { recursive: true }); writeFileSync(statePathFile, JSON.stringify(store)); }, null);
  writeHookOutput(root, { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: lines.join('\n') } });
  return files.length;
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot(args);
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  if (args.includes('--stop-report')) return { mode: 'stop-report', warned: stopReport(root, cfg, t) || 0 };
  const files = args.filter((a) => !a.startsWith('--')).map((f) => relative(root, resolve(f)).split(sep).join('/'));
  if (!files.length) { console.log(t('ver.usage')); return { mode: 'usage' }; }
  const report = verificationReport(root, files, cfg);
  if (args.includes('--json')) { process.stdout.write(`${JSON.stringify({ root, groups: report }, null, 2)}\n`); return { mode: 'cli' }; }
  for (const g of report) {
    console.log(t('ver.cliProject', { project: g.project, cmd: g.command || t('ver.noCommand') }));
    for (const f of g.files) {
      console.log(`  ${f.file}`);
      if (!f.related.length) console.log(`    ${t('ver.noRelated')}`);
      for (const r of f.related) console.log(`    → ${r.file} (${t(`ver.reason.${r.reason}`)})`);
    }
  }
  return { mode: 'cli' };
}

if (isMain(import.meta.url)) {
  const started = Date.now();
  let result = {};
  try { result = main() || {}; } catch (error) {
    if (!process.argv.includes('--stop-report')) console.log(`verify: ${error?.message || error}`);
  } finally {
    safe(() => recordMetric(resolveRoot(process.argv.slice(2)), 'verify', { ...result, durationMs: Date.now() - started }), null);
  }
  process.exit(0);
}
