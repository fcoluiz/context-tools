// `ct snapshot`: o JSON versionado que painéis e CI consomem. O que mais importa aqui é o que NÃO
// sai: conteúdo de código, de mapa, de documento, de prompt ou de resposta. Os testes semeiam
// marcadores em todos esses lugares e procuram por eles na saída.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPath } from './paths.mjs';
import { SNAPSHOT_SCHEMA, githubSlug, machineId, remoteSemCredencial } from '../scripts/snapshot-export.mjs';

const SCRIPT = localPath('../scripts/snapshot-export.mjs');
const SEGREDO_CODIGO = 'MARCADOR_CODIGO_8f3a';
const SEGREDO_MAPA = 'MARCADOR_MAPA_19be';
const SEGREDO_PROMPT = 'MARCADOR_PROMPT_c7d2';
const SEGREDO_RESPOSTA = 'MARCADOR_RESPOSTA_4e61';

function projeto() {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-snapshot-'));
  mkdirSync(join(raiz, 'src'), { recursive: true });
  writeFileSync(join(raiz, 'src', 'a.js'), `export function alfa() { return '${SEGREDO_CODIGO}'; }\n`);
  const g = (...a) => spawnSync('git', ['-C', raiz, ...a], { stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('remote', 'add', 'origin', 'https://ghp_TOKENSECRETO@github.com/dono/projeto.git');
  g('add', '-A');
  g('commit', '-qm', 'init');
  mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
  writeFileSync(join(raiz, '.claude', 'context', 'area.md'),
    `---\narea: "minha-area"\ncovers:\n  - "src/a.js"\nverified_at: HEAD\n---\n\n${SEGREDO_MAPA}: como a área funciona.\n`);
  return raiz;
}

function transcript(dir, sid) {
  const linha = (o) => JSON.stringify(o);
  writeFileSync(join(dir, `${sid}.jsonl`), [
    linha({ type: 'user', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: SEGREDO_PROMPT } }),
    // A última resposta aparece em duas linhas (um bloco por linha, mesmo id e mesmo usage), como o
    // Claude Code grava: os totais não podem contar a mesma requisição duas vezes.
    ...[0, 1, 2, 3, 4, 4].map((i) => linha({
      type: 'assistant', timestamp: new Date(Date.parse('2026-10-01T10:00:00.000Z') + (i + 1) * 60000).toISOString(),
      message: {
        id: `msg_${i}`, model: 'claude-test-1',
        content: [{ type: 'text', text: SEGREDO_RESPOSTA }],
        usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 10000 * (i + 1), cache_creation_input_tokens: 500 },
      },
    })),
  ].join('\n') + '\n');
}

function snapshot(raiz, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, `--root=${raiz}`, '--sessions=5'], {
    encoding: 'utf8', cwd: raiz,
    env: {
      ...process.env, CONTEXT_TOOLS_HOST: 'claude', CONTEXT_MAPS_ROOT: raiz, CLAUDE_PROJECT_DIR: raiz,
      // Sem isto o teste varreria as sessões reais do Codex de quem roda a suíte.
      CONTEXT_TOOLS_CODEX_SESSIONS: join(raiz, 'sem-sessoes-codex'),
      ...extraEnv,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return { texto: r.stdout, json: JSON.parse(r.stdout) };
}

test('snapshot: schema versionado, repositório sem credencial, inventário e sessões em números', () => {
  const raiz = projeto();
  const casa = mkdtempSync(join(tmpdir(), 'ctx-snapshot-home-'));
  const transcritos = mkdtempSync(join(tmpdir(), 'ctx-snapshot-transc-'));
  try {
    transcript(transcritos, 'sessao-1');
    const { texto, json } = snapshot(raiz, { CONTEXT_TOOLS_HOME: casa, CONTEXT_TOOLS_TRANSCRIPTS: transcritos });
    assert.equal(json.schema, SNAPSHOT_SCHEMA);
    assert.match(json.machineId, /^[0-9a-f-]{36}$/);
    const [repo] = json.repositories;
    assert.equal(repo.remote, 'https://github.com/dono/projeto.git', 'o token do remote não sai');
    assert.equal(repo.github, 'dono/projeto');
    assert.match(repo.head, /^[0-9a-f]{40}$/);
    assert.deepEqual(json.knowledge.items.map((i) => [i.kind, i.path]), [['map', '.claude/context/area.md']]);
    assert.ok(['fresh', 'stale'].includes(json.knowledge.items[0].status));
    assert.equal(json.sessions.length, 1);
    const [s] = json.sessions;
    assert.equal(s.id, 'sessao-1');
    assert.equal(s.host, 'claude');
    assert.equal(s.peakContextTokens, 50000);
    assert.deepEqual(s.tokens, { input: 50, output: 500, cacheRead: 150000, cacheWrite: 2500 }, 'uma vez por mensagem');
    assert.equal(s.model, 'claude-test-1');
    assert.ok(s.messages > 0 && s.startedAt && s.endedAt);
    for (const marcador of [SEGREDO_CODIGO, SEGREDO_MAPA, SEGREDO_PROMPT, SEGREDO_RESPOSTA, 'ghp_TOKENSECRETO']) {
      assert.ok(!texto.includes(marcador), `${marcador} vazou para o snapshot`);
    }
  } finally {
    for (const d of [raiz, casa, transcritos]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** Um rollout do Codex como ele grava: `session_meta` com o `cwd`, e o `token_count` acumulado. */
function rolloutCodex(base, dia, id, cwd, ms) {
  const dir = join(base, '2026', '10', dia);
  mkdirSync(dir, { recursive: true });
  const linha = (o) => JSON.stringify(o);
  const caminho = join(dir, `rollout-2026-10-${dia}T10-00-00-${id}.jsonl`);
  writeFileSync(caminho, [
    linha({ timestamp: '2026-10-02T10:00:00.000Z', type: 'session_meta', payload: { id, cwd, base_instructions: { text: 'x'.repeat(100000) } } }),
    linha({ timestamp: '2026-10-02T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-test-1' } }),
    linha({ timestamp: '2026-10-02T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
    linha({ timestamp: '2026-10-02T10:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: SEGREDO_PROMPT }] } }),
    linha({ timestamp: '2026-10-02T10:05:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, total_tokens: 1050 },
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 },
      model_context_window: 200000,
    } } }),
  ].join('\n') + '\n');
  utimesSync(caminho, ms / 1000, ms / 1000);
}

test('snapshot: sessões do Codex desta pasta entram junto com as do Claude, as mais recentes primeiro', () => {
  const raiz = projeto();
  const casa = mkdtempSync(join(tmpdir(), 'ctx-snapshot-home-'));
  const transcritos = mkdtempSync(join(tmpdir(), 'ctx-snapshot-transc-'));
  const codex = mkdtempSync(join(tmpdir(), 'ctx-snapshot-codex-'));
  try {
    transcript(transcritos, 'sessao-claude');
    utimesSync(join(transcritos, 'sessao-claude.jsonl'), 1000, 1000);
    // Sessão retomada: o arquivo fica no diretório do dia em que começou, mas o mtime é recente.
    rolloutCodex(codex, '01', 'codex-desta-pasta', `${raiz}/`, Date.now());
    rolloutCodex(codex, '02', 'codex-de-outra-pasta', join(raiz, 'outra'), Date.now());
    const { texto, json } = snapshot(raiz, { CONTEXT_TOOLS_HOME: casa, CONTEXT_TOOLS_TRANSCRIPTS: transcritos, CONTEXT_TOOLS_CODEX_SESSIONS: codex });
    const ids = json.sessions.map((s) => s.id);
    assert.deepEqual(ids, ['codex-desta-pasta', 'sessao-claude'], 'a de outra pasta fica de fora');
    const [c] = json.sessions;
    assert.equal(c.host, 'codex');
    assert.equal(c.model, 'gpt-test-1');
    assert.deepEqual(c.tokens, { input: 200, output: 50, cacheRead: 800, cacheWrite: 0 }, 'entrada sem o que veio do cache');
    assert.ok(!texto.includes(SEGREDO_PROMPT), 'o prompt do Codex não vaza');
  } finally {
    for (const d of [raiz, casa, transcritos, codex]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('snapshot: identidade anônima da máquina é estável e não deriva de nome nem de hostname', () => {
  const casa = mkdtempSync(join(tmpdir(), 'ctx-snapshot-id-'));
  try {
    const env = { CONTEXT_TOOLS_HOME: casa };
    const a = machineId(env);
    assert.equal(machineId(env), a, 'a mesma máquina, o mesmo id');
    assert.equal(readFileSync(join(casa, 'machine-id'), 'utf8').trim(), a);
    rmSync(join(casa, 'machine-id'));
    assert.notEqual(machineId(env), a, 'apagar o arquivo gera outro');
  } finally { rmSync(casa, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('snapshot: remote sem credencial e slug do GitHub em https e ssh', () => {
  assert.equal(remoteSemCredencial('https://user:senha@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(remoteSemCredencial('git@github.com:o/r.git'), 'git@github.com:o/r.git');
  assert.equal(remoteSemCredencial(null), null);
  assert.equal(githubSlug('https://github.com/o/r.git'), 'o/r');
  assert.equal(githubSlug('git@github.com:o/r.git'), 'o/r');
  assert.equal(githubSlug('https://gitlab.com/o/r.git'), null);
});

test('snapshot: opção desconhecida ou fora do intervalo falha com mensagem, sem JSON pela metade', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--sessions=999'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /--sessions must be an integer/);
});
