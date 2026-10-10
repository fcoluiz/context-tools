#!/usr/bin/env node
// 🧪 Benchmark de RESULTADO — a mesma tarefa, feita por um agente real, com e sem o context-tools.
//
// Os outros benchmarks medem ferramenta contra ferramenta (precisão, recall, tamanho de saída). Este
// mede o que importa para quem usa: a tarefa foi resolvida? quanto custou? quantos turnos? Cada caso
// roda numa cópia limpa do repositório-alvo, nos dois braços:
//   - without: `claude -p` só com as configurações do PROJETO (nenhum plugin, hook ou servidor MCP
//              do usuário entra) — o agente como ele é;
//   - with:    o mesmo, mais `--plugin-dir <este repositório>` — skill e hooks do context-tools.
// O resultado é conferido por um comando (testes) ou por expressões sobre a resposta final.
//
// Custo real: cada execução é uma sessão de agente paga. Há teto por execução (--per-run-cost, que vai
// para `--max-budget-usd` do CLI) e teto total (--max-cost): ao atingi-lo, nenhuma execução nova começa.
// `--dry-run` mostra o plano sem chamar nada.
//
// Uso:
//   benchmark-outcome.mjs --cases=<arquivo.json> [--arms=without,with] [--reps=1] [--max-cost=10]
//                         [--per-run-cost=2] [--model=<modelo>] [--out=<pasta>] [--dry-run]
//
// Arquivo de casos: { "cases": [ { "id", "repo" (pasta local) ou "git" (URL), "ref"?, "prompt", "remove"?: [caminhos],
//   "setup"?: [[comando, ...args], …], "check": { "command": [cmd, ...args] } | { "answer": [regex, …] } } ] }
// `repo` relativo ao arquivo de casos. Casos com dados privados ficam em `*.local.json` (ignorado pelo git).

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/roots.mjs';
import { run } from './lib/setup-shared.mjs';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash(node:*)', 'Bash(git:*)', 'Bash(rg:*)', 'Bash(grep:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(find:*)', 'Bash(npm test:*)'];
// Variáveis da sessão que chamou o benchmark: herdá-las faria o agente medido "continuar" outra
// sessão ou achar que roda dentro de um hook.
// Também as de um app hospedeiro (CLAUDE_CODE_SIMPLE, por exemplo, ligaria o modo mínimo e desligaria
// os plugins nos dois braços).
const ENV_DESCARTADO = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CONTEXT_TOOLS_.*|CODEX_.*)$/;

function arg(args, name, fallback = null) {
  const found = args.find((a) => a.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : fallback;
}

export function loadCases(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const base = dirname(resolve(file));
  const cases = Array.isArray(data) ? data : data.cases;
  if (!Array.isArray(cases) || !cases.length) throw new Error('no cases');
  // `{casesDir}` em comandos aponta para a pasta do arquivo de casos (scripts de conferência ficam ali,
  // fora da cópia que o agente pode editar).
  const subst = (v) => (typeof v === 'string' ? v.split('{casesDir}').join(base) : v);
  return cases.map((c) => {
    if (!c.id || !(c.repo || c.git) || !c.prompt || !c.check) throw new Error(`case needs id, repo or git, prompt and check: ${JSON.stringify(c).slice(0, 120)}`);
    return {
      ...c,
      repo: c.repo ? resolve(base, c.repo) : null,
      setup: (c.setup || []).map((cmd) => cmd.map(subst)),
      check: c.check.command ? { command: c.check.command.map(subst) } : c.check,
    };
  });
}

/** O plano completo, na ordem de execução: caso × repetição × braço (braços alternados). */
export function plan(cases, arms = ['without', 'with'], reps = 1) {
  const out = [];
  for (const c of cases) for (let rep = 1; rep <= reps; rep++) for (const arm of arms) out.push({ case: c, arm, rep });
  return out;
}

export function claudeArgs(arm, { perRunCost, model } = {}) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--strict-mcp-config',
    '--no-session-persistence', '--permission-mode', 'acceptEdits', '--allowedTools', ...ALLOWED_TOOLS,
  ];
  if (perRunCost) args.push('--max-budget-usd', String(perRunCost));
  if (model) args.push('--model', model);
  if (arm === 'with') args.push('--plugin-dir', PLUGIN_DIR);
  return args;
}

function prepararCopia(c) {
  const dir = mkdtempSync(join(tmpdir(), `ct-outcome-${c.id}-`));
  const git = (...a) => spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', ...a], { cwd: dir, encoding: 'utf8' });
  const clone = c.repo
    ? spawnSync('git', ['clone', '--quiet', '--no-hardlinks', c.repo, dir], { encoding: 'utf8' })
    : spawnSync('git', ['clone', '--quiet', '--filter=blob:none', c.git, dir], { encoding: 'utf8', timeout: 600000 });
  if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr}`);
  if (c.ref && git('checkout', '--quiet', c.ref).status !== 0) throw new Error(`ref not found: ${c.ref}`);
  // Configuração de agente que o repositório traga (hooks do próprio projeto, por exemplo) valeria
  // nos dois braços e contaminaria a comparação: o caso declara o que sai.
  for (const p of c.remove || []) rmSync(join(dir, p), { recursive: true, force: true });
  for (const [cmd, ...a] of c.setup || []) {
    const r = spawnSync(cmd, a, { cwd: dir, encoding: 'utf8', shell: false });
    if (r.status !== 0) throw new Error(`setup failed (${cmd} ${a.join(' ')}): ${r.stderr || r.stdout}`);
  }
  git('add', '-A');
  git('commit', '--quiet', '--allow-empty', '-m', 'benchmark baseline');
  return dir;
}

export function conferir(check, dir, resposta) {
  if (Array.isArray(check.answer)) {
    const faltando = check.answer.filter((re) => !new RegExp(re, 'i').test(resposta || ''));
    return { ok: faltando.length === 0, detail: faltando.length ? `missing: ${faltando.join(' | ')}` : 'answer matched' };
  }
  const [cmd, ...a] = check.command;
  const r = spawnSync(cmd, a, { cwd: dir, encoding: 'utf8', timeout: 300000 });
  return { ok: r.status === 0, detail: `exit ${r.status}` };
}

/**
 * Uma execução só vale como medida se o modelo foi chamado. Sem login, por exemplo, o CLI devolve um
 * JSON "success" com custo zero e o texto do erro como resposta — contar isso como "não resolveu"
 * seria inventar um resultado.
 */
export function runError(json, r = {}) {
  if (!json) return `no JSON result (exit ${r.status}): ${String(r.stderr || r.stdout || '').slice(0, 300)}`;
  if (json.is_error) return json.subtype || 'error';
  const u = json.usage || {};
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  if (!tokens || /^(Failed to authenticate|Invalid API key|API Error)/i.test(String(json.result || ''))) return 'no-model-call';
  return null;
}

/**
 * Saída `stream-json`: o evento `result` traz custo, turnos e resposta; as mensagens do assistente
 * trazem cada chamada de ferramenta. Sem saber o que o agente consultou, uma resposta errada não
 * separa "não usou a ferramenta" de "usou e leu errado".
 */
export function parseStream(stdout) {
  let json = null;
  const tools = [];
  for (const line of String(stdout || '').split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'result') json = ev;
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content || []) {
      if (c.type !== 'tool_use') continue;
      const i = c.input || {};
      const alvo = i.command ?? i.pattern ?? i.file_path ?? i.skill ?? i.path ?? '';
      tools.push(`${c.name}${alvo ? `: ${String(alvo).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
    }
  }
  return { json, tools };
}

/**
 * `results.json` é feito para ser publicado: a cópia temporária vira `<copy>` e a pasta do usuário
 * vira `<home>` (com `\` ou `/`, como o agente tiver escrito). O transcript bruto fica como está.
 */
export function anonimizar(texto, dir, home = homedir()) {
  let s = String(texto ?? '');
  // `C:\x`, `C:/x`, `C:\\x` (JSON ou shell escapado) e `/c/x` (Git Bash).
  const variantes = (p) => (p ? [...new Set([
    p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\'), p.replace(/\\/g, '\\\\'),
    p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/'),
  ])] : []);
  for (const v of variantes(dir).sort((a, b) => b.length - a.length)) s = s.split(v).join('<copy>');
  for (const v of variantes(home).sort((a, b) => b.length - a.length)) s = s.split(v).join('<home>');
  return s;
}

function executar(item, opts) {
  const dir = prepararCopia(item.case);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !ENV_DESCARTADO.test(k)));
  const started = Date.now();
  const r = run(opts.claude || 'claude', claudeArgs(item.arm, opts), {
    cwd: dir, env, input: item.case.prompt, timeout: 20 * 60 * 1000, maxBuffer: 64 << 20,
  });
  const { json, tools } = parseStream(r.stdout);
  if (opts.traceFile) writeFileSync(opts.traceFile, r.stdout);
  const resposta = json?.result || '';
  const check = conferir(item.case.check, dir, resposta);
  const changed = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const u = json?.usage || {};
  const out = {
    case: item.case.id, arm: item.arm, rep: item.rep,
    ok: check.ok, check: check.detail,
    costUsd: Number(json?.total_cost_usd) || 0,
    turns: json?.num_turns ?? null,
    durationMs: json?.duration_ms ?? Date.now() - started,
    tokens: {
      input: u.input_tokens ?? null, output: u.output_tokens ?? null,
      cacheCreation: u.cache_creation_input_tokens ?? null, cacheRead: u.cache_read_input_tokens ?? null,
    },
    filesChanged: changed.filter((f) => !/^(ai-context|\.claude|\.codex)\//.test(f)).length,
    error: runError(json, r),
    model: json?.modelUsage ? Object.keys(json.modelUsage).join(',') : (opts.model || null),
    tools: tools.map((t) => anonimizar(t, dir)),
    answer: anonimizar(resposta.slice(0, 2000), dir),
  };
  if (!opts.keep) rmSync(dir, { recursive: true, force: true });
  return out;
}

const mediana = (v) => {
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarize(results) {
  const porBraco = {};
  for (const r of results) (porBraco[r.arm] ||= []).push(r);
  const resumo = {};
  for (const [arm, rs] of Object.entries(porBraco)) {
    resumo[arm] = {
      runs: rs.length,
      solved: rs.filter((r) => r.ok).length,
      totalCostUsd: Math.round(rs.reduce((a, r) => a + r.costUsd, 0) * 100) / 100,
      medianCostUsd: mediana(rs.map((r) => r.costUsd)),
      medianTurns: mediana(rs.map((r) => r.turns)),
      medianDurationS: mediana(rs.map((r) => r.durationMs / 1000)),
      medianContextTokens: mediana(rs.map((r) => (r.tokens.input || 0) + (r.tokens.cacheCreation || 0) + (r.tokens.cacheRead || 0))),
    };
  }
  return resumo;
}

export function markdownReport(results, meta = {}) {
  const resumo = summarize(results);
  const linhas = [
    `# Outcome benchmark — ${meta.date || new Date().toISOString().slice(0, 10)}`, '',
    `Model: ${meta.model || 'CLI default'} · CLI: ${meta.cli || 'claude'} · runs: ${results.length}`, '',
    '| arm | solved | total cost | median cost | median turns | median duration | median context tokens |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(resumo).map(([arm, s]) => `| ${arm} | ${s.solved}/${s.runs} | $${s.totalCostUsd.toFixed(2)} | $${(s.medianCostUsd ?? 0).toFixed(2)} | ${s.medianTurns ?? '—'} | ${s.medianDurationS == null ? '—' : `${Math.round(s.medianDurationS)} s`} | ${s.medianContextTokens ?? '—'} |`),
    '', '| case | arm | solved | cost | turns | files changed | check |', '|---|---|---|---:|---:|---:|---|',
    ...results.map((r) => `| ${r.case} | ${r.arm} | ${r.ok ? 'yes' : 'no'} | $${r.costUsd.toFixed(2)} | ${r.turns ?? '—'} | ${r.filesChanged} | ${String(r.error || r.check).replace(/\|/g, '\\|')} |`),
  ];
  return linhas.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const file = arg(args, '--cases');
  if (!file) { console.log('usage: benchmark-outcome.mjs --cases=<file.json> [--arms=without,with] [--reps=1] [--max-cost=10] [--per-run-cost=2] [--model=<m>] [--out=<dir>] [--dry-run]'); return 2; }
  const cases = loadCases(file);
  const arms = (arg(args, '--arms', 'without,with')).split(',').map((s) => s.trim()).filter(Boolean);
  if (arms.some((a) => a !== 'with' && a !== 'without')) throw new Error('arms must be with and/or without');
  const reps = Math.max(1, Number(arg(args, '--reps', '1')) || 1);
  const maxCost = Number(arg(args, '--max-cost', '10'));
  const perRunCost = Number(arg(args, '--per-run-cost', '2'));
  const model = arg(args, '--model');
  const itens = plan(cases, arms, reps);
  console.log(`plan: ${cases.length} case(s) × ${reps} rep(s) × ${arms.join('/')} = ${itens.length} run(s); per-run cap $${perRunCost}, total cap $${maxCost}`);
  if (args.includes('--dry-run')) {
    for (const i of itens) console.log(`  ${i.case.id} · ${i.arm} · rep ${i.rep}`);
    console.log(`claude ${claudeArgs('with', { perRunCost, model }).join(' ')}`);
    return 0;
  }
  // Sem login, cada execução "termina" em segundos com custo zero e a tarefa não resolvida — um
  // resultado falso que parece medição. Confere antes de começar.
  const auth = run(arg(args, '--claude', 'claude'), ['auth', 'status'], { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !ENV_DESCARTADO.test(k))) });
  if (/"loggedIn"\s*:\s*false/.test(auth.stdout) && !process.env.ANTHROPIC_API_KEY) {
    console.log('claude CLI is not logged in (claude auth status). Log in with `claude auth login` (or set ANTHROPIC_API_KEY) and run again.');
    return 2;
  }
  const outDir = resolve(arg(args, '--out', join(tmpdir(), `ct-outcome-${Date.now()}`)));
  mkdirSync(outDir, { recursive: true });
  const results = [];
  let gasto = 0;
  for (const item of itens) {
    if (gasto >= maxCost) { console.log(`total cap reached ($${gasto.toFixed(2)}); ${itens.length - results.length} run(s) not started`); break; }
    process.stdout.write(`▶ ${item.case.id} · ${item.arm} · rep ${item.rep} … `);
    const traceFile = join(outDir, `${item.case.id}.${item.arm}.${item.rep}.jsonl`);
    const r = executar(item, { perRunCost, model, keep: args.includes('--keep'), traceFile });
    if (r.error === 'no-model-call') {
      console.log(`no model call — ${r.answer.slice(0, 120) || 'empty answer'}. Stopping: nothing here would be a measurement.`);
      return 2;
    }
    gasto += r.costUsd;
    results.push(r);
    console.log(`${r.ok ? 'solved' : 'NOT solved'} · $${r.costUsd.toFixed(2)} · ${r.turns ?? '?'} turns${r.error ? ` · ${r.error}` : ''}`);
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  }
  const cli = run(arg(args, '--claude', 'claude'), ['--version']).stdout.trim();
  writeFileSync(join(outDir, 'report.md'), `${markdownReport(results, { model, cli })}\n`);
  console.log(`\n${markdownReport(results, { model, cli })}\n\nresults: ${outDir}`);
  return 0;
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(`benchmark-outcome: ${e.message}`); process.exitCode = 1; });
}
