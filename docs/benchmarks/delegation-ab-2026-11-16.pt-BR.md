# A/B da delegação a subagentes baratos — 2026-11-16

Pergunta: delegar o trabalho volumoso a um subagente Haiku (`ct-explorer`, `ct-verifier`, `ct-executor`)
deixa a sessão principal (Opus 5.5) mais barata, sem errar mais?

Resposta curta: **sim, em busca larga feita em várias rodadas, numa sessão de contexto grande; não, em
correção de bug pequena.** Ganho medido: −13% no custo marginal da exploração agrupada (até −53% num
caso), empate nas correções. Nenhum braço errou. A amostra é pequena (2 repetições por caso).

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
- **Correção não economiza**: o Edit exige que a principal leia o arquivo antes, então ela relê o
  que o explorador acabou de achar (visto no trace de `delegate-forced`).
- **Montar o briefing num turno à parte anulava o ganho.** Corrigido: o hook `SubagentStart` passou a
  entregar a linha do `ct` aos agentes `ct-*`, e a principal delega num turno só (`delegate-direct`).
- O Opus, quando a delegação é só sugerida, escolhe não delegar em tarefa pequena — e, pelos números,
  acerta.

## Limites

Duas repetições por caso; seis casos de sessão longa; contexto grande simulado por texto colado, não
por uma sessão real de horas; só o Claude (o Codex não foi medido aqui). O executor fazendo também a
edição (a principal sem ler o arquivo) não foi testado.

Resultados brutos: `outcome/results-2026-11-16-*.json`.
