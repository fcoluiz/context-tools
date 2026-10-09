#!/usr/bin/env node
// 🔌 Servidor MCP do context-tools — opcional, stdio, sem dependência.
//
// Os hooks e a skill já levam as ferramentas ao Claude Code e ao Codex. O MCP serve para dois casos
// que eles não cobrem: outros clientes MCP (editores e agentes que não leem a skill) e quem prefere
// chamada de ferramenta tipada a um comando de terminal. Ele também mantém o processo vivo: as
// consultas não pagam a partida do Node (~130 ms) a cada chamada.
//
// O custo é honesto e fica no README: a definição das ferramentas entra no contexto de cada
// requisição do cliente que as carrega (~2.000 caracteres, ~500 tokens — teto garantido por teste). Por isso
// o servidor é OPCIONAL e o setup só o registra com `--mcp`.
//
// Protocolo: JSON-RPC 2.0, uma mensagem por linha em stdin/stdout. Nada além de mensagens do protocolo
// pode sair em stdout — qualquer `console.log` de módulo importado vai para stderr.
//
// A raiz do projeto é a do processo (o cliente inicia o servidor na pasta do projeto) ou a indicada
// por CONTEXT_TOOLS_PROJECT_DIR/CLAUDE_PROJECT_DIR. Caminhos recebidos nunca saem dessa raiz.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const { resolveRoot, loadConfig, isMain, sanitizeModelText } = await import('./lib/roots.mjs');
const { makeT, detectLang } = await import('./lib/i18n.mjs');
const { recordMetric } = await import('./lib/telemetry.mjs');
const { buildIndex, reportOne } = await import('./symbols.mjs');
const { findReferences, formatReferences } = await import('./refs.mjs');
const { buildImpact, formatImpact } = await import('./impact.mjs');
const { buildOverview, formatOverview } = await import('./overview.mjs');
const { outlineReport } = await import('./outline.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try { return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
})();
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const leitura = { readOnlyHint: true, openWorldHint: false };
/** Fonte única das ferramentas expostas. Descrições curtas de propósito: entram em toda requisição. */
export const TOOLS = [
  {
    name: 'find_symbol',
    description: 'Where a function, class, method, type or SQL table is defined in this project: file and line range of the definition, not every textual mention. Use before grep.',
    inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: 'One or more names' }, all: { type: 'boolean', description: 'Include partial matches' } }, required: ['names'] },
    annotations: leitura,
  },
  {
    name: 'references',
    description: 'Uses of a name outside its definition, each with the function that contains it. Comments and strings excluded. By name, not by type.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    annotations: leitura,
  },
  {
    name: 'impact',
    description: 'Before changing a symbol or file: its uses, files that historically change with it (git), related tests, and the written docs that cite it with whether they are up to date.',
    inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'Symbol name or project-relative file path' }, budget: { type: 'integer', description: 'Output budget in characters (default 2000)' } }, required: ['target'] },
    annotations: leitura,
  },
  {
    name: 'outline',
    description: 'Line-to-symbol map of one file (sections for Markdown), for files too large to read whole. A filter returns only matching symbols.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Project-relative path' }, filter: { type: 'string', description: 'Case-insensitive regex' } }, required: ['file'] },
    annotations: leitura,
  },
  {
    name: 'overview',
    description: 'First-minute panorama of the project from code and git: main areas, most changed files, large files, strongest co-changes, test command, written knowledge.',
    inputSchema: { type: 'object', properties: {} },
    annotations: leitura,
  },
];

const INSTRUCTIONS = 'Code navigation and project knowledge for this repository. Answers are generated on the spot and say when they do not know — then fall back to text search.';

function projectRoot() {
  return resolveRoot([]);
}

/** Caminho recebido do cliente, dentro da raiz — ou null. */
function dentroDaRaiz(root, file) {
  const abs = isAbsolute(file) ? resolve(file) : resolve(root, file);
  const rel = relative(root, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? abs : null;
}

const texto = (s) => String(s ?? '');
const arg = (args, name) => (args && typeof args === 'object' ? args[name] : undefined);

/** Executa uma ferramenta e devolve { text, isError }. Nunca lança. */
export function callTool(name, args = {}, root = projectRoot()) {
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  try {
    if (name === 'find_symbol') {
      const nomes = [].concat(arg(args, 'names') ?? arg(args, 'name') ?? []).map(texto).filter(Boolean).slice(0, 20);
      if (!nomes.length) return { text: 'names is required', isError: true };
      const index = buildIndex(root, cfg, {});
      if (!index.fileCount) return { text: t('sym.none', { root }) };
      const blocos = nomes.map((q) => reportOne(q, index, { wantAll: Boolean(arg(args, 'all')), ms: null, t }).join('\n'));
      return { text: blocos.join('\n\n') };
    }
    if (name === 'references') {
      const nome = texto(arg(args, 'name'));
      if (!nome) return { text: 'name is required', isError: true };
      return { text: formatReferences(findReferences(root, nome, { cfg }), t).join('\n') };
    }
    if (name === 'impact') {
      const alvo = texto(arg(args, 'target'));
      if (!alvo) return { text: 'target is required', isError: true };
      const budget = Number(arg(args, 'budget')) || undefined;
      return { text: formatImpact(buildImpact(root, alvo, { cfg }), t, budget).join('\n') };
    }
    if (name === 'outline') {
      const file = texto(arg(args, 'file'));
      const abs = file && dentroDaRaiz(root, file);
      if (!abs) return { text: `file must be a path inside the project: ${sanitizeModelText(file, 160)}`, isError: true };
      const filtro = arg(args, 'filter');
      return { text: outlineReport(abs, filtro ? texto(filtro) : undefined, t).lines.join('\n') };
    }
    if (name === 'overview') {
      return { text: formatOverview(buildOverview(root, { cfg }), t).join('\n') };
    }
    return { text: `unknown tool: ${sanitizeModelText(name, 80)}`, isError: true };
  } catch (e) {
    return { text: `context-tools ${sanitizeModelText(name, 40)} failed: ${sanitizeModelText(e?.message || e, 300)} — fall back to text search`, isError: true };
  }
}

/** Uma mensagem JSON-RPC → resposta (ou null para notificação). Exportado para teste. */
export function handleMessage(msg, root = projectRoot()) {
  const id = msg && Object.hasOwn(msg, 'id') ? msg.id : undefined;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
  const notificacao = id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const pedida = msg.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(pedida) ? pedida : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'context-tools', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return notificacao ? null : ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const nome = msg.params?.name;
      const started = Date.now();
      const { text, isError } = callTool(nome, msg.params?.arguments || {}, root);
      recordMetric(root, 'mcp', { tool: sanitizeModelText(nome, 40), durationMs: Date.now() - started, error: Boolean(isError) });
      return ok({ content: [{ type: 'text', text }], isError: Boolean(isError) });
    }
    default:
      if (notificacao) return null;   // notifications/initialized, notifications/cancelled…
      return fail(-32601, `Method not found: ${sanitizeModelText(msg.method, 80)}`);
  }
}

function serve() {
  // stdout é do protocolo: qualquer console.log de módulo do projeto vai para stderr.
  console.log = (...args) => process.stderr.write(`${args.join(' ')}\n`);
  const root = projectRoot();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const enviar = (obj) => { if (obj) process.stdout.write(`${JSON.stringify(obj)}\n`); };
  rl.on('line', (linha) => {
    if (!linha.trim()) return;
    let msg;
    try { msg = JSON.parse(linha); } catch {
      enviar({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(msg)) {
      const respostas = msg.map((m) => handleMessage(m, root)).filter(Boolean);
      if (respostas.length) enviar(respostas);
      return;
    }
    enviar(handleMessage(msg, root));
  });
  rl.on('close', () => process.exit(0));
}

if (isMain(import.meta.url)) serve();
