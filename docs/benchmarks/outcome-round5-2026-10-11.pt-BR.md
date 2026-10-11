# Benchmark de resultado — rodada 5, 2026-10-11

As rodadas anteriores tinham uma só tarefa de **correção**; o resto era leitura. Esta rodada mede
correção de bug em casos que o plugin nunca viu, em JavaScript: três bugs injetados no
[node-semver](https://github.com/npm/node-semver) (sem dependências), mais uma pergunta de leitura.
Plugin 2.7.3 com a correção do parser de JS/TS (2.7.4). Sonnet 5 e Haiku 4.5, com e sem o plugin,
4 repetições por braço — 64 execuções válidas.

## Casos

- **`fix-semver-max-satisfying`** — `maxSatisfying` devolve a menor versão (comparação invertida em
  `ranges/max-satisfying.js`).
- **`fix-semver-caret-zero-minor`** — `^0.2.3` aceita `0.3.0` (uma condição em `replaceCaret`,
  arquivo de 578 linhas com vários ramos quase iguais).
- **`fix-semver-inc-patch-prerelease`** — `inc('1.2.0-5', 'patch')` devolve `1.2.1` (`classes/semver.js`).
- **`js-semver-isx-users`** — quais funções de `classes/range.js` chamam `isX` (5; `replaceTildes`
  no lugar de `replaceTilde` conta como erro).

Os bugs são injetados por [`semver-bugs.mjs`](outcome/semver-bugs.mjs), que exige exatamente uma
ocorrência do trecho alvo; a correção é conferida **executando a biblioteca** (vários casos por bug,
incluindo comportamentos vizinhos que não podem quebrar), não pelos testes do projeto. Antes da
rodada: o código original passa em todas as conferências e cada bug injetado falha. Casos:
[`cases.v4.json`](outcome/cases.v4.json).

## Resultado

| modelo | braço | resolvidos | custo total |
|---|---|---:|---:|
| Sonnet 5 | sem o plugin | 16/16 | $4.08 |
| Sonnet 5 | com o plugin | 16/16 | **$3.13** (−23%) |
| Haiku 4.5 | sem o plugin | 16/16 | $1.81 |
| Haiku 4.5 | com o plugin | 16/16 | $2.16 (**+19%**) |

| caso | Sonnet sem · com (turnos) | Haiku sem · com (turnos) |
|---|---|---|
| fix-semver-max-satisfying | $0.93 (9–13) · $0.89 (10–12) | $0.49 (18–22) · $0.47 (16–23) |
| fix-semver-caret-zero-minor | $1.29 (11–22) · $1.00 (10–15) | $0.75 (20–30) · $1.03 (24–42) |
| fix-semver-inc-patch-prerelease | $1.39 (12–26) · $0.91 (8–14) | $0.42 (10–22) · $0.51 (14–25) |
| js-semver-isx-users | $0.47 (3–6) · $0.33 (2–3) | $0.15 (2) · $0.15 (2) |

Dados brutos: [`results-2026-10-11-round5-default.json`](outcome/results-2026-10-11-round5-default.json),
[`results-2026-10-11-round5-haiku.json`](outcome/results-2026-10-11-round5-haiku.json).

## O que dá para ler

- **Todos resolveram tudo.** Em correção de bug com uma descrição clara do sintoma, os dois modelos
  acham e corrigem sem ajuda; o plugin não muda a taxa de acerto aqui.
- **No Sonnet, o plugin barateia a correção:** −23% no total, com menos turnos nos dois bugs mais
  difíceis de localizar (`caret`: 10–15 contra 11–22; `inc`: 8–14 contra 12–26).
- **No Haiku, não ajudou — e custou mais.** +19% no total, puxado pelo caso `caret` (24–42 turnos
  contra 20–30). Os rastros não mostram um desperdício próprio do plugin: nos dois braços o Haiku
  tenta `npm test`/`npm install` (as dependências de teste não estão instaladas na cópia), verifica
  a correção com `node -e` e lê `range.js` aos pedaços; com o plugin fez mais Grep e Read antes de
  editar. Com 4 repetições as faixas se sobrepõem. Não foi feito ajuste no plugin para este caso —
  ajustar olhando a própria medida é o que torna a medida inútil —, e o resultado fica registrado
  como está: **em correção de bug no Haiku, o plugin não é uma vantagem medida.**
- **A pergunta de leitura confirma o padrão das rodadas anteriores** no Sonnet (−30%, 2–3 turnos);
  no Haiku os dois braços resolveram em 2 turnos.

## A correção que esta rodada exigiu antes de rodar

Ao preparar o caso `isX`, o outline do node-semver mostrava as linhas de `replaceTilde` como se
estivessem num "método" `debug()`: o parser de JS/TS tomava qualquer chamada indentada num arquivo
com classe por declaração de método. Corrigido antes da rodada (diff de conjunto de símbolos:
node-semver −31, todos `debug()`; zod −81, todos chamadas; nada novo). Sem isso, o contexto do Grep
teria dado o método errado justamente neste repositório.

## Limites

Quatro repetições por braço; um repositório; bugs de uma linha com sintoma bem descrito. Os
números de custo do Haiku em correção variam muito entre execuções (14 a 42 turnos no mesmo caso).
