# A/B da delegação a subagentes baratos — 2026-11-16

Pergunta: delegar o trabalho volumoso a um subagente Haiku (`ct-explorer`, `ct-verifier`, `ct-executor`)
deixa a sessão principal (Opus 5.5) mais barata, sem errar mais?

Resposta curta: **sim, numa sessão de contexto grande, quando a principal deixa de ler código: na
busca larga feita em várias rodadas e na correção de bug em que o executor também faz a edição.**
Ganho medido no custo marginal: −13% na exploração agrupada (até −53% num caso) e −20% nas correções
com o executor editando; delegar só a investigação da correção empatou. Nenhum braço errou (43
execuções). A amostra é pequena (2 repetições por caso).

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

**2. Sessão longa, correção de 2–3 bugs** (`cases.delegation-long.json`, 2 repetições):

| braço | resolvidos | custo marginal médio | requisições da principal |
|---|---:|---:|---:|
| `with` | 4/4 | $0,195 | 5,5 |
| `delegate-direct` | 4/4 | $0,203 | 5,5 |
| `delegate-full` | 4/4 | **$0,156 (−20%)** | 3,8 |

No `delegate-full` a principal não chamou Read nem Edit nenhuma vez: explorador (todas as perguntas
numa chamada), escopo + executor (todas as trocas numa chamada), resposta. O semver caiu de $0,239 para
$0,191 e o js-yaml de $0,153 para $0,121; o Haiku custou ~$0,005 por execução. A trava não negou nada
(as edições estavam no escopo declarado). O `with` e o `delegate-direct` desta tabela são da mesma
manhã; o `delegate-full` rodou depois, com o mesmo plugin, casos e commits.

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
  (visto no trace de `delegate-forced`). Com o executor editando, ela cai de 5,5 para 3,8 requisições.
  O preço: a principal decide pelo relato do explorador, sem ver o código — bom para bug localizado,
  arriscado para bug sutil.
- **Montar o briefing num turno à parte anulava o ganho.** Corrigido: o hook `SubagentStart` passou a
  entregar a linha do `ct` aos agentes `ct-*`, e a principal delega num turno só (`delegate-direct`).
- O Opus, quando a delegação é só sugerida, escolhe não delegar em tarefa pequena — e, pelos números,
  acerta.

## Limites

Duas repetições por caso; seis casos de sessão longa; contexto grande simulado por texto colado, não
por uma sessão real de horas; só o Claude (o Codex não foi medido aqui). Os bugs são injetados e localizados (uma ou duas linhas
cada): o `delegate-full` ainda não foi medido num bug que exija entender o desenho.

Resultados brutos: `outcome/results-2026-11-16-*.json`.
