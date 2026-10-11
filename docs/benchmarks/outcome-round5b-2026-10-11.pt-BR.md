# Benchmark de resultado — rodada 5b, 2026-10-11

A [rodada 5](outcome-round5-2026-10-11.pt-BR.md) registrou a primeira linha em que o plugin custou
mais: Haiku 4.5 corrigindo bugs no node-semver, +19%. Os rastros não mostravam desperdício próprio do
plugin, mas também não mostravam o que os hooks injetavam — o `stream-json` não traz a saída de
PreToolUse/PostToolUse. Esta rodada repete **só o braço com o plugin**, nos três casos de correção,
duas vezes:

- **5b** — com o aviso de dependências não instaladas no SessionStart e o registro do que cada hook
  injetou (`CONTEXT_TOOLS_HOOK_LOG`), ambos da 2.7.5;
- **5c** — o mesmo, mais o pacote de evidências enxuto antes do Grep (a correção que a 5b motivou).

Haiku 4.5, 4 repetições por caso, 12 execuções válidas em cada uma. Casos, commit e conferência
iguais aos da rodada 5 ([`cases.v4.json`](outcome/cases.v4.json), sem o caso de leitura).

## Resultado

| braço | resolvidos | custo total | tentativas de `npm test`/`npm install` |
|---|---:|---:|---:|
| sem o plugin (rodada 5) | 12/12 | $1.66 | 36 |
| com o plugin 2.7.4 (rodada 5) | 12/12 | $2.01 (+21%) | 38 |
| com o aviso de dependências (5b) | 12/12 | $1.77 (+7%) | 23 |
| com o aviso e o pacote enxuto (5c) | 12/12 | $1.48 (−11%) | 25 |

| caso | 2.7.4 (r5) | 5b | 5c |
|---|---|---|---|
| fix-semver-max-satisfying | $0.47 · 16–23 turnos | $0.48 · 12–23 | $0.48 · 14–27 |
| fix-semver-caret-zero-minor | $1.03 · 24–42 | $0.86 · 23–31 | $0.62 · 9–29 |
| fix-semver-inc-patch-prerelease | $0.51 · 14–25 | $0.44 · 13–16 | $0.38 · 9–16 |

Os números da rodada 5 aqui são só dos três casos de correção (a tabela do README inclui a pergunta
de leitura, por isso +19% lá e +21% aqui). Dados brutos:
[`results-2026-10-11-round5b-haiku.json`](outcome/results-2026-10-11-round5b-haiku.json),
[`results-2026-10-11-round5c-haiku.json`](outcome/results-2026-10-11-round5c-haiku.json) — cada
resultado traz agora o campo `hooks`, com quantas saídas e quantos caracteres cada hook emitiu.

## O que o registro dos hooks mostrou (5b)

- **SessionStart:** ~600 caracteres por execução (documentação, comando de teste, mapas), em todas.
- **O pacote de evidências do PreToolUse era o maior gasto.** Em `max-satisfying`, a busca por
  `compare` bateu o teto de 3.200 caracteres em 3 de 4 execuções (uma somou 4.511 em duas buscas).
  O conteúdo era quase todo ruído: 6 das 8 "definições exatas" eram `const compare =
  require('./compare')`, seguidas de 24 definições parciais (`compareBuild`, `rcompare`, testes) e
  de correspondências textuais que o próprio Grep devolveria em seguida.
- **O aviso de dependências chega ao agente** ("Dependencies are NOT installed… it will fail until
  `npm install`") e as tentativas de `npm test`/`npm install` caíram de 38 para 23 — mas não sumiram:
  o Haiku recebe o aviso e tenta mesmo assim.

## O que mudou entre 5b e 5c

O pacote antes do Grep, quando o nome tem uma definição exata real, passou a trazer as definições,
uma linha com os arquivos que só importam o nome e uma linha de nomes parecidos; sem outline do
arquivo homônimo nem correspondências textuais. A mesma busca por `compare` caiu de 3.200 para 609
caracteres, com a contagem de importações completa (12 arquivos; antes, 6 de uma lista cortada em 8).
Nas execuções, o PreToolUse de `max-satisfying` foi de 3.200 · 1.311 · 3.200 · 4.511 caracteres para
623 · 0 · 0 · 304.

## O que dá para ler — e o que não dá

- **Todos resolveram tudo**, nas duas rodadas; nenhuma mudança piorou a taxa de acerto.
- **O aviso de dependências tirou um terço das tentativas inúteis de npm.** É o efeito mais direto e
  o único que aparece nos rastros de forma consistente.
- **O pacote enxuto reduziu o contexto injetado, mas não mostrou efeito de custo.** No único caso em
  que o pacote disparou com frequência (`max-satisfying`), o custo ficou igual ($0.48 nas duas). A
  queda do total na 5c veio de `caret` e `inc`, onde o pacote disparou em 1 de 8 execuções — isso é
  variação do Haiku (9 a 29 turnos no mesmo caso), não a correção.
- **Não é uma medida independente.** As duas mudanças nasceram dos rastros destes mesmos casos, o
  braço sem o plugin não foi refeito, e 4 repetições não separam +7% de −11% com segurança. A linha
  da rodada 5 no README continua como medida; esta rodada explica de onde vinha o custo, não o
  substitui.

## Conferência de regressão nas perguntas de leitura (rodada 4b)

O pacote enxuto tirou informação do contexto (linhas textuais, local das definições parciais) e o
PreToolUse passou a calar quando só há nomes de teste parecidos. O risco estava nas perguntas de
leitura, onde o plugin mais rendia. Repetido o braço com o plugin da
[rodada 4](outcome-round4-2026-10-10.pt-BR.md) no Haiku 4.5 — 11 casos × 5, mesmos commits —, com
as duas mudanças:

| | rodada 4 (2.7.3) | rodada 4b (este PR) |
|---|---:|---:|
| resolvidos | 53/55 | **53/55** |
| custo total | $3.86 | $3.47 |

Por caso, 9 dos 11 repetiram o resultado. `ts-zod-escaperegex-users` foi de 4/5 para 5/5;
`py-requests-redirect-limit` foi de 5/5 para 4/5, com a mesma resposta errada que a rodada 3 já
registrava (`Session.resolve_redirects`, sem `SessionRedirectMixin`). A falha que restou em
`EnsureDateTime` é a mesma da rodada 4 (as chamadas internas ficaram de fora). Nenhuma mudança de
acerto aponta para o pacote; o custo menor está dentro da variação. Dados:
[`results-2026-10-11-round4b-haiku.json`](outcome/results-2026-10-11-round4b-haiku.json).

Nesta rodada, um agente escreveu o caminho da cópia temporária numa grafia que não existe
(`/d/<usuário>/AppData/…`), que o anonimizador não cobria; o harness agora troca por `<copy>`
qualquer caminho que termine no nome único da cópia, e os dados publicados foram corrigidos assim.

Custo destas rodadas: $3.25 (5b + 5c) e $3.47 (4b).
