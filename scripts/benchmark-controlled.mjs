#!/usr/bin/env node
/**
 * Benchmark controlado de localização de definições.
 *
 * O conjunto de respostas esperadas é fechado e foi conferido com leitura do código.
 * O benchmark só lê os projetos externos; o estado/cache do context-tools vai para uma
 * pasta temporária e é removido ao terminar.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, isAbsolute, relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildContextPack } from './context-pack.mjs';
import { buildIndex, reportOne } from './symbols.mjs';
import { lerTexto, loadConfig, relPath, walk } from './lib/roots.mjs';

const REPEATS = Math.max(1, Number(process.env.CONTROLLED_BENCH_REPEATS || 3));

// Cada item é uma resposta esperada de localização de definição: arquivo relativo + linha.
// Declarações Pascal também entram, pois o parser de símbolos as indexa intencionalmente.
//
// O gold set fica FORA do código: um conjunto real descreve projetos de terceiros (caminhos,
// arquivos, linhas), e isso não pode ir para o repositório. O padrão é o arquivo local
// `docs/benchmarks/cases.local.json`, ignorado pelo git; `--cases=<arquivo>` aponta outro.
// `docs/benchmarks/cases.example.json` mostra o formato e roda contra este próprio repositório.
// `root` relativo é resolvido a partir da pasta do arquivo de casos.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CASES_FILE = join(REPO_ROOT, 'docs', 'benchmarks', 'cases.local.json');

function loadCases() {
  const arg = process.argv.find((a) => a.startsWith('--cases='));
  const file = resolve(arg ? arg.slice('--cases='.length) : DEFAULT_CASES_FILE);
  if (!existsSync(file)) {
    console.error(`Arquivo de casos não encontrado: ${file}`);
    console.error('Crie docs/benchmarks/cases.local.json (fora do git) ou rode com');
    console.error('  --cases=docs/benchmarks/cases.example.json');
    process.exit(2);
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const cases = Array.isArray(data) ? data : data.cases;
  if (!Array.isArray(cases) || !cases.length) {
    console.error(`Nenhum caso em ${file} (esperado: { "cases": [ ... ] }).`);
    process.exit(2);
  }
  const base = dirname(file);
  return cases.map((c) => ({ ...c, root: isAbsolute(c.root) ? c.root : resolve(base, c.root) }));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function score(found, expected) {
  const f = new Set(found);
  const e = new Set(expected);
  let tp = 0;
  for (const item of f) if (e.has(item)) tp++;
  const fp = f.size - tp;
  const fn = e.size - tp;
  const precision = f.size ? tp / f.size : 0;
  const recall = e.size ? tp / e.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, found: f.size, expected: e.size, precision, recall, f1 };
}

function locationKey(root, absoluteOrRelative, line) {
  const file = absoluteOrRelative.includes('\\') || absoluteOrRelative.includes(':\\')
    ? relative(root, absoluteOrRelative)
    : absoluteOrRelative;
  return `${file.replace(/\\/g, '/')}:${line}`;
}

function filesForGlobs(test) {
  const exts = test.globs.map((glob) => glob.replace(/^\*\./, '.').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return walk(test.root, new RegExp(`(?:${exts.join('|')})$`, 'i'), []).sort();
}

// Baseline sem context-tools: busca textual fixa, equivalente ao uso manual de rg,
// implementada aqui para que o Node não dependa da permissão de spawn do ambiente.
function runManual(test) {
  const started = performance.now();
  const query = test.query.toLowerCase();
  const found = [];
  let chars = 0;
  for (const file of filesForGlobs(test)) {
    const text = lerTexto(file);
    if (text === null) continue;
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (!line.toLowerCase().includes(query)) return;
      const key = locationKey(test.root, file, index + 1);
      found.push(key);
      chars += `${key}:${line.trim()}\n`.length;
    });
  }
  return { found, chars, ms: performance.now() - started, matches: found.length };
}

function exactSymbolLocations(index, test) {
  const query = test.query.replace(/^[A-Za-z_]\w*\./, '').toLowerCase();
  const found = [];
  for (const [name, locations] of index.defs) {
    if (name.toLowerCase() !== query) continue;
    for (const loc of locations) found.push(`${loc.file.replace(/\\/g, '/')}:${loc.line}`);
  }
  return [...new Set(found)];
}

function buildSymbolFixture(root, stateDir) {
  process.env.CONTEXT_TOOLS_STATE_DIR = stateDir;
  const started = performance.now();
  const index = buildIndex(root, loadConfig(root), { fresh: true });
  return { index, ms: performance.now() - started };
}

function runSymbols(test, fixture) {
  const started = performance.now();
  const found = exactSymbolLocations(fixture.index, test);
  const report = reportOne(test.query, fixture.index, { wantAll: false, ms: 0 }).join('\n');
  return { found, chars: report.length, ms: performance.now() - started, matches: found.length };
}

function runContextPack(test, budget = 2000) {
  const started = performance.now();
  const pack = buildContextPack(test.root, test.query, { budget, history: false });
  const query = test.query.toLowerCase();
  const definitions = pack.items
    .filter((item) => item.kind === 'definition' && item.file && item.line
      && String(item.symbol || '').toLowerCase() === query)
    .map((item) => `${item.file.replace(/\\/g, '/')}:${item.line}`);
  return {
    found: [...new Set(definitions)],
    chars: JSON.stringify(pack).length,
    ms: performance.now() - started,
    matches: pack.items.length,
    definitions: definitions.length,
    textual: pack.items.filter((item) => item.kind === 'textual-match' || item.kind === 'test').length,
    status: pack.status,
  };
}

// O pack adaptativo só entra quando há ambiguidade real ou múltiplos arquivos.
function adaptiveNeedsPack(symbols) {
  const files = new Set(symbols.found.map((item) => item.replace(/:\d+$/, '')));
  return symbols.found.length > 2 || files.size > 1;
}

function aggregate(rows, method) {
  const subset = rows.map((row) => row[method].score);
  const tp = subset.reduce((n, s) => n + s.tp, 0);
  const fp = subset.reduce((n, s) => n + s.fp, 0);
  const fn = subset.reduce((n, s) => n + s.fn, 0);
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}

function pct(value) { return `${(value * 100).toFixed(1)}%`; }
function tok(chars) { return Math.round(chars / 4); }

function run() {
  const stateDir = mkdtempSync(join(tmpdir(), 'context-tools-controlled-'));
  const fixtures = new Map();
  const rows = [];
  try {
    for (const test of loadCases()) {
      const root = resolve(test.root);
      if (!fixtures.has(root)) fixtures.set(root, buildSymbolFixture(root, stateDir));
      const fixture = fixtures.get(root);
      const manualRuns = [];
      const symbolRuns = [];
      const packRuns = [];
      const adaptivePackRuns = [];
      for (let i = 0; i < REPEATS; i++) {
        manualRuns.push(runManual(test));
        symbolRuns.push(runSymbols(test, fixture));
        packRuns.push(runContextPack(test));
      }
      const manual = manualRuns[0];
      const symbols = symbolRuns[0];
      const pack = packRuns[0];
      const useAdaptivePack = adaptiveNeedsPack(symbols);
      if (useAdaptivePack) {
        for (let i = 0; i < REPEATS; i++) adaptivePackRuns.push(runContextPack(test, 800));
      }
      const adaptiveSource = useAdaptivePack ? adaptivePackRuns : symbolRuns;
      const adaptive = adaptiveSource[0];
      rows.push({
        id: test.id, root: test.root, query: test.query, expected: test.expected,
        manual: { score: score(manual.found, test.expected), found: manual.found, chars: manual.chars, tokens: tok(manual.chars), ms: median(manualRuns.map((r) => r.ms)), matches: manual.matches },
        symbols: { score: score(symbols.found, test.expected), found: symbols.found, chars: symbols.chars, tokens: tok(symbols.chars), ms: median(symbolRuns.map((r) => r.ms)), matches: symbols.matches, indexMs: fixture.ms },
        context: { score: score(pack.found, test.expected), found: pack.found, chars: pack.chars, tokens: tok(pack.chars), ms: median(packRuns.map((r) => r.ms)), matches: pack.matches, definitions: pack.definitions, textual: pack.textual, status: pack.status },
        adaptive: { score: score(adaptive.found, test.expected), found: adaptive.found, chars: adaptive.chars, tokens: tok(adaptive.chars), ms: useAdaptivePack ? median(adaptivePackRuns.map((r) => r.ms)) : median(symbolRuns.map((r) => r.ms)), matches: adaptive.matches, route: useAdaptivePack ? 'context-pack@800' : 'symbols' },
      });
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.CONTEXT_TOOLS_STATE_DIR;
  }

  const aggregates = { manual: aggregate(rows, 'manual'), symbols: aggregate(rows, 'symbols'), context: aggregate(rows, 'context'), adaptive: aggregate(rows, 'adaptive') };
  const indexMs = [...new Map(rows.map((r) => [r.root, r.symbols.indexMs])).values()].reduce((a, b) => a + b, 0);
  const payload = { date: new Date().toISOString(), repeats: REPEATS, cases: rows.length, roots: [...new Set(rows.map((r) => r.root))], indexMs, aggregates, rows };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`# Benchmark controlado — localização de definições`);
  console.log(`Data: ${payload.date.slice(0, 10)} · ${rows.length} casos · ${REPEATS} repetições (mediana de tempo)`);
  console.log('Escopo: somente leitura; estado temporário removido ao terminar. Gold set fechado por arquivo e linha.');
  console.log('');
  console.log('| Caso | Esperado | busca manual P/R/F1 | symbols P/R/F1 | context-pack P/R/F1 | Saída manual/symbols/pack (tokens) | tempo manual/symbols/pack (ms) |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    const format = (s) => `${pct(s.precision)}/${pct(s.recall)}/${pct(s.f1)}`;
    console.log(`| ${row.id} · '${row.query}' | ${row.expected.length} | ${format(row.manual.score)} | ${format(row.symbols.score)} | ${format(row.context.score)} | ${row.manual.tokens}/${row.symbols.tokens}/${row.context.tokens} | ${row.manual.ms.toFixed(0)}/${row.symbols.ms.toFixed(2)}/${row.context.ms.toFixed(0)} |`);
  }
  console.log('');
  console.log(`## Agregado`);
  console.log('');
  console.log(`- busca manual textual: P ${pct(aggregates.manual.precision)}, R ${pct(aggregates.manual.recall)}, F1 ${pct(aggregates.manual.f1)}.`);
  console.log(`- symbols: P ${pct(aggregates.symbols.precision)}, R ${pct(aggregates.symbols.recall)}, F1 ${pct(aggregates.symbols.f1)}; índice frio por raiz: ${indexMs.toFixed(0)} ms.`);
  console.log(`- context-pack: P ${pct(aggregates.context.precision)}, R ${pct(aggregates.context.recall)}, F1 ${pct(aggregates.context.f1)}; inclui evidências textuais além das definições.`);
  console.log(`- adaptativo: P ${pct(aggregates.adaptive.precision)}, R ${pct(aggregates.adaptive.recall)}, F1 ${pct(aggregates.adaptive.f1)}; symbols por padrão e context-pack@800 apenas quando há ambiguidade ou múltiplos arquivos.`);
  console.log('');
  console.log('## Roteamento adaptativo');
  console.log('');
  console.log('| Caso | Rota | P/R/F1 | Saída (tokens) | Tempo (ms) |');
  console.log('|---|---|---:|---:|---:|');
  for (const row of rows) {
    const format = (s) => `${pct(s.precision)}/${pct(s.recall)}/${pct(s.f1)}`;
    console.log(`| ${row.id} | ${row.adaptive.route} | ${format(row.adaptive.score)} | ${row.adaptive.tokens} | ${row.adaptive.ms.toFixed(0)} |`);
  }
  console.log('');
  console.log('P/R/F1 medem somente localização de definições exatas do gold set; candidatos parciais/textuais do context-pack ficam fora dessa pontuação. Tokens são caracteres/4 e tempo é local, não custo de modelo.');
}

run();
