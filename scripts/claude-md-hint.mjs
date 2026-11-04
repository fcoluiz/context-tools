#!/usr/bin/env node
// One-time navigation hint for an existing CLAUDE.md.

import { resolveRoot, loadConfig, isMain } from './lib/roots.mjs';
import { exitWhenFlushed, writeHookOutput } from './lib/hook-output.mjs';
import { makeT, detectInstructionLang } from './lib/i18n.mjs';
import { aplicarMdHint, lerTextoHint } from './lib/md-hint.mjs';

const MARCA_INICIO = '<!-- context-tools:before-explore -->';
const MARCA_FIM = '<!-- /context-tools:before-explore -->';

// Texto gravado até a 2.9.16: citava scripts como se estivessem no projeto. Com o plugin instalado
// globalmente eles só existem no cache, e o agente procurava no checkout e avisava que faltavam.
const BLOCO_PT_V1 = `${MARCA_INICIO}
## Antes de delegar a um subagente de exploração

Para perguntas do tipo "onde X está definido" ou "como Y funciona", experimente o skill
\`context-tools\` (ou \`symbols.mjs\`/\`outline.mjs\` diretamente) ANTES de abrir um subagente de
exploração ampla. Quando já existe doc curada em \`.claude/context/\`, ele resolve em segundos
e sem gastar o orçamento de um subagente. Reserve o subagente para perguntas realmente abertas
("qual o comportamento de X em todo o sistema"), onde cobertura importa mais que custo.
As regras deste \`CLAUDE.md\` continuam sendo a autoridade do projeto; esta nota é apenas uma sugestão operacional.
${MARCA_FIM}
`;

const BLOCO_EN_V1 = `${MARCA_INICIO}
## Before delegating to an exploration subagent

For "where is X defined" or "how does Y work" questions, try the \`context-tools\` skill (or
\`symbols.mjs\`/\`outline.mjs\` directly) BEFORE spawning a broad exploration subagent. When a
curated doc already exists under \`.claude/context/\`, it resolves in seconds without spending a
subagent's budget. Reserve the subagent for genuinely open questions ("what's the behavior of X
across the whole system"), where coverage matters more than cost.
The rules in this \`CLAUDE.md\` remain the project's authority; this note is only an operational suggestion.
${MARCA_FIM}
`;

const BLOCO_PT = `${MARCA_INICIO}
## Antes de delegar a um subagente de exploração

Para perguntas do tipo "onde X está definido" ou "como Y funciona", experimente o skill
\`context-tools\` ANTES de abrir um subagente de exploração ampla; ele sabe onde seus scripts estão
instalados, então não os procure neste projeto. Quando já existe doc curada em \`.claude/context/\`, ele resolve em segundos
e sem gastar o orçamento de um subagente. Reserve o subagente para perguntas realmente abertas
("qual o comportamento de X em todo o sistema"), onde cobertura importa mais que custo.
As regras deste \`CLAUDE.md\` continuam sendo a autoridade do projeto; esta nota é apenas uma sugestão operacional.
${MARCA_FIM}
`;

const BLOCO_EN = `${MARCA_INICIO}
## Before delegating to an exploration subagent

For "where is X defined" or "how does Y work" questions, try the \`context-tools\` skill BEFORE
spawning a broad exploration subagent; it knows where its scripts are installed, so don't look for
them in this project. When a curated doc already exists under \`.claude/context/\`, it resolves in
seconds without spending a subagent's budget. Reserve the subagent for genuinely open questions
("what's the behavior of X across the whole system"), where coverage matters more than cost.
The rules in this \`CLAUDE.md\` remain the project's authority; this note is only an operational suggestion.
${MARCA_FIM}
`;

export function aplicarHintClaudeMd(root, cfg) {
  return aplicarMdHint(root, cfg, {
    targetFile: 'CLAUDE.md',
    markerStart: MARCA_INICIO,
    markerEnd: MARCA_FIM,
    stateFile: '.claude-md-hint-done',
    version: '2',
    block: (atual) => detectInstructionLang(atual, cfg) === 'pt' ? BLOCO_PT : BLOCO_EN,
    legacyBlocks: [BLOCO_PT_V1, BLOCO_EN_V1],
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
  exitWhenFlushed(0);
}
