// 🧩 Os agentes delegados nos dois hosts, a partir de uma fonte só: `agents/ct-*.md`.
//
// Claude: o plugin carrega `agents/*.md` sozinho; a instalação standalone copia para
// `.claude/agents/`. Codex: agente de projeto é um TOML em `.codex/agents/` (name, description,
// developer_instructions, model, model_reasoning_effort). Os dois textos são o mesmo corpo do .md.
//
// Nenhum agente leva caminho de script: o briefing (`ct brief`) entrega a linha de comando
// absoluta do `ct`. Assim o arquivo gerado é o mesmo em toda máquina e pode ser versionado.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function parseAgent(text) {
  const m = String(text).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return meta.name ? { meta, body: m[2].trim() } : null;
}

export function agentSources(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^ct-[\w-]+\.md$/.test(f)).sort()
    .map((f) => ({ file: f, ...parseAgent(readFileSync(join(dir, f), 'utf8')) }))
    .filter((a) => a.meta);
}

/** Texto TOML entre aspas triplas literais: sem escape; `'''` no corpo vira `''\'`. */
const tomlMultiline = (text) => `'''\n${String(text).replace(/'''/g, "''\\'")}\n'''`;
const tomlString = (text) => JSON.stringify(String(text));

const CODEX_EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };

/** O TOML de agente do Codex. `model` nulo: o agente herda o modelo da sessão. */
export function renderCodexAgent(agent, { model = null } = {}) {
  const lines = [
    '# Gerado pelo context-tools a partir de agents/' + agent.file + ' — reinstale para atualizar.',
    `name = ${tomlString(agent.meta.name)}`,
    `description = ${tomlString(agent.meta.description || '')}`,
  ];
  if (model) lines.push(`model = ${tomlString(model)}`);
  const effort = CODEX_EFFORT[agent.meta.effort];
  if (effort) lines.push(`model_reasoning_effort = ${tomlString(effort)}`);
  // O Codex não tem lista de ferramentas por agente: o subagente herda o sandbox da sessão que o
  // chamou, e as regras acima valem pela trava dos hooks.
  const body = `${agent.body}\n\nThis agent runs inside the Codex sandbox of the session that started it.`;
  lines.push(`developer_instructions = ${tomlMultiline(body)}`);
  return `${lines.join('\n')}\n`;
}

/** Versão no nome do modelo (`gpt-6.1-luna` → [6, 1]); sem número, a mais baixa. */
const versionOf = (slug) => (String(slug).match(/(\d+(?:\.\d+)*)/)?.[1] || '0').split('.').map(Number);
const newer = (a, b) => {
  const va = versionOf(a), vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((va[i] || 0) !== (vb[i] || 0)) return (va[i] || 0) > (vb[i] || 0);
  return false;
};

/**
 * O modelo barato do Codex desta máquina, lido do `models_cache.json`. O Codex não tem um apelido
 * estável como o `haiku` do Claude; ler a lista na instalação é o que mantém "sempre o mais novo"
 * sem gravar um nome que envelhece. Preferido: o `*-luna` de versão mais alta (a linha rápida e
 * barata); sem nenhum, o primeiro que se descreve como barato e não como geração anterior. Sem
 * cache legível, `null` (o agente herda o modelo da sessão).
 */
export function cheapestCodexModel(env = process.env) {
  if (env.CONTEXT_TOOLS_CODEX_AGENT_MODEL) return env.CONTEXT_TOOLS_CODEX_AGENT_MODEL;
  try {
    const cache = JSON.parse(readFileSync(join(env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    const models = Array.isArray(cache) ? cache : Array.isArray(cache?.models) ? cache.models : [];
    const luna = models.map((m) => m?.slug).filter((slug) => typeof slug === 'string' && /-luna$/i.test(slug))
      .reduce((best, slug) => (!best || newer(slug, best) ? slug : best), null);
    if (luna) return luna;
    const pick = models.find((m) => {
      const text = `${m?.description || ''} ${m?.display_name || ''}`;
      return /affordable|efficient|mini|fast\b/i.test(text) && !/\b(older|previous|legacy|deprecated)\b/i.test(text)
        && !/review/i.test(String(m?.slug || ''));
    });
    return typeof pick?.slug === 'string' && pick.slug ? pick.slug : null;
  } catch { return null; }
}
