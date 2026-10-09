// Sugestão de registro para investigações que só LERAM código.
//
// A revisão de mapas e documentos do `Stop` só dispara quando a sessão edita arquivos. Uma sessão
// de pergunta e resposta ("onde o sistema grava este campo?") pode atravessar cinco
// units, reconstruir um fluxo inteiro e terminar sem deixar nada para a próxima — que refaz tudo.
//
// Fonte: a transcrição que o próprio host grava em disco (Claude: `<sessão>.jsonl`; Codex: o
// `rollout-*.jsonl` entregue em `transcript_path`). Tudo local e offline: nenhum modelo, nenhuma
// rede, e nada é escrito em mapa ou documento. O máximo que isto faz é UMA linha para o usuário,
// uma vez por sessão; quem decide registrar é ele.
//
// Regra desta lib, a mesma de `sessao.mjs`: nunca lançar. Formato de transcrição mudado, arquivo
// ausente ou estado corrompido viram silêncio. Falso negativo custa uma sugestão; falso positivo
// ensina o usuário a ignorar a categoria inteira.

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { HISTORY_CODE_RE, isIgnoredPath, safe, sanitizeModelText, stateDir, statePath } from './roots.mjs';

/** Arquivos de código distintos, sem cobertura, para valer uma sugestão. */
export const MIN_UNCOVERED_FILES = 3;
/** ...espalhados por pelo menos este número de pastas: três arquivos irmãos são uma consulta, não um fluxo. */
export const MIN_UNCOVERED_DIRS = 2;

const MAX_READS = 300;
const CHUNK_BYTES = 8 * 1024 * 1024;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 50;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'shell_command', 'exec_command', 'container.exec']);
// Só linhas que podem conter chamada de ferramenta passam pelo JSON.parse: o resto (mensagens,
// raciocínio, contagem de tokens) é a maior parte do arquivo e não informa nada aqui.
const CALL_HINT = /"tool_use"|"custom_tool_call"|"function_call"/;
const STRING_LITERAL = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60`;
const EXEC_ARG_RE = new RegExp(String.raw`\b(cmd|workdir)"?\s*:\s*(${STRING_LITERAL})`, 'g');
const PATCH_CALL_RE = new RegExp(String.raw`apply_patch\(\s*(${STRING_LITERAL})`, 'g');
const PATCH_FILE_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$/m;
const TOKEN_RE = /'([^']*)'|"([^"]*)"|([^\s;|,()<>&]+)/g;

const key = (value) => {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

function decodeLiteral(literal) {
  if (literal.startsWith('"')) {
    const parsed = safe(() => JSON.parse(literal), null);
    if (typeof parsed === 'string') return parsed;
  }
  return literal.slice(1, -1).replace(/\\(.)/g, '$1');
}

/** Caminhos de código citados num comando de terminal. Só candidatos: quem confirma é `accept`. */
export function pathsInCommand(command) {
  const out = [];
  for (const m of String(command || '').matchAll(TOKEN_RE)) {
    const token = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (token && HISTORY_CODE_RE.test(token)) out.push(token);
  }
  return out;
}

/**
 * Eventos de leitura e edição de UMA linha de transcrição, nos dois formatos.
 * Devolve `{ reads: [{ path, base }], edited: boolean }`; `base` é o diretório do comando, quando
 * o host o informa.
 */
export function eventsFromLine(record) {
  const reads = [];
  let edited = false;
  const editOf = (path) => { if (HISTORY_CODE_RE.test(String(path || '').trim())) edited = true; };

  // Claude: `assistant` com blocos `tool_use`.
  const content = record?.type === 'assistant' && Array.isArray(record.message?.content) ? record.message.content : [];
  for (const block of content) {
    if (!block || block.type !== 'tool_use') continue;
    const input = block.input || {};
    if (EDIT_TOOLS.has(block.name)) editOf(input.file_path || input.notebook_path);
    else if (block.name === 'Read' && input.file_path) reads.push({ path: input.file_path });
    else if (block.name === 'Grep' && typeof input.path === 'string') reads.push({ path: input.path });
    else if (SHELL_TOOLS.has(block.name)) for (const path of pathsInCommand(input.command)) reads.push({ path });
  }

  // Codex: `response_item` com `custom_tool_call` (formato atual, JS que chama `tools.*`) ou
  // `function_call` (formato antigo, argumentos em JSON).
  const payload = record?.type === 'response_item' ? record.payload : null;
  if (payload?.type === 'custom_tool_call') {
    const input = String(payload.input || '');
    if (payload.name === 'apply_patch') editOf(input.match(PATCH_FILE_RE)?.[1]);
    for (const m of input.matchAll(PATCH_CALL_RE)) editOf(decodeLiteral(m[1]).match(PATCH_FILE_RE)?.[1]);
    // `{ cmd: "...", workdir: "..." }`: o `workdir` vem depois do `cmd` a que pertence.
    let pending = [];
    for (const m of input.matchAll(EXEC_ARG_RE)) {
      const value = decodeLiteral(m[2]);
      if (m[1] === 'cmd') {
        pending = pathsInCommand(value).map((path) => ({ path }));
        reads.push(...pending);
      } else {
        for (const item of pending) item.base = value;
        pending = [];
      }
    }
  } else if (payload?.type === 'function_call') {
    const args = typeof payload.arguments === 'string' ? safe(() => JSON.parse(payload.arguments), {}) : (payload.arguments || {});
    if (payload.name === 'apply_patch') editOf(String(args.input || args.patch || '').match(PATCH_FILE_RE)?.[1]);
    else if (SHELL_TOOLS.has(payload.name)) {
      const command = Array.isArray(args.command) ? args.command.join(' ') : (args.command ?? args.cmd);
      const base = typeof (args.workdir ?? args.cwd) === 'string' ? (args.workdir ?? args.cwd) : undefined;
      for (const path of pathsInCommand(command)) reads.push({ path, base });
    }
  }
  return { reads, edited };
}

/** Linhas completas a partir de `offset`, em blocos, sem reler o que já foi visto. */
function readNewLines(path, offset, onLine) {
  const fd = safe(() => openSync(path, 'r'), null);
  if (fd == null) return offset;
  try {
    const size = fstatSync(fd).size;
    let position = size < offset ? 0 : offset;   // arquivo encolheu: transcrição foi trocada
    while (position < size) {
      const length = Math.min(CHUNK_BYTES, size - position);
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, position);
      const end = buffer.subarray(0, read).lastIndexOf(10);
      if (end < 0) {
        // Uma linha maior que o bloco: pula até o fim dela em vez de travar a leitura.
        if (read < CHUNK_BYTES) break;
        position += read;
        continue;
      }
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) onLine(line);
      position += end + 1;
    }
    return position;
  } finally { safe(() => closeSync(fd), null); }
}

function loadState(path) {
  const state = safe(() => JSON.parse(readFileSync(path, 'utf8')), null);
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

function saveState(root, path, state) {
  const now = Date.now();
  const entries = Object.entries(state)
    .filter(([, value]) => value && now - (value.at || 0) < STATE_TTL_MS)
    .sort(([, a], [, b]) => (b.at || 0) - (a.at || 0))
    .slice(0, MAX_SESSIONS);
  safe(() => { mkdirSync(stateDir(root), { recursive: true }); writeFileSync(path, JSON.stringify(Object.fromEntries(entries))); }, null);
}

/**
 * Atualiza o acumulado da sessão com o que a transcrição ganhou desde o último `Stop`.
 * `reads` guarda caminhos relativos à raiz, só de arquivos que existem dentro dela.
 */
export function scanSession(root, entry, transcriptPath) {
  const rootKey = key(resolve(root));
  const stateKey = key(stateDir(root));
  const reads = new Set(entry.reads || []);
  let edited = entry.edited === true;
  const accept = (path, base) => {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(base && isAbsolute(base) ? base : root, path);
    const absoluteKey = key(absolute);
    if (!absoluteKey.startsWith(`${rootKey}/`) || absoluteKey.startsWith(`${stateKey}/`)) return;
    const rel = relative(root, absolute).replace(/\\/g, '/');
    if (!HISTORY_CODE_RE.test(rel) || isIgnoredPath(rel)) return;
    if (!safe(() => statSync(absolute).isFile(), false)) return;
    if (reads.size < MAX_READS) reads.add(rel);
  };
  const offset = readNewLines(transcriptPath, entry.offset || 0, (line) => {
    if (!CALL_HINT.test(line)) return;
    const record = safe(() => JSON.parse(line), null);
    if (!record) return;
    const events = safe(() => eventsFromLine(record), null);
    if (!events) return;
    if (events.edited) edited = true;
    for (const { path, base } of events.reads) safe(() => accept(String(path), base), null);
  });
  return { ...entry, transcript: transcriptPath, offset, reads: [...reads], edited, at: Date.now() };
}

/** Um arquivo lido já tem mapa ou documento que o cite? Generoso de propósito: na dúvida, coberto. */
async function coverageChecker(root, cfg) {
  const { contextMapCoverage } = await import('../context-maps.mjs');
  const { buildDocumentationCatalog } = await import('./documentation.mjs');
  const covers = safe(() => contextMapCoverage(root), [])
    .flatMap((map) => map.covers.map((cover) => key(resolve(map.repo, cover))));
  const catalog = safe(() => buildDocumentationCatalog(root, cfg), { documents: [] });
  const references = catalog.documents
    .filter((document) => document.type !== 'index')
    .flatMap((document) => document.references || [])
    .map((reference) => String(reference).replace(/[),.;:]+$/, ''));
  return (rel) => {
    const absoluteKey = key(resolve(root, rel));
    const relKey = key(rel);
    if (covers.some((cover) => absoluteKey === cover || absoluteKey.startsWith(`${cover}/`))) return true;
    return references.some((reference) => {
      if (/^[A-Za-z]:[\\/]/.test(reference) || reference.startsWith('/')) return key(resolve(reference)) === absoluteKey;
      const referenceKey = key(reference.replace(/^\.\//, ''));
      return relKey === referenceKey || relKey.endsWith(`/${referenceKey}`);
    });
  };
}

function message(docs, files) {
  const names = files.slice(0, 4).map((file) => sanitizeModelText(basename(file), 80));
  const list = names.join(', ') + (files.length > names.length ? ` +${files.length - names.length}` : '');
  // A frase pedida ao usuário é a mesma que a skill reconhece: tipo, pasta e índice ficam com o
  // agente, que tem a conversa à frente. Mudar uma sem a outra quebra o atalho em silêncio.
  if (docs.language === 'pt') {
    return `📝 Esta sessão leu ${files.length} arquivos de código sem documentação no contexto (${list}). `
      + 'Se a resposta vai ser útil de novo, diga "registre no contexto". '
      + '(Aviso único nesta sessão; para desligar: "documentation": { "captureHint": false }.)';
  }
  return `📝 This session read ${files.length} code files with no context documentation (${list}). `
    + 'If the answer will be useful again, say "save this to context". '
    + '(Shown once per session; to turn it off: "documentation": { "captureHint": false }.)';
}

/**
 * Chamado no `Stop` dos dois hosts. Devolve a linha para o usuário, ou `''`.
 *
 * Custo: depois da sugestão (ou sem transcrição) sai sem ler nada. Antes dela, lê só os bytes que
 * a transcrição ganhou desde o `Stop` anterior; mapas e documentos só são carregados quando o
 * limiar de leituras já foi atingido.
 */
export async function readCaptureSuggestion(root, cfg = {}, { sessionId, transcriptPath } = {}) {
  const raw = cfg.documentation && typeof cfg.documentation === 'object' ? cfg.documentation : {};
  if (raw.enabled === false || raw.captureHint === false) return '';
  if (!transcriptPath || !existsSync(transcriptPath)) return '';

  const path = statePath(root, '.session-reads.json');
  const state = loadState(path);
  const id = String(sessionId || key(transcriptPath)).slice(0, 200);
  const previous = state[id] && state[id].transcript === transcriptPath ? state[id] : {};
  if (previous.notified) return '';

  const entry = scanSession(root, previous, transcriptPath);
  state[id] = entry;
  let text = '';
  // `checked` evita recarregar mapas e documentos a cada resposta quando nada novo foi lido.
  if (!entry.edited && entry.reads.length >= MIN_UNCOVERED_FILES && entry.reads.length !== previous.checked) {
    state[id] = { ...entry, checked: entry.reads.length };
    const covered = await coverageChecker(root, cfg);
    const uncovered = entry.reads.filter((rel) => !covered(rel));
    const dirs = new Set(uncovered.map((rel) => dirname(rel)));
    if (uncovered.length >= MIN_UNCOVERED_FILES && dirs.size >= MIN_UNCOVERED_DIRS) {
      const { documentationConfig } = await import('./documentation.mjs');
      const docs = documentationConfig(root, cfg);
      if (docs.enabled && docs.valid) {
        text = message(docs, uncovered);
        state[id] = { ...entry, notified: Date.now() };
        const { recordMetric } = await import('./telemetry.mjs');
        safe(() => recordMetric(root, 'read-capture', { outcome: 'suggested', readFiles: entry.reads.length, uncoveredFiles: uncovered.length, uncoveredDirs: dirs.size }), null);
      }
    }
  }
  saveState(root, path, state);
  return text;
}
