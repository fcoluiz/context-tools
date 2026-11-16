import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  bashViolation, clearScope, delegationDenial, listScopes, matchesScope, normalizeRole, parseAllow, readScope, ROLES,
  roleFromEvent, writeScope,
} from '../scripts/lib/delegation.mjs';
import { agentSources, cheapestCodexModel, parseAgent, renderCodexAgent } from '../scripts/lib/delegation-agents.mjs';
import { claudeReport, counterfactual, formatReport, priceFor, requestCost } from '../scripts/lib/delegation-report.mjs';
import { buildBrief } from '../scripts/brief.mjs';
import { VERBS } from '../scripts/ct.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

// Cada teste tem a própria pasta do usuário (onde mora o ticket de escopo) e o próprio projeto.
function fixture(fn) {
  const home = mkdtempSync(join(tmpdir(), 'ct-deleg-home-'));
  const project = mkdtempSync(join(tmpdir(), 'ct-deleg-proj-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  const env = { ...process.env, CONTEXT_TOOLS_HOME: home, CONTEXT_TOOLS_LANG: 'en' };
  const clean = () => {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  let result;
  try { result = fn({ home, project, env }); } catch (e) { clean(); throw e; }
  if (result && typeof result.then === 'function') return result.finally(clean);
  clean();
  return result;
}

const run = (name, args, env, event) => spawnSync(process.execPath, [script(name), ...args], {
  input: event === undefined ? '' : JSON.stringify(event), encoding: 'utf8', env,
});
const json = (stdout) => (stdout.trim() ? JSON.parse(stdout) : null);
const edit = (project, file, agent) => ({ tool_name: 'Edit', agent_type: agent, cwd: project, tool_input: { file_path: join(project, file) } });
const bash = (command, agent) => ({ tool_name: 'Bash', agent_type: agent, tool_input: { command } });

test('delegação: papel vem do agent_type (plugin, standalone) e nunca da sessão principal', () => {
  assert.equal(normalizeRole('explorer'), 'ct-explorer');
  assert.equal(normalizeRole('context-tools:ct-map-keeper'), 'ct-map-keeper');
  assert.equal(normalizeRole('Explore'), null);
  assert.equal(roleFromEvent({ agent_type: 'context-tools:ct-executor' }), 'ct-executor');
  assert.equal(roleFromEvent({ agent_type: 'ct-verifier' }), 'ct-verifier');
  assert.equal(roleFromEvent({ agent_type: 'general-purpose' }), null);
  assert.equal(roleFromEvent({ tool_name: 'Edit' }), null);
});

test('delegação: no Codex, o papel também sai do session_meta do rollout do subagente', () => fixture(({ project }) => {
  const rollout = join(project, 'rollout-2026-11-15T00-00-00-abc.jsonl');
  const meta = { type: 'session_meta', payload: { id: 'sub', parent_thread_id: 'main', base_instructions: 'x'.repeat(70000), source: { subagent: { thread_spawn: { agent_role: 'ct-explorer' } } } } };
  writeFileSync(rollout, `${JSON.stringify(meta)}\n{"type":"x"}\n`);
  assert.equal(roleFromEvent({ transcript_path: rollout }), 'ct-explorer');
  // Thread principal: sem `source.subagent`, nada a travar.
  writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: 'main', source: 'vscode' } })}\n`);
  assert.equal(roleFromEvent({ transcript_path: rollout }), null);
}));

test('delegação: shell que muda o git, chama gh ou escreve arquivo é recusado; leitura e teste passam', () => {
  for (const ok of ['npm test 2>&1 | tail -5', 'node -e "a.map(x=>x>1)"', 'ls > /dev/null', 'npm test 2>$null', 'git -C . log --oneline',
    'git diff --stat', 'rg foo src', 'node "C:/x/ct.mjs" find X', 'npm install']) assert.equal(bashViolation(ok), null, ok);
  const cases = {
    'git commit -m x': 'git-write', 'git -C repo push origin': 'git-write', 'git reset --hard': 'git-write', 'git checkout main': 'git-write',
    'git branch -D x': 'git-write', 'gh pr create': 'gh', 'npm publish': 'publish', 'sed -i s/a/b/ f': 'in-place-edit',
    'cat a | tee b': 'shell-write', 'rg x && rm -rf y': 'shell-write', 'Set-Content a.txt x': 'shell-write',
    'echo hi > out.txt': 'redirect', 'node t.mjs > log.txt 2>&1': 'redirect', 'cmd >> a.log': 'redirect',
  };
  for (const [command, why] of Object.entries(cases)) assert.equal(bashViolation(command), why, command);
});

test('delegação: escopo declarado — glob, pasta, caminho inseguro, validade', () => fixture(({ project, env }) => {
  assert.deepEqual(parseAllow('src/a.ts, docs/ ,../x,/abs,C:/w,./b.md'), ['src/a.ts', 'docs/**', 'b.md']);
  assert.ok(matchesScope('docs/x/y.md', ['docs/**']));
  assert.ok(matchesScope('src/a.ts', ['src/*.ts']));
  assert.ok(!matchesScope('src/sub/a.ts', ['src/*.ts']));
  assert.ok(matchesScope('a/b/c.md', ['**/c.md']));
  const now = 1_000_000;
  const r = writeScope({ root: project, role: 'executor', allow: 'src/', ttlMinutes: 10, now, env });
  assert.ok(r.ok);
  assert.ok(readScope(project, 'ct-executor', { now, env }));
  assert.equal(readScope(project, 'ct-executor', { now: now + 11 * 60000, env }), null, 'ticket vencido não vale');
  assert.equal(listScopes(project, { now, env }).length, 1);
  assert.equal(clearScope(project, null, env), 1);
  assert.equal(writeScope({ root: project, role: 'nope', allow: 'x', env }).ok, false);
}));

test('delegação: a trava por papel (só-leitura, sem escopo, dentro, fora, mapa) e nada na sessão principal', () => fixture(({ project, env }) => {
  const deny = (event) => delegationDenial({ event, cwd: project, env });
  assert.match(deny(edit(project, 'src/a.ts', 'ct-explorer')), /read-only/);
  assert.match(deny(edit(project, 'src/a.ts', 'context-tools:ct-verifier')), /read-only/);
  assert.match(deny(edit(project, 'src/a.ts', 'ct-executor')), /no write scope/);
  writeScope({ root: project, role: 'executor', allow: 'src/a.ts', env });
  assert.equal(deny(edit(project, 'src/a.ts', 'ct-executor')), null);
  assert.match(deny(edit(project, 'src/b.ts', 'ct-executor')), /outside the declared write scope/);
  assert.match(deny(edit(project, '../fora.ts', 'ct-executor')), /outside/);
  // O tradutor não herda o escopo do executor: cada papel tem o seu ticket.
  assert.match(deny(edit(project, 'src/a.ts', 'ct-translator')), /no write scope/);
  assert.equal(deny(edit(project, '.claude/context/area.md', 'ct-map-keeper')), null, 'mapas sem declarar');
  assert.equal(deny(edit(project, 'ai-context/features/x.md', 'ct-map-keeper')), null);
  assert.match(deny(edit(project, 'src/a.ts', 'ct-map-keeper')), /outside/);
  // Hook disparado de uma subpasta: o ticket gravado na raiz continua valendo.
  assert.equal(delegationDenial({ event: edit(project, 'src/a.ts', 'ct-executor'), cwd: join(project, 'src'), env }), null);
  // Codex: apply_patch com dois arquivos, um fora.
  const patch = { tool_name: 'apply_patch', agent_type: 'ct-executor', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/c.ts\n*** End Patch' } };
  assert.match(deny(patch), /src\/c\.ts/);
  assert.match(deny(bash('git push', 'ct-executor')), /git state/);
  assert.equal(deny(edit(project, 'src/zzz.ts', 'general-purpose')), null, 'agente que não é nosso');
  assert.equal(deny(edit(project, 'src/zzz.ts')), null, 'sessão principal');
  assert.equal(delegationDenial({ event: edit(project, 'src/zzz.ts', 'ct-explorer'), cwd: project, env: { ...env, CONTEXT_TOOLS_DELEGATION_GUARD: '0' } }), null);
}));

test('delegação: hook do Claude nega por JSON e fica calado fora de um ct-*', () => fixture(({ project, env }) => {
  const out = json(run('delegate.mjs', ['--hook=pre-tool'], env, edit(project, 'src/a.ts', 'context-tools:ct-explorer')).stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('delegate.mjs', ['--hook=pre-tool'], env, edit(project, 'src/a.ts', 'Explore')).stdout, '');
  assert.equal(run('delegate.mjs', ['--hook=pre-tool'], env, bash('git commit -m ct-explorer')).stdout, '', 'texto ct-* na sessão principal');
  assert.equal(run('delegate.mjs', ['--hook=pre-tool'], env, '{quebrado').status, 0);
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse;
  const group = hooks.find((g) => g.hooks.some((h) => h.command.includes('delegate.mjs')));
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) assert.ok(new RegExp(`^(?:${group.matcher})$`).test(tool), tool);
}));

test('delegação: no Codex a trava roda dentro dos hooks que já existiam (edição e Bash)', () => fixture(({ project, env }) => {
  const codex = JSON.parse(readFileSync(join(ROOT, 'hooks', 'codex-hooks.json'), 'utf8'));
  assert.ok(!JSON.stringify(codex).includes('delegate.mjs'), 'hook novo no Codex fica mudo até ser aprovado em /hooks');
  const ev = { ...edit(project, 'src/a.ts', 'ct-explorer'), hook_event_name: 'PreToolUse', session_id: 's1' };
  const r = run('codex-hook.mjs', ['session-write-journal.mjs', '--pre-tool-use'], env, ev);
  assert.equal(r.status, 2);
  assert.equal(json(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const b = run('codex-hook.mjs', ['pre-tool.mjs'], env, { ...bash('git push', 'ct-verifier'), cwd: project, hook_event_name: 'PreToolUse', session_id: 's1' });
  assert.equal(b.status, 2);
  assert.match(json(b.stdout).hookSpecificOutput.permissionDecisionReason, /git state/);
  const ok = run('codex-hook.mjs', ['pre-tool.mjs'], env, { ...bash('git status'), cwd: project, hook_event_name: 'PreToolUse', session_id: 's1' });
  assert.equal(ok.status, 0);
}));

test('delegação: brief traz tarefa, regras do papel, comando ct, outline e grava o escopo', async () => fixture(async ({ project, env }) => {
  const big = Array.from({ length: 400 }, (_, i) => (i % 40 === 0 ? `export function calcularTotal${i}(x) {` : i % 40 === 39 ? '}' : '  return 1;')).join('\n');
  writeFileSync(join(project, 'src', 'pedido.js'), big);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const explorer = await buildBrief(project, { task: 'onde calcularTotal120 é usado em src/pedido.js', role: 'explorer', env });
  assert.ok(explorer.ok);
  assert.deepEqual(explorer.files, ['src/pedido.js']);
  assert.match(explorer.text, /Read-only/);
  assert.match(explorer.text, /ct\.mjs" <verb>/);
  assert.match(explorer.text, /calcularTotal120/);
  assert.doesNotMatch(explorer.text, /calcularTotal40\b/, 'outline filtrado pelos nomes da tarefa');
  const verifier = await buildBrief(project, { task: 'rode os testes', role: 'verifier', env });
  assert.equal(verifier.test, 'npm test');
  assert.match(verifier.text, /exit=<code>/);
  const executor = await buildBrief(project, { task: 'renomeie X', role: 'executor', allow: 'src/pedido.js', env });
  assert.deepEqual(executor.scope.allow, ['src/pedido.js']);
  assert.ok(readScope(project, 'ct-executor', { env }));
  const sem = await buildBrief(project, { task: 'renomeie X', role: 'translator', env });
  assert.match(sem.text, /No write scope declared/);
  assert.equal((await buildBrief(project, { task: '', env })).error, 'empty-task');
  assert.equal((await buildBrief(project, { task: 'x', role: 'chefe', env })).error, 'invalid-role');
  // O orçamento corta as seções de apoio, nunca a tarefa nem as regras.
  const curto = await buildBrief(project, { task: 'onde calcularTotal120 é usado em src/pedido.js', role: 'explorer', budget: 1500, env });
  assert.ok(curto.chars <= 1800, `briefing com ${curto.chars} chars`);
  assert.match(curto.text, /Task:/);
}));

test('delegação: preços e custo por requisição, com a faixa longa do Haiku', () => {
  const haiku = priceFor('claude-haiku-5-5');
  assert.equal(priceFor('claude-sonnet-5-5').cacheRead, 0.10);
  assert.equal(priceFor('claude-sonnet-5').cacheRead, 0.20, 'prefixo mais longo vence');
  assert.equal(priceFor('modelo-desconhecido'), null);
  assert.equal(priceFor('meu-modelo', { 'meu-modelo': { input: 1, output: 2 } }).output, 2);
  const curto = { input: 1000, output: 1000, cacheRead: 50000, cacheWrite5m: 1000, cacheWrite1h: 0 };
  assert.ok(Math.abs(requestCost(curto, haiku) - (1000 * 0.1 + 1000 * 0.5 + 50000 * 0.01 + 1000 * 0.125) / 1e6) < 1e-12);
  const longo = { ...curto, cacheRead: 150000 };
  assert.ok(Math.abs(requestCost(longo, haiku) - (1000 * 0.5 + 1000 * 2.5 + 150000 * 0.05 + 1000 * 0.625) / 1e6) < 1e-12);
  assert.ok(Math.abs(requestCost({ ...curto, cacheWrite5m: 0, cacheWrite1h: 1000 }, priceFor('claude-opus-5-5')) - (4000 + 20000 + 50000 * 0.2 + 8000) / 1e6) < 1e-12);
  assert.equal(requestCost(curto, null), null);
  const est = counterfactual([{ ...curto, cacheRead: 10000, cacheWrite5m: 0, input: 0, output: 0 }, { input: 0, output: 100, cacheRead: 30000, cacheWrite5m: 0, cacheWrite1h: 0 }],
    { mainPrice: priceFor('claude-opus-5-5'), baseContext: 100000, laterMainRequests: 10, resultTokens: 5000 });
  assert.equal(est.keptTokens, 15000);
  assert.ok(Math.abs(est.carry - 15000 * 10 * 0.2 / 1e6) < 1e-12);
});

test('delegação: relatório lê subagents/, deduplica por id e compara com a estimativa', () => fixture(({ project }) => {
  const dir = join(project, 'transcripts');
  const sid = 'sessao-1';
  mkdirSync(join(dir, sid, 'subagents'), { recursive: true });
  const line = (id, model, at, usage, text = null) => JSON.stringify({ type: 'assistant', timestamp: at, message: { id, model, usage, content: text ? [{ type: 'text', text }] : [] } });
  const u = (cr, out, cw = 0) => ({ input_tokens: 2, output_tokens: out, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
  writeFileSync(join(dir, `${sid}.jsonl`), [
    line('m1', 'claude-opus-5-5', '2026-11-15T10:00:00Z', u(100000, 200)),
    line('m2', 'claude-opus-5-5', '2026-11-15T10:10:00Z', u(101000, 200)),
    line('m3', 'claude-opus-5-5', '2026-11-15T10:11:00Z', u(102000, 200)),
  ].join('\n'));
  writeFileSync(join(dir, sid, 'subagents', 'agent-a1.jsonl'), [
    line('s1', 'claude-haiku-5-5', '2026-11-15T10:01:00Z', u(0, 10, 8000)),
    line('s1', 'claude-haiku-5-5', '2026-11-15T10:01:00Z', u(0, 50, 8000)),
    line('s2', 'claude-haiku-5-5', '2026-11-15T10:02:00Z', u(8000, 80, 12000), 'resposta curta'),
    // A resposta final pode vir por uma ferramenta de devolução, sem texto: ela é o que a principal relê.
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-15T10:02:00Z', message: { id: 's2', model: 'claude-haiku-5-5', usage: u(8000, 80, 12000),
      content: [{ type: 'tool_use', name: 'SubagentHandback', input: { report: 'r'.repeat(400) } }] } }),
  ].join('\n'));
  writeFileSync(join(dir, sid, 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'context-tools:ct-explorer', description: 'achar X' }));
  const report = claudeReport(project, { dir });
  assert.equal(report.status, 'ok');
  assert.equal(report.session, sid);
  const [agent] = report.agents;
  assert.equal(agent.agentType, 'context-tools:ct-explorer');
  assert.equal(agent.tokens.requests, 2, 'mesma mensagem em duas linhas conta uma vez');
  assert.equal(agent.tokens.output, 130, 'fica o maior output de cada mensagem');
  assert.equal(agent.laterMainRequests, 2);
  assert.ok(agent.resultTokens >= 100, 'resposta entregue pela ferramenta de devolução conta');
  assert.equal(agent.baseContext, 100002);
  assert.ok(agent.usd > 0 && agent.estimate.usd > agent.usdWithResult, 'delegar sai mais barato neste caso');
  const text = formatReport(report, 'pt');
  assert.match(text, /custo medido/);
  assert.match(text, /ESTIMATIVA/);
  assert.equal(claudeReport(project, { dir: join(project, 'nada') }).status, 'no-subagents');
}));

test('delegação: um agente por papel, mesmos papéis nos dois hosts, Codex gerado da mesma fonte', () => fixture(({ home, project, env }) => {
  const agents = agentSources(join(ROOT, 'agents'));
  assert.deepEqual(agents.map((a) => a.meta.name).sort(), Object.keys(ROLES).sort());
  for (const a of agents) {
    assert.equal(a.file, `${a.meta.name}.md`);
    assert.equal(a.meta.model, 'haiku', `${a.meta.name}: o apelido mantém o Haiku mais novo`);
    assert.equal(a.meta.effort, ROLES[a.meta.name].effort);
    assert.ok(a.meta.description.length <= 400, `${a.meta.name}: descrição longa`);
    const tools = a.meta.tools.split(/,\s*/);
    assert.equal(tools.includes('Edit') || tools.includes('Write'), ROLES[a.meta.name].writes, `${a.meta.name}: ferramentas de escrita`);
    assert.doesNotMatch(a.body, /[A-Z]:[\\/]|\/Users\//, 'agente sem caminho de máquina');
    const toml = renderCodexAgent(a, { model: 'modelo-barato' });
    assert.match(toml, new RegExp(`^name = "${a.meta.name}"$`, 'm'));
    assert.match(toml, /^model = "modelo-barato"$/m);
    assert.match(toml, new RegExp(`^model_reasoning_effort = "${a.meta.effort}"$`, 'm'));
    assert.match(toml, /^developer_instructions = '''\n[\s\S]+\n'''\n$/m);
  }
  assert.doesNotMatch(renderCodexAgent(agents[0]), /^model =/m, 'sem modelo conhecido, herda');
  assert.equal(parseAgent('sem frontmatter'), null);
  // Modelo barato do Codex: o primeiro "affordable" que não é geração anterior.
  const codexHome = join(home, 'codex');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'grande', description: 'Frontier model.' }, { slug: 'velho', description: 'Older fast and efficient model.' },
    { slug: 'barato-novo', description: 'Fast and affordable model for easier tasks.' },
  ] }));
  assert.equal(cheapestCodexModel({ CODEX_HOME: codexHome }), 'barato-novo');
  assert.equal(cheapestCodexModel({ CODEX_HOME: codexHome, CONTEXT_TOOLS_CODEX_AGENT_MODEL: 'fixo' }), 'fixo');
  assert.equal(cheapestCodexModel({ CODEX_HOME: join(home, 'nada') }), null);
  // Instaladores: Codex grava .codex/agents/*.toml; Claude standalone copia .claude/agents/.
  const codexRun = spawnSync(process.execPath, [join(ROOT, 'install-codex.mjs'), project, '--no-hooks', '--agent-model=modelo-x'], { encoding: 'utf8', env });
  assert.equal(codexRun.status, 0, codexRun.stderr);
  assert.deepEqual(readdirSync(join(project, '.codex', 'agents')).sort(), Object.keys(ROLES).map((r) => `${r}.toml`).sort());
  assert.match(readFileSync(join(project, '.codex', 'agents', 'ct-explorer.toml'), 'utf8'), /model = "modelo-x"/);
  const claudeRun = spawnSync(process.execPath, [join(ROOT, 'install.mjs'), project, '--no-hooks'], { encoding: 'utf8', env });
  assert.equal(claudeRun.status, 0, claudeRun.stderr);
  assert.ok(existsSync(join(project, '.claude', 'agents', 'ct-verifier.md')));
  assert.ok(VERBS.brief && VERBS.delegate);
}));
