// Núcleo da documentação operacional: descoberta, catálogo, inicialização segura e sugestões.
//
// O plugin é responsável pela estrutura e pelo roteamento. O agente continua responsável por
// investigar e escrever regras de negócio. Tudo que é criado aqui é esqueleto ou índice neutro.

import {
  createHash,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { lerDocumento } from './md-hint.mjs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  HISTORY_CODE_RE,
  findRepos,
  lerTexto,
  loadConfig,
  relPath,
  resolveRoot,
  runtimeHost,
  safe,
  sanitizeModelText,
  scriptCommand,
  statePath,
  walk,
} from './roots.mjs';
import { currentSessionId, sessionChangedFiles, sessionStartedAt, sinceRef } from '../context-maps.mjs';
import { compareReviewedSources, fingerprintKey, fingerprintSourcesInRoots, loadFingerprintState, parseSourceFingerprints, rememberFingerprint, sameDigest, saveFingerprintState } from './source-fingerprints.mjs';
import { markdownSectionsForSources } from './markdown-sections.mjs';
import { selectAutomaticReviewCandidates } from './auto-review-candidates.mjs';
import { reviewFinding } from './review-findings.mjs';
import { documentDependencies } from './document-dependencies.mjs';

const CACHE_FORMAT = 2;
const STOP_STATE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_DOCS_IN_PACK = 8;
const MAX_DOC_TEXT = 12000;
const STOP_WORDS = new Set(['a', 'as', 'ao', 'aos', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'o', 'os', 'para', 'por', 'um', 'uma', 'the', 'and', 'of', 'to', 'in', 'on', 'for']);

const LANGUAGE_LAYOUTS = Object.freeze({
  pt: Object.freeze({
    index: '00-indice.md',
    dirs: Object.freeze({ feature: 'features', screen: 'telas', decision: 'decisoes', integration: 'integracoes', database: 'banco' }),
    labels: Object.freeze({ feature: 'feature', screen: 'tela', decision: 'decisão', integration: 'integração', database: 'banco', operational: 'operacional' }),
  }),
  en: Object.freeze({
    index: '00-index.md',
    dirs: Object.freeze({ feature: 'features', screen: 'screens', decision: 'decisions', integration: 'integrations', database: 'database' }),
    labels: Object.freeze({ feature: 'feature', screen: 'screen', decision: 'decision', integration: 'integration', database: 'database', operational: 'operational' }),
  }),
});

const DOC_TYPES = new Set(['feature', 'screen', 'tela', 'decision', 'decisao', 'integration', 'integracao', 'database', 'banco']);

const TEMPLATE_TEXT = Object.freeze({
  pt: Object.freeze({
    feature: (name) => `# Feature: ${name}\n\n## Status do contexto\n\n- Confiabilidade: baixa\n- Fonte principal: A mapear\n- Última revisão: A mapear\n\n## Objetivo\n\nA mapear\n\n## Escopo\n\n- A mapear\n\n## Fora do escopo\n\n- A mapear\n\n## Telas relacionadas\n\n- A mapear\n\n## Arquivos principais\n\n- A mapear\n\n## Banco de dados\n\n- A mapear\n\n## Integrações\n\n- A mapear\n\n## Fluxo principal\n\n- A mapear\n\n## Regras de negócio\n\n- A mapear\n\n## Pontos críticos\n\n- A mapear\n\n## Arquivos somente leitura\n\n- A mapear\n\n## Decisões técnicas relacionadas\n\n- A mapear\n\n## Histórico de atualização\n\n- ${today()} : Criação do documento. Motivo: A mapear.\n`,
    screen: (name) => `# Tela: ${name}\n\n## Status do contexto\n\n- Confiabilidade: baixa\n- Fonte principal: A mapear\n- Última revisão: A mapear\n\n## Arquivos\n\n- .pas: A mapear\n- .dfm: A mapear\n- Outras units relacionadas: A mapear\n\n## Feature relacionada\n\nA mapear\n\n## Objetivo da tela\n\nA mapear\n\n## Eventos importantes\n\n- A mapear\n\n## Datasets/queries\n\n- A mapear\n\n## Regras específicas\n\n- A mapear\n\n## Telas chamadas por esta tela\n\n- A mapear\n\n## Chamado por\n\n- A mapear\n\n## Status somente leitura\n\nA mapear\n\n## Pontos de atenção\n\n- A mapear\n\n## Histórico de atualização\n\n- ${today()} : Criação do documento. Motivo: A mapear.\n`,
    decision: (name) => `# Decisão técnica: ${name}\n\n## Data\n\n${today()}\n\n## Status do contexto\n\n- Confiabilidade: baixa\n- Fonte principal: A mapear\n\n## Contexto\n\nA mapear\n\n## Decisão\n\nA mapear\n\n## Motivo\n\nA mapear\n\n## Impacto\n\n- A mapear\n\n## Riscos\n\n- A mapear\n\n## Alternativas consideradas\n\n- A mapear\n\n## Referências\n\n- A mapear\n`,
    integration: (name) => `# Integração: ${name}\n\n## Status do contexto\n\n- Confiabilidade: baixa\n- Fonte principal: A mapear\n- Última revisão: A mapear\n\n## Objetivo\n\nA mapear\n\n## Escopo\n\n- A mapear\n\n## Sistemas envolvidos\n\n- A mapear\n\n## Fluxo\n\n- A mapear\n\n## Contratos e referências\n\n- A mapear\n\n## Riscos e pendências\n\n- A mapear\n\n## Histórico de atualização\n\n- ${today()} : Criação do documento. Motivo: A mapear.\n`,
    database: (name) => `# Banco de dados: ${name}\n\n## Status do contexto\n\n- Confiabilidade: baixa\n- Fonte principal: A mapear\n- Última revisão: A mapear\n\n## Objetivo\n\nA mapear\n\n## Tabelas e objetos\n\n- A mapear\n\n## Relacionamentos\n\n- A mapear\n\n## Regras e impactos\n\n- A mapear\n\n## Scripts e referências\n\n- A mapear\n\n## Riscos\n\n- A mapear\n\n## Histórico de atualização\n\n- ${today()} : Criação do documento. Motivo: A mapear.\n`,
  }),
  en: Object.freeze({
    feature: (name) => `# Feature: ${name}\n\n## Context status\n\n- Confidence: low\n- Primary source: To map\n- Last reviewed: To map\n\n## Objective\n\nTo map\n\n## Scope\n\n- To map\n\n## Out of scope\n\n- To map\n\n## Related screens\n\n- To map\n\n## Main files\n\n- To map\n\n## Database\n\n- To map\n\n## Integrations\n\n- To map\n\n## Main flow\n\n- To map\n\n## Business rules\n\n- To map\n\n## Critical points\n\n- To map\n\n## Readonly files\n\n- To map\n\n## Related technical decisions\n\n- To map\n\n## Update history\n\n- ${today()} : Document created. Reason: To map.\n`,
    screen: (name) => `# Screen: ${name}\n\n## Context status\n\n- Confidence: low\n- Primary source: To map\n- Last reviewed: To map\n\n## Files\n\n- Source: To map\n- Form: To map\n- Other related units: To map\n\n## Related feature\n\nTo map\n\n## Screen objective\n\nTo map\n\n## Important events\n\n- To map\n\n## Datasets/queries\n\n- To map\n\n## Specific rules\n\n- To map\n\n## Screens called by this screen\n\n- To map\n\n## Called by\n\n- To map\n\n## Readonly status\n\nTo map\n\n## Attention points\n\n- To map\n\n## Update history\n\n- ${today()} : Document created. Reason: To map.\n`,
    decision: (name) => `# Technical decision: ${name}\n\n## Date\n\n${today()}\n\n## Context status\n\n- Confidence: low\n- Primary source: To map\n\n## Context\n\nTo map\n\n## Decision\n\nTo map\n\n## Reason\n\nTo map\n\n## Impact\n\n- To map\n\n## Risks\n\n- To map\n\n## Alternatives considered\n\n- To map\n\n## References\n\n- To map\n`,
    integration: (name) => `# Integration: ${name}\n\n## Context status\n\n- Confidence: low\n- Primary source: To map\n- Last reviewed: To map\n\n## Objective\n\nTo map\n\n## Scope\n\n- To map\n\n## Systems involved\n\n- To map\n\n## Flow\n\n- To map\n\n## Contracts and references\n\n- To map\n\n## Risks and pending items\n\n- To map\n\n## Update history\n\n- ${today()} : Document created. Reason: To map.\n`,
    database: (name) => `# Database: ${name}\n\n## Context status\n\n- Confidence: low\n- Primary source: To map\n- Last reviewed: To map\n\n## Objective\n\nTo map\n\n## Tables and objects\n\n- To map\n\n## Relationships\n\n- To map\n\n## Rules and impacts\n\n- To map\n\n## Scripts and references\n\n- To map\n\n## Risks\n\n- To map\n\n## Update history\n\n- ${today()} : Document created. Reason: To map.\n`,
  }),
});

const INDEX_TEXT = Object.freeze({
  pt: (dirs) => `# Índice da documentação operacional\n\nEste arquivo é o ponto de entrada da documentação operacional deste projeto. Leia primeiro este índice e carregue apenas os documentos relacionados à tarefa.\n\n## Estrutura padrão\n\n- \`${dirs.feature}/\`: features e fluxos funcionais.\n- \`${dirs.screen}/\`: telas, forms e eventos.\n- \`${dirs.decision}/\`: decisões técnicas adotadas.\n- \`${dirs.integration}/\`: integrações e contratos.\n- \`${dirs.database}/\`: banco, tabelas, objetos e scripts.\n\n## Autoridade\n\nA documentação orienta o roteamento, mas não substitui o código, os forms, o SQL, o banco ou os metadados técnicos. Conteúdo marcado como \`A mapear\` não é regra confirmada.\n\n## Como atualizar\n\nO agente deve investigar antes de preencher regras, registrar fonte, confiabilidade e última revisão, e preservar documentos existentes.\n`,
  en: (dirs) => `# Operational documentation index\n\nThis file is the entry point for this project's operational documentation. Read this index first and load only documents related to the task.\n\n## Standard structure\n\n- \`${dirs.feature}/\`: features and functional flows.\n- \`${dirs.screen}/\`: screens, forms and events.\n- \`${dirs.decision}/\`: adopted technical decisions.\n- \`${dirs.integration}/\`: integrations and contracts.\n- \`${dirs.database}/\`: database, tables, objects and scripts.\n\n## Authority\n\nDocumentation routes investigation but does not replace code, forms, SQL, database or technical metadata. Content marked \`To map\` is not a confirmed rule.\n\n## Updating\n\nThe agent must investigate before filling rules, record source, confidence and last review, and preserve existing documents.\n`,
});

const HISTORY_CODE_EXTENSIONS = HISTORY_CODE_RE.source
  .slice(HISTORY_CODE_RE.source.indexOf('(') + 1, HISTORY_CODE_RE.source.lastIndexOf(')'))
  .split('|');
const REF_EXTENSIONS = [...new Set([...HISTORY_CODE_EXTENSIONS, 'md', 'json', 'ini', 'xml', 'fmx'])].join('|');
const REF_RE = new RegExp(`(?:[A-Za-z]:\\\\[^\`"'\\r\\n]+|[\\w.\\\\/-]+\\.(?:${REF_EXTENSIONS}))`, 'gi');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeLanguage(value) {
  const text = String(value || '').toLowerCase();
  if (text.startsWith('pt')) return 'pt';
  if (text.startsWith('en')) return 'en';
  return null;
}

function pathInside(root, candidate) {
  const abs = resolve(root, candidate);
  const rel = relative(resolve(root), abs);
  if (rel === '') return abs;
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return null;
  return abs;
}

function inferLanguage(rootPath, cfg, requested) {
  const explicit = normalizeLanguage(requested);
  if (explicit) return explicit;
  if (existsSync(join(rootPath, '00-indice.md'))) return 'pt';
  if (existsSync(join(rootPath, '00-index.md'))) return 'en';
  const configured = normalizeLanguage(cfg.lang) || normalizeLanguage(process.env.CONTEXT_TOOLS_LANG);
  return configured || 'en';
}

export function documentationConfig(root = resolveRoot(), cfg = loadConfig(root)) {
  const raw = cfg.documentation && typeof cfg.documentation === 'object' ? cfg.documentation : {};
  const rootValue = typeof raw.root === 'string' && raw.root.trim() ? raw.root.trim() : 'ai-context';
  const rootPath = pathInside(root, rootValue);
  if (!rootPath) return { enabled: raw.enabled !== false, valid: false, error: 'documentation.root points outside the project' };
  const language = inferLanguage(rootPath, cfg, raw.language);
  const layout = LANGUAGE_LAYOUTS[language];
  return {
    enabled: raw.enabled !== false,
    autoInit: raw.autoInit !== false,
    valid: true,
    language,
    rootValue: relative(root, rootPath).replace(/\\/g, '/') || '.',
    rootPath,
    indexPath: join(rootPath, layout.index),
    dirs: layout.dirs,
    layout,
  };
}

function docTypeFor(relativePath, config) {
  const first = String(relativePath).replace(/\\/g, '/').split('/')[0];
  for (const [type, dir] of Object.entries(config.dirs)) if (first === dir) return type;
  return first === config.layout.index ? 'index' : 'operational';
}

export function readMetadata(text) {
  text = text.replace(/^```[^\r\n]*\r?\n[\s\S]*?^```[^\r\n]*$/gm, '').replace(/^~~~[^\r\n]*\r?\n[\s\S]*?^~~~[^\r\n]*$/gm, '');
  const find = (patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1].trim();
    }
    return null;
  };
  const sourceFingerprintsValue = find([/^\s*-?\s*(?:source_fingerprints|source fingerprints)\s*:\s*(.+)$/im]);
  const sourceFingerprints = parseSourceFingerprints(sourceFingerprintsValue);
  return {
    confidence: find([/^\s*-?\s*(?:Confiabilidade|Confidence)\s*:\s*(.+)$/im, /^\s*confidence\s*:\s*(.+)$/im]),
    source: find([/^\s*-?\s*(?:Fonte principal|Primary source|Source)\s*:\s*(.+)$/im, /^\s*source\s*:\s*(.+)$/im]),
    lastReviewed: find([/^\s*-?\s*(?:Ultima revisao|Última revisão|Last reviewed)\s*:\s*(.+)$/im, /^\s*last_reviewed\s*:\s*(.+)$/im]),
    sourceDigest: find([/^\s*-?\s*(?:source_digest|source digest)\s*:\s*(.+)$/im]),
    sourceFingerprints: sourceFingerprints.sources,
    sourceFingerprintsPresent: sourceFingerprints.present,
    sourceFingerprintsValid: sourceFingerprints.valid,
    maintenance: find([/^\s*-?\s*maintenance\s*:\s*(.+)$/im]),
    reviewDependencies: find([/^\s*-?\s*review_dependencies\s*:\s*(.+)$/im]),
    dependencyFingerprints: find([/^\s*-?\s*dependency_fingerprints\s*:\s*(.+)$/im]),
    reviewSources: find([/^\s*-?\s*review_sources\s*:\s*(.+)$/im]),
  };
}

function parseDocument(file, root, config) {
  const decoded = safe(() => lerDocumento(file), null);
  const text = decoded?.text || '';
  const rel = relPath(root, file);
  const relToDocs = relPath(config.rootPath, file);
  const st = safe(() => statSync(file), { mtimeMs: 0, size: 0 });
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(file, extname(file));
  const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 80);
  const metadata = readMetadata(text);
  if (!decoded) metadata.unavailable = true;
  let references = [...new Set([...text.matchAll(REF_RE)].map((m) => m[0].trim()).filter(Boolean))];
  if (references.length > 120) { metadata.invalidReviewSources = true; references = references.slice(0, 120); }
  if (metadata.reviewSources) {
    try {
      const declared = JSON.parse(metadata.reviewSources);
      if (!Array.isArray(declared) || declared.length > 120 || declared.some((value) => typeof value !== 'string' || !HISTORY_CODE_RE.test(value))) throw new Error('invalid review_sources');
      references = [...new Set(declared)];
      metadata.invalidReviewSources = false;
    } catch { metadata.invalidReviewSources = true; }
  }
  return {
    path: rel.replace(/\\/g, '/'),
    type: docTypeFor(relToDocs, config),
    title: sanitizeModelText(title, 180),
    headings,
    references,
    metadata,
    text: text.slice(0, MAX_DOC_TEXT),
    searchText: normalizeSearchText(`${rel}\n${title}\n${headings.join('\n')}\n${references.join('\n')}\n${text}`),
    m: st.mtimeMs,
    s: st.size,
  };
}

function normalizeSearchText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function documentationFiles(config) {
  if (!existsSync(config.rootPath)) return [];
  const files = [];
  walk(config.rootPath, /\.md$/i, files);
  return files;
}

function cachePath(root) {
  return statePath(root, '.documentation-cache.json');
}

function loadCache(root) {
  return safe(() => JSON.parse(readFileSync(cachePath(root), 'utf8')), null);
}

function saveCache(root, config, entries) {
  const payload = JSON.stringify({
    format: CACHE_FORMAT,
    root: config.rootPath,
    language: config.language,
    entries,
  });
  const destination = cachePath(root);
  const dir = dirname(destination);
  const temp = join(dir, `.documentation-cache.${process.pid}.tmp`);
  return safe(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, payload, 'utf8');
    renameSync(temp, destination);
    return true;
  }, false);
}

export function buildDocumentationCatalog(root = resolveRoot(), cfg = loadConfig(root), opts = {}) {
  const config = documentationConfig(root, cfg);
  if (!config.enabled) return { status: 'disabled', config, documents: [], reused: 0, reread: 0 };
  if (!config.valid) return { status: 'invalid', config, documents: [], reused: 0, reread: 0 };
  if (!existsSync(config.rootPath)) return { status: 'missing', config, documents: [], reused: 0, reread: 0 };

  const stored = opts.fresh ? null : loadCache(root);
  const previous = stored?.format === CACHE_FORMAT ? stored : null;
  const byPath = new Map(Array.isArray(previous?.entries) ? previous.entries.map((entry) => [entry.path, entry]) : []);
  const documents = [];
  let reused = 0;
  let reread = 0;
  for (const file of documentationFiles(config)) {
    const rel = relPath(root, file).replace(/\\/g, '/');
    const st = safe(() => statSync(file), null);
    const old = byPath.get(rel);
    if (st && old && old.m === st.mtimeMs && old.s === st.size && old.type === docTypeFor(relPath(config.rootPath, file), config)) {
      documents.push(old);
      reused++;
    } else {
      documents.push(parseDocument(file, root, config));
      reread++;
    }
  }
  if (opts.persist !== false) saveCache(root, config, documents);
  return { status: 'ready', config, documents, reused, reread };
}

/** Read-only source-reference lookup for the explain command; it deliberately bypasses cache writes. */
export function documentationReferencesForFile(root = resolveRoot(), cfg = loadConfig(root), repositoryName, relativeFile) {
  const catalog = buildDocumentationCatalog(root, cfg, { fresh: true, persist: false });
  if (catalog.status !== 'ready') return { status: catalog.status, documents: [] };
  const repos = findRepos(root, { requireGit: false, cfg });
  const targetRepo = repos.find((repo) => repo.name === repositoryName);
  if (!targetRepo) return { status: 'repository-unavailable', documents: [] };
  const target = resolve(targetRepo.path, relativeFile);
  const targetKey = process.platform === 'win32' ? target.toLowerCase() : target;
  const findByBasename = buscaPorNome(repos);
  const documents = [];
  for (const document of catalog.documents) {
    if (document.type === 'index') continue;
    const matches = referencedCodeFiles(document, root, repos, findByBasename)
      .some((source) => {
        const sourcePath = resolve(source.repo.path, source.file);
        const sourceKey = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath;
        return sourceKey === targetKey;
      });
    if (!matches) continue;
    documents.push({
      path: document.path,
      title: document.title,
      type: document.type,
      lastReviewed: document.metadata.lastReviewed || null,
      sourceDigestPresent: Boolean(document.metadata.sourceDigest),
      sourceFingerprintsPresent: document.metadata.sourceFingerprintsPresent,
      maintenance: document.metadata.maintenance || (document.type === 'decision' ? 'historical' : 'live'),
    });
  }
  return { status: 'ready', documents };
}

function queryTerms(query) {
  return [...new Set(normalizeSearchText(query).split(/[^a-z0-9_./-]+/).filter((term) => term.length >= 2 && !STOP_WORDS.has(term)))];
}

function scoreDocument(document, terms) {
  let score = 0;
  const reasons = [];
  const fields = [
    ['title', normalizeSearchText(document.title), 12],
    ['path', normalizeSearchText(document.path), 10],
    ['references', normalizeSearchText(document.references.join('\n')), 7],
    ['headings', normalizeSearchText(document.headings.join('\n')), 5],
    ['content', document.searchText, 1],
  ];
  for (const term of terms) {
    for (const [name, value, weight] of fields) {
      if (value.includes(term)) {
        score += weight;
        reasons.push(`${name}:${term}`);
      }
    }
  }
  return { score, reasons: [...new Set(reasons)] };
}

export function searchDocumentation(root, query, cfg = loadConfig(root), opts = {}) {
  const catalog = buildDocumentationCatalog(root, cfg, opts);
  if (catalog.status !== 'ready') return { ...catalog, results: [] };
  const terms = queryTerms(query);
  if (!terms.length) return { ...catalog, results: [] };
  const results = catalog.documents
    .map((document) => ({ document, ...scoreDocument(document, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.document.path.localeCompare(b.document.path))
    .slice(0, opts.limit || MAX_DOCS_IN_PACK);
  return { ...catalog, results };
}

function excerpt(document, terms) {
  const lines = document.text.split(/\r?\n/);
  const wanted = terms.map((term) => normalizeSearchText(term));
  const index = lines.findIndex((line) => wanted.some((term) => normalizeSearchText(line).includes(term)));
  if (index < 0) return document.title;
  return lines.slice(Math.max(0, index - 1), index + 3).join(' ').replace(/\s+/g, ' ').trim();
}

export function documentationEvidence(root, query, cfg = loadConfig(root), opts = {}) {
  const found = searchDocumentation(root, query, cfg, opts);
  const terms = queryTerms(query);
  return found.results.map(({ document, score }) => ({
    kind: 'documentation',
    confidence: document.metadata.confidence || 'declared',
    freshness: document.metadata.lastReviewed && !/^(?:A mapear|To map)$/i.test(document.metadata.lastReviewed)
      ? `reviewed:${document.metadata.lastReviewed}`
      : 'needs-review',
    text: `${document.path} — ${document.title} [${document.type}] — ${excerpt(document, terms)}`,
    file: document.path,
    score,
    documentType: document.type,
  }));
}

function atomicCreate(path, content) {
  if (existsSync(path)) return { created: false, reason: 'exists' };
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  return safe(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    // Avoid replacing a file created by another concurrent agent between the initial check
    // and the rename. The remaining race window is harmless because the target is a skeleton.
    if (existsSync(path)) {
      unlinkSync(temp);
      return { created: false, reason: 'exists' };
    }
    renameSync(temp, path);
    return { created: true };
  }, { created: false, reason: 'write-failed' });
}

export function initializeDocumentation(root = resolveRoot(), cfg = loadConfig(root)) {
  const config = documentationConfig(root, cfg);
  if (!config.enabled) return { status: 'disabled', created: [], existing: [], config };
  if (!config.valid) return { status: 'invalid', created: [], existing: [], config };
  const created = [];
  const existing = [];
  safe(() => mkdirSync(config.rootPath, { recursive: true }), null);
  const targets = [config.indexPath, ...Object.values(config.dirs).map((dir) => join(config.rootPath, dir))];
  for (const target of targets) {
    const isDir = !extname(target);
    if (existsSync(target)) { existing.push(relPath(root, target).replace(/\\/g, '/')); continue; }
    if (isDir) {
      safe(() => { mkdirSync(target, { recursive: true }); created.push(relPath(root, target).replace(/\\/g, '/')); }, null);
      continue;
    }
    const result = atomicCreate(target, INDEX_TEXT[config.language](config.dirs));
    if (result.created) created.push(relPath(root, target).replace(/\\/g, '/'));
  }
  return { status: 'ready', created, existing, config };
}

function canonicalType(type) {
  const value = String(type || '').toLowerCase();
  const aliases = { tela: 'screen', decisao: 'decision', integracao: 'integration', banco: 'database' };
  return aliases[value] || value;
}

function safeDocumentName(value) {
  const original = String(value || '').trim();
  if (!original || original.length > 120) return null;
  const withoutExt = original.replace(/\.md$/i, '');
  const name = withoutExt.replace(/[^A-Za-z0-9À-ÿ._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return name || null;
}

export function createDocumentationDocument(root = resolveRoot(), type, name, cfg = loadConfig(root)) {
  const config = documentationConfig(root, cfg);
  if (!config.enabled) return { status: 'disabled', created: [], config };
  if (!config.valid) return { status: 'invalid', created: [], config };
  const canonical = canonicalType(type);
  const safeName = safeDocumentName(name);
  if (!DOC_TYPES.has(canonical) || !safeName) return { status: 'invalid-input', created: [], config };
  initializeDocumentation(root, cfg);
  const path = join(config.rootPath, config.dirs[canonical], `${safeName}.md`);
  const content = TEMPLATE_TEXT[config.language][canonical](safeName);
  const result = atomicCreate(path, content);
  return {
    status: result.created ? 'created' : (result.reason === 'exists' ? 'exists' : 'write-failed'),
    created: result.created ? [relPath(root, path).replace(/\\/g, '/')] : [],
    path: relPath(root, path).replace(/\\/g, '/'),
    config,
  };
}

function runGit(repo, args) {
  return safe(() => execFileSync('git', ['-C', repo, ...args], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), '');
}

function touchedFiles(repo) {
  if (repo.git) {
    const ref = sinceRef(repo.path);
    const tracked = runGit(repo.path, ['diff', '--name-only', ref]);
    const untracked = runGit(repo.path, ['ls-files', '--others', '--exclude-standard']);
    return [...new Set([...tracked.split('\n'), ...untracked.split('\n')].map((value) => value.trim()).filter((value) => value && HISTORY_CODE_RE.test(value)))];
  }
  const started = sessionStartedAt(repo.path);
  if (started == null) return [];
  return walk(repo.path, HISTORY_CODE_RE).filter((file) => safe(() => statSync(file).mtimeMs >= started, false)).map((file) => relPath(repo.path, file));
}

function normalizePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function documentCoversFile(document, root, file, repoPath) {
  const target = normalizePath(resolve(repoPath, file));
  for (const reference of document.references) {
    const ref = reference.replace(/[),.;]+$/, '');
    if (/^[A-Za-z]:[\\/]/.test(ref)) {
      if (normalizePath(ref) === target) return true;
      continue;
    }
    const candidate = normalizePath(resolve(root, ref));
    if (candidate === target) return true;
    const relTarget = normalizePath(relative(root, resolve(repoPath, file)));
    if (normalizePath(ref) === relTarget || relTarget.endsWith(`/${normalizePath(ref)}`)) return true;
  }
  return false;
}

function stopStatePath(root) {
  return statePath(root, '.documentation-stop-state.json');
}

function shouldReport(root, text) {
  // O Codex limita Stop a uma continuação por turno via stop_hook_active. Não deixe o
  // dedupe de 12h esconder uma pendência que ainda precisa de revisão em uma tarefa futura.
  if (process.env.CONTEXT_TOOLS_HOST === 'codex') return true;
  const signature = createHash('sha256').update(text).digest('hex');
  const previous = safe(() => JSON.parse(readFileSync(stopStatePath(root), 'utf8')), null);
  if (previous && previous.signature === signature && Date.now() - previous.at < STOP_STATE_TTL_MS) return false;
  safe(() => { mkdirSync(dirname(stopStatePath(root)), { recursive: true }); writeFileSync(stopStatePath(root), JSON.stringify({ signature, at: Date.now() })); }, null);
  return true;
}

function dateOnly(value) {
  const day = String(value || '').trim().match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!day) return null;
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day ? day : null;
}

function referencedCodeFiles(document, root, repos, findByBasename) {
  const found = new Map();
  for (const reference of document.references) {
    if (!HISTORY_CODE_RE.test(reference)) continue;
    const explicitPath = isAbsolute(reference) || /[\\/]/.test(reference);
    const missingCandidates = [];
    const candidates = isAbsolute(reference)
      ? [resolve(reference)]
      : [resolve(root, reference), ...repos.map((repo) => resolve(repo.path, reference))];
    let matched = false;
    for (const candidate of candidates) {
      for (const repo of repos) {
        const relativeFile = relative(resolve(repo.path), candidate);
        if (!relativeFile || relativeFile === '..' || relativeFile.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativeFile)) continue;
        const file = relativeFile.replace(/\\/g, '/');
        if (!HISTORY_CODE_RE.test(file)) continue;
        const sourcePath = resolve(repo.path, file);
        const sourceStat = safe(() => statSync(sourcePath), null);
        if (!sourceStat) {
          if (!explicitPath) continue;
          missingCandidates.push({ repo, file, exists: false, mtime: 0, sourcePath });
          continue;
        }
        if (!sourceStat.isFile()) continue;
        found.set(`${resolve(repo.path, file).toLowerCase()}`, {
          repo,
          file,
          exists: true,
          mtime: sourceStat.mtimeMs,
        });
        matched = true;
      }
    }
    // Documentos operacionais às vezes citam só o nome da unit. O audit-docs já considera
    // esse caso resolvido quando o basename existe; a revisão por mtime precisa apontar para a
    // mesma fonte real, em vez de inventar um arquivo com esse nome em cada extraRepo.
    if (!matched) {
      const basenameMatches = findByBasename(basename(reference));
      for (const source of basenameMatches) {
        found.set(`${resolve(source.repo.path, source.file).toLowerCase()}`, source);
      }
      if (!basenameMatches.length) {
        for (const source of missingCandidates) found.set(source.sourcePath.toLowerCase(), source);
      }
    }
  }
  return [...found.values()];
}

/** Fresh source declarations for the metadata writer; does not trust a stored queue manifest. */
export function documentationReviewTarget(root, documentPath, cfg = loadConfig(root)) {
  const config = documentationConfig(root, cfg);
  const path = resolve(root, documentPath);
  const rel = relative(config.rootPath, path);
  if (!config.valid || !rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('document outside documentation root');
  const document = parseDocument(path, root, config);
  if (document.metadata.invalidReviewSources) throw new Error('invalid review_sources');
  const repos = findRepos(root, { requireGit: false, cfg });
  const byName = (name) => repos.flatMap((repo) => walk(repo.path, HISTORY_CODE_RE)
    .filter((file) => basename(file).toLowerCase() === name.toLowerCase())
    .map((path) => ({ repo, file: relPath(repo.path, path).replace(/\\/g, '/'), exists: true, mtime: statSync(path).mtimeMs })));
  return { document, sources: referencedCodeFiles(document, root, repos, byName) };
}

/**
 * Fontes por nome de arquivo, montado só na primeira consulta: documento que cita apenas o nome da
 * unit (`UCadCliente.pas`) aponta para a mesma fonte real que o audit-docs considera resolvida.
 */
function buscaPorNome(repos) {
  let basenameIndex = null;
  return (name) => {
    if (!basenameIndex) {
      basenameIndex = new Map();
      for (const repo of repos) {
        for (const path of walk(repo.path, HISTORY_CODE_RE)) {
          const file = relPath(repo.path, path).replace(/\\/g, '/');
          const sourceStat = safe(() => statSync(path), null);
          if (!sourceStat?.isFile()) continue;
          const key = basename(file).toLowerCase();
          const sources = basenameIndex.get(key) || [];
          sources.push({ repo, file, exists: true, mtime: sourceStat.mtimeMs });
          basenameIndex.set(key, sources);
        }
      }
    }
    return basenameIndex.get(String(name || '').toLowerCase()) || [];
  };
}

function referenceIsStale(document, source) {
  if (!source.exists) return true;
  const reviewed = dateOnly(document.metadata.lastReviewed);
  if (!reviewed) return true;
  const changed = dateOnly(new Date(source.mtime).toISOString());
  return changed !== null && changed >= reviewed;
}

export function documentationStopReport(root = resolveRoot(), cfg = loadConfig(root), options = {}) {
  const sessionOnly = options.sessionOnly === true;
  const config = documentationConfig(root, cfg);
  if (!config.enabled || !config.valid) { options.onIssue?.({ kind: config.enabled ? 'invalid-documentation-config' : 'documentation-disabled' }); return ''; }
  const catalog = buildDocumentationCatalog(root, cfg);
  if (catalog.status !== 'ready') { options.onIssue?.({ kind: 'documentation-unavailable', status: catalog.status }); return ''; }
  const repos = findRepos(root, { requireGit: false, cfg });
  const fingerprintState = loadFingerprintState(root);
  const stale = [];
  const missing = [];
  const missingByRepo = new Map();
  const reportedStale = new Set();
  const fingerprintStatus = new Map();
  const sessionFilesByRepo = new Map();
  const filesChangedThisSession = (repoPath) => {
    const key = resolve(repoPath);
    if (!sessionFilesByRepo.has(key)) {
      const changed = options.sessionFiles ? options.sessionFiles(key) : sessionChangedFiles(key, HISTORY_CODE_RE);
      sessionFilesByRepo.set(key, changed === null ? null : new Set(changed.map(normalizePath)));
    }
    return sessionFilesByRepo.get(key);
  };
  const sourceChangedThisSession = (source) => {
    const changed = filesChangedThisSession(source.repo.path);
    return changed?.has(normalizePath(source.file)) || false;
  };
  let fingerprintStateChanged = false;
  const findByBasename = buscaPorNome(repos);
  for (const document of catalog.documents) {
    if (document.type === 'index') continue;
    if (document.metadata.invalidReviewSources) { options.onIssue?.({ kind: 'invalid-review-sources', document: document.path }); continue; }
    if (document.metadata.unavailable) { options.onIssue?.({ kind: 'document-unavailable', document: document.path }); continue; }
    const maintenance = document.metadata.maintenance || (document.type === 'decision' ? 'historical' : 'live');
    if (!['live', 'historical', 'manual'].includes(maintenance)) { options.onIssue?.({ kind: 'invalid-maintenance-policy', document: document.path }); continue; }
    if (maintenance !== 'live') { options.onStatus?.(document.path, 'not-live'); continue; }
    const forced = options.forceDocuments?.has(resolve(root, document.path));
    // Select before resolving basenames or hashing: a quiet Stop must not scan every source
    // referenced by the project's documentation.
    if (sessionOnly && !forced && !repos.some((repo) => {
      const files = filesChangedThisSession(repo.path);
      return files && [...files].some((file) => documentCoversFile(document, root, file, repo.path));
    })) continue;
    const sources = referencedCodeFiles(document, root, repos, findByBasename);
    if (!sources.length) { options.onStatus?.(document.path, 'no-sources'); continue; }
    const fingerprint = fingerprintSourcesInRoots(sources.map((source) => ({
      root: source.repo.path,
      path: resolve(source.repo.path, source.file),
      id: `${source.repo.name}/${source.file}`,
    })), options.fingerprintCache);
    if (fingerprint.markers.length) { options.onStatus?.(document.path, 'unavailable'); options.onIssue?.({ kind: 'source-unavailable', document: document.path, errors: fingerprint.errors }); continue; }
    const dependencies = documentDependencies(document.metadata, fingerprint, options.fingerprintCache);
    if (dependencies.declared && !dependencies.valid) options.onIssue?.({ kind: dependencies.reason, document: document.path });
    const publish = (keys, reason = 'source-changed') => options.onFinding?.(reviewFinding(root, {
      kind: 'document', document: resolve(root, document.path), title: document.title, fingerprint, keys, reason,
      dependencies: dependencies.valid ? dependencies.current : null,
    }));
    const key = `doc:${fingerprintKey(resolve(root, document.path))}`;
    const previous = fingerprintState.entries[key];
    let changedSourceIds = [];
    let isStale = false;
    const trustedDigest = document.metadata.sourceDigest
      || (!document.metadata.sourceFingerprintsPresent ? previous?.digest : null);
    const reviewed = compareReviewedSources(
      fingerprint,
      document.metadata.sourceFingerprintsPresent ? document.metadata.sourceFingerprints : undefined,
      previous,
      trustedDigest,
    );
    const hasLegacyDigest = /^sha256:[a-f\d]{64}$/i.test(document.metadata.sourceDigest || '');
    const digestNeedsSync = hasLegacyDigest
      && !sameDigest(fingerprint, document.metadata.sourceDigest)
      && reviewed.valid && reviewed.metadataComplete;
    if (digestNeedsSync) {
      fingerprintStatus.set(document.path, 'fresh');
      if (!sessionOnly || forced || sources.some(sourceChangedThisSession)) {
        publish(Object.keys(fingerprint.sources), 'digest-sync');
        stale.push(sanitizeModelText(`source_digest: ${fingerprint.digest}; ${document.path}; all per-source fingerprints already match current references; synchronize aggregate metadata only, without re-reviewing code.`, 1200));
      }
      continue;
    }
    if (dependencies.complete || (reviewed.valid && (sameDigest(fingerprint, document.metadata.sourceDigest)
      || (!sessionOnly && previous?.digest === fingerprint.digest)
      || (reviewed.complete && (!sessionOnly || document.metadata.sourceFingerprintsPresent || hasLegacyDigest))))) {
      if (previous?.digest !== fingerprint.digest) {
        rememberFingerprint(fingerprintState, key, fingerprint);
        fingerprintStateChanged = true;
      }
      fingerprintStatus.set(document.path, 'fresh');
      options.onReviewed?.(reviewFinding(root, { kind: 'document', document: resolve(root, document.path), fingerprint, keys: Object.keys(fingerprint.sources), dependencies: dependencies.valid ? dependencies.current : null }));
      continue;
    }
    if (!reviewed.valid) {
      changedSourceIds = Object.keys(fingerprint.sources);
      isStale = true;
    } else if (sessionOnly && !document.metadata.sourceFingerprintsPresent && !hasLegacyDigest) {
      changedSourceIds = sources.filter(sourceChangedThisSession).map((source) => `${source.repo.name}/${source.file}`);
      isStale = changedSourceIds.length > 0;
    } else if (document.metadata.sourceFingerprintsPresent || hasLegacyDigest || previous?.digest) {
      changedSourceIds = reviewed.changed;
      isStale = true;
    } else {
      const staleSources = sessionOnly ? sources.filter(sourceChangedThisSession) : sources.filter((source) => referenceIsStale(document, source));
      if (!staleSources.length) {
        rememberFingerprint(fingerprintState, key, fingerprint);
        fingerprintStateChanged = true;
        fingerprintStatus.set(document.path, 'fresh');
        continue;
      }
      changedSourceIds = staleSources.map((source) => `${source.repo.name}/${source.file}`);
      isStale = true;
    }
    if (!isStale) continue;
    fingerprintStatus.set(document.path, 'stale');
    const sourceById = new Map(sources.map((source) => [`${source.repo.name}/${source.file}`, source]));
    const changedSourceFiles = changedSourceIds.map((id) => sourceById.get(id)).filter(Boolean);
    const scopedSourceFiles = sessionOnly && !forced ? changedSourceFiles.filter(sourceChangedThisSession) : changedSourceFiles;
    if (sessionOnly && !scopedSourceFiles.length) continue;
    publish(scopedSourceFiles.map((source) => `${source.repo.name}/${source.file}`));
    const changedSources = scopedSourceFiles.map((source) => `${source.repo.name}/${source.file}`);
    const list = changedSources.slice(0, 3).join(', ') + (changedSources.length > 3 ? `, +${changedSources.length - 3}` : '');
    const itemKey = `${document.path}|${fingerprint.digest}`.toLowerCase();
    if (reportedStale.has(itemKey)) continue;
    reportedStale.add(itemKey);
    const sections = markdownSectionsForSources(document.text, changedSources, 2);
    const hint = sections.length ? `; relevant sections: ${sections.join('; ')}` : '';
    const sourceFingerprints = Object.fromEntries(scopedSourceFiles.slice(0, 8).map((source) => [
      `${source.repo.name}/${source.file}`,
      fingerprint.sources[`${source.repo.name}/${source.file}`],
    ]));
    const overflow = scopedSourceFiles.length > Object.keys(sourceFingerprints).length
      ? `; ${scopedSourceFiles.length - Object.keys(sourceFingerprints).length} additional source(s) remain pending for a later review`
      : '';
    // Claude: o hash é gravado pelo `ack.mjs` depois da revisão; o modelo não copia SHA-256.
    // O Codex mantém o formato que a fila de revisão automática dele consome.
    if (runtimeHost() !== 'codex') {
      stale.push(sanitizeModelText(`${document.path}; changed: ${list}${overflow}${hint}; after reviewing, record it: ${scriptCommand(root, 'ack.mjs')} ${document.path}`, 600));
      continue;
    }
    stale.push(sanitizeModelText(`source_fingerprints: ${JSON.stringify(sourceFingerprints)}; source_digest: ${fingerprint.digest} (set only when every current reference has a matching per-source fingerprint; otherwise preserve its current value); ${document.path}; changed: ${list}${overflow}${hint}`, 1600));
  }
  for (const repo of repos) {
    const sessionFiles = sessionOnly ? filesChangedThisSession(repo.path) : null;
    const touched = sessionOnly
      ? (sessionFiles ? [...sessionFiles] : [])
      : touchedFiles(repo);
    for (const file of touched) {
      const related = catalog.documents.filter((document) => document.type !== 'index' && documentCoversFile(document, root, file, repo.path));
      if (!related.length) {
        const files = missingByRepo.get(repo.path) || [];
        files.push(file);
        missingByRepo.set(repo.path, files);
      } else {
        const old = related.filter((document) => {
          if (fingerprintStatus.get(document.path) === 'fresh' || fingerprintStatus.get(document.path) === 'stale') return false;
          const source = { repo, file, exists: existsSync(join(repo.path, file)), mtime: safe(() => statSync(join(repo.path, file)).mtimeMs, 0) };
          return referenceIsStale(document, source);
        });
        for (const document of old) {
          const key = `${document.path}|${repo.path}|${file}`.toLowerCase();
          if (reportedStale.has(key)) continue;
          reportedStale.add(key);
          stale.push(sanitizeModelText(`${document.path} (${file})`, 240));
        }
      }
    }
  }
  for (const [repoPath, files] of missingByRepo) {
    const repo = repos.find((item) => item.path === repoPath);
    const selected = sessionOnly
      ? selectAutomaticReviewCandidates(root, repoPath, files, options.sessionId || currentSessionId(), Date.now(), options.onIssue)
      : files;
    const repoName = repo?.name === '.' ? basename(repoPath) : (repo?.name || basename(repoPath));
    if (selected.length && options.onFinding) {
      for (const file of selected) {
        const fingerprint = fingerprintSourcesInRoots([{ root: repoPath, path: resolve(repoPath, file), id: `${repo?.name || '.'}/${file}` }], options.fingerprintCache);
        if (!fingerprint.markers.length) options.onFinding(reviewFinding(root, { kind: 'coverage-document', fingerprint, keys: Object.keys(fingerprint.sources), reason: 'uncovered-sources' }));
        else options.onIssue?.({ kind: 'source-unavailable', errors: fingerprint.errors });
      }
    }
    for (const file of selected) missing.push(sanitizeModelText(`${repoName}/${file}`, 160));
  }
  for (const [path, status] of fingerprintStatus) options.onStatus?.(path, status);
  if (fingerprintStateChanged) saveFingerprintState(root, fingerprintState);
  const lines = [];
  if (stale.length) lines.push(`📚 Operational documentation needs source review: ${stale.slice(0, 3).join(', ')}${stale.length > 3 ? `; ${stale.length - 3} more pending for a later review` : ''}. Update factual content and review metadata only after checking the current source.`);
  if (missing.length) lines.push(`📚 Changed code has no related ai-context document: ${missing.slice(0, 2).join(', ')}${missing.length > 2 ? `; ${missing.length - 2} more pending for a later review` : ''}. Create or update documentation when the area warrants it; otherwise leave it undocumented with a clear reason.`);
  const text = lines.join('\n');
  return text && (options.dedupe === false || shouldReport(root, text)) ? text : '';
}

/**
 * Documentos deixados para trás por um diff (CI): um documento `live` cita uma fonte que o diff
 * mudou, e a revisão portátil gravada nele (`source_fingerprints`/`source_digest`, escrita pelo
 * `ack`) não corresponde ao conteúdo novo dessa fonte. Só confia no que está no próprio documento —
 * em CI não há cache local, e um cache não prova que alguém revisou.
 */
export function documentationDrift(root = resolveRoot(), cfg = loadConfig(root), changedPaths = []) {
  const config = documentationConfig(root, cfg);
  if (!config.enabled || !config.valid) return { status: config.enabled ? 'invalid' : 'disabled', items: [] };
  const catalog = buildDocumentationCatalog(root, cfg, { persist: false });
  if (catalog.status !== 'ready') return { status: catalog.status, items: [] };
  const chave = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const changed = new Set(changedPaths.map(chave));
  const repos = findRepos(root, { requireGit: false, cfg });
  const findByBasename = buscaPorNome(repos);
  const items = [];
  for (const document of catalog.documents) {
    if (document.type === 'index' || document.metadata.invalidReviewSources || document.metadata.unavailable) continue;
    const maintenance = document.metadata.maintenance || (document.type === 'decision' ? 'historical' : 'live');
    if (maintenance !== 'live') continue;
    const sources = referencedCodeFiles(document, root, repos, findByBasename);
    const touched = sources.filter((source) => changed.has(chave(resolve(source.repo.path, source.file))));
    if (!touched.length) continue;
    const id = (source) => `${source.repo.name}/${source.file}`;
    const fingerprint = fingerprintSourcesInRoots(sources.map((source) => ({
      root: source.repo.path, path: resolve(source.repo.path, source.file), id: id(source),
    })));
    const reviewed = compareReviewedSources(
      fingerprint,
      document.metadata.sourceFingerprintsPresent ? document.metadata.sourceFingerprints : undefined,
      null,
      null,
    );
    const recorded = document.metadata.sourceFingerprintsPresent && reviewed.valid;
    if (sameDigest(fingerprint, document.metadata.sourceDigest)) continue;
    if (recorded && touched.every((source) => !reviewed.changed.includes(id(source)))) continue;
    items.push({
      kind: 'document',
      path: document.path,
      title: document.title,
      sources: touched.map((source) => (source.repo.name === '.' ? source.file : id(source))),
      documentUpdated: changed.has(chave(resolve(root, document.path))),
      reason: !reviewed.valid ? 'invalid-fingerprints' : recorded ? 'review-outdated' : 'no-recorded-review',
    });
  }
  return { status: 'ready', items };
}

export function documentationSessionContext(root = resolveRoot(), cfg = loadConfig(root)) {
  const config = documentationConfig(root, cfg);
  if (!config.enabled || !config.valid) return '';
  const init = config.autoInit ? initializeDocumentation(root, cfg) : { created: [] };
  const catalog = buildDocumentationCatalog(root, cfg);
  const created = init.created.length ? ` Created: ${init.created.map((value) => sanitizeModelText(value, 160)).join(', ')}.` : '';
  const count = catalog.status === 'ready' ? catalog.documents.length : 0;
  return sanitizeModelText(`📚 Operational documentation: ${config.rootValue}/${config.layout.index} (${config.language}, ${count} document(s)). Read the index before broad exploration; documentation routes investigation but does not prove semantic correctness.${created}`, 1800);
}

export function documentationStatus(root = resolveRoot(), cfg = loadConfig(root)) {
  const config = documentationConfig(root, cfg);
  const catalog = buildDocumentationCatalog(root, cfg);
  return {
    status: catalog.status,
    enabled: config.enabled,
    autoInit: config.autoInit,
    language: config.language,
    root: config.rootValue,
    index: config.valid ? relPath(root, config.indexPath).replace(/\\/g, '/') : null,
    documents: catalog.documents.length,
    reused: catalog.reused,
    reread: catalog.reread,
  };
}

function likelyReference(value) {
  const text = String(value || '').trim();
  if (!text || /^A mapear$|^To map$/i.test(text) || text.includes('*') || text.endsWith('/.pas') || text.endsWith('/.dfm')) return false;
  // XML/JSON/INI em caixa alta costuma ser nome de payload/campo de integração, não arquivo
  // local. Só auditar esse caso quando houver caminho ou quando o arquivo realmente existir.
  if (/^-[A-Za-z]/.test(text)) return false;
  if (!/[\\/]/.test(text) && /\.(?:xml|json|ini)$/i.test(text) && text === text.toUpperCase()) return false;
  return true;
}

function referenceExists(root, reference, knownFiles) {
  if (!likelyReference(reference)) return true;
  const ref = String(reference).replace(/[),.;]+$/, '');
  if (/^[A-Za-z]:[\\/]/.test(ref)) return existsSync(ref);
  const candidate = resolve(root, ref);
  if (existsSync(candidate)) return true;
  const normalized = normalizePath(ref);
  return knownFiles.some((file) => normalizePath(file) === normalized || basename(file).toLowerCase() === basename(ref).toLowerCase());
}

export function auditDocumentation(root = resolveRoot(), cfg = loadConfig(root)) {
  const catalog = buildDocumentationCatalog(root, cfg);
  if (catalog.status !== 'ready') return { status: catalog.status, issues: [], documents: 0, pending: 0 };
  const config = catalog.config;
  const knownFiles = [];
  const fileReferenceRe = /\.(?:pas|dfm|dpr|dpk|inc|dproj|sql|md|json|ini|xml|fmx)$/i;
  for (const repo of findRepos(root, { requireGit: false, cfg })) {
    for (const file of walk(repo.path, fileReferenceRe)) knownFiles.push(relPath(root, file).replace(/\\/g, '/'));
  }
  for (const file of documentationFiles(config)) knownFiles.push(relPath(root, file).replace(/\\/g, '/'));

  const issues = [];
  let pending = 0;
  if (!existsSync(config.indexPath)) issues.push({ severity: 'high', path: config.rootValue, message: `missing index: ${config.layout.index}` });
  for (const dir of Object.values(config.dirs)) {
    if (!existsSync(join(config.rootPath, dir))) issues.push({ severity: 'high', path: config.rootValue, message: `missing standard directory: ${dir}` });
  }
  for (const document of catalog.documents) {
    if (document.type === 'index' || /(^|\/)README\.md$/i.test(document.path) || /template/i.test(document.path)) continue;
    const metadata = document.metadata;
    if (!metadata.confidence) issues.push({ severity: 'low', path: document.path, message: 'missing confidence metadata' });
    if (!metadata.source) issues.push({ severity: 'low', path: document.path, message: 'missing source metadata' });
    if (!metadata.lastReviewed && document.type !== 'decision') issues.push({ severity: 'low', path: document.path, message: 'missing last_reviewed metadata' });
    if (metadata.lastReviewed && !/^(?:A mapear|To map)$/i.test(metadata.lastReviewed) && Number.isNaN(Date.parse(metadata.lastReviewed))) {
      issues.push({ severity: 'medium', path: document.path, message: `invalid last_reviewed: ${metadata.lastReviewed}` });
    }
    const unresolved = document.references.filter((reference) => !referenceExists(root, reference, knownFiles));
    if (unresolved.length) issues.push({ severity: 'medium', path: document.path, message: `unresolved reference(s): ${unresolved.slice(0, 5).join(', ')}${unresolved.length > 5 ? ', …' : ''}` });
    const pointers = document.text.match(/(?:[A-Za-z0-9_./\\-]+\.(?:pas|dfm|dpr|dpk|inc|dproj|sql|md):\d{1,6})/gi) || [];
    if (pointers.length) issues.push({ severity: 'medium', path: document.path, message: `line pointer(s) should be avoided: ${pointers.slice(0, 5).join(', ')}` });
    if (/\bA mapear\b|\bTo map\b/i.test(document.text)) pending++;
  }
  return { status: 'ready', issues, documents: catalog.documents.length, pending, reused: catalog.reused, reread: catalog.reread };
}

export { DOC_TYPES, LANGUAGE_LAYOUTS, normalizeLanguage, canonicalType };
