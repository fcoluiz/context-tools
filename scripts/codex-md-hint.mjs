#!/usr/bin/env node
// One-time navigation hint for an existing AGENTS.md.

import { resolveRoot, loadConfig, isMain } from './lib/roots.mjs';
import { writeHookOutput } from './lib/hook-output.mjs';
import { makeT, detectInstructionLang } from './lib/i18n.mjs';
import { recordMetric } from './lib/telemetry.mjs';
import { aplicarMdHint, lerTextoHint } from './lib/md-hint.mjs';

const MARCA_INICIO = '<!-- context-tools:before-explore-codex -->';
const MARCA_FIM = '<!-- /context-tools:before-explore-codex -->';
// Texto gravado até a 2.9.16: `.codex/scripts/` só existe na instalação local; na global o agente
// procurava a pasta no checkout e avisava que o script não estava lá.
const BLOCO_PT_V1 = `${MARCA_INICIO}
## Antes de delegar a um subagente de exploração

Para perguntas do tipo "onde X está definido" ou "como Y funciona", experimente primeiro a skill
\`context-tools\` ou a navegação instalada para este host (\`.codex/scripts/\`), quando isso for adequado.
Use um subagente para perguntas realmente abertas, nas quais a cobertura de todo o sistema importa.
As regras deste \`AGENTS.md\` continuam sendo a autoridade do projeto; esta nota é apenas uma sugestão operacional.
${MARCA_FIM}
`;

const BLOCO_EN_V1 = `${MARCA_INICIO}
## Before delegating to an exploration subagent

For "where is X defined" or "how does Y work", try the \`context-tools\` skill or the navigation
installed for this host (\`.codex/scripts/\`) first, when appropriate. Use a subagent for genuinely
open questions where whole-system coverage matters.
The rules in this \`AGENTS.md\` remain the project's authority; this note is only an operational suggestion.
${MARCA_FIM}
`;

const BLOCO_PT = `${MARCA_INICIO}
## Antes de delegar a um subagente de exploração

Para perguntas do tipo "onde X está definido" ou "como Y funciona", experimente primeiro a skill
\`context-tools\`, quando isso for adequado; ela sabe onde seus scripts estão instalados, então não os
procure neste projeto.
Use um subagente para perguntas realmente abertas, nas quais a cobertura de todo o sistema importa.
As regras deste \`AGENTS.md\` continuam sendo a autoridade do projeto; esta nota é apenas uma sugestão operacional.
${MARCA_FIM}
`;

const BLOCO_EN = `${MARCA_INICIO}
## Before delegating to an exploration subagent

For "where is X defined" or "how does Y work", try the \`context-tools\` skill first, when
appropriate; it knows where its scripts are installed, so don't look for them in this project. Use a
subagent for genuinely open questions where whole-system coverage matters.
The rules in this \`AGENTS.md\` remain the project's authority; this note is only an operational suggestion.
${MARCA_FIM}
`;

export function aplicarHintCodexMd(root, cfg) {
  return aplicarMdHint(root, cfg, {
    targetFile: 'AGENTS.md',
    markerStart: MARCA_INICIO,
    markerEnd: MARCA_FIM,
    stateFile: '.codex-md-hint-done',
    version: '2',
    block: (atual) => detectInstructionLang(atual, cfg) === 'pt' ? BLOCO_PT : BLOCO_EN,
    legacyBlocks: [BLOCO_PT_V1, BLOCO_EN_V1],
    // A configuração do Codex é isolada. Uma opção de opt-out do Claude não pode
    // desligar a orientação do AGENTS.md quando os dois hosts convivem no projeto.
    disabledBy: ['codexMdHint'],
  });
}

function main() {
  const root = resolveRoot();
  const cfg = loadConfig(root);
  const t = makeT(detectInstructionLang(lerTextoHint(root, 'AGENTS.md'), cfg));
  const resultado = aplicarHintCodexMd(root, cfg);
  if (resultado !== 'added') return;
  writeHookOutput(root, {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: t('codexmd.added'),
    },
  });
}

if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot();
  try { main(); } catch { /* optional hook: never break the session */ }
  finally { recordMetric(root, 'codex-md-hint', { durationMs: Date.now() - started }); }
  process.exit(0);
}
