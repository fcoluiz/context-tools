#!/usr/bin/env node
// CLI e hooks da documentação operacional.
//
// Hooks só criam o esqueleto configurado e detectam pendências. No Codex, Stop pode iniciar uma
// continuação limitada; o agente investiga as fontes e preenche o conteúdo semântico.

import { resolveRoot, loadConfig, isMain, sanitizeModelText, statePath } from './lib/roots.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { recordMetric } from './lib/telemetry.mjs';
import {
  auditDocumentation,
  createDocumentationDocument,
  documentationSessionContext,
  documentationStatus,
  documentationStopReport,
  initializeDocumentation,
} from './lib/documentation.mjs';
import { contextMapsPromptAudit, contextMapsStopReport } from './context-maps.mjs';

function arg(name, fallback = null) {
  const item = process.argv.find((value) => value.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : fallback;
}

function emitHook(eventName, text, notice = '', autoReview = false) {
  if (!text) return;
  const hookSpecificOutput = { hookEventName: eventName, additionalContext: text.slice(0, 3200) };
  if (notice) hookSpecificOutput._contextToolsNotice = notice.slice(0, 1800);
  if (autoReview) hookSpecificOutput._contextToolsAutoReview = true;
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

function sessionNotice(root, cfg, context) {
  const status = documentationStatus(root, cfg);
  const noticePath = statePath(root, '.documentation-session-notice.json');
  const signature = context.includes('Created:') ? 'created' : (status.documents <= 1 ? 'skeleton-only' : 'ready');
  if (signature === 'ready') return '';
  let previous = null;
  try { previous = JSON.parse(readFileSync(noticePath, 'utf8')); } catch {}
  if (previous?.signature === signature && Date.now() - (previous.at || 0) < 24 * 60 * 60 * 1000) return '';
  try {
    mkdirSync(dirname(noticePath), { recursive: true });
    writeFileSync(noticePath, JSON.stringify({ signature, at: Date.now() }));
  } catch {}
  if (status.language === 'en') {
    if (signature === 'created') return '📚 context-tools created the initial ai-context structure. The agent must fill or create documents only after investigating the relevant area; do not invent rules.';
    return '📚 ai-context is active, but it has no semantic documents beyond the index yet. When working on a relevant area, the agent should propose a document and fill it only with project evidence.';
  }
  if (signature === 'created') return '📚 O context-tools criou a estrutura inicial do ai-context. O agente deve preencher ou criar documentos somente após investigar a área relevante; não invente regras.';
  return '📚 O ai-context está ativo, mas ainda não possui documentos semânticos além do índice. Ao trabalhar em uma área relevante, o agente deve propor a criação de um documento e preenchê-lo somente com evidências do projeto.';
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  const status = result.status || 'unknown';
  console.log(`context-docs — ${status}`);
  if (result.root) console.log(`  root: ${result.root}`);
  if (result.index) console.log(`  index: ${result.index}`);
  if (result.language) console.log(`  language: ${result.language}`);
  if (result.documents != null) console.log(`  documents: ${result.documents}`);
  if (result.created?.length) console.log(`  created: ${result.created.join(', ')}`);
  if (result.path) console.log(`  path: ${result.path}`);
  if (result.pending != null) console.log(`  pending: ${result.pending}`);
  for (const issue of result.issues || []) console.log(`  [${issue.severity}] ${issue.path}: ${issue.message}`);
}

async function main() {
  const root = resolveRoot();
  const cfg = loadConfig(root);
  const mode = process.argv.find((value) => value === '--session-start' || value === '--stop-report' || value === '--prompt-audit') || null;
  if (mode === '--session-start') {
    // Establish byte-level baselines for clean operational docs so Stop can distinguish
    // this session's edits from older pending work without asking the model to inspect either.
    try { documentationStopReport(root, cfg, { dedupe: false, sessionOnly: true }); } catch { /* preflight cache is best-effort */ }
    const context = documentationSessionContext(root, cfg);
    emitHook('SessionStart', context, sessionNotice(root, cfg, context));
    return;
  }
  if (mode === '--stop-report') {
    const codex = process.env.CONTEXT_TOOLS_HOST === 'codex';
    if (codex) {
      const { executeContextReview, codexReviewOutput } = await import('./lib/review-engine.mjs');
      let event = {};
      try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* empty CLI input */ }
      const output = codexReviewOutput(executeContextReview(root, {
        sessionId: event.session_id || process.env.CONTEXT_TOOLS_SESSION_ID,
        turnId: event.turn_id || process.env.CONTEXT_TOOLS_TURN_ID,
        continuation: event.stop_hook_active === true,
      }));
      if (output) process.stdout.write(output);
      return;
    }
    const mapStarted = Date.now();
    let mapReport = '';
    if (codex) {
      try { mapReport = contextMapsStopReport(root, { sessionOnly: true }); } catch { /* falha de mapa não bloqueia o hook de documentação */ }
      recordMetric(root, 'context-maps', { mode: 'stop-report', durationMs: Date.now() - mapStarted });
    }
    const reports = [
      documentationStopReport(root, cfg, { sessionOnly: true }),
      ...(codex ? [mapReport] : []),
    ].filter(Boolean);
    emitHook('Stop', reports.join('\n\n'), '', codex);
    return;
  }
  if (mode === '--prompt-audit') {
    let event = {};
    try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* malformed event: no context */ }
    let context = '';
    try { context = contextMapsPromptAudit(root, typeof event.prompt === 'string' ? event.prompt : ''); } catch { /* local audit must never disrupt the user prompt */ }
    emitHook('UserPromptSubmit', context);
    return;
  }

  const action = process.argv.slice(2).find((value) => !value.startsWith('--')) || 'status';
  const json = process.argv.includes('--json');
  if (action === 'init') {
    printResult({ ...initializeDocumentation(root, cfg), root: documentationStatus(root, cfg).root }, json);
    return;
  }
  if (action === 'create') {
    const type = arg('--type', process.argv.slice(2).find((value) => !value.startsWith('--') && value !== 'create'));
    const name = arg('--name', process.argv.slice(2).filter((value) => !value.startsWith('--') && value !== 'create' && value !== type).join(' '));
    const result = createDocumentationDocument(root, type, name, cfg);
    printResult(result, json);
    if (result.status === 'invalid' || result.status === 'invalid-input' || result.status === 'write-failed') process.exitCode = 1;
    return;
  }
  if (action === 'status') {
    printResult(documentationStatus(root, cfg), json);
    return;
  }
  if (action === 'audit') {
    const result = auditDocumentation(root, cfg);
    printResult(result, json);
    if (result.issues?.some((issue) => issue.severity === 'high')) process.exitCode = 1;
    return;
  }
  console.error(`context-docs: unknown action ${sanitizeModelText(action, 80)}`);
  process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  try { await main(); } catch (error) {
    console.error(`context-docs: ${sanitizeModelText(error?.message || error, 240)}`);
    process.exitCode = 1;
  }
}
