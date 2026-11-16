# Delegar a um subagente barato

Parte da skill `context-tools`; lida sob demanda. Prefixo dos comandos: o mesmo do `SKILL.md`.

Por que: o que a sessão principal lê fica no contexto e é relido a cada mensagem seguinte. Um
subagente é uma mini-sessão: lê o volume, devolve só a resposta.

Delegue trabalho volumoso e de pouca decisão. Decisão de desenho, revisão e commit ficam com a
sessão principal.

| papel | quando | escreve |
|---|---|---|
| `ct-explorer` | onde está, quem usa, o que um diff toca | nada |
| `ct-verifier` | rodar os testes e trazer só exit code + falhas literais | nada |
| `ct-map-keeper` | atualizar mapa/`ai-context/` depois de mudar código | mapas e `ai-context/` |
| `ct-translator` | espelhar doc já decidida pt-BR ↔ en | só o `--allow` |
| `ct-executor` | edição mecânica já decidida (renomear, mesma troca em N lugares) | só o `--allow` |

1. Monte o briefing: `ct.mjs brief "<tarefa>" --role=<papel> --done="<critério>"`, com
   `--files=a,b` para os arquivos em foco, `--allow=<globs>` para o escopo de escrita e
   `--test="<comando>"` para o verificador. Sai a tarefa, as regras do papel, a linha absoluta do
   `ct`, o "Por onde começar" dos mapas atualizados, o outline filtrado e o que muda junto;
   `--handoff=<arquivo>` junta o bloco que só a sessão sabia.
2. Chame o agente com esse texto como prompt: no Claude, o agente `ct-<papel>`
   (`context-tools:ct-<papel>` no plugin); no Codex, o agente `ct-<papel>` de `.codex/agents/`.
3. Confira a resposta antes de afirmar algo ao usuário: é evidência, não prova.

Trava: papel só-leitura não edita; papel que escreve só edita o escopo; nenhum muda o git, chama
`gh` ou escreve arquivo pelo shell. É contra engano, não um sandbox. `ct.mjs delegate status`
mostra os escopos vivos; `ct.mjs delegate clear` apaga.

Custo: `ct.mjs delegate report [--session=<id>]` mede cada subagente pelo transcript e compara com
uma ESTIMATIVA do mesmo trabalho no contexto principal — diga que é estimativa ao citar.
