# Benchmark de resultado — rodada 4, 2026-10-10

O erro que restou na rodada 3 ([outcome-round3](outcome-round3-2026-10-10.pt-BR.md)) foi uma busca
qualificada: o Haiku procurou `DateTimeUtils\.EnsureDateTime` e perdeu as 4 chamadas feitas de
dentro da própria classe, que não usam o prefixo — 1/5 com e sem o plugin. Esta rodada mede o aviso
criado para isso. Só o braço **com** o plugin foi executado; o braço sem o plugin não muda com uma
alteração do plugin, então a comparação usa o da rodada 3 (mesmos casos, mesmos commits, mesmo CLI).

## O que mudou no plugin

Antes de um Grep (ou `rg`/`grep`) com padrão `Prefixo.nome` — `DateTimeUtils\.EnsureDateTime`,
`util.cleanRegex`, `Classe.metodo(` —, o hook lê o arquivo que define `nome` e lista as chamadas
soltas a `nome` ali dentro, sem o prefixo, com o método que contém cada uma. `valor.ToString()` não
conta (é outro objeto); `self.`/`this.` não disparam; comentário e string não contam.

**O texto do aviso importou.** A primeira versão dizia só que essas chamadas "não vão aparecer nesta
busca". O Haiku recebia o aviso — conferido pedindo que ele o citasse — e mesmo assim as deixava de
fora: **0/5** ([dados](outcome/results-2026-10-10-round4-haiku-first-wording.json)). Ele lia "quem
chama `DateTimeUtils.EnsureDateTime`" como "quem chama de fora da classe". A versão final diz que
esses lugares **também chamam** `DateTimeUtils.EnsureDateTime` e que devem contar como chamadores.

## Resultado (versão final)

| modelo · casos | sem o plugin (rodada 3) | com o plugin (rodada 3) | com o plugin (rodada 4) |
|---|---:|---:|---:|
| Sonnet 5 · 5 casos novos | 21/25 · $3.58 | 24/25 · $2.72 | **25/25 · $2.51** |
| Haiku 4.5 · 11 casos | 48/55 · $4.70 | 50/55 · $3.02 | **53/55 · $3.86** |

| caso (Haiku) | sem (r3) | com (r3) | com (r4) |
|---|---|---|---|
| qa-newtonsoft-ensuredatetime-callers | 1/5 · 13–39 turnos | 1/5 · 2 turnos | **4/5** · 2–12 turnos |
| ts-zod-escaperegex-users | 3/5 · 9–20 turnos | 5/5 | 4/5 |
| qa-commons-lang-strings-null | 4/5 | 5/5 | 5/5 |
| qa-newtonsoft-additional-text | 5/5 | 5/5 | 5/5 |
| py-requests-redirect-limit | 5/5 | 4/5 | 5/5 |
| os outros 6 casos | 30/30 | 30/30 | 30/30 |

Dados brutos: [`results-2026-10-10-round4-default.json`](outcome/results-2026-10-10-round4-default.json),
[`results-2026-10-10-round4-haiku.json`](outcome/results-2026-10-10-round4-haiku.json).

## O que dá para ler

- **Sonnet: 25/25 nos casos novos**, sem nenhum erro, e o menor custo das três medidas (−30% contra
  sem o plugin).
- **Haiku: 53/55**, o melhor resultado até aqui. O caso `EnsureDateTime` foi de 1/5 para 4/5; a
  execução que ainda errou repetiu a busca qualificada duas vezes e deixou as 4 chamadas de fora.
  A outra falha (`escapeRegex`) parou de ler antes de chegar ao `schemas.ts`.
- **O custo do Haiku com o plugin subiu em relação à rodada 3 ($3.02 → $3.86) — e não por causa do
  hook.** Em `additional-text`, com os mesmos 3 turnos, as execuções desta rodada leram o
  `JsonTextReader.cs` (~37 mil tokens de cache a mais por execução); na rodada 3, respondiam só com o
  Grep anotado. Uma execução de `EnsureDateTime` levou 12 turnos e custou $0.30 sozinha. É variação de
  comportamento do modelo; continua 18% abaixo do braço sem o plugin.

## Limites

O braço sem o plugin vem da rodada 3 (horas antes, mesmo CLI e modelos). Cinco repetições por braço.
O ajuste do texto do aviso foi feito olhando este mesmo caso — o 4/5 confirma a correção, não é uma
medida independente.
