#!/usr/bin/env node
// 🧪 Benchmark de RESULTADO — a mesma tarefa, feita por um agente real, com e sem o context-tools.
//
// Os outros benchmarks medem ferramenta contra ferramenta (precisão, recall, tamanho de saída). Este
// mede o que importa para quem usa: a tarefa foi resolvida? quanto custou? quantos turnos? Cada caso
// roda numa cópia limpa do repositório-alvo, nos dois braços:
//   - without: `claude -p` só com as configurações do PROJETO (nenhum plugin, hook ou servidor MCP
//              do usuário entra) — o agente como ele é;
//   - with:    o mesmo, mais `--plugin-dir <este repositório>` — skill e hooks do context-tools
//              (`context-tools` é o mesmo braço com outro nome);
//   - outros:  ferramentas de terceiros com o mesmo propósito, declaradas em `--arms-file` (ver
//              `loadArms`): plugin, settings com hooks, servidor MCP, variáveis de ambiente.
// O resultado é conferido por um comando (testes) ou por expressões sobre a resposta final.
//
// Custo real: cada execução é uma sessão de agente paga. Há teto por execução (--per-run-cost, que vai
// para `--max-budget-usd` do CLI) e teto total (--max-cost): ao atingi-lo, nenhuma execução nova começa.
// `--dry-run` mostra o plano sem chamar nada.
//
// Uso:
//   benchmark-outcome.mjs --cases=<arquivo.json> [--arms=without,with] [--arms-file=<arquivo.json>] [--reps=1]
//                         [--max-cost=10] [--per-run-cost=2] [--model=<modelo>] [--parallel=N] [--out=<pasta>] [--dry-run]
//
// Arquivo de casos: { "cases": [ { "id", "repo" (pasta local) ou "git" (URL), "ref"?, "prompt", "remove"?: [caminhos],
//   "setup"?: [[comando, ...args], …], "check": { "command": [cmd, ...args] } | { "answer": [regex, …] } } ] }
// `repo` relativo ao arquivo de casos. Casos com dados privados ficam em `*.local.json` (ignorado pelo git).

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/roots.mjs';
import { run, runAsync } from './lib/setup-shared.mjs';

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

const BRACOS_EMBUTIDOS = { without: {}, with: { pluginDir: PLUGIN_DIR }, 'context-tools': { pluginDir: PLUGIN_DIR } };

/**
 * Braços de outras ferramentas: `{ "vars": { nome: valor }, "arms": { nome: espec } }`. A espec
 * reproduz o que o instalador da ferramenta faria, sem tocar na configuração do usuário:
 *   pluginDir: pasta ou lista (`--plugin-dir`) · settings: objeto (`--settings`, hooks) ·
 *   mcpConfig: objeto `{ mcpServers }` (`--mcp-config`) · env: variáveis da sessão ·
 *   allowedTools: ferramentas além das comuns (as MCP da ferramenta) · prepare: comandos
 *   `[[cmd, ...args]]` rodados na cópia antes do agente (o instalador por projeto da ferramenta) ·
 *   settingSources: em vez de `project` (um instalador que grava hooks em `settings.local.json` pede
 *   `project,local`; a cópia é nova, então só há o que ele gravou) · ignoreChanged: regex de
 *   arquivos que a ferramenta cria ou muda na cópia e não contam como alteração do agente.
 * Em qualquer texto, `{var}` vem de `vars`, e por execução: `{copy}` (a cópia), `{run}` (pasta da
 * execução, fora da cópia), `{PATH}` e `{pathsep}`. Caminhos locais ficam em `*.local.json`.
 */
export function loadArms(file) {
  const data = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return { vars: data.vars || {}, arms: { ...BRACOS_EMBUTIDOS, ...(data.arms || {}) } };
}

export function substituir(valor, vars) {
  if (typeof valor === 'string') return valor.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(valor)) return valor.map((v) => substituir(v, vars));
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, substituir(v, vars)]));
  return valor;
}

/** `arm`: nome de braço embutido ou espec já resolvida; `files`: settings/MCP gravados para a execução. */
export function claudeArgs(arm, { perRunCost, model } = {}, files = {}) {
  const spec = typeof arm === 'string' ? (BRACOS_EMBUTIDOS[arm] || {}) : (arm || {});
  // `--include-hook-events` só acrescenta eventos à saída: dá para medir o que os hooks de qualquer
  // ferramenta puseram no contexto, não só os do context-tools.
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--setting-sources', spec.settingSources || 'project', '--strict-mcp-config',
    '--no-session-persistence', '--permission-mode', 'acceptEdits', '--allowedTools', ...ALLOWED_TOOLS, ...(spec.allowedTools || []),
  ];
  if (perRunCost) args.push('--max-budget-usd', String(perRunCost));
  if (model) args.push('--model', model);
  for (const p of [spec.pluginDir || []].flat()) args.push('--plugin-dir', p);
  if (files.settings) args.push('--settings', files.settings);
  if (files.mcp) args.push('--mcp-config', files.mcp);
  return args;
}

/**
 * Um espelho local por repositório remoto, criado uma vez e reaproveitado entre execuções e rodadas:
 * clonar do GitHub a cada execução custava 10–20 s de cada ~70. A cópia do agente sai do espelho
 * (clone local), no mesmo commit — o que é medido não muda.
 */
export function mirrorPath(url, base = join(tmpdir(), 'ct-outcome-mirrors')) {
  return join(base, createHash('sha1').update(url).digest('hex').slice(0, 12));
}

function prepararEspelho(c) {
  const path = mirrorPath(c.git);
  const temRef = () => !c.ref || spawnSync('git', ['-C', path, 'cat-file', '-e', `${c.ref}^{commit}`]).status === 0;
  if (existsSync(join(path, 'HEAD'))) {
    if (temRef()) return path;
    spawnSync('git', ['-C', path, 'fetch', '--quiet', 'origin', '+refs/*:refs/*'], { encoding: 'utf8', timeout: 600000 });
    if (temRef()) return path;
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(dirname(path), { recursive: true });
  const r = spawnSync('git', ['clone', '--quiet', '--mirror', c.git, path], { encoding: 'utf8', timeout: 900000 });
  if (r.status !== 0) throw new Error(`mirror failed for ${c.git}: ${r.stderr}`);
  return path;
}

export function prepararCopia(c, mirrors = {}) {
  const dir = mkdtempSync(join(tmpdir(), `ct-outcome-${c.id}-`));
  const git = (...a) => spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', ...a], { cwd: dir, encoding: 'utf8' });
  const origem = c.repo || mirrors[c.git];
  const clone = origem
    ? spawnSync('git', ['clone', '--quiet', '--no-hardlinks', origem, dir], { encoding: 'utf8', timeout: 600000 })
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
  // Um bug injetado commitado por cima do histórico aparece inteiro em `git log -p`: na validação
  // independente, o Haiku achou o bug assim em 8 de 20 execuções (nos dois braços). Um bug de
  // verdade não vem com o diff que o criou. Com `setup`, a cópia começa num commit único, sem
  // histórico — nem ramos ou tags de origem que permitam comparar. `"history": "keep"` mantém.
  if (c.setup?.length && c.history !== 'keep') {
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    git('init', '--quiet');
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
  const u = json.usage || {};
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  // Limite de uso (429) chega como `is_error` com subtype "success", custo zero e o aviso como
  // resposta: contá-lo como "não resolveu" inventou 0/5 em casos inteiros da rodada 3.
  if (json.api_error_status === 429 || /hit your (session|usage) limit|rate limit/i.test(String(json.result || ''))) return 'no-model-call';
  if (!tokens || /^(Failed to authenticate|Invalid API key|API Error)/i.test(String(json.result || ''))) return 'no-model-call';
  if (json.is_error) return json.subtype && json.subtype !== 'success' ? json.subtype : 'error';
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
  const injected = { emitted: 0, contextChars: 0, byHook: {} };
  for (const line of String(stdout || '').split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'result') json = ev;
    if (ev.type === 'system' && ev.subtype === 'hook_response') {
      const n = hookContextChars(ev);
      if (n > 0) {
        const h = (injected.byHook[ev.hook_name || ev.hook_event || '?'] ||= { emitted: 0, contextChars: 0 });
        injected.emitted++; h.emitted++;
        injected.contextChars += n; h.contextChars += n;
      }
    }
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content || []) {
      if (c.type !== 'tool_use') continue;
      const i = c.input || {};
      const alvo = i.command ?? i.pattern ?? i.file_path ?? i.skill ?? i.path ?? '';
      tools.push(`${c.name}${alvo ? `: ${String(alvo).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
    }
  }
  return { json, tools, injected };
}

/**
 * Quanto de uma resposta de hook chega ao modelo: `additionalContext`, o motivo de um bloqueio
 * (`permissionDecisionReason`, `reason`), o stderr de um exit 2, e o stdout cru de SessionStart e
 * UserPromptSubmit (nos outros eventos, stdout que não é JSON não vai para o contexto).
 */
export function hookContextChars(ev) {
  if (ev.exit_code === 2) return String(ev.stderr || '').trim().length;
  const out = String(ev.stdout ?? ev.output ?? '').trim();
  if (!out) return 0;
  let j = null;
  try { j = JSON.parse(out); } catch { /* texto cru */ }
  if (j && typeof j === 'object') {
    const h = j.hookSpecificOutput || {};
    return [h.additionalContext, h.permissionDecisionReason, j.reason].reduce((a, s) => a + (s ? String(s).length : 0), 0);
  }
  return /^(SessionStart|UserPromptSubmit)$/.test(ev.hook_event || '') ? out.length : 0;
}

/** Uma execução registrada conta como medida: o modelo foi chamado e não houve limite de uso. */
export function medidaValida(r) {
  const t = r?.tokens || {};
  const tokens = (t.input || 0) + (t.output || 0) + (t.cacheCreation || 0) + (t.cacheRead || 0);
  return tokens > 0 && r.error !== 'no-model-call' && !/hit your (session|usage) limit/i.test(String(r.answer || ''));
}

/**
 * `results.json` é feito para ser publicado: a cópia temporária vira `<copy>` e a pasta do usuário
 * vira `<home>` (com `\` ou `/`, como o agente tiver escrito). O transcript bruto fica como está.
 */
export function anonimizar(texto, dir, home = homedir()) {
  let s = String(texto ?? '');
  // `C:\x`, `C:/x`, `C:\\x` (JSON ou shell escapado), `/c/x` (Git Bash) e `C--x` (a pasta de
  // transcripts do Claude Code, que troca todo caractere não alfanumérico por `-`).
  const variantes = (p) => (p ? [...new Set([
    p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\'), p.replace(/\\/g, '\\\\'),
    p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/'),
    p.replace(/[^A-Za-z0-9]/g, '-'),
  ])] : []);
  for (const v of variantes(dir).sort((a, b) => b.length - a.length)) s = s.split(v).join('<copy>');
  // O agente às vezes inventa uma grafia que não existe (`/d/<usuário>/AppData/…/ct-outcome-x-AB12cd`):
  // o nome da cópia é único, então qualquer caminho que termine nele é a cópia.
  // Separa por `\` e `/`: `path.basename` no Linux não corta um caminho do Windows.
  const nomeDaCopia = String(dir || '').split(/[\\/]/).pop();
  if (nomeDaCopia.length >= 8) s = s.replace(new RegExp(`[^\\s"'\`(),]*${nomeDaCopia.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '<copy>');
  for (const v of variantes(home).sort((a, b) => b.length - a.length)) s = s.split(v).join('<home>');
  return s;
}

async function executar(item, opts) {
  const dir = prepararCopia(item.case, opts.mirrors);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !ENV_DESCARTADO.test(k)));
  // Fora da cópia: o agente não vê o arquivo, e o `git diff` da conferência não o conta.
  if (opts.hookLogFile) env.CONTEXT_TOOLS_HOOK_LOG = opts.hookLogFile;
  const runDir = mkdtempSync(join(tmpdir(), 'ct-arm-'));
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const defs = opts.armDefs || loadArms();
  // Barras normais: valem no Windows e dentro do bash que roda os hooks.
  const barra = (p) => p.replace(/\\/g, '/');
  const spec = substituir(defs.arms[item.arm] || {}, { ...defs.vars, copy: barra(dir), run: barra(runDir), PATH: env[pathKey] || '', pathsep: delimiter });
  for (const [k, v] of Object.entries(spec.env || {})) env[k.toUpperCase() === 'PATH' ? pathKey : k] = v;
  for (const [cmd, ...a] of spec.prepare || []) {
    const p = spawnSync(cmd, a, { cwd: dir, env, encoding: 'utf8', timeout: 600000 });
    if (p.status !== 0) throw new Error(`arm ${item.arm}: prepare failed (${cmd} ${a.join(' ')}): ${String(p.stderr || p.stdout || p.error).slice(0, 400)}`);
  }
  const files = {};
  if (spec.settings) writeFileSync(files.settings = join(runDir, 'settings.json'), JSON.stringify(spec.settings, null, 2));
  if (spec.mcpConfig) writeFileSync(files.mcp = join(runDir, 'mcp.json'), JSON.stringify(spec.mcpConfig, null, 2));
  const started = Date.now();
  const r = await runAsync(opts.claude || 'claude', claudeArgs(spec, opts, files), {
    cwd: dir, env, input: item.case.prompt, timeout: 20 * 60 * 1000, maxBuffer: 64 << 20,
  });
  const { json, tools, injected } = parseStream(r.stdout);
  if (opts.traceFile) writeFileSync(opts.traceFile, r.stdout);
  const resposta = json?.result || '';
  const check = conferir(item.case.check, dir, resposta);
  const changed = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    .filter((f) => !spec.ignoreChanged || !new RegExp(spec.ignoreChanged).test(f));
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
    hooks: opts.hookLogFile ? summarizeHookLog(safeRead(opts.hookLogFile)) : null,
    injected,
    filesChanged: changed.filter((f) => !/^(ai-context|\.claude|\.codex)\//.test(f)).length,
    error: runError(json, r),
    model: json?.modelUsage ? Object.keys(json.modelUsage).join(',') : (opts.model || null),
    tools: tools.map((t) => anonimizar(t, dir)),
    answer: anonimizar(resposta.slice(0, 2000), dir),
  };
  if (!opts.keep) {
    // No Windows, um processo que a ferramenta deixou vivo (servidor de linguagem, daemon) pode
    // segurar arquivos da cópia: a limpeza falha com EPERM. Perder a medida por isso — e derrubar o
    // worker, que deixava execuções sem começar — é pior que deixar a pasta para trás.
    for (const p of [dir, runDir]) {
      try { rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch (e) { out.cleanup = `not removed: ${e.code || e.message}`; }
    }
  }
  return out;
}

const safeRead = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

/**
 * O que os hooks puseram no contexto de uma execução, a partir do log de `CONTEXT_TOOLS_HOOK_LOG`:
 * quantas saídas e quantos caracteres, no total e por script. Só conta o que foi emitido — uma saída
 * deduplicada não chega ao agente. O texto fica no log bruto, não em `results.json`.
 */
export function summarizeHookLog(text) {
  const out = { emitted: 0, contextChars: 0, deduped: 0, byScript: {} };
  for (const line of String(text || '').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e.emitted) { out.deduped++; continue; }
    const s = (out.byScript[`${e.script || '?'} · ${e.event || '?'}`] ||= { emitted: 0, contextChars: 0 });
    out.emitted++; s.emitted++;
    out.contextChars += e.contextChars || 0; s.contextChars += e.contextChars || 0;
  }
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
      medianHookChars: mediana(rs.filter((r) => r.hooks).map((r) => r.hooks.contextChars)),
      medianInjectedChars: mediana(rs.filter((r) => r.injected).map((r) => r.injected.contextChars)),
    };
  }
  return resumo;
}

export function markdownReport(results, meta = {}) {
  const resumo = summarize(results);
  const linhas = [
    `# Outcome benchmark — ${meta.date || new Date().toISOString().slice(0, 10)}`, '',
    `Model: ${meta.model || 'CLI default'} · CLI: ${meta.cli || 'claude'} · runs: ${results.length}`, '',
    '| arm | solved | total cost | median cost | median turns | median duration | median context tokens | median hook chars |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(resumo).map(([arm, s]) => `| ${arm} | ${s.solved}/${s.runs} | $${s.totalCostUsd.toFixed(2)} | $${(s.medianCostUsd ?? 0).toFixed(2)} | ${s.medianTurns ?? '—'} | ${s.medianDurationS == null ? '—' : `${Math.round(s.medianDurationS)} s`} | ${s.medianContextTokens ?? '—'} | ${s.medianInjectedChars ?? '—'} |`),
    '', '| case | arm | solved | cost | turns | hook outputs (chars) | files changed | check |', '|---|---|---|---:|---:|---:|---:|---|',
    ...results.map((r) => `| ${r.case} | ${r.arm} | ${r.ok ? 'yes' : 'no'} | $${r.costUsd.toFixed(2)} | ${r.turns ?? '—'} | ${r.injected ? `${r.injected.emitted} (${r.injected.contextChars})` : r.hooks ? `${r.hooks.emitted} (${r.hooks.contextChars})` : '—'} | ${r.filesChanged} | ${String(r.error || r.check).replace(/\|/g, '\\|')} |`),
  ];
  return linhas.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const file = arg(args, '--cases');
  if (!file) { console.log('usage: benchmark-outcome.mjs --cases=<file.json> [--arms=without,with] [--arms-file=<file.json>] [--reps=1] [--max-cost=10] [--per-run-cost=2] [--model=<m>] [--parallel=1] [--out=<dir>] [--resume] [--dry-run]'); return 2; }
  const cases = loadCases(file);
  const arms = (arg(args, '--arms', 'without,with')).split(',').map((s) => s.trim()).filter(Boolean);
  const armDefs = loadArms(arg(args, '--arms-file'));
  const desconhecidos = arms.filter((a) => !armDefs.arms[a]);
  if (desconhecidos.length) throw new Error(`unknown arm(s): ${desconhecidos.join(', ')}; known: ${Object.keys(armDefs.arms).join(', ')} (others come from --arms-file)`);
  const reps = Math.max(1, Number(arg(args, '--reps', '1')) || 1);
  const maxCost = Number(arg(args, '--max-cost', '10'));
  const perRunCost = Number(arg(args, '--per-run-cost', '2'));
  const model = arg(args, '--model');
  const itens = plan(cases, arms, reps);
  console.log(`plan: ${cases.length} case(s) × ${reps} rep(s) × ${arms.join('/')} = ${itens.length} run(s); per-run cap $${perRunCost}, total cap $${maxCost}`);
  if (args.includes('--dry-run')) {
    for (const i of itens) console.log(`  ${i.case.id} · ${i.arm} · rep ${i.rep}`);
    for (const a of arms) console.log(`${a}: claude ${claudeArgs(substituir(armDefs.arms[a], armDefs.vars), { perRunCost, model }, { settings: armDefs.arms[a].settings && '<run>/settings.json', mcp: armDefs.arms[a].mcpConfig && '<run>/mcp.json' }).join(' ')}`);
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
  // --resume: aproveita as medidas válidas de um results.json anterior na mesma pasta e roda só o
  // que falta — uma rodada interrompida (limite de uso, queda) não precisa ser paga de novo.
  const anteriores = args.includes('--resume') && existsSync(join(outDir, 'results.json'))
    ? JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')).filter(medidaValida) : [];
  const feitas = new Set(anteriores.map((r) => `${r.case}|${r.arm}|${r.rep}`));
  if (anteriores.length) console.log(`resume: ${anteriores.length} valid run(s) kept`);
  const results = [...anteriores];
  // Execuções independentes (cópia e sessão próprias) rodam em paralelo: o mesmo custo, uma fração
  // do tempo. O teto total vale para o que COMEÇA: as que já estão rodando podem passá-lo em até
  // (parallel − 1) × per-run-cost.
  const parallel = Math.max(1, Number(arg(args, '--parallel', '1')) || 1);
  const ordem = new Map(itens.map((i, n) => [`${i.case.id}|${i.arm}|${i.rep}`, n]));
  const chave = (r) => `${r.case}|${r.arm}|${r.rep}`;
  const fila = itens.filter((i) => !feitas.has(`${i.case.id}|${i.arm}|${i.rep}`));
  // Os espelhos saem antes dos workers: duas execuções nunca criam o mesmo ao mesmo tempo.
  const mirrors = {};
  for (const url of new Set(fila.map((i) => i.case.git).filter(Boolean))) mirrors[url] = prepararEspelho({ git: url, ref: fila.find((i) => i.case.git === url).case.ref });
  let gasto = 0;
  let parar = null;
  let naoIniciadas = 0;
  // Na ordem do plano, não na de chegada: o relatório e o results.json não mudam com --parallel.
  const ordenar = () => results.sort((a, b) => (ordem.get(chave(a)) ?? 0) - (ordem.get(chave(b)) ?? 0));
  const gravar = () => writeFileSync(join(outDir, 'results.json'), JSON.stringify(ordenar(), null, 2));
  const worker = async () => {
    while (fila.length) {
      if (parar) return;
      if (gasto >= maxCost) { naoIniciadas = fila.length; fila.length = 0; return; }
      const item = fila.shift();
      const rotulo = `${item.case.id} · ${item.arm} · rep ${item.rep}`;
      if (parallel === 1) process.stdout.write(`▶ ${rotulo} … `);
      const traceFile = join(outDir, `${item.case.id}.${item.arm}.${item.rep}.jsonl`);
      const hookLogFile = join(outDir, `${item.case.id}.${item.arm}.${item.rep}.hooks.jsonl`);
      rmSync(hookLogFile, { force: true });
      const r = await executar(item, { armDefs, perRunCost, model, keep: args.includes('--keep'), traceFile, hookLogFile, mirrors, claude: arg(args, '--claude', 'claude') });
      const prefixo = parallel === 1 ? '' : `▶ ${rotulo} … `;
      if (r.error === 'no-model-call') {
        parar = parar || `${prefixo}no model call — ${r.answer.slice(0, 120) || 'empty answer'}. Stopping: nothing here would be a measurement.`;
        return;
      }
      gasto += r.costUsd;
      results.push(r);
      console.log(`${prefixo}${r.ok ? 'solved' : 'NOT solved'} · $${r.costUsd.toFixed(2)} · ${r.turns ?? '?'} turns${r.error ? ` · ${r.error}` : ''}`);
      gravar();
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, fila.length || 1) }, worker));
  if (parar) { console.log(parar); return 2; }
  ordenar();
  if (naoIniciadas) console.log(`total cap reached ($${gasto.toFixed(2)}); ${naoIniciadas} run(s) not started`);
  const cli = run(arg(args, '--claude', 'claude'), ['--version']).stdout.trim();
  writeFileSync(join(outDir, 'report.md'), `${markdownReport(results, { model, cli })}\n`);
  console.log(`\n${markdownReport(results, { model, cli })}\n\nresults: ${outDir}`);
  return 0;
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(`benchmark-outcome: ${e.message}`); process.exitCode = 1; });
}
