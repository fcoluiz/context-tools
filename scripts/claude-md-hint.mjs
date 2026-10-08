#!/usr/bin/env node
// One-time navigation hint for an existing CLAUDE.md.

import { resolveRoot, loadConfig, isMain } from './lib/roots.mjs';
import { writeHookOutput } from './lib/hook-output.mjs';
import { makeT, detectInstructionLang } from './lib/i18n.mjs';
import { aplicarMdHint, lerTextoHint } from './lib/md-hint.mjs';

const MARCA_INICIO = '<!-- context-tools:before-explore -->';
const MARCA_FIM = '<!-- /context-tools:before-explore -->';

const BLOCO_PT = `${MARCA_INICIO}
## Antes de delegar a um subagente de exploração

Para perguntas do tipo "onde X está definido" ou "como Y funciona", experimente o skill
\`context-tools\` (ou \`symbols.mjs\`/\`outline.mjs\` diretamente) ANTES de abrir um subagente de
exploração ampla. Quando já existe doc curada em \`.claude/context/\`, ele resolve em segundos
e sem gastar o orçamento de um subagente. Reserve o subagente para perguntas realmente abertas
("qual o comportamento de X em todo o sistema"), onde cobertura importa mais que custo.
As regras deste \`CLAUDE.md\` continuam sendo a autoridade do projeto; esta nota é apenas uma sugestão operacional.
${MARCA_FIM}
`;

const BLOCO_EN = `${MARCA_INICIO}
## Before delegating to an exploration subagent

For "where is X defined" or "how does Y work" questions, try the \`context-tools\` skill (or
\`symbols.mjs\`/\`outline.mjs\` directly) BEFORE spawning a broad exploration subagent. When a
curated doc already exists under \`.claude/context/\`, it resolves in seconds without spending a
subagent's budget. Reserve the subagent for genuinely open questions ("what's the behavior of X
across the whole system"), where coverage matters more than cost.
The rules in this \`CLAUDE.md\` remain the project's authority; this note is only an operational suggestion.
${MARCA_FIM}
`;

export function aplicarHintClaudeMd(root, cfg) {
  return aplicarMdHint(root, cfg, {
    targetFile: 'CLAUDE.md',
    markerStart: MARCA_INICIO,
    stateFile: '.claude-md-hint-done',
    block: (atual) => detectInstructionLang(atual, cfg) === 'pt' ? BLOCO_PT : BLOCO_EN,
    disabledBy: ['claudeMdHint'],
  });
}

function main() {
  const root = resolveRoot();
  const cfg = loadConfig(root);
  const t = makeT(detectInstructionLang(lerTextoHint(root, 'CLAUDE.md'), cfg));
  const resultado = aplicarHintClaudeMd(root, cfg);
  if (resultado !== 'added') return;
  writeHookOutput(root, {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: t('claudemd.added') },
  });
}

if (isMain(import.meta.url)) {
  try { main(); } catch { /* M4: silence, never break the session */ }
  process.exit(0);
}
