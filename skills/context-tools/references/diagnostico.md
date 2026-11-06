# Diagnóstico e configuração

Parte da skill `context-tools`; lida sob demanda. Prefixo dos comandos: o mesmo do `SKILL.md`.

- `ct.mjs health [--days=30] [--audit] [--json]`: saúde local, atualidade do conhecimento e uso.
  Resposta emitida por hook não prova uso; digest em dia não prova correção. Contadores crus:
  `node "${PLUGIN_ROOT}/scripts/metrics.mjs" [--json|--clear]`.
- `ct.mjs providers [--install-plan]`: language servers opcionais; nenhum hook instala nada.
- `map-suggestions.mjs`: arquivos sem mapa que co-mudam com fontes mapeadas (pista, não confirmação).
- `ct.mjs drift --base=<ref> [--strict]`: mapas/documentos cuja fonte mudou no diff sem revisão
  registrada — para PR/CI (há uma GitHub Action no repositório do plugin).
- Configuração opcional em `.claude/context-tools.json` ou `.codex/context-tools.json`:
  `sourceDirs`, `ignoreDirs` (pastas descartáveis, por nome), `extraRepos` (repos irmãos; derivado
  de um `*.code-workspace` quando existe, `[]` desliga), `coupling`, `lang`,
  `claudeMdHint`/`codexMdHint`, `documentation.{enabled,autoInit,captureHint,root}`, `updateCheck`,
  `leanRule` (`false` tira a regra mínima do SessionStart), `debt.markers`.
- `ct.mjs status [--json]`: custo/contexto da sessão e se os testes valem — a faixa acima do prompt
  do Claude Code mostra o mesmo.
