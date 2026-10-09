#!/usr/bin/env node
// Pacote de contexto determinístico: compõe sinais existentes sob um orçamento.
// Não interpreta uma tarefa livre como plano; cada item informa sua origem e limitação.

import { existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative, extname, basename } from 'node:path';
import { resolveRoot, findRepos, loadConfig, isMain, lerTexto, walk, HISTORY_CODE_RE, sanitizeModelText } from './lib/roots.mjs';
import { buildIndex } from './symbols.mjs';
import { parserForExt } from './outline.mjs';
import { evidence, evidenceEnvelope, formatEvidence } from './lib/evidence.mjs';
import { suggestionsForExtensions } from './providers.mjs';
import { recordMetric } from './lib/telemetry.mjs';
import { analyze as analyzeCoupling, DEFAULTS as COUPLING_DEFAULTS } from './coupling.mjs';
import { documentationEvidence } from './lib/documentation.mjs';
import { isTestFile } from './lib/verification.mjs';

const MAX_ITEMS = 80;
const MAX_SCAN_HITS = 24;

function arg(name, fallback = null) {
  const p = process.argv.find((x) => x.startsWith(`${name}=`));
  return p ? p.slice(name.length + 1) : fallback;
}

/** Teste pelo nome do arquivo ou da pasta — inclusive o projeto `.Tests` de uma solução .NET. */
function ehArquivoDeTeste(file) {
  return Boolean(file) && (isTestFile(file) || /(?:^|[\\/])[^\\/]+\.Tests?[\\/]/i.test(file));
}

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function fileInside(root, candidate) {
  const abs = resolve(root, candidate);
  const rel = relative(root, abs);
  return rel && !rel.startsWith('..') && !rel.includes(`..${requireSep()}`) ? abs : null;
}

function requireSep() { return process.platform === 'win32' ? '\\' : '/'; }

function git(repo, args) {
  try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}

function findTargetFile(root, query, knownFiles = null) {
  const direct = fileInside(root, query);
  if (direct && existsSync(direct) && statSync(direct).isFile()) return direct;
  if (Array.isArray(knownFiles)) {
    const exact = knownFiles.find((f) => basename(f, extname(f)).toLowerCase() === query.toLowerCase()
      || f.replace(root, '').replace(/^[\\/]/, '').replace(/\\/g, '/') === query.replace(/\\/g, '/'));
    if (exact && existsSync(exact)) return exact;
  }
  for (const repo of findRepos(root, { requireGit: false, cfg: loadConfig(root) })) {
    const files = [];
    walk(repo.path, HISTORY_CODE_RE, files);
    const exact = files.find((f) => basename(f, extname(f)).toLowerCase() === query.toLowerCase()
      || f.replace(repo.path, '').replace(/^[\\/]/, '').replace(/\\/g, '/') === query.replace(/\\/g, '/'));
    if (exact) return exact;
  }
  return null;
}

function outlineItems(file, root) {
  const parser = parserForExt(extname(file));
  const text = lerTexto(file);
  if (!parser || text === null) return [];
  const lines = text.split('\n');
  return parser(lines).slice(0, MAX_SCAN_HITS).map((s) => evidence('outline', {
    text: `${relative(root, file).replace(/\\/g, '/')}:${s.line} ${s.name}`,
    file: relative(root, file).replace(/\\/g, '/'),
    line: s.line,
    symbol: sanitizeModelText(s.name, 140),
  }, { confidence: 'parsed', freshness: 'generated' }));
}

function mapItems(root, query) {
  const out = [];
  for (const dir of [join(root, '.claude', 'context'), join(root, '.codex', 'context')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const file = join(dir, name);
      const text = lerTexto(file) || '';
      const covers = [...text.matchAll(/^\s*-\s*"?([^"\n]+)"?\s*$/gm)].map((m) => m[1].trim());
      if (!covers.some((c) => c.toLowerCase().includes(query.toLowerCase()))) continue;
      out.push(evidence('context-map', {
        text: `${relative(root, file).replace(/\\/g, '/')}: ${sanitizeModelText(covers.join(', '), 180)}`,
        file: relative(root, file).replace(/\\/g, '/'),
      }, { confidence: 'declared', freshness: 'needs-verification' }));
    }
  }
  return out;
}

function textualItems(root, query, cfg) {
  const re = new RegExp(esc(query), 'i');
  const out = [];
  for (const repo of findRepos(root, { requireGit: false, cfg })) {
    const files = [];
    walk(repo.path, HISTORY_CODE_RE, files);
    for (const file of files) {
      const text = lerTexto(file);
      if (text === null) continue;
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (out.length >= MAX_SCAN_HITS || !re.test(line)) return;
        const kind = /(^|[\\/])tests?[\\/]|\.(test|spec)\./i.test(file) ? 'test' : 'textual-match';
        out.push(evidence(kind, {
          text: `${relative(root, file).replace(/\\/g, '/')}:${i + 1} ${line.trim()}`,
          file: relative(root, file).replace(/\\/g, '/'),
          line: i + 1,
        }, { confidence: 'textual', freshness: 'generated' }));
      });
      if (out.length >= MAX_SCAN_HITS) break;
    }
    if (out.length >= MAX_SCAN_HITS) break;
  }
  return out;
}

function historyItems(root, query, knownFiles = null) {
  const out = [];
  const target = findTargetFile(root, query, knownFiles);
  if (!target) return out;
  const repo = findRepos(root, { requireGit: true }).find((r) => target.startsWith(r.path));
  if (!repo) return out;
  const rel = relative(repo.path, target).replace(/\\/g, '/');
  for (const line of git(repo.path, ['log', '-n', '3', '--format=%h %ad %s', '--date=short', '--', rel]).split('\n').filter(Boolean)) {
    out.push(evidence('history', { text: `${rel}: ${line}` }, { confidence: 'git', freshness: 'current-history' }));
  }
  return out;
}

function couplingItems(root, target, cfg) {
  if (!target) return [];
  const repo = findRepos(root, { requireGit: true, cfg }).find((r) => target.startsWith(r.path));
  if (!repo) return [];
  const relTarget = relative(repo.path, target).replace(/\\/g, '/');
  const report = analyzeCoupling(repo.path, { ...COUPLING_DEFAULTS, ...cfg });
  return report.links
    .filter((link) => link.a === relTarget || link.b === relTarget)
    .slice(0, MAX_SCAN_HITS)
    .map((link) => {
      const other = link.a === relTarget ? link.b : link.a;
      const denominator = link.a === relTarget ? link.soloA : link.soloB;
      return evidence('co-change', {
        text: `${relTarget} ↔ ${other} (${Math.round(link.conf * 100)}%; ${link.n}/${denominator} cestas)`,
        file: relTarget,
        related: other,
        together: link.n,
        denominator,
      }, { confidence: link.conf, freshness: `git:${COUPLING_DEFAULTS.since}` });
    });
}

export function buildContextPack(root, query, opts = {}) {
  const cfg = loadConfig(root);
  const budget = Math.max(400, Math.min(12000, Number(opts.budget || 2000)));
  // O hook pre-tool já construiu o índice para decidir se precisa de pack. Reutilizá-lo
  // evita pagar uma segunda varredura justamente no caminho que deve ser econômico.
  const index = opts.index || buildIndex(root, cfg);
  const items = [];
  const q = String(query || '').trim();
  if (!q) return evidenceEnvelope({ status: 'invalid', query: q, limitations: ['a query is required'] });

  let re;
  try { re = new RegExp(q.replace(/^[A-Za-z_]\w*\./, ''), 'i'); }
  catch { return evidenceEnvelope({ status: 'invalid', query: q, limitations: ['query is not a valid symbol pattern'] }); }
  for (const [name, locs] of index.defs) {
    if (!re.test(name)) continue;
    for (const loc of locs.slice(0, 8)) {
      items.push(evidence('definition', {
        text: `${loc.file}:${loc.line}-${loc.end || loc.line} ${loc.kind}`,
        file: loc.file, line: loc.line, end: loc.end || loc.line, symbol: name,
      }, { confidence: name.toLowerCase() === q.toLowerCase() ? 'exact' : 'partial', freshness: index.tier === 'B' ? 'cache-validated' : 'generated' }));
    }
  }
  // Código de produção antes de teste, exato antes de parcial; no resto, a ordem do índice. Na ordem
  // do índice, `MaxDepth` trazia métodos de teste e uma constante de nome parecido no meio das
  // propriedades — e a resposta errada do benchmark de resultado nomeou justamente essa constante.
  const peso = (item) => (ehArquivoDeTeste(item.file) ? 2 : 0) + (item.confidence === 'exact' ? 0 : 1);
  items.sort((a, b) => peso(a) - peso(b));

  // A documentação operacional entra antes do outline e das correspondências textuais. Ela
  // orienta a investigação, mas continua marcada como declarada/precisa de confirmação — não é
  // uma definição de código nem prova semântica.
  for (const item of documentationEvidence(root, q, cfg)) {
    items.push(evidence('documentation', {
      text: item.text,
      file: item.file,
      documentType: item.documentType,
    }, { confidence: item.confidence, freshness: item.freshness }));
  }

  const target = findTargetFile(root, q, index.files);
  if (target) items.push(...outlineItems(target, root));
  items.push(...mapItems(root, q));
  items.push(...textualItems(root, q, cfg));
  if (opts.history) {
    items.push(...historyItems(root, q, index.files));
    items.push(...couplingItems(root, target, cfg));
  }

  const extensions = [...new Set((index.files || []).map((f) => extname(f)))];
  const hasDefinition = items.some((x) => x.kind === 'definition');
  const suggestions = hasDefinition ? [] : suggestionsForExtensions(extensions, root, cfg);
  const limitations = [];
  if (!hasDefinition) limitations.push('no parsed definition matched; textual results are not definitions');
  if (index.truncados?.length) limitations.push('directory depth limit was reached');
  for (const p of suggestions.slice(0, 4)) limitations.push(`${p.language} semantic provider unavailable: ${p.install}`);

  const maxChars = budget * 4;
  const selected = [];
  let chars = 0;
  for (const item of items.slice(0, MAX_ITEMS)) {
    const line = formatEvidence(item);
    if (chars + line.length > maxChars) break;
    selected.push(item);
    chars += line.length + 1;
  }
  return evidenceEnvelope({
    status: selected.length ? 'ok' : 'not-found', query: q,
    scope: index.repos, freshness: index.tier === 'B' ? 'cache-validated' : 'generated',
    items: selected, limitations: [...new Set(limitations)],
  });
}

function main() {
  const root = resolveRoot();
  const query = process.argv.slice(2).filter((x) => !x.startsWith('--'))[0] || '';
  const pack = buildContextPack(root, query, { budget: arg('--budget', 2000), history: process.argv.includes('--history') });
  recordMetric(root, 'context-pack', { outcome: pack.status, queryLength: query.length, items: pack.items.length, budget: Number(arg('--budget', 2000)) || 2000 });
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(pack, null, 2) + '\n');
  else {
    console.log(`context-pack — ${pack.query} — ${pack.status} — scope: ${pack.scope.join(', ')}`);
    for (const item of pack.items) console.log(formatEvidence(item));
    for (const note of pack.limitations) console.log(`! ${note}`);
  }
}

if (isMain(import.meta.url)) {
  try { main(); } catch (e) { console.log(`context-pack: ${sanitizeModelText(e?.message || e, 200)}`); }
}
