#!/usr/bin/env node
// Relatório local de sinais de uso e saúde documental. Não envia dados nem lê prompts.

import { resolveRoot, isMain, loadConfig, sanitizeModelText, runtimeHost } from './lib/roots.mjs';
import { MAX_EVENTS, readMetrics } from './lib/telemetry.mjs';
import { contextMapsStopReport, sessionBaselineDiagnostics, currentSessionId } from './context-maps.mjs';
import { sessionWriteJournalDiagnostics } from './lib/session-write-journal.mjs';
import { reviewQueueDiagnostics } from './lib/auto-review-state.mjs';
import {
  auditDocumentation,
  documentationStatus,
  documentationStopReport,
} from './lib/documentation.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizeMetrics(events, days, now) {
  const start = now - days * DAY_MS;
  const recent = events.filter((event) => Number.isFinite(event?.at) && event.at >= start && event.at <= now);
  const byTool = {};
  for (const event of recent) byTool[event.type] = (byTool[event.type] || 0) + 1;

  const observedSearches = recent.filter((event) => event.type === 'pretool' && typeof event.outcome === 'string');
  const outcomes = {};
  for (const event of observedSearches) outcomes[event.outcome] = (outcomes[event.outcome] || 0) + 1;
  const followThrough = { used: 0, ignored: 0 };
  for (const event of recent) if (event.type === 'pretool-followup' && (event.outcome === 'used' || event.outcome === 'ignored')) followThrough[event.outcome]++;
  const pretoolDurations = {};
  for (const event of observedSearches) {
    if (!Number.isFinite(event.durationMs) || event.durationMs < 0) continue;
    const host = event.host === 'Bash' ? 'bash' : event.host === 'Grep' ? 'grep' : 'other';
    (pretoolDurations[host] ||= []).push(event.durationMs);
  }
  const pretoolDurationSummary = Object.fromEntries(Object.entries(pretoolDurations).map(([host, values]) => [host, {
    samples: values.length,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
  }]));

  const languageDemand = {};
  for (const event of recent) {
    if (event.type !== 'language-demand' || !/^[a-z0-9]{1,10}$/.test(event.extension || '')) continue;
    const summary = languageDemand[event.extension] ||= { lookups: 0, bySource: {} };
    const source = ['unsupported-file-lookup', 'outline-unsupported-file'].includes(event.source) ? event.source : 'other';
    summary.lookups++;
    summary.bySource[source] = (summary.bySource[source] || 0) + 1;
  }

  const symbolEvents = recent.filter((event) => event.type === 'symbols' && event.mode === 'query');
  const symbolLookups = {
    calls: symbolEvents.length,
    queries: symbolEvents.reduce((sum, event) => sum + (Number.isFinite(event.queryCount) ? event.queryCount : 0), 0),
    classifiedQueries: symbolEvents.reduce((sum, event) => sum + (Number.isFinite(event.classifiedQueries) ? event.classifiedQueries : 0), 0),
    symbolMatches: symbolEvents.reduce((sum, event) => sum + (Number.isFinite(event.symbolMatches) ? event.symbolMatches : 0), 0),
    fileMatches: symbolEvents.reduce((sum, event) => sum + (Number.isFinite(event.fileMatches) ? event.fileMatches : 0), 0),
    misses: symbolEvents.reduce((sum, event) => sum + (Number.isFinite(event.misses) ? event.misses : 0), 0),
  };

  const autoReviewEvents = recent.filter((event) => event.type === 'auto-review');
  const autoReviewOutcomes = {};
  for (const event of autoReviewEvents) {
    const outcome = typeof event.outcome === 'string' ? event.outcome : 'unknown';
    autoReviewOutcomes[outcome] = (autoReviewOutcomes[outcome] || 0) + 1;
  }
  const promptedReviewEvents = autoReviewEvents.filter((event) => event.outcome === 'prompted');
  const reviewTokenEstimates = promptedReviewEvents
    .map((event) => event.hookPromptTokensEstimate)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const autoReview = {
    attempts: autoReviewEvents.length,
    outcomes: autoReviewOutcomes,
    prompted: promptedReviewEvents.length,
    offline: {
      sourceReads: autoReviewEvents.reduce((sum, event) => sum + (event.sourceReads || 0), 0),
      sourceBytes: autoReviewEvents.reduce((sum, event) => sum + (event.sourceBytes || 0), 0),
      sourceCacheHits: autoReviewEvents.reduce((sum, event) => sum + (event.sourceCacheHits || 0), 0),
      metadataSynchronized: autoReviewEvents.reduce((sum, event) => sum + (event.metadataSynchronized || 0), 0),
      verificationIssues: autoReviewEvents.reduce((sum, event) => sum + (event.verificationIssues || 0), 0),
    },
    hookPromptEstimate: {
      samples: reviewTokenEstimates.length,
      totalTokens: reviewTokenEstimates.reduce((sum, value) => sum + value, 0),
      p50Tokens: percentile(reviewTokenEstimates, 0.50),
      p95Tokens: percentile(reviewTokenEstimates, 0.95),
    },
  };

  const durations = {};
  for (const event of recent) {
    if (!Number.isFinite(event?.durationMs) || event.durationMs < 0) continue;
    (durations[event.type] ||= []).push(event.durationMs);
  }
  const durationSummary = Object.fromEntries(Object.entries(durations).map(([type, values]) => [type, {
    samples: values.length,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
  }]));

  return {
    days,
    storedEvents: events.length,
    retentionLimit: MAX_EVENTS,
    retentionMayBeTruncated: events.length >= MAX_EVENTS,
    eventsInWindow: recent.length,
    byTool,
    pretool: {
      observedSymbolSearches: observedSearches.length,
      outcomes,
      responsesEmitted: (outcomes.hit || 0) + (outcomes.pack || 0),
      handlerDuration: pretoolDurationSummary,
      followThrough,
    },
    unsupportedLanguageLookups: languageDemand,
    symbolLookups,
    autoReview,
    durations: durationSummary,
    firstStoredAt: events.length && Number.isFinite(events[0]?.at) ? new Date(events[0].at).toISOString() : null,
    lastStoredAt: events.length && Number.isFinite(events.at(-1)?.at) ? new Date(events.at(-1).at).toISOString() : null,
  };
}

function reportFindings(fn) {
  try {
    const issues = [];
    const text = fn((issue) => { if (issue.kind !== 'documentation-disabled') issues.push(issue); });
    return { status: issues.length ? 'incomplete' : 'ok', issues, findings: text ? text.split(/\r?\n/).filter(Boolean).map((line) => sanitizeModelText(line, 500)) : [] };
  } catch (error) {
    return { status: 'error', error: sanitizeModelText(error?.message || error, 300), findings: [] };
  }
}

function reportAudit(root, config) {
  try {
    const result = auditDocumentation(root, config);
    if (result.status !== 'ready') return { status: result.status, issueCount: null, issues: [], pending: null };
    const issues = result.issues.map((issue) => ({
      severity: sanitizeModelText(issue.severity, 20),
      path: sanitizeModelText(issue.path, 180),
      message: sanitizeModelText(issue.message, 300),
    }));
    return { status: issues.length || result.pending ? 'findings' : 'clean', issueCount: issues.length, issues, pending: result.pending };
  } catch (error) {
    return { status: 'error', error: sanitizeModelText(error?.message || error, 300), issueCount: null, issues: [], pending: null };
  }
}

function buildReport(root, days, includeAudit) {
  const config = loadConfig(root);
  const now = Date.now();
  const storage = readMetrics(root);
  const events = storage.events;
  const sessionBaseline = sessionBaselineDiagnostics(root);
  const host = runtimeHost();
  const sessionId = currentSessionId();
  const writeAttribution = host === 'codex' ? sessionWriteJournalDiagnostics(root, sessionId) : null;
  const reviewQueue = reviewQueueDiagnostics(root);
  const trackingIssues = host === 'codex' ? [] : sessionBaseline;
  const docs = documentationStatus(root, config);
  const mapFreshness = reportFindings((onIssue) => contextMapsStopReport(root, { onIssue }));
  // A diagnostic report must show current findings even if a hook already showed the same text.
  const documentFreshness = reportFindings((onIssue) => documentationStopReport(root, config, { dedupe: false, onIssue }));
  const audit = includeAudit ? reportAudit(root, config) : null;
  const metrics = summarizeMetrics(events, days, now);
  metrics.storageStatus = storage.status;
  const hasFindings = mapFreshness.findings.length > 0
    || storage.status !== 'ready'
    || documentFreshness.findings.length > 0
    || trackingIssues.length > 0
    || (host === 'codex' && sessionId && writeAttribution?.status !== 'active')
    || reviewQueue.pending > 0
    || !['clean', 'pending'].includes(reviewQueue.status)
    || ['error', 'incomplete'].includes(mapFreshness.status)
    || ['error', 'incomplete'].includes(documentFreshness.status)
    || ['findings', 'error'].includes(audit?.status);
  const overallStatus = hasFindings
    ? 'attention'
    : docs.status === 'ready'
      ? metrics.eventsInWindow === 0
        ? 'limited-data'
        : 'no-findings'
      : 'documentation-unavailable';

  return {
    status: overallStatus,
    generatedAt: new Date(now).toISOString(),
    root,
    metrics,
    reviewQueue,
    sessionTracking: {
      status: !sessionId ? 'not-applicable' : host === 'codex' ? (writeAttribution?.status === 'active' ? 'complete' : 'incomplete') : trackingIssues.length ? 'incomplete' : 'complete',
      method: host === 'codex' ? 'codex-write-journal' : 'workspace-snapshot',
      ...(writeAttribution ? { writeAttribution } : {}),
      issues: trackingIssues.map((issue) => ({
        repository: sanitizeModelText(issue.repo, 180),
        kind: issue.kind,
        ...(issue.count != null ? { observedFiles: issue.count } : {}),
        ...(issue.limit != null ? { limit: issue.limit } : {}),
      })),
    },
    documentation: {
      status: docs.status,
      enabled: docs.enabled,
      language: docs.language,
      root: docs.root,
      documentCount: docs.documents,
      pendingPlaceholders: audit?.pending ?? null,
      audit: audit ? {
        status: audit.status,
        issueCount: audit.issueCount,
        bySeverity: Object.fromEntries(['high', 'medium', 'low'].map((severity) => [
          severity,
          audit.issues.filter((issue) => issue.severity === severity).length,
        ])),
        issues: audit.issues,
        ...(audit.error ? { error: audit.error } : {}),
      } : null,
    },
    freshness: {
      contextMaps: mapFreshness,
      operationalDocuments: documentFreshness,
    },
    notes: [
      ...(docs.language === 'pt' ? [
        'As métricas são locais e limitadas; prompts, conteúdo-fonte e comandos completos não são armazenados.',
        'O hook de preflight não grava duração por mensagem; use benchmark:prompt-audit para medir p50/p95 local com entradas sintéticas.',
        'As contagens de PreToolUse mostram buscas semelhantes a símbolos e respostas emitidas; "respostas aproveitadas" mede, só no Claude, se um arquivo indicado foi aberto ou editado nas 6 chamadas seguintes — correlação, não causa.',
        'Consultas diretas a symbols indicam se o índice localizou símbolo/arquivo ou não, não se o agente usou o resultado.',
        'A duração do handler aparece apenas para buscas de símbolo reconhecidas; use benchmark-pretool para medir o processo Bash ponta a ponta sob demanda.',
        'A estimativa de tokens da revisão automática cobre somente o texto do hook (caracteres ÷ 4); não é uso faturado e não inclui leituras de fonte, contexto anterior ou resposta do modelo.',
        'Arquivos sem cobertura ficam fora do Stop automático isoladamente; eles são promovidos por mudança em grupo ou recorrência, enquanto a visão de saúde não aplica esse filtro.',
        'Consultas por arquivos de linguagens sem parser são sinais agregados por extensão, não prova suficiente para adicionar suporte.',
        'Um digest limpo confirma que os bytes da fonte correspondem à impressão digital revisada; não prova correção semântica.',
        'As verificações podem atualizar caches locais de diagnóstico, mas não editam documentos nem código do projeto.',
        ...(metrics.retentionMayBeTruncated ? ['O anel local atingiu o limite de retenção; a janela pode omitir eventos mais antigos.'] : []),
      ] : [
        'All metrics are local and bounded; prompts, source contents and full commands are not stored.',
        'The preflight hook does not record per-message duration; use benchmark:prompt-audit for a local p50/p95 measurement with synthetic inputs.',
        'PreToolUse counts describe symbol-like searches and answers emitted; "answers used" measures, on Claude only, whether an indicated file was opened or edited within the next 6 calls — correlation, not cause.',
        'Direct symbols counts describe whether the local index found a symbol/file, not whether the agent used the result.',
        'Handler duration is shown only for recognized symbol searches; use benchmark-pretool for an on-demand end-to-end Bash process measurement.',
        'Automatic-review token estimates cover only hook text (characters ÷ 4); they are not billed usage and exclude source reads, prior context and model output.',
        'Uncovered files are held out of automatic Stop review on their own; grouped or recurring changes are promoted, while health reporting remains unfiltered.',
        'Lookups for files in languages without a parser are aggregate signals by extension, not sufficient evidence by themselves to add support.',
        'A clean digest confirms source bytes match a reviewed fingerprint; it does not prove semantic correctness.',
        'Freshness checks may refresh local diagnostic caches but do not edit project documents or source files.',
        ...(metrics.retentionMayBeTruncated ? ['The local event ring reached its retention limit; window counts may omit older events.'] : []),
      ]),
    ],
  };
}

function printHuman(report, portuguese) {
  const say = (pt, en) => portuguese ? pt : en;
  const root = sanitizeModelText(report.root, 180);
  const m = report.metrics;
  console.log(`context-tools health — ${root}`);
  const statusText = {
    attention: say('atenção', 'attention'),
    'no-findings': say('nenhuma pendência detectada', 'no findings detected'),
    'limited-data': say('sem dados de uso recentes', 'no recent usage data'),
    'documentation-unavailable': say('documentação indisponível ou desativada', 'documentation unavailable or disabled'),
  }[report.status] || report.status;
  console.log(say(`Sinal geral: ${statusText}`, `Overall signal: ${statusText}`));
  console.log(say(`Fila de revisão: ${report.reviewQueue.status}; ${report.reviewQueue.pending ?? '?'} pendência(s).`, `Review queue: ${report.reviewQueue.status}; ${report.reviewQueue.pending ?? '?'} pending item(s).`));
  if (report.sessionTracking.method === 'codex-write-journal') {
    const attribution = report.sessionTracking.writeAttribution;
    const attributionStatus = {
      active: say('diário ativo', 'journal active'),
      'no-session-id': say('sem ID de sessão disponível', 'session ID unavailable'),
      'not-initialized': say('diário não inicializado; o Stop fica em silêncio', 'journal not initialized; Stop stays quiet'),
      unavailable: say('diário indisponível; o Stop fica em silêncio', 'journal unavailable; Stop stays quiet'),
      'verification-limited': say('verificação de hashes excedeu o limite; o Stop fica em silêncio', 'hash verification exceeded its limit; Stop stays quiet'),
    }[attribution?.status] || say('estado do diário desconhecido', 'journal status unknown');
    console.log(say(
      `Atribuição do Codex: ${attributionStatus}${attribution?.status === 'active' ? `; ${attribution.editEvents} edição(ões), ${attribution.currentMatches}/${attribution.observedFiles} arquivo(s) ainda correspondem ao hash registrado.` : attribution?.status === 'verification-limited' ? `; ${attribution.editEvents} edição(ões), ${attribution.observedFiles} arquivo(s) observados.` : '.'}`,
      `Codex attribution: ${attributionStatus}${attribution?.status === 'active' ? `; ${attribution.editEvents} edit event(s), ${attribution.currentMatches}/${attribution.observedFiles} file(s) still match the recorded hash.` : attribution?.status === 'verification-limited' ? `; ${attribution.editEvents} edit event(s), ${attribution.observedFiles} file(s) observed.` : '.'}`,
    ));
    if (attribution?.pendingEvents) console.log(say('  Há evento(s) de edição ainda sem confirmação pós-ferramenta.', '  Edit event(s) are still waiting for post-tool confirmation.'));
    if (attribution?.skippedEvents) console.log(say(`  ${attribution.skippedEvents} edição(ões) explícita(s) não puderam ser registradas por formato, acesso ou limite local.`, `  ${attribution.skippedEvents} explicit edit(s) could not be recorded because of format, access, or local limits.`));
  }
  if (report.sessionTracking.status === 'incomplete') {
    console.log(report.sessionTracking.method === 'codex-write-journal'
      ? say('Snapshot auxiliar incompleto; alterações do Codex por Bash ou ferramentas sem caminho explícito podem não entrar na revisão automática.', 'Auxiliary snapshot is incomplete; Codex writes through Bash or tools without explicit paths may be absent from automatic review.')
      : say('Rastreio desta sessão: incompleto; o Stop automático pode deixar alterações passar.', 'Session tracking: incomplete; automatic Stop may miss changes.'));
    for (const issue of report.sessionTracking.issues) {
      const reason = {
        'dirty-limit': say('muitas alterações locais ao abrir a sessão', 'too many pre-existing local changes'),
        'file-limit': say('snapshot sem Git acima do limite', 'no-Git snapshot exceeded its limit'),
        'git-unavailable': say('revisão inicial do Git indisponível', 'Git starting revision unavailable'),
        'legacy-baseline': say('baseline ausente ou incompleto', 'baseline missing or incomplete'),
      }[issue.kind] || issue.kind;
      console.log(`  ${issue.repository}: ${reason}${issue.observedFiles != null ? ` (${issue.observedFiles} ${say('arquivos', 'files')}; ${say('limite', 'limit')} ${issue.limit})` : ''}`);
    }
  }
  console.log(say(`Métricas locais: ${m.eventsInWindow} evento(s) em ${m.days} dias; ${m.storedEvents}/${m.retentionLimit} armazenados.`, `Local metrics: ${m.eventsInWindow} event(s) in ${m.days} days; ${m.storedEvents}/${m.retentionLimit} stored.`));
  if (Object.keys(m.byTool).length) console.log(`  ${say('Por tipo de evento', 'By event type')}: ${Object.entries(m.byTool).map(([name, count]) => `${name} ${count}`).join(' · ')}`);
  if (m.pretool.observedSymbolSearches) {
    const outcomes = Object.entries(m.pretool.outcomes).map(([name, count]) => `${name} ${count}`).join(' · ');
    console.log(`  PreToolUse: ${m.pretool.responsesEmitted} ${say('resposta(s) emitida(s)', 'response(s) emitted')} / ${m.pretool.observedSymbolSearches} ${say('busca(s) de símbolo registrada(s)', 'recorded symbol search(es)')} (${outcomes}).`);
    const ft = m.pretool.followThrough || { used: 0, ignored: 0 };
    if (ft.used + ft.ignored) console.log(`  ${say('Respostas aproveitadas', 'Answers used')}: ${ft.used}/${ft.used + ft.ignored} ${say('(arquivo indicado aberto ou editado nas 6 chamadas seguintes; só Claude)', '(an indicated file was opened or edited within the next 6 calls; Claude only)')}`);
    for (const [host, values] of Object.entries(m.pretool.handlerDuration)) {
      console.log(`  ${say('Handler', 'Handler')} ${host}: p50 ${values.p50Ms} ms · p95 ${values.p95Ms} ms (${values.samples} ${say('amostra(s)', 'sample(s)')})`);
    }
  }
  if (Object.keys(m.unsupportedLanguageLookups).length) {
    const counts = Object.entries(m.unsupportedLanguageLookups).sort((a, b) => b[1].lookups - a[1].lookups).map(([ext, value]) => {
      const sources = Object.entries(value.bySource).map(([source, count]) => `${source} ${count}`).join(', ');
      return `${ext} ${value.lookups} (${sources})`;
    }).join(' · ');
    console.log(`  ${say('Consultas por formato sem parser', 'Lookups for formats without a parser')}: ${counts}`);
  }
  if (m.symbolLookups.calls) {
    const s = m.symbolLookups;
    const unclassified = Math.max(0, s.queries - s.classifiedQueries);
    console.log(`  ${say('Consultas symbols', 'symbols lookups')}: ${s.symbolMatches} ${say('símbolo(s)', 'symbol(s)')} + ${s.fileMatches} ${say('arquivo(s)', 'file(s)')} · ${s.misses} ${say('sem resultado', 'misses')} / ${s.classifiedQueries} ${say('consulta(s) classificadas', 'classified lookup(s)')}${unclassified ? ` · ${unclassified} ${say('sem classificação', 'unclassified')}` : ''}`);
  }
  if (m.autoReview.attempts) {
    const outcomes = Object.entries(m.autoReview.outcomes).map(([name, count]) => `${name} ${count}`).join(' · ');
    const estimate = m.autoReview.hookPromptEstimate;
    console.log(`  ${say('Revisão automática', 'Automatic review')}: ${m.autoReview.prompted} ${say('continuação(ões) solicitada(s)', 'continuation(s) requested')} · ${say('prompt do hook estimado', 'estimated hook prompt')} ${estimate.totalTokens} ${say('tokens', 'tokens')} (p50 ${estimate.p50Tokens ?? 0}, p95 ${estimate.p95Tokens ?? 0}) · ${outcomes}`);
  }
  for (const [name, values] of Object.entries(m.durations)) {
    console.log(`  ${name} ${say('duração observada', 'observed duration')}: p50 ${values.p50Ms} ms · p95 ${values.p95Ms} ms (${values.samples} ${say('amostra(s)', 'sample(s)')})`);
  }
  console.log(say(`Documentação: ${report.documentation.status}; ${report.documentation.documentCount} documento(s) em ${report.documentation.root}.`, `Documentation: ${report.documentation.status}; ${report.documentation.documentCount} document(s) in ${report.documentation.root}.`));
  if (report.documentation.audit) {
    const audit = report.documentation.audit;
    if (audit.status !== 'ready' && audit.status !== 'clean' && audit.status !== 'findings') {
      console.log(say(`  Auditoria indisponível: ${audit.status}`, `  Audit unavailable: ${audit.status}`));
    } else {
      console.log(say(`  Auditoria: ${audit.issueCount ?? 0} problema(s); ${report.documentation.pendingPlaceholders ?? 0} campo(s) ainda “A mapear”.`, `  Audit: ${audit.issueCount ?? 0} issue(s); ${report.documentation.pendingPlaceholders ?? 0} “To map” placeholder(s).`));
    }
    for (const issue of audit.issues || []) console.log(`    [${issue.severity}] ${issue.path}: ${issue.message}`);
    if (audit.error) console.log(`    ${say('Falha na auditoria', 'Audit error')}: ${audit.error}`);
  }
  for (const [label, section] of [
    [say('Mapas de contexto', 'Context maps'), report.freshness.contextMaps],
    [say('Documentação operacional', 'Operational documentation'), report.freshness.operationalDocuments],
  ]) {
    console.log(`${label}:`);
    if (section.status === 'error') console.log(`  ${say('não foi possível verificar', 'could not verify')}: ${section.error}`);
    else if (!section.findings.length) console.log(`  ${say('nenhuma pendência mecânica detectada', 'no mechanical findings detected')}`);
    else for (const finding of section.findings) console.log(`  ${finding}`);
  }
  for (const note of report.notes) console.log(`- ${note}`);
}

function main() {
  const root = resolveRoot();
  const args = process.argv.slice(2);
  const unsupported = args.filter((value) => !/^--days=/.test(value) && !['--audit', '--json'].includes(value));
  if (unsupported.length) throw new Error(`unknown option(s): ${unsupported.join(', ')}`);
  const daysArg = args.find((value) => value.startsWith('--days='));
  const days = daysArg ? Number(daysArg.slice('--days='.length)) : 30;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be an integer from 1 to 365');
  const report = buildReport(root, days, args.includes('--audit'));
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printHuman(report, report.documentation.language === 'pt');
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`context-tools health: ${sanitizeModelText(error?.message || error, 300)}`);
    process.exitCode = 1;
  }
}
