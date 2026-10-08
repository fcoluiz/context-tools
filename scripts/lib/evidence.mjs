// Contrato pequeno e determinístico para respostas compostas.
// A camada não decide se algo é verdade: apenas torna origem, frescor e limite visíveis.

import { sanitizeModelText } from './roots.mjs';

export const EVIDENCE_KINDS = Object.freeze([
  'definition', 'outline', 'test', 'co-change', 'context-map', 'documentation', 'history',
  'textual-match', 'provider', 'diagnostic',
]);

export function evidence(kind, data = {}, opts = {}) {
  const k = EVIDENCE_KINDS.includes(kind) ? kind : 'diagnostic';
  const safeData = Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    typeof value === 'string' ? sanitizeModelText(value, key === 'text' ? 360 : 200) : value,
  ]));
  return {
    kind: k,
    confidence: opts.confidence || 'observed',
    freshness: opts.freshness || 'generated',
    ...safeData,
  };
}

export function evidenceEnvelope({ status = 'ok', query = '', scope = [], freshness = 'generated', items = [], limitations = [] } = {}) {
  return {
    status,
    query: sanitizeModelText(query, 180),
    scope: scope.map((x) => sanitizeModelText(x, 100)),
    freshness,
    items,
    limitations: limitations.map((x) => sanitizeModelText(x, 240)),
  };
}

export function formatEvidence(item) {
  const source = `[${item.kind}]`;
  const confidence = item.confidence ? ` (${item.confidence})` : '';
  const freshness = item.freshness && item.freshness !== 'generated' ? ` {${item.freshness}}` : '';
  return `${source}${confidence}${freshness} ${sanitizeModelText(item.text || item.file || '', 240)}`.trim();
}
