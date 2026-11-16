#!/usr/bin/env node
// 🧩 Briefing para um subagente barato: o mínimo que ele precisa para trabalhar sozinho.
//
//   brief.mjs "<tarefa>" --role=explorer|verifier|map-keeper|translator|executor
//             [--done="<critério de pronto>"] [--files=a,b] [--allow=<globs>] [--test="<comando>"]
//             [--handoff=<arquivo>] [--budget=<caracteres>] [--ttl-minutes=N] [--json]
//
// Imprime um texto para colar no prompt do subagente (`Agent` no Claude, o agente `ct-*` no
// Codex). Junta a tarefa e o critério de pronto, as regras do papel, a linha de comando absoluta
// do `ct`, o bloco do handoff que só a sessão sabia, o "Por onde começar" dos mapas ATUALIZADOS
// que cobrem os arquivos citados, um outline filtrado dos arquivos grandes e o que muda junto.
//
// Papel que escreve: `--allow` declara o escopo de escrita e grava o ticket que a trava dos hooks
// consulta (lib/delegation.mjs). Sem `--allow`, só o `map-keeper` escreve (mapas e ai-context/).
//
// Tudo aqui é determinístico e local: nada chama modelo, nada sai da máquina.

import { existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { findRepos, isMain, lerTexto, loadConfig, resolveRoot, safe, sanitizeModelText, scriptDir } from './lib/roots.mjs';
import { detectLang, makeT } from './lib/i18n.mjs';
import { normalizeRole, parseAllow, ROLES, writeScope, SCOPE_TTL_MINUTES } from './lib/delegation.mjs';
import { recordMetric } from './lib/telemetry.mjs';

const BIG_FILE_LINES = 300;
const MAX_FILES = 8;

const flag = (args, name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};

const TXT = {
  en: {
    title: (r) => `# Briefing — ${r}`,
    task: 'Task', done: 'Done when', doneDefault: 'you can answer the task with evidence, or you know you cannot',
    rules: 'Rules for this role', ct: 'Context tools (use instead of re-exploring)',
    readOnly: 'Read-only: do not edit, create, move or delete files; do not change git state.',
    scope: (g) => `Write scope (edits elsewhere are denied): ${g}`,
    noScope: 'No write scope declared: every edit will be denied. Ask the main session for `--allow`.',
    noShell: 'Never change git state or write files from the shell; edits go through the edit tools.',
    test: 'Test command', handoff: 'What the session knows (from its handoff)',
    start: 'Where to start (from up-to-date context maps)', outline: 'Outline of large files (filtered)',
    coupling: 'Usually changes together', answer: 'Answer format', stale: (n) => `${n} map(s) cover these files but are not up to date: confirm in the code.`,
  },
  pt: {
    title: (r) => `# Briefing — ${r}`,
    task: 'Tarefa', done: 'Pronto quando', doneDefault: 'você consegue responder a tarefa com evidência, ou sabe que não consegue',
    rules: 'Regras deste papel', ct: 'Ferramentas de contexto (use em vez de re-explorar)',
    readOnly: 'Só leitura: não edite, crie, mova nem apague arquivos; não mude o git.',
    scope: (g) => `Escopo de escrita (editar fora é negado): ${g}`,
    noScope: 'Sem escopo de escrita declarado: toda edição será negada. Peça `--allow` à sessão principal.',
    noShell: 'Nunca mude o git nem escreva arquivo pelo shell; edição vai pelas ferramentas de edição.',
    test: 'Comando de teste', handoff: 'O que a sessão sabe (do handoff dela)',
    start: 'Por onde começar (dos mapas de contexto atualizados)', outline: 'Outline dos arquivos grandes (filtrado)',
    coupling: 'Costuma mudar junto', answer: 'Formato da resposta', stale: (n) => `${n} mapa(s) cobrem estes arquivos mas não estão atualizados: confirme no código.`,
  },
};

const ANSWER = {
  'ct-explorer': { en: 'One-line answer; evidence as `path:line — what`; `Not verified:` list. At most 20 lines, no file contents.', pt: 'Resposta numa linha; evidência como `caminho:linha — o quê`; lista `Não verificado:`. No máximo 20 linhas, sem colar arquivo.' },
  'ct-verifier': { en: '`exit=<code>`, the command, then the failing lines verbatim (at most 40). Do not fix anything.', pt: '`exit=<código>`, o comando, e as linhas de falha literais (no máximo 40). Não corrija nada.' },
  'ct-map-keeper': { en: 'Files changed, one line each; `Not verified:` list. Record each reviewed map with `ct ack <map>`.', pt: 'Arquivos mudados, uma linha cada; lista `Não verificado:`. Registre cada mapa revisado com `ct ack <mapa>`.' },
  'ct-translator': { en: 'Files written, sections changed, `Doubts:` list.', pt: 'Arquivos escritos, seções mudadas, lista `Dúvidas:`.' },
  'ct-executor': { en: 'Files changed, one line each; check command and exit code; `Stopped at:` list.', pt: 'Arquivos mudados, uma linha cada; comando de verificação e exit code; lista `Parei em:`.' },
};

/** Arquivos citados: `--files` mais os caminhos da tarefa que existem no projeto. */
function focusFiles(root, task, files) {
  const listed = String(files || '').split(',').map((f) => f.trim()).filter(Boolean);
  const named = [...String(task || '').matchAll(/[\w@./\\-]+\.[A-Za-z][\w]{0,5}\b/g)].map((m) => m[0]);
  const out = [];
  for (const candidate of [...listed, ...named]) {
    const abs = isAbsolute(candidate) ? candidate : resolve(root, candidate);
    const rel = relative(root, abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || out.includes(rel)) continue;
    if (safe(() => statSync(abs).isFile(), false)) out.push(rel);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/** Palavras da tarefa que parecem identificador: filtram o outline. */
function identifiers(task) {
  const stop = new Set(['the', 'and', 'that', 'with', 'from', 'this', 'para', 'onde', 'como', 'quem', 'which', 'where', 'what']);
  return [...new Set([...String(task || '').matchAll(/[A-Za-z_$][\w$]{3,}/g)].map((m) => m[0]).filter((w) => !stop.has(w.toLowerCase())))];
}

/** A seção de um markdown cujo título casa `re`, sem o título. */
function section(text, re) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((l) => /^##\s/.test(l) && re.test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^##?\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

async function mapStarts(root, files) {
  const { contextMapsExplainFile } = await import('./context-maps.mjs');
  const fresh = new Map();
  let stale = 0;
  for (const file of files) {
    const info = safe(() => contextMapsExplainFile(root, file), null);
    for (const map of info?.maps || []) {
      if (map.status !== 'fresh') { stale++; continue; }
      if (fresh.has(map.path)) continue;
      const body = section(lerTexto(join(root, map.path)), /por onde começar|where to start|start here/i);
      if (body) fresh.set(map.path, body.split('\n').slice(0, 14).join('\n'));
    }
  }
  return { fresh, stale };
}

async function outlines(root, files, words) {
  const { parserForExt } = await import('./outline.mjs');
  const out = [];
  for (const file of files) {
    const parser = parserForExt(extname(file));
    const text = lerTexto(join(root, file));
    if (!parser || text === null) continue;
    const lines = text.split('\n');
    if (lines.length < BIG_FILE_LINES) continue;
    const symbols = safe(() => parser(lines), []) || [];
    const re = words.length ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null;
    const hits = (re ? symbols.filter((s) => re.test(s.name)) : []).slice(0, 12);
    const shown = hits.length ? hits : symbols.slice(0, 12);
    out.push(`${file} (${lines.length} lines)${hits.length ? '' : ' — first symbols'}`);
    for (const s of shown) out.push(`  ${s.line}: ${sanitizeModelText(s.name, 120)}`);
  }
  return out;
}

async function couplings(root, files) {
  if (!files.length) return [];
  const { analyze, DEFAULTS } = await import('./coupling.mjs');
  const cfg = loadConfig(root);
  const out = [];
  for (const repo of findRepos(root, { requireGit: true, cfg })) {
    const mine = files.map((f) => relative(repo.path, resolve(root, f)).replace(/\\/g, '/')).filter((f) => !f.startsWith('..'));
    if (!mine.length) continue;
    const report = safe(() => analyze(repo.path, { ...DEFAULTS, ...cfg }), null);
    for (const link of report?.links || []) {
      const own = mine.includes(link.a) ? link.a : mine.includes(link.b) ? link.b : null;
      if (!own) continue;
      const other = own === link.a ? link.b : link.a;
      if (mine.includes(other)) continue;
      out.push({ text: `${own} → ${other} (${Math.round(link.conf * 100)}%, ${link.n}×)`, conf: link.conf });
    }
  }
  return out.sort((a, b) => b.conf - a.conf).slice(0, 6).map((x) => x.text);
}

function handoffBlock(root, file) {
  if (!file) return '';
  const text = lerTexto(isAbsolute(file) ? file : resolve(root, file));
  if (!text) return '';
  const heads = ['en', 'pt'].flatMap((l) => { const t = makeT(l); return [t('ho.volatil'), t('ho.volatilPrompt')]; })
    .filter((h) => typeof h === 'string' && h && !h.startsWith('ho.'));
  const re = new RegExp(heads.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || 'know', 'i');
  return section(text, re).slice(0, 3000);
}

export async function buildBrief(root, opts = {}) {
  const cfg = loadConfig(root);
  const lang = detectLang(cfg) === 'pt' ? 'pt' : 'en';
  const T = TXT[lang];
  const role = normalizeRole(opts.role || 'explorer');
  if (!role) return { ok: false, error: 'invalid-role' };
  const spec = ROLES[role];
  const task = String(opts.task || '').trim();
  if (!task) return { ok: false, error: 'empty-task' };

  const files = focusFiles(root, task, opts.files);
  const ct = `node "${join(scriptDir(), 'ct.mjs').replace(/\\/g, '/')}"`;
  let scope = null;
  if (spec.writes) {
    const allow = parseAllow(opts.allow);
    if (allow.length) scope = writeScope({ root, role, allow, task, ttlMinutes: opts.ttlMinutes || SCOPE_TTL_MINUTES, env: opts.env }).ticket;
  }
  const globs = [...(spec.defaultScope || []), ...(scope?.allow || [])];
  const test = role === 'ct-verifier' ? (opts.test || (await import('./lib/verification.mjs')).detectTestCommand(root, cfg) || null) : (opts.test || null);

  const parts = [T.title(role), '', `**${T.task}:** ${task}`, `**${T.done}:** ${opts.done || T.doneDefault}`, ''];
  parts.push(`## ${T.rules}`);
  if (!spec.writes) parts.push(`- ${T.readOnly}`);
  else parts.push(`- ${globs.length ? T.scope(globs.join(', ')) : T.noScope}`);
  parts.push(`- ${T.noShell}`);
  if (test) parts.push(`- ${T.test}: \`${test}\` (cwd: ${root.replace(/\\/g, '/')})`);
  parts.push('', `## ${T.ct}`, `\`${ct} <verb>\` — find <name> · refs <name> · outline <file> [filter] · coupling <file> · impact <name>${role === 'ct-map-keeper' ? ' · ack <map>' : ''}`, '');

  const sections = [];
  const handoff = handoffBlock(root, opts.handoff);
  if (handoff) sections.push([T.handoff, handoff]);
  const { fresh, stale } = files.length ? await mapStarts(root, files) : { fresh: new Map(), stale: 0 };
  if (fresh.size || stale) {
    const body = [...fresh].map(([path, text]) => `${path}:\n${text}`).join('\n\n');
    sections.push([T.start, [body, stale ? T.stale(stale) : ''].filter(Boolean).join('\n')]);
  }
  const outline = await outlines(root, files, identifiers(task));
  if (outline.length) sections.push([T.outline, outline.join('\n')]);
  const together = await couplings(root, files);
  if (together.length) sections.push([T.coupling, together.map((x) => `- ${x}`).join('\n')]);

  // Orçamento: as seções de apoio entram em ordem até o teto; a tarefa e as regras, sempre.
  const budget = Math.max(1500, Math.min(20000, Number(opts.budget) || 6000));
  let used = parts.join('\n').length;
  const dropped = [];
  for (const [title, body] of sections) {
    const block = `## ${title}\n${body}\n`;
    if (used + block.length > budget) { dropped.push(title); continue; }
    parts.push(block);
    used += block.length;
  }
  parts.push(`## ${T.answer}`, ANSWER[role][lang]);
  const text = parts.join('\n');
  return { ok: true, role, lang, text, files, scope, test, dropped, chars: text.length };
}

async function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot(args);
  const task = args.filter((a) => !a.startsWith('--')).join(' ');
  const result = await buildBrief(root, {
    task, role: flag(args, 'role'), done: flag(args, 'done'), files: flag(args, 'files'), allow: flag(args, 'allow'),
    test: flag(args, 'test'), handoff: flag(args, 'handoff'), budget: flag(args, 'budget'), ttlMinutes: flag(args, 'ttl-minutes'),
  });
  recordMetric(root, 'delegation-brief', { outcome: result.ok ? 'ok' : result.error, role: result.role || null, chars: result.chars || 0, scoped: Boolean(result.scope) });
  if (!result.ok) {
    process.stderr.write(result.error === 'invalid-role'
      ? `brief: --role must be one of: ${Object.keys(ROLES).map((r) => r.slice(3)).join(', ')}\n`
      : 'brief: pass the task as text, e.g. brief.mjs "where is X computed?" --role=explorer\n');
    process.exitCode = 1;
    return;
  }
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(result.text);
}

if (isMain(import.meta.url)) {
  try { await main(); } catch (e) { console.log(`brief: ${sanitizeModelText(e?.message || e, 200)}`); process.exitCode = 1; }
}
