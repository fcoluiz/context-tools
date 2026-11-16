# A/B da delegação a subagentes baratos — 2026-11-16

Pergunta: delegar o trabalho volumoso a um subagente Haiku (`ct-explorer`, `ct-verifier`, `ct-executor`)
deixa a sessão principal (Opus 5.5) mais barata, sem errar mais?

Resposta curta: **sim, numa sessão de contexto grande, quando a principal deixa de ler código: na
busca larga feita em várias rodadas e na correção de bug em que o executor também faz a edição.**
Ganho medido no custo marginal: −13% na exploração agrupada (até −53% num caso), −13% nas correções
simples e **−44% nas correções em que a causa fica longe do sintoma**, com o executor editando;
delegar só a investigação da correção empatou. Nenhum braço errou (61 execuções). A amostra é pequena
(2 a 3 repetições por caso) e a variação entre repetições é grande: nas correções simples, 2 de 7
execuções delegadas custaram mais que a média do `with`.

## Como foi medido

`scripts/benchmark-outcome.mjs`, `claude -p` (CLI 2.1.300, Windows), sessão principal
`claude-opus-5-5`, cópia limpa de repositórios públicos em commit fixo, resultado conferido por
comando ou por expressão sobre a resposta. Os dois braços carregam o plugin desta versão (skill,
agentes `ct-*`, trava); muda só uma instrução de sistema:

| braço | instrução |
|---|---|
| `with` | nenhuma |
| `delegate` | delegue o trabalho volumoso, montando o prompt com `ct brief` |
| `delegate-forced` | não leia o código: toda investigação vai ao `ct-explorer`, via `ct brief` |
| `delegate-direct` | idem, mas chamando o agente direto (sem o turno do `ct brief`), perguntas independentes numa chamada só |
| `delegate-full` | não leia nem edite: o explorador acha e propõe a troca; o executor aplica, com o escopo declarado por `ct delegate scope` na mesma mensagem |

Custo em preço de lista da API, como o CLI informa (a conta era de assinatura: o valor é
comparativo). "Sessão longa" = ~80k tokens de documentação pública deste repositório colados antes
do pedido (`prelude` nos casos), para a sessão principal começar com o contexto grande.

## Resultados

**1. Tarefas curtas, contexto pequeno** (8 casos, 1 repetição; `cases.delegation.json`):
`with` 8/8 e $1,28; `delegate` 8/8 e $1,15 — mas o Opus **não delegou nenhuma vez**: com o `ct` à
mão, cada tarefa levou de 2 a 11 turnos e não valia abrir um subagente. Diferença = ruído (o mesmo
caso variou de $0,25 para $0,13). Forçando (`delegate-forced`, 4 buscas): mesmo patamar, ~$0,13 cada;
o Haiku custou $0,001–0,003 por chamada.

**2. Sessão longa, correção de 2–3 bugs localizados** (`cases.delegation-long.json`; duas rodadas,
a segunda com `with` e `delegate-full` lado a lado, cortada pelo limite de uso depois de 6 execuções):

| braço | resolvidos | custo marginal médio | requisições da principal |
|---|---:|---:|---:|
| `with` | 7/7 | $0,195 | 5,4 |
| `delegate-direct` | 4/4 | $0,203 | 5,5 |
| `delegate-full` | 7/7 | **$0,170 (−13%)** | 4,1 |

Por caso: semver $0,233 → $0,198 (−15%), js-yaml $0,145 → $0,132 (−9%). Na rodada lado a lado a
diferença foi menor (−4%), e uma execução delegada do semver custou $0,248, mais que qualquer `with`.
No `delegate-full` a principal não chamou Read nem Edit nenhuma vez: explorador (todas as perguntas
numa chamada), escopo + executor (todas as trocas numa chamada), resposta. O Haiku custou ~$0,005 por
execução. A trava não negou nada (as edições estavam no escopo declarado).

**2b. Sessão longa, bugs com a causa longe do sintoma** (`cases.delegation-hard.json`, 3 repetições,
braços lado a lado). O relato cita uma função pública; a causa está num módulo interno que outras
funções usam (`internal/identifiers.js` e `internal/parse-options.js` no semver; o laço de
`testImplicitResolving` e o `mergeMappings` no js-yaml). O check confere também as outras funções,
então remendar só a função citada não passa.

| braço | resolvidos | custo marginal médio | requisições da principal |
|---|---:|---:|---:|
| `with` | 6/6 | $0,364 | 9,7 |
| `delegate-full` | 6/6 | **$0,205 (−44%)** | 5,0 |

Por caso: semver $0,448 → $0,227 (−49%), js-yaml $0,279 → $0,184 (−34%); as 6 execuções delegadas
custaram menos que todas as 6 do `with`. O explorador (Haiku) achou a causa nos módulos internos nas 6,
rodando o código para confirmar; numa delas a principal pediu uma segunda rodada ao explorador antes
de decidir. Os dois braços mudaram só os 2 arquivos-fonte, nenhum teste. Haiku: $0,006–0,010 por
execução.

**3. Sessão longa, várias perguntas de busca larga** (`cases.delegation-explore.json`, 2 repetições):

| braço | resolvidos | custo marginal médio | requisições da principal |
|---|---:|---:|---:|
| `with` | 4/4 | $0,119 | 3,3 |
| `delegate-direct` | 4/4 | **$0,103** | 2,5 |

No commons-lang (2 perguntas), $0,150 → $0,071 nas duas repetições; no Newtonsoft (3 perguntas),
uma repetição empatou e a outra custou mais (o Opus chamou o explorador duas vezes).

"Custo marginal" tira a primeira requisição da principal, a que grava o prefixo de ~140k tokens no
cache: $1,02 em toda execução, igual nos dois braços, e que numa sessão longa real já estaria paga
(`outcome/marginal-cost.cjs` refaz a conta a partir dos traces).

## O que explica

- **O custo de uma sessão grande é o número de turnos da principal**: cada turno relê o contexto
  inteiro. Delegar só compensa quando a chamada ao agente substitui várias rodadas de busca.
- **Correção só economiza se a edição também sair da principal**: o Edit exige que quem edita leia o
  arquivo antes, então com só a investigação delegada a principal relia o que o explorador achou
  (visto no trace de `delegate-forced`). Com o executor editando, a principal deixa de ler código.
- **Quanto mais a principal teria de explorar, mais a delegação ganha**: no bug localizado o `with`
  resolve em ~5 requisições e sobra pouco para economizar (−13%, com repetições em que perde); quando a
  causa está longe do sintoma, o `with` vai a ~10 requisições e a delegação corta pela metade (−44%).
- O preço: a principal decide pelo relato do explorador, sem ver o código. Nos 13 casos medidos o
  relato estava certo; um relato errado viraria uma correção errada, e só o check (ou o verificador)
  pega.
- **Montar o briefing num turno à parte anulava o ganho.** Corrigido: o hook `SubagentStart` passou a
  entregar a linha do `ct` aos agentes `ct-*`, e a principal delega num turno só (`delegate-direct`).
- O Opus, quando a delegação é só sugerida, escolhe não delegar em tarefa pequena — e, pelos números,
  acerta.

## Limites

Duas a três repetições por caso; oito casos de sessão longa; contexto grande simulado por texto
colado, não por uma sessão real de horas; só o Claude (o Codex não foi medido aqui). Os bugs são
injetados: mesmo os "difíceis" têm causa de uma linha, e ainda não foi medido um bug que exija mudar o
desenho. Sessão curta com `delegate-full` não foi medida (a rodada parou no limite de uso antes do
primeiro resultado); pela seção 1, ali a delegação não deve compensar.

Resultados brutos: `outcome/results-2026-11-16-*.json`.
