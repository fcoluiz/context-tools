# Benchmark de resultado — rodada 3, 2026-10-10

Duas perguntas: o ganho das rodadas anteriores se mantém em **casos que o plugin nunca viu**? E num
**modelo menor**? Plugin com os hooks da 2.7.2. 160 execuções válidas, 5 repetições por braço.

- **Casos novos (validação):** cinco perguntas de leitura em TypeScript (zod) e Python (requests),
  escritas depois dos ajustes da 2.7.2 — [`outcome/cases.v3.json`](outcome/cases.v3.json). Gabarito
  conferido à mão contra o código no commit fixado; uma das menções a `escapeRegex` está em código
  comentado e não conta.
- **Haiku:** os 6 casos da rodada 2 mais os 5 novos ([`outcome/cases.all.json`](outcome/cases.all.json))
  com `--model=haiku` (Claude Haiku 4.5).
- Modelo padrão do CLI: Claude Sonnet 5. CLI 2.1.227, conta claude.ai; o custo é o que o CLI informa
  por execução — uma estimativa numa conta de assinatura.
- Dados brutos: [`results-2026-10-10-round3-default.json`](outcome/results-2026-10-10-round3-default.json)
  e [`results-2026-10-10-round3-haiku.json`](outcome/results-2026-10-10-round3-haiku.json).

## Resultado

| modelo · casos | braço | resolvidos | custo total |
|---|---|---:|---:|
| Sonnet 5 · 5 casos novos | sem o plugin | 21/25 | $3.58 |
| Sonnet 5 · 5 casos novos | com o plugin | **24/25** | **$2.72** (−24%) |
| Haiku 4.5 · 11 casos | sem o plugin | 48/55 | $4.70 |
| Haiku 4.5 · 11 casos | com o plugin | **50/55** | **$3.02** (−36%) |

### Sonnet 5, casos novos

| caso | sem: resolvidos · custo · turnos | com: resolvidos · custo · turnos |
|---|---|---|
| ts-zod-escaperegex-users | 5/5 · $0.91 · 5,6,7,7,5 | 5/5 · $0.58 · 2,8,3,3,2 |
| ts-zod-cleanregex-users | 5/5 · $0.75 · 3,4,7,4,4 | 5/5 · $0.64 · 3,3,3,4,6 |
| py-requests-to-native-string-callers | 5/5 · $0.97 · 12,10,9,12,15 | 5/5 · $0.63 · 8,5,9,8,8 |
| py-requests-two-tuples | 5/5 · $0.46 · 3,3,2,3,3 | 5/5 · $0.39 · 2,2,2,2,2 |
| py-requests-redirect-limit | 1/5 · $0.49 · 4,2,3,3,4 | 4/5 · $0.48 · 3,3,2,3,2 |

### Haiku 4.5, 11 casos

| caso | sem: resolvidos · custo · turnos | com: resolvidos · custo · turnos |
|---|---|---|
| qa-newtonsoft-maxdepth | 5/5 · $0.29 · 6,5,4,4,4 | 5/5 · $0.25 · 4,5,3,9,3 |
| qa-newtonsoft-ensuredatetime-callers | 1/5 · $0.52 · 33,14,15,39,13 | 1/5 · $0.12 · 2,2,2,2,2 |
| qa-newtonsoft-additional-text | 5/5 · $0.34 · 5,6,3,3,4 | 5/5 · $0.12 · 2,2,3,3,3 |
| qa-commons-lang-abbreviate | 5/5 · $0.24 · 4,7,8,7,6 | 5/5 · $0.19 · 6,3,3,3,6 |
| qa-commons-lang-strings-null | 4/5 · $0.17 · 7,7,7,7,3 | 5/5 · $0.17 · 3,6,6,8,2 |
| fix-qualified-lookup | 5/5 · $1.06 · 17,32,24,21,12 | 5/5 · $0.93 · 20,20,25,16,19 |
| ts-zod-escaperegex-users | 3/5 · $0.68 · 20,9,16,20,11 | 5/5 · $0.14 · 3,3,2,2,2 |
| ts-zod-cleanregex-users | 5/5 · $0.65 · 9,10,6,10,9 | 5/5 · $0.45 · 7,4,3,3,3 |
| py-requests-to-native-string-callers | 5/5 · $0.38 · 6,15,6,6,6 | 5/5 · $0.30 · 6,6,7,8,8 |
| py-requests-two-tuples | 5/5 · $0.13 · 4,3,3,3,3 | 5/5 · $0.11 · 3,2,3,2,2 |
| py-requests-redirect-limit | 5/5 · $0.23 · 6,8,7,12,5 | 4/5 · $0.22 · 10,9,5,5,4 |

## O que dá para ler

- **Nos casos novos, o plugin nunca resolveu menos e sempre custou menos.** Com o Sonnet, de 2% a
  36% mais barato em cada um dos 5 casos (15% a 36% nos quatro de "quem usa X"); com o Haiku, mais barato ou igual em todos os 11. A
  vantagem de acertos é pequena e concentrada: no Sonnet, inteira no caso do redirecionamento.
- **O redirecionamento mede precisão de localização.** Sem o plugin, o Sonnet respondeu
  `Session.resolve_redirects` — o método é herdado; está definido em `SessionRedirectMixin`, e a
  pergunta pede onde exatamente a verificação fica. É o mesmo tipo de imprecisão do `MaxDepth`
  (linha vista no Grep, classe ou método deduzido), e o gabarito exige a classe que define o método.
  Com o Haiku, esse caso inverteu (5/5 sem, 4/5 com): a execução que errou com o plugin também
  escreveu `Session.resolve_redirects`.
- **O Haiku é onde o plugin rende mais.** Sem ele, o Haiku reconstrói o método de cada linha com
  muitas idas e vindas: 20 turnos em "quem usa `escapeRegex`" (3/5 resolvidos), até 39 em "quem chama
  `EnsureDateTime`". Com ele, 2 a 3 turnos. Custo total 36% menor.
- **`EnsureDateTime` no Haiku: 1/5 nos dois braços, pelo mesmo motivo.** O Haiku procura pelo nome
  qualificado (`DateTimeUtils\.EnsureDateTime`) e perde as 4 chamadas feitas de dentro do próprio
  `DateTimeUtils`, que não levam o prefixo da classe. Não é o hook — é a busca. É também a próxima
  melhoria óbvia: avisar quando uma busca qualificada deixa de fora usos sem o prefixo.

## Correções feitas nesta rodada

- **Limite de uso contado como erro.** No meio da rodada a conta bateu no limite; o CLI devolve
  `is_error` com subtype "success", custo zero e o aviso como resposta, e o harness contava isso como
  "não resolvido" — o que produziu vários 0/5 falsos. Agora isso é "sem chamada ao modelo": a rodada
  para, e `--resume` roda só o que falta. Todas as 160 execuções acima são válidas (o modelo foi
  chamado); as inválidas foram descartadas e refeitas.
- **Gabarito errado em `ts-zod-cleanregex-users`.** A primeira versão exigia `partPattern`, que chama
  `util.cleanRegex` mas não é exportada — e a pergunta pede as exportadas. Os agentes que a deixaram
  de fora estavam certos. A conferência foi corrigida e todas as respostas gravadas foram
  recalculadas (campo `rescored` nos dados brutos).
- **Caminho local nos dados.** O harness agora troca a cópia temporária por `<copy>` e a pasta do
  usuário por `<home>` antes de gravar `results.json`, em todas as grafias (inclusive a pasta de
  transcripts do Claude Code, que codifica o caminho com `-`).

## Limites

Cinco repetições por braço; código público em quatro linguagens; perguntas de leitura (só um caso
de correção, e nele a diferença fica dentro da variação). Não mede uso real em sessões longas.
