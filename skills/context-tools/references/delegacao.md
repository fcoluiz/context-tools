# Delegar a um subagente barato

Parte da skill `context-tools`; lida sob demanda. Prefixo dos comandos: o mesmo do `SKILL.md`.

Por que: o que a sessão principal lê fica no contexto e é relido a cada mensagem seguinte. Um
subagente é uma mini-sessão: lê o volume, devolve só a resposta.

Delegue trabalho volumoso e de pouca decisão. Decisão de desenho, revisão e commit ficam com a
sessão principal. Medido (A/B de 2026-11-16): compensa quando UMA chamada substitui várias rodadas
de busca — junte as perguntas independentes numa chamada só. Não compensa numa correção pequena (para
editar você vai ler o arquivo de qualquer jeito) nem numa tarefa de poucos turnos: cada turno a mais
da sessão principal relê o contexto inteiro dela.

| papel | quando | escreve |
|---|---|---|
| `ct-explorer` | onde está, quem usa, o que um diff toca | nada |
| `ct-verifier` | rodar os testes e trazer só exit code + falhas literais | nada |
| `ct-map-keeper` | atualizar mapa/`ai-context/` depois de mudar código | mapas e `ai-context/` |
| `ct-translator` | espelhar doc já decidida pt-BR ↔ en | só o `--allow` |
| `ct-executor` | edição mecânica já decidida (renomear, mesma troca em N lugares) | só o `--allow` |

1. Explorador e verificador: chame o agente direto com a pergunta (no Claude ele recebe a linha do
   `ct` sozinho). Briefing só quando agrega: `ct.mjs brief "<tarefa>" --role=<papel>` junta o bloco
   do handoff (`--handoff=`), o "Por onde começar" dos mapas e o outline; para o executor e o
   tradutor, `--allow=<globs>` declara o escopo de escrita (sem ele, toda edição é negada).
2. O agente: no Claude, `ct-<papel>` (`context-tools:ct-<papel>` no plugin); no Codex, o
   `ct-<papel>` de `.codex/agents/`.
3. Confira a resposta antes de afirmar algo ao usuário: é evidência, não prova.

Trava: papel só-leitura não edita; papel que escreve só edita o escopo; nenhum muda o git, chama
`gh` ou escreve arquivo pelo shell. É contra engano, não um sandbox. `ct.mjs delegate status`
mostra os escopos vivos; `ct.mjs delegate clear` apaga.

Custo: `ct.mjs delegate report [--session=<id>]` mede cada subagente pelo transcript e compara com
uma ESTIMATIVA do mesmo trabalho no contexto principal — diga que é estimativa ao citar.
