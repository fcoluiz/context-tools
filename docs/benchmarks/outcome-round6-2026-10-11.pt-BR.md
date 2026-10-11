# Benchmark de resultado — rodada 6 (validação independente), 2026-10-11

As mudanças das rodadas 5b/5c (aviso de dependências, pacote de evidências enxuto, PreToolUse que
não chama teste de definição) nasceram dos rastros dos **mesmos** casos que as mediam — a medida
confirmava a correção, mas não valia como validação. Esta rodada é a que vale: **bugs novos, em dois
repositórios em que o plugin nunca tinha rodado**, com os casos escritos e conferidos antes de
qualquer execução do plugin neles. Os dois braços, Sonnet 5 e Haiku 4.5, 4 repetições por caso.

## Casos

Três bugs de uma linha, injetados por [`held-out-bugs.mjs`](outcome/held-out-bugs.mjs) (o trecho
alvo tem que casar exatamente uma vez), com a correção conferida **executando a biblioteca**, inclusive
comportamentos vizinhos que não podem quebrar. Antes da rodada: o código original passa em todas as
conferências e cada bug injetado falha. Casos: [`cases.v5.json`](outcome/cases.v5.json).

- **`fix-yaml-merge-keys`** — js-yaml 4.1.0: `<<: *base` deixa de trazer as chaves da base
  (`mergeMappings`, em `lib/loader.js`, 1.727 linhas).
- **`fix-yaml-block-chomping`** — js-yaml 4.1.0: `|-` mantém a quebra final e `|+` a remove (os dois
  indicadores trocados em `readBlockScalar`).
- **`fix-commander-long-equals`** — commander.js v15.0.0: `--port=8080` chega como `"=8080"`
  (`parseOptions`, em `lib/command.js`, 2.790 linhas).

Plugin: `main` depois da 2.7.5 com o pacote enxuto (o que vai na 2.7.6). CLI 2.1.227.

## Resultado

| modelo | braço | resolvidos | custo total |
|---|---|---:|---:|
| Sonnet 5 | sem o plugin | 12/12 | $3.71 |
| Sonnet 5 | com o plugin | 12/12 | **$2.39** (−36%) |
| Haiku 4.5 | sem o plugin | 12/12 | $2.68 |
| Haiku 4.5 | com o plugin | 12/12 | **$1.77** (−34%) |

| caso | Sonnet sem · com (turnos) | Haiku sem · com (turnos) |
|---|---|---|
| fix-yaml-merge-keys | $1.48 (13–30) · $0.74 (7–10) | $1.15 (29–45) · $0.51 (20–25) |
| fix-yaml-block-chomping | $1.36 (13–24) · $1.03 (9–12) | $0.97 (20–36) · $0.68 (20–27) |
| fix-commander-long-equals | $0.86 (9–14) · $0.62 (5–9) | $0.56 (21–24) · $0.58 (19–23) |

Dados brutos: [`results-2026-10-11-round6-default.json`](outcome/results-2026-10-11-round6-default.json),
[`results-2026-10-11-round6-haiku.json`](outcome/results-2026-10-11-round6-haiku.json).

## O que dá para ler

- **Todos resolveram tudo, nos dois braços.** Em correção de bug com sintoma claro, o plugin não
  muda a taxa de acerto — o que muda é quanto custa chegar lá.
- **Mais barato nos dois modelos, e o oposto da rodada 5 no Haiku.** Lá o Haiku saiu 19% mais caro
  com o plugin; aqui, 34% mais barato. No Sonnet, 36%. A maior diferença é em `merge-keys`, onde o
  agente precisa achar `mergeMappings` num arquivo de 1.700 linhas a partir de um sintoma: com o plugin,
  metade do custo e menos da metade dos turnos no Sonnet.
- **Menos variação.** No Sonnet, o pior caso de cada bug com o plugin ficou abaixo do melhor sem ele em
  `merge-keys` e `block-chomping`.
- **Onde não ajudou:** `commander-long-equals` no Haiku ficou igual ($0.56 contra $0.58). O sintoma
  (`--port=`) leva direto ao trecho que trata `=`, e os dois braços chegaram lá no mesmo número de turnos.

## O vazamento que a primeira tentativa do Haiku encontrou

A primeira execução do Haiku nesta rodada achou um atalho no próprio harness: o bug injetado era
commitado como "benchmark baseline" por cima do histórico do repositório, e `git log -p` mostrava
exatamente a linha quebrada. O Haiku achou o bug assim em **8 de 20 execuções** (4 em cada braço); o
Sonnet, em 1 de 24 (braço com o plugin); na rodada 5, 2 de 48. Um bug de verdade não vem com o diff que
o criou. O harness agora começa a cópia de um caso com `setup` num commit único, sem histórico nem
origem para comparar, e o Haiku foi medido de novo assim — os números acima são dessa segunda medida.
A primeira fica publicada para comparação
([`results-2026-10-11-round6-haiku-history-leak.json`](outcome/results-2026-10-11-round6-haiku-history-leak.json):
10/10 nos dois braços, $3.29 sem e $1.82 com o plugin, 4 execuções não iniciadas pelo teto de custo).
Os dados do Sonnet são da primeira execução; a única que usou o histórico está no braço com o plugin.

## Limites

Quatro repetições por braço; dois repositórios, ambos JavaScript; bugs de uma linha com sintoma bem
descrito. Não mede perguntas de leitura (rodadas 3 e 4) nem trabalho em várias sessões.

Custo: $6.10 (Sonnet), $4.45 (Haiku), $5.11 (a execução com vazamento).
