import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadConfig, runtimeHost } from '../scripts/lib/roots.mjs';
import { fingerprintSourcesInRoot } from '../scripts/lib/source-fingerprints.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

function novoRepo() {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-codex-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'sample.mjs'), 'export function buildIndex() {}\n');
  const git = spawnSync('git', ['-C', root, 'init', '-q'], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const commit = spawnSync('git', [
    '-C', root,
    '-c', 'user.name=context-tools-test',
    '-c', 'user.email=context-tools@example.invalid',
    'add', '.',
  ], { encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  const saved = spawnSync('git', [
    '-C', root,
    '-c', 'user.name=context-tools-test',
    '-c', 'user.email=context-tools@example.invalid',
    'commit', '-qm', 'initial',
  ], { encoding: 'utf8' });
  assert.equal(saved.status, 0, saved.stderr);
  return root;
}

function runHook(name, args, root, event, env = {}) {
  return spawnSync(process.execPath, [script(name), ...args], {
    cwd: root,
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: {
      ...process.env,
      CONTEXT_TOOLS_LANG: 'en',
      ...env,
    },
  });
}

test('Codex manifest aponta para skill e hooks do plugin, mantendo bootstrap standalone', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'context-tools');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.hooks, './hooks/codex-hooks.json');
  assert.ok(existsSync(join(ROOT, 'hooks', 'codex-hooks.json')));

  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'codex-hooks.json'), 'utf8')).hooks;
  assert.ok(hooks.UserPromptSubmit?.[0]?.hooks.some((h) => h.command.includes('context-docs.mjs --prompt-audit')),
    'Codex deve executar a auditoria local dos arquivos citados no prompt');
  assert.ok(hooks.PreToolUse.some(group => group.matcher === 'Bash'));
  assert.ok(hooks.SessionStart[0].hooks.every((h) => h.command.includes('codex-hook.mjs')));
  assert.ok(hooks.SessionStart[0].hooks.some((h) => h.command.includes('context-docs.mjs')));
  assert.ok(hooks.Stop[0].hooks.some((h) => h.command.includes('context-docs.mjs')));
  assert.equal(hooks.Stop[0].hooks.filter((h) => h.command.includes('context-maps.mjs')).length, 0,
    'mapas e documentação precisam compartilhar um único Stop para evitar continuações duplicadas');
  assert.equal(hooks.Stop[0].hooks.filter((h) => h.command.includes('context-docs.mjs')).length, 1);
  assert.equal(hooks.Stop[0].hooks.find((h) => h.command.includes('context-docs.mjs')).timeout, 35);

  const standalone = JSON.parse(readFileSync(join(ROOT, '.codex', 'hooks.json'), 'utf8')).hooks;
  const commands = Object.values(standalone)
    .flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
  assert.ok(commands.some((command) => command.includes('context-docs.mjs --session-start')));
  assert.ok(commands.some((command) => command.includes('context-docs.mjs --stop-report')));
});

test('Codex UserPromptSubmit usa preflight offline no adapter e cala quando o mapa está fresco', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-prompt-hook-'));
  const source = join(root, 'src', 'sample.mjs');
  const map = join(root, '.claude', 'context', 'area.md');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.claude', 'context'), { recursive: true });
    writeFileSync(source, 'export const first = true;\n');
    const digest = fingerprintSourcesInRoot(root, ['src/sample.mjs']).digest;
    writeFileSync(map, `---\narea: prompt-area\ncovers:\n  - "src/sample.mjs"\nverified_at: 2026-01-01\nsource_digest: ${digest}\n---\n`);

    const event = {
      session_id: 'codex-prompt-audit',
      cwd: root,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Please inspect src/sample.mjs.',
    };
    const fresh = runHook('codex-hook.mjs', ['context-docs.mjs', '--prompt-audit'], root, event);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stdout, '', 'fresh map adds no prompt context');

    writeFileSync(source, 'export const second = true;\n');
    const stale = runHook('codex-hook.mjs', ['context-docs.mjs', '--prompt-audit'], root, event);
    assert.equal(stale.status, 0, stale.stderr);
    const output = JSON.parse(stale.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(output.hookSpecificOutput.additionalContext, /prompt-area/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('marketplace do Codex aponta para a release do próprio plugin', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const codexPlugin = JSON.parse(readFileSync(join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(codexPlugin.version, pkg.version);
  const catalog = JSON.parse(readFileSync(join(ROOT, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  const entry = catalog.plugins.find((plugin) => plugin.name === 'context-tools');
  assert.ok(entry, 'o catálogo precisa expor context-tools');
  assert.equal(entry.source.source, 'url');
  assert.equal(entry.source.url, 'https://github.com/fcoluiz/context-tools.git');
  assert.equal(entry.source.ref, `v${pkg.version}`);
  assert.equal(entry.policy.installation, 'AVAILABLE');
  assert.equal(entry.policy.authentication, 'ON_INSTALL');
  assert.equal(entry.category, 'Developer Tools');
});

test('script standalone identifica Codex pelo diretório instalado', () => {
  assert.equal(runtimeHost({}, 'C:\\projeto\\.codex\\scripts\\symbols.mjs'), 'codex');
  assert.equal(runtimeHost({}, 'C:\\projeto\\.claude\\scripts\\symbols.mjs'), 'claude');
  assert.equal(runtimeHost({ CONTEXT_TOOLS_HOST: 'codex' }, 'C:\\plugin\\scripts\\symbols.mjs'), 'codex');
  assert.equal(runtimeHost({ CONTEXT_TOOLS_HOST: 'claude' }, 'C:\\projeto\\.codex\\scripts\\symbols.mjs'), 'claude');
});

test('Codex Bash busca usa o mesmo pre-hook sem tocar no estado Claude', () => {
  const root = novoRepo();
  try {
    const event = {
      session_id: 'codex-session',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rg buildIndex src' },
    };
    const codex = runHook('codex-hook.mjs', ['pre-tool.mjs'], root, event);
    assert.equal(codex.status, 0, codex.stderr);
    const output = JSON.parse(codex.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(output.hookSpecificOutput.additionalContext, /buildIndex/);
    assert.ok(existsSync(join(root, '.codex', 'context-tools', '.pre-tool-state.json')));
    assert.ok(!existsSync(join(root, '.claude', '.pre-tool-state.json')));

    const claude = runHook('pre-tool.mjs', [], root, {
      tool_name: 'Grep',
      tool_input: { pattern: 'buildIndex' },
    }, { CONTEXT_TOOLS_HOST: 'claude', CLAUDE_CODE_SESSION_ID: 'claude-session' });
    assert.equal(claude.status, 0, claude.stderr);
    assert.match(JSON.parse(claude.stdout).hookSpecificOutput.additionalContext, /buildIndex/);
    assert.ok(existsSync(join(root, '.claude', '.pre-tool-state.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex SessionStart grava baseline no estado Codex', () => {
  const root = novoRepo();
  try {
    const result = runHook('codex-hook.mjs', ['context-maps.mjs', '--session-start'], root, {
      session_id: 'codex-baseline',
      cwd: root,
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    assert.equal(result.status, 0, result.stderr);
    const baseline = join(root, '.codex', 'context-tools', '.context-maps-session-baseline.json');
    assert.ok(existsSync(baseline));
    assert.ok(JSON.parse(readFileSync(baseline, 'utf8'))['codex-baseline']);
    assert.ok(!existsSync(join(root, '.claude', '.context-maps-session-baseline.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex SessionStart transforma alerta acionável em systemMessage visível', () => {
  const root = novoRepo();
  try {
    const result = runHook('codex-hook.mjs', ['context-maps.mjs', '--session-start'], root, {
      session_id: 'codex-visible-notice',
      cwd: root,
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.systemMessage, /No context maps were found/);
    assert.equal(output.hookSpecificOutput._contextToolsNotice, undefined);
    assert.match(output.hookSpecificOutput.additionalContext, /No context maps were found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex usa cwd do evento como raiz mesmo quando o projeto sem git está dentro de workspace maior', () => {
  const pai = mkdtempSync(join(tmpdir(), 'context-tools-codex-workspace-'));
  const root = join(pai, 'AppServer');
  const vizinho = join(pai, 'OutroProjeto');
  try {
    mkdirSync(join(root, '.codex'), { recursive: true });
    mkdirSync(vizinho, { recursive: true });
    const git = spawnSync('git', ['-C', vizinho, 'init', '-q'], { encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    writeFileSync(join(root, '.codex', 'context-tools.json'), JSON.stringify({ extraRepos: [] }));

    const result = runHook('codex-hook.mjs', ['context-maps.mjs', '--session-start'], root, {
      session_id: 'codex-project-root',
      cwd: root,
      hook_event_name: 'SessionStart',
    });
    assert.equal(result.status, 0, result.stderr);
    const baseline = join(root, '.codex', 'context-tools', '.context-maps-session-baseline.json');
    assert.ok(existsSync(baseline), 'o baseline precisa ficar no projeto informado pelo Codex');
    assert.ok(JSON.parse(readFileSync(baseline, 'utf8'))['codex-project-root']);
    assert.ok(!existsSync(join(pai, '.codex', 'context-tools', '.context-maps-session-baseline.json')),
      'o hook não pode subir para o estado do workspace-pai');
  } finally { rmSync(pai, { recursive: true, force: true }); }
});

test('Codex Stop permanece silencioso e o handoff registra as métricas', () => {
  const root = novoRepo();
  const transcript = join(root, 'rollout.jsonl');
  const token = {
    timestamp: '2026-08-06T07:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 70000, cached_input_tokens: 60000, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: 70110 },
        last_token_usage: { input_tokens: 70000, cached_input_tokens: 60000, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: 70110 },
        model_context_window: 258400,
      },
    },
  };
  writeFileSync(transcript, [
    JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', type: 'session_meta' }),
    JSON.stringify({ timestamp: '2026-08-06T07:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify(token),
  ].join('\n') + '\n');
  try {
    const result = runHook('codex-hook.mjs', ['handoff.mjs', '--stop-report'], root, {
      session_id: 'codex-long-stop',
      cwd: root,
      transcript_path: transcript,
      hook_event_name: 'Stop',
      turn_id: 'turn-1',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '', 'Codex não deve emitir aviso de contexto ou tempo no Stop');

    const handoff = runHook('codex-hook.mjs', ['handoff.mjs', '--salvar'], root, {
      session_id: 'codex-long-stop',
      cwd: root,
      transcript_path: transcript,
      hook_event_name: 'Stop',
      turn_id: 'turn-1',
    });
    assert.equal(handoff.status, 0, handoff.stderr);
    assert.match(handoff.stdout, /Codex session/i);
    assert.ok(existsSync(join(root, '.codex', 'context-tools', 'handoff-codex-lo.md')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex Stop inicia uma revisão automática única para mapas e documentação pendentes', () => {
  const root = novoRepo();
  try {
    const oldHead = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    mkdirSync(join(root, '.claude', 'context'), { recursive: true });
    writeFileSync(join(root, '.claude', 'context', 'area.md'),
      `---\narea: sample\ncovers:\n  - src/sample.mjs\nverified_at: ${oldHead}\n---\n`);
    mkdirSync(join(root, 'ai-context', 'features'), { recursive: true });
    writeFileSync(join(root, 'ai-context', '00-index.md'), '# Operational documentation index\n');
    writeFileSync(join(root, 'ai-context', 'features', 'sample.md'),
      '# Sample flow\n\n- Source: src/sample.mjs\n- Last reviewed: 2020-01-01\n');

    const event = {
      session_id: 'codex-auto-doc-review',
      cwd: root,
      hook_event_name: 'Stop',
      turn_id: 'turn-review-1',
      stop_hook_active: false,
    };
    const start = runHook('codex-hook.mjs', ['context-maps.mjs', '--session-start'], root, {
      ...event,
      hook_event_name: 'SessionStart',
    });
    assert.equal(start.status, 0, start.stderr);
    const attribution = { ...event, tool_use_id: 'edit-sample', tool_name: 'Write', tool_input: { file_path: 'src/sample.mjs' }, tool_response: { success: true } };
    runHook('codex-hook.mjs', ['session-write-journal.mjs', '--session-start'], root, { ...event, hook_event_name: 'SessionStart' });
    runHook('codex-hook.mjs', ['session-write-journal.mjs', '--pre-tool-use'], root, attribution);
    appendFileSync(join(root, 'src', 'sample.mjs'), 'export function changedSinceMapReview() {}\n');
    runHook('codex-hook.mjs', ['session-write-journal.mjs', '--post-tool-use'], root, attribution);
    const first = runHook('codex-hook.mjs', ['context-docs.mjs', '--stop-report'], root, event);
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.decision, 'block', 'Codex deve iniciar uma continuação para resolver a revisão');
    assert.match(result.reason, /\"kind\":\"map\"/, 'structured finding identifies a map');
    assert.match(result.reason, /"kind":"document"/);
    assert.match(result.reason, /ai-context\/features\/sample\.md/);
    assert.doesNotMatch(first.stdout, /_contextToolsAutoReview/);

    const second = runHook('codex-hook.mjs', ['context-docs.mjs', '--stop-report'], root, {
      ...event,
      stop_hook_active: true,
    });
    assert.equal(second.status, 0, second.stderr);
    const afterReviewAttempt = JSON.parse(second.stdout);
    assert.equal(afterReviewAttempt.decision, undefined, 'não deve pedir uma segunda continuação no mesmo turno');
    assert.match(afterReviewAttempt.systemMessage, /remains pending/i);
    assert.match(afterReviewAttempt.systemMessage, /review\.mjs/);

    const repeatedTask = runHook('codex-hook.mjs', ['context-docs.mjs', '--stop-report'], root, {
      ...event,
      turn_id: 'turn-review-2',
      stop_hook_active: false,
    });
    assert.equal(repeatedTask.stdout.trim(), '', 'não repete a mesma revisão em tarefas seguintes sem mudança durante o cooldown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('configuração específica de um host não atravessa para o outro', () => {
  const root = novoRepo();
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.claude', 'context-tools.json'), '{"lang":"pt"}\n');
    writeFileSync(join(root, '.codex', 'context-tools.json'), '{"lang":"en"}\n');

    assert.equal(loadConfig(root, { CONTEXT_TOOLS_HOST: 'codex' }).lang, 'en');
    assert.equal(loadConfig(root, { CONTEXT_TOOLS_HOST: 'claude' }).lang, 'pt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('instalação both cria as duas integrações sem misturar os diretórios', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-install-'));
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'context-tools.json'), '{"lang":"pt","contextMaps":{"intentionallyUnmapped":["install.mjs"]}}\n');
    const installer = fileURLToPath(new URL('../install.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [installer, root, '--target=both'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(existsSync(join(root, '.claude', 'settings.json')));
    assert.ok(existsSync(join(root, '.codex', 'hooks.json')));
    assert.ok(existsSync(join(root, '.codex', 'context-tools-install.json')));
    assert.match(readFileSync(join(root, '.codex', '.gitignore'), 'utf8'), /context-tools-install\.json/);
    // O marker do Claude espelha o do Codex (mesma forma: name/version/installedAt/source), e
    // existe pelo mesmo motivo: dar a setup-claude.mjs status/doctor algo para comparar com a
    // versão instalada, igual ao que install-codex.mjs já fazia só para o lado Codex.
    assert.ok(existsSync(join(root, '.claude', 'context-tools-install.json')));
    const claudeMarker = JSON.parse(readFileSync(join(root, '.claude', 'context-tools-install.json'), 'utf8'));
    assert.equal(claudeMarker.name, 'context-tools');
    assert.ok(claudeMarker.version);
    assert.match(readFileSync(join(root, '.claude', '.gitignore'), 'utf8'), /context-tools-install\.json/);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, '.codex', 'context-tools.json'), 'utf8')),
      JSON.parse(readFileSync(join(root, '.claude', 'context-tools.json'), 'utf8')),
    );
    assert.ok(existsSync(join(root, '.agents', 'skills', 'context-tools', 'SKILL.md')));
    const hooks = JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'));
    assert.ok(hooks.hooks.PreToolUse.some(group => group.matcher === 'Bash'));
    const commands = Object.values(hooks.hooks)
      .flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
    assert.ok(commands.some((command) => command.includes('node ".codex/scripts/codex-hook.mjs')));
    assert.ok(commands.every((command) => !command.includes('git rev-parse')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude e Codex usam o mesmo núcleo de md-hint com estado isolado', () => {
  const root = novoRepo();
  try {
    writeFileSync(join(root, 'CLAUDE.md'), '# Claude\n');
    writeFileSync(join(root, 'AGENTS.md'), '# Codex\n');

    const claude = runHook('claude-md-hint.mjs', [], root, {}, { CONTEXT_TOOLS_HOST: 'claude' });
    assert.equal(claude.status, 0, claude.stderr);
    assert.match(JSON.parse(claude.stdout).hookSpecificOutput.additionalContext, /CLAUDE\.md/);
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /context-tools:before-explore/);
    assert.ok(existsSync(join(root, '.claude', '.claude-md-hint-done')));
    assert.ok(!existsSync(join(root, '.codex', 'context-tools', '.codex-md-hint-done')));

    const codex = runHook('codex-md-hint.mjs', [], root, {}, { CONTEXT_TOOLS_HOST: 'codex' });
    assert.equal(codex.status, 0, codex.stderr);
    assert.match(JSON.parse(codex.stdout).hookSpecificOutput.additionalContext, /AGENTS\.md/);
    assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /context-tools:before-explore-codex/);
    assert.ok(existsSync(join(root, '.codex', 'context-tools', '.codex-md-hint-done')));

    const claudeAgain = runHook('claude-md-hint.mjs', [], root, {}, { CONTEXT_TOOLS_HOST: 'claude' });
    const codexAgain = runHook('codex-md-hint.mjs', [], root, {}, { CONTEXT_TOOLS_HOST: 'codex' });
    assert.equal(claudeAgain.stdout.trim(), '');
    assert.equal(codexAgain.stdout.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('md-hint observa o idioma do arquivo antes do idioma do ambiente', () => {
  const root = novoRepo();
  try {
    writeFileSync(join(root, 'AGENTS.md'), '# Regras do projeto\n\nAntes de qualquer alteração, leia o arquivo e use as regras do projeto.\n');
    const codex = runHook('codex-md-hint.mjs', [], root, {}, { CONTEXT_TOOLS_LANG: '' });
    assert.equal(codex.status, 0, codex.stderr);
    const conteudo = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    assert.match(conteudo, /Antes de delegar a um subagente de exploração/);
    assert.doesNotMatch(conteudo, /Before delegating to an exploration subagent/);
    assert.match(JSON.parse(codex.stdout).hookSpecificOutput.additionalContext, /AGENTS\.md/);

    writeFileSync(join(root, 'CLAUDE.md'), '# Regras do projeto\n\nAntes de qualquer alteração, leia o arquivo e use as regras do projeto.\n');
    const claude = runHook('claude-md-hint.mjs', [], root, {}, { CONTEXT_TOOLS_LANG: '' });
    assert.equal(claude.status, 0, claude.stderr);
    const claudeText = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    assert.match(claudeText, /Antes de delegar a um subagente de exploração/);
    assert.doesNotMatch(claudeText, /Before delegating to an exploration subagent/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('md-hint preserva bytes, encoding ANSI e quebras de linha existentes', () => {
  const root = novoRepo();
  try {
    const agents = join(root, 'AGENTS.md');
    const antes = Buffer.from('# Regras do projeto\r\n- não alterar arquivo.\r\n', 'latin1');
    writeFileSync(agents, antes);
    const result = runHook('codex-md-hint.mjs', [], root, {}, { CONTEXT_TOOLS_HOST: 'codex', CONTEXT_TOOLS_LANG: 'pt' });
    assert.equal(result.status, 0, result.stderr);
    const depois = readFileSync(agents);
    assert.ok(depois.subarray(0, antes.length).equals(antes), 'o prefixo original precisa permanecer byte a byte');
    assert.match(depois.toString('latin1'), /Antes de delegar a um subagente de explora/);
    assert.match(depois.toString('latin1'), /\r\n## Antes/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('codex-md-hint respeita codexMdHint:false sem alterar AGENTS.md', () => {
  const root = novoRepo();
  try {
    const agents = join(root, 'AGENTS.md');
    const antes = '# Regras do projeto\n';
    writeFileSync(agents, antes);
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.codex', 'context-tools.json'), JSON.stringify({ codexMdHint: false }));
    const result = runHook('codex-md-hint.mjs', [], root, {}, { CONTEXT_TOOLS_HOST: 'codex', CONTEXT_TOOLS_LANG: 'pt' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '');
    assert.equal(readFileSync(agents, 'utf8'), antes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('opt-out do Claude não desliga o hint do Codex em instalação conjunta', () => {
  const root = novoRepo();
  try {
    const agents = join(root, 'AGENTS.md');
    writeFileSync(agents, '# Regras do projeto\n');
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.codex', 'context-tools.json'), JSON.stringify({ claudeMdHint: false }));
    const result = runHook('codex-md-hint.mjs', [], root, {}, { CONTEXT_TOOLS_HOST: 'codex', CONTEXT_TOOLS_LANG: 'pt' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /AGENTS\.md/);
    assert.match(readFileSync(agents, 'utf8'), /context-tools:before-explore-codex/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
