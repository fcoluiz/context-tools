import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CODE_RE, HISTORY_CODE_RE, LANGUAGE_CAPABILITIES, capabilityForExtension,
  sanitizeModelText,
} from '../scripts/lib/roots.mjs';
import { evidenceEnvelope } from '../scripts/lib/evidence.mjs';
import { providerForExtension, discoverProviders } from '../scripts/providers.mjs';
import { buildContextPack } from '../scripts/context-pack.mjs';
import { fatosDaSessao } from '../scripts/lib/sessao.mjs';
import { recordMetric, readMetrics, clearMetrics } from '../scripts/lib/telemetry.mjs';

function projeto() {
  const root = mkdtempSync(join(tmpdir(), 'ctx-new-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

test('catálogo único distingue parser local de extensão histórica', () => {
  assert.ok(LANGUAGE_CAPABILITIES.length >= 7);
  assert.equal(capabilityForExtension('.go').id, 'go');
  assert.equal(CODE_RE.test('x.go'), true);
  assert.equal(CODE_RE.test('x.rb'), false);
  assert.equal(HISTORY_CODE_RE.test('x.rb'), true);
});

test('sanitização remove controles sem quebrar texto comum', () => {
  assert.equal(sanitizeModelText('A\u001b[31m\nB\tC'), 'A [31m B C');
  assert.equal(sanitizeModelText('abcdef', 3), 'abc...');
});

test('envelope de evidência preserva origem e limitações', () => {
  const e = evidenceEnvelope({ query: 'X\n', scope: ['repo\u0007'], items: [{ kind: 'definition' }], limitations: ['não é definição'] });
  assert.equal(e.query, 'X');
  assert.deepEqual(e.scope, ['repo']);
  assert.equal(e.items[0].kind, 'definition');
});

test('provedores semânticos são detectados sem instalação automática', () => {
  const p = providerForExtension('.go');
  assert.equal(p.id, 'gopls');
  const rows = discoverProviders('C:\\tmp', { semanticProviders: false });
  assert.ok(rows.every((x) => x.enabled === false && x.available === false));
});

test('skill do Codex aponta para caminhos executáveis, não para placeholder', () => {
  const skill = readFileSync(new URL('../skills/context-tools/SKILL.md', import.meta.url), 'utf8');
  assert.doesNotMatch(skill, /node <scripts>\//);
  assert.match(skill, /node "\$\{PLUGIN_ROOT\}\/scripts\/ct\.mjs"/);
  assert.match(skill, /node "\$\{PLUGIN_ROOT\}\/scripts\/metrics\.mjs"/);
  assert.match(skill, /\.codex\/scripts\//);
});

test('context-pack entrega definição estruturada sob orçamento', () => {
  const root = projeto();
  try {
    writeFileSync(join(root, 'src', 'a.js'), 'export function alfa() { return 1; }\n');
    const pack = buildContextPack(root, 'alfa', { budget: 20 });
    assert.equal(pack.status, 'ok');
    assert.ok(pack.items.some((x) => x.kind === 'definition' && x.confidence === 'exact'));
    assert.ok(pack.items.every((x) => typeof x.kind === 'string'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fatos do transcript registram ferramentas, edição e falha sem interpretar intenção', () => {
  const root = projeto();
  const transcript = join(root, 'session.jsonl');
  try {
    writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.js' } }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
      JSON.stringify({ type: 'tool_result', is_error: true, content: [{ text: 'failed' }] }),
    ].join('\n'));
    const facts = fatosDaSessao(transcript);
    assert.deepEqual(facts.ferramentas, ['Bash', 'Edit']);
    assert.deepEqual(facts.edicoes, ['src/a.js']);
    assert.equal(facts.comandos, 1);
    assert.deepEqual(facts.falhas, ['failed']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('métricas locais são limitadas ao estado do projeto', () => {
  const root = projeto();
  const old = process.env.CONTEXT_TOOLS_STATE_DIR;
  process.env.CONTEXT_TOOLS_STATE_DIR = join(root, '.state');
  try {
    recordMetric(root, 'test', { value: 'ok\n' });
    const data = readMetrics(root);
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].value, 'ok');
  } finally {
    clearMetrics(root);
    if (old === undefined) delete process.env.CONTEXT_TOOLS_STATE_DIR;
    else process.env.CONTEXT_TOOLS_STATE_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('todo verbo do ct.mjs citado na skill existe e aponta para um script que existe', async () => {
  // A skill é a única documentação que o agente lê; um verbo citado ali e ausente do ct.mjs viraria
  // "verbo desconhecido" no meio de uma tarefa.
  const { VERBS } = await import('../scripts/ct.mjs');
  const skill = readFileSync(new URL('../skills/context-tools/SKILL.md', import.meta.url), 'utf8');
  const citados = [...skill.matchAll(/ct\.mjs (?:"\s*)?([a-z]+)/g)].map((m) => m[1]).filter((v) => v !== 'help');
  assert.ok(citados.length >= 8, 'a skill deveria citar os verbos principais');
  for (const verbo of new Set(citados)) {
    assert.ok(VERBS[verbo], `verbo "${verbo}" citado na skill e ausente do ct.mjs`);
    assert.ok(existsSync(new URL(`../scripts/${VERBS[verbo].script}`, import.meta.url)), `script de "${verbo}" não existe`);
  }
  for (const [verbo, v] of Object.entries(VERBS)) {
    assert.ok(existsSync(new URL(`../scripts/${v.script}`, import.meta.url)), `ct.mjs ${verbo} aponta para ${v.script}, que não existe`);
  }
});
