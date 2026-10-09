#!/usr/bin/env node
// 🧭 Conhecimento deixado para trás por um diff — a checagem de PR/CI do context-tools.
//
// Num time, o mapa de contexto e o documento `ai-context` só continuam valendo se quem muda o código
// também confere o que está escrito sobre ele. Este comando olha o diff de um PR e lista cada mapa ou
// documento `live` cuja fonte citada mudou SEM uma revisão registrada (o `ack` grava no próprio
// arquivo o fingerprint da fonte revisada — é a única prova que vale em CI, onde não há cache local).
//
// Não julga se o texto continua certo: diz qual conhecimento ficou para trás e por quê, para alguém
// conferir. Falha visível: sem conseguir comparar (ref inexistente, clone raso), sai com código 2 e
// diz o remédio — "não consegui olhar" não pode passar por "nada mudou".
//
// Uso:
//   drift-check.mjs --base=<ref> [--head=HEAD] [--format=text|github|json] [--strict]
//   (em GitHub Actions, sem --base usa origin/$GITHUB_BASE_REF)
//
// Saída 0 = nada para trás (ou achados sem --strict) · 1 = achados com --strict · 2 = não deu para olhar.

import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  resolveRoot, loadConfig, isMain, findRepos, sanitizeModelText, CODE_RE,
} from './lib/roots.mjs';
import { contextMapsDrift, refSeguro } from './context-maps.mjs';
import { documentationDrift } from './lib/documentation.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';

function arg(args, name) {
  const found = args.find((a) => a.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : null;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Arquivos que o diff base...head mudou, em caminho absoluto. Lança se não der para comparar. */
export function changedFiles(root, base, head = 'HEAD', cfg = loadConfig(root)) {
  if (!refSeguro(base) || !refSeguro(head)) throw new Error(`invalid ref: ${base} / ${head}`);
  const repos = findRepos(root, { requireGit: true, cfg });
  if (!repos.length) throw new Error('no git repository under the root');
  const out = [];
  for (const repo of repos) {
    const names = git(repo.path, ['diff', '--name-only', '-z', `${base}...${head}`, '--']).split('\0').filter(Boolean);
    for (const name of names) out.push(resolve(repo.path, name));
  }
  return out;
}

export function driftReport(root, base, head = 'HEAD', cfg = loadConfig(root)) {
  const changed = changedFiles(root, base, head, cfg);
  const maps = contextMapsDrift(root, changed);
  const docs = documentationDrift(root, cfg, changed);
  return {
    base, head,
    changed: changed.length,
    changedCode: changed.filter((f) => CODE_RE.test(f)).length,
    items: [...maps, ...docs.items],
    documentation: docs.status,
  };
}

function mensagem(item, t) {
  const fontes = item.sources.slice(0, 3).map((s) => sanitizeModelText(s, 120)).join(', ') + (item.sources.length > 3 ? ` +${item.sources.length - 3}` : '');
  const motivo = t(`drift.reason.${item.reason}`);
  return t(item.documentUpdated ? 'drift.itemEdited' : 'drift.item', {
    kind: t(`drift.kind.${item.kind}`), title: sanitizeModelText(item.title, 80), sources: fontes, reason: motivo, path: item.path,
  });
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot(args);
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  const format = arg(args, '--format') || 'text';
  const strict = args.includes('--strict');
  const base = arg(args, '--base') || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null);
  const head = arg(args, '--head') || 'HEAD';
  if (!base) { console.log(t('drift.usage')); return 2; }

  let report;
  try {
    report = driftReport(root, base, head, cfg);
  } catch (e) {
    const detalhe = sanitizeModelText(String(e?.stderr || e?.message || e).split('\n')[0], 240);
    if (format === 'github') console.log(`::error title=context-tools drift::${t('drift.cannotLook', { base, err: detalhe })}`);
    else console.log(t('drift.cannotLook', { base, err: detalhe }));
    return 2;
  }

  if (format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const linhas = [t('drift.header', { base: report.base, head: report.head, n: report.changed, code: report.changedCode })];
    if (!report.items.length) linhas.push(t('drift.clean'));
    for (const item of report.items) {
      const texto = mensagem(item, t);
      linhas.push(`  ⚠️ ${texto}`);
      if (format === 'github') console.log(`::warning file=${item.path},title=context-tools drift::${texto.replace(/\r?\n/g, ' ')}`);
    }
    if (report.items.length) linhas.push(t('drift.howTo'));
    linhas.push(t('drift.caveat'));
    console.log(linhas.join('\n'));
    if (format === 'github' && process.env.GITHUB_STEP_SUMMARY) {
      const resumo = [`### ${t('drift.summaryTitle')}`, '', ...linhas.slice(1).map((l) => (l.startsWith('  ⚠️') ? `- ${l.trim()}` : l))].join('\n');
      try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${resumo}\n`); } catch { /* resumo é opcional */ }
    }
  }
  return strict && report.items.length ? 1 : 0;
}

if (isMain(import.meta.url)) {
  let code = 2;
  try { code = main(); } catch (e) {
    console.log(`context-tools drift: ${sanitizeModelText(e?.message || e, 300)}`);
  }
  process.exit(code);
}
