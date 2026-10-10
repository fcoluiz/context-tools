# Benchmark de resultado — rodada 2, 2026-10-10

Segunda rodada de `scripts/benchmark-outcome.mjs`, já com as correções do piloto
([outcome-pilot-2026-10-09](outcome-pilot-2026-10-09.pt-BR.md)) — context-tools 2.7.1. Seis casos
([`outcome/cases.v2.json`](outcome/cases.v2.json)), 5 repetições por braço, 60 execuções:

- os três do piloto;
- **quem chama `DateTimeUtils.EnsureDateTime`** no Newtonsoft.Json: 13 métodos em 10 arquivos (fora
  os testes) — uma pergunta de "quem usa X" em que o Grep devolve linhas sem o método em volta;
- **quais métodos do `JsonTextReader` lançam** "Additional text encountered after finished reading
  JSON content" (`Read()` e `ReadFinished()`);
- **quais métodos do `StringUtils`** (commons-lang, 9.435 linhas) lançam "Strings must not be null",
  contando as duas sobrecargas de `getLevenshteinDistance`.

O gabarito dos casos novos foi conferido à mão contra o código no commit fixado (cabeçalho de cada
método), não só pela ferramenta. CLI: Claude Code 2.1.227, modelo padrão, conta claude.ai — o custo
é o que o CLI informa por execução, uma estimativa numa conta de assinatura. Dados brutos, com a
resposta e as ferramentas de cada execução: [`outcome/results-2026-10-10.json`](outcome/results-2026-10-10.json).

## Resultado

| braço | resolvidos | custo total |
|---|---:|---:|
| sem o plugin | 26/30 | $5.85 |
| com o plugin (2.7.1) | 28/30 | $4.99 |

| caso | sem: resolvidos · custo · turnos | com: resolvidos · custo · turnos |
|---|---|---|
| qa-newtonsoft-maxdepth | 4/5 · $0.49 · 3,3,3,3,3 | 5/5 · $0.54 · 4,3,3,4,2 |
| qa-newtonsoft-ensuredatetime-callers | 2/5 · $1.33 · 13,16,22,13,16 | 3/5 · $0.84 · 5,6,6,7,9 |
| qa-newtonsoft-additional-text | 5/5 · $0.56 · 4,5,4,6,4 | 5/5 · $0.44 · 3,3,2,3,3 |
| qa-commons-lang-abbreviate | 5/5 · $0.68 · 5,5,5,5,5 | 5/5 · $0.68 · 5,5,5,4,3 |
| qa-commons-lang-strings-null | 5/5 · $0.65 · 2,3,3,3,4 | 5/5 · $0.54 · 10,6,6,2,2 |
| fix-qualified-lookup | 5/5 · $2.14 · 16,9,16,12,12 | 5/5 · $1.95 · 11,11,9,13,9 |

## O que os rastros mostram

- **O erro do piloto reapareceu — no braço sem o plugin.** A execução sem o plugin que errou o
  `MaxDepth` viu `356-359` no Grep e nomeou `SetStateBasedOnCurrent` em vez de `Push`, o mesmo
  mecanismo do piloto. Com o plugin, que agora diz o método de cada linha, foram 5/5.
- **Os hooks chegam ao agente; o `stream-json` é que não os mostra.** O transcript registra o
  `SessionStart`, mas não o que `PreToolUse`/`PostToolUse` acrescentam. Conferido de duas formas: o
  estado em disco de uma cópia mantida (`.pre-tool-answers.json`, `.hook-emissions`) e um agente
  que, perguntado, citou literalmente o 🔎 de antes do Grep e o 🧭 de depois.
- **O hook do Grep cortava em silêncio.** No caso `EnsureDateTime`, o Grep traz 11 arquivos; o hook
  anotava os 8 primeiros e parava, e um deles era um teste. Ficavam de fora `DateTimeUtils` (4 dos
  13 chamadores) e os dois `JsonSerializerInternal*`. Uma execução com o plugin errou exatamente os 4
  de `DateTimeUtils` — o arquivo que tinha ficado fora da lista anotada.
- **Sem parâmetros, o agente abria cada sobrecarga.** No caso do `StringUtils` a pergunta pede a
  lista de parâmetros; o hook dava nome e intervalo, e o agente lia cada método à parte (até 10
  turnos) — ainda mais barato que sem o plugin, mas com mais idas e vindas.
- **Sem o plugin, o custo do "quem usa X" está em reconstruir o método de cada linha**: 13 a 22
  turnos lendo arquivo por arquivo, ou fazendo Grep de cabeçalhos com regex. Mesmo assim, 3 das 5
  execuções erraram (um `SetToken` de 70 linhas cujo cabeçalho não aparece perto do uso).
- **O enunciado também pesa**: uma execução sem o plugin deixou de fora os mesmos 4 chamadores de
  dentro do `DateTimeUtils`, lendo "quem chama" como "quem chama de fora". Na execução com o plugin
  que errou esses 4, as duas causas — o corte e essa leitura — são possíveis; o rastro não separa.

## Correção e nova medida

O hook passou a anotar até 20 arquivos com código de produção antes de teste, a **nomear os arquivos
que ficam de fora** em vez de cortar em silêncio, e a incluir a linha da declaração (os parâmetros)
quando cabe no orçamento. Mesmos dois casos, só o braço com o plugin, 5 repetições:

| caso | sem o plugin | com 2.7.1 | com o hook corrigido |
|---|---|---|---|
| qa-newtonsoft-ensuredatetime-callers | 2/5 · $1.33 · 13–22 turnos | 3/5 · $0.84 · 5–9 turnos | **5/5 · $0.49 · 2 turnos em todas** |
| qa-commons-lang-strings-null | 5/5 · $0.65 · 2–4 turnos | 5/5 · $0.54 · 2–10 turnos | **5/5 · $0.43 · 2–3 turnos** |

Nas dez execuções o agente respondeu depois de um Grep (dois, numa delas), sem abrir arquivo: a
lista anotada tinha os 13 chamadores, e no `StringUtils` cada sobrecarga vinha com a própria
assinatura.

São 10 execuções de um braço só, nos dois casos em que o defeito apareceu — confirmam a correção,
não substituem uma rodada completa. A próxima rodada completa deve trazer casos novos, que o hook
não tenha visto ao ser ajustado.
