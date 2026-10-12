# Benchmark de resultado — rodada 7 (comparação com outras ferramentas), 2026-10-12

As rodadas 1–6 mediram o context-tools contra o agente sozinho. Esta mede contra **cinco ferramentas de
terceiros com o mesmo propósito** — reduzir o que o agente gasta lendo e procurando código — no mesmo
harness, nos mesmos casos e com o mesmo modelo. Só Haiku 4.5 (o mais barato, e o que mostra onde está
a diferença).

## Os braços

Cada ferramenta foi montada como o instalador dela deixa a configuração do Claude Code, sem tocar na
configuração do usuário: plugin, hooks em `--settings`, servidor MCP em `--mcp-config`, variáveis de
ambiente e, quando o instalador é por projeto, o próprio instalador rodado na cópia antes do agente
(`--arms-file`; o formato está em [`arms.example.json`](outcome/arms.example.json)). O código de cada uma
foi lido antes de instalar.

| braço | o que é | como entra |
|---|---|---|
| sem nada | o agente como ele é | — |
| **context-tools** | este plugin, `main` depois da 2.7.6 | `--plugin-dir` |
| [read-once](https://github.com/Bande-a-Bonnot/Boucle-framework/tree/main/tools/read-once) | guarda de releitura | hook PreToolUse em Read (modo padrão: avisa) + PostCompact |
| [Serena](https://github.com/oraios/serena) 1.7.0 | busca e edição por símbolo via LSP | MCP (`--context claude-code`) + os hooks `remind`/`activate`/`cleanup` que a documentação "recomenda fortemente" |
| [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) 0.11.0 | grafo do código (tree-sitter) | MCP + skill + 3 agentes + hooks em Grep/Glob/Bash/Read/SessionStart, como `install --clients=claude` grava |
| [token-savior](https://github.com/Mibayy/token-savior) 4.23.2 | navegação por símbolo + memória | MCP + os 10 hooks de `ts init --agent claude`, com as variáveis que ele manda ativar |
| [context-os](https://github.com/sravan27/context-os) 2.10.2 | grafo do repositório injetado antes do prompt | `setup.sh` rodado na cópia: 9 hooks, CLAUDE.md com regras de resposta, `MAX_THINKING_TOKENS=8000` |

Ajustes, todos para não penalizar a ferramenta pelo ambiente de medida:
- **Serena**: dashboard e telemetria desligados; o servidor de C# precisou do runtime .NET 10 (instalado
  à parte) e o de Python do `uv` no PATH. Não usei o `--system-prompt` que a documentação sugere: ele
  troca o prompt de sistema inteiro do Claude Code, e a comparação deixaria de ser da ferramenta.
- **codebase-memory**: `auto_index` ligado (opção documentada; o fluxo dele é o usuário pedir "Index this
  project" uma vez) e timeout dos hooks de 5 s para 15 s — no Windows cada chamada leva ~2,8 s e quatro
  execuções em paralelo passavam do limite.
- **token-savior**: memória e estatísticas numa pasta por execução; sem isso, a execução 2 "lembraria"
  a execução 1 do mesmo caso.
- **read-once**: cache numa pasta por execução (a sessão é nova a cada execução de qualquer forma).

Também ficou registrado no `results.json`, para todos os braços, o que os hooks puseram no contexto
(`injected`, lido dos eventos `hook_response` do stream com `--include-hook-events`).

## Correção de bug — 3 casos × 4 repetições

Os casos da rodada 6 ([`cases.v5.json`](outcome/cases.v5.json): js-yaml e commander.js), que nenhuma
das ferramentas tinha visto.

| braço | resolvidos | custo total | vs. sem nada | turnos (mediana) | tokens de contexto (mediana) |
|---|---:|---:|---:|---:|---:|
| **context-os** | 11/12 | **$1.16** | **−45%** | 16 | 414k |
| **context-tools** | **12/12** | $1.87 | −11% | 22 | 733k |
| sem nada | 11/12 | $2.11 | — | 26 | 864k |
| codebase-memory | 12/12 | $2.64 | +25% | 26 | 861k |
| Serena | 11/12 | $2.96 | +40% | 31,5 | 1.052k |
| token-savior | 12/12 | $3.07 | +45% | 30 | 1.402k |
| read-once | 12/12 | $3.09 | +46% | 27,5 | 1.176k |

## Leitura e navegação — 11 casos × 2 repetições

As perguntas de [`cases.all.json`](outcome/cases.all.json) (C#, Java, TypeScript, Python e um caso de
correção), conferidas contra uma resposta verificada à mão.

| braço | resolvidos | custo total | vs. sem nada | turnos (mediana) | tokens de contexto (mediana) |
|---|---:|---:|---:|---:|---:|
| **context-tools** | **21/22** | **$1.34** | **−26%** | **3,5** | **91k** |
| Serena | 21/22 | $1.80 | −1% | 8,5 | 206k |
| read-once | 20/22 | $1.67 | −8% | 7,5 | 179k |
| token-savior | 19/22 | $1.78 | −2% | 6 | 141k |
| sem nada | 18/22 | $1.82 | — | 6,5 | 125k |
| codebase-memory | 18/22 | $1.66 | −9% | 7 | 133k |
| context-os | 16/22 | $1.29 | −29% | 6 | 110k |

| caso | sem nada | context-tools | read-once | Serena | codebase-memory | token-savior | context-os |
|---|---|---|---|---|---|---|---|
| qa-newtonsoft-maxdepth | 2/2 $0.10 | 2/2 $0.09 | 2/2 $0.11 | 2/2 $0.09 | 2/2 $0.11 | 2/2 $0.11 | 1/2 $0.07 |
| qa-newtonsoft-ensuredatetime-callers | 0/2 $0.19 | **2/2 $0.05** | 1/2 $0.21 | 1/2 $0.17 | 0/2 $0.15 | 1/2 $0.15 | 0/2 $0.24 |
| qa-newtonsoft-additional-text | 2/2 $0.19 | 2/2 $0.11 | 2/2 $0.08 | 2/2 $0.09 | 2/2 $0.13 | 2/2 $0.13 | 2/2 $0.07 |
| qa-commons-lang-abbreviate | 2/2 $0.08 | 2/2 $0.09 | 2/2 $0.11 | 2/2 $0.12 | 2/2 $0.08 | 2/2 $0.09 | 2/2 $0.08 |
| qa-commons-lang-strings-null | 2/2 $0.08 | 1/2 $0.05 | 2/2 $0.09 | 2/2 $0.09 | 1/2 $0.08 | 2/2 $0.06 | 2/2 $0.07 |
| fix-qualified-lookup | 2/2 $0.46 | 2/2 $0.43 | 2/2 $0.31 | 2/2 $0.46 | 2/2 $0.35 | 2/2 $0.41 | 2/2 $0.24 |
| ts-zod-escaperegex-users | 1/2 $0.13 | **2/2 $0.05** | 2/2 $0.22 | 2/2 $0.19 | 2/2 $0.17 | 0/2 $0.23 | 1/2 $0.16 |
| ts-zod-cleanregex-users | 2/2 $0.27 | 2/2 $0.20 | 2/2 $0.25 | 2/2 $0.25 | 2/2 $0.27 | 2/2 $0.26 | 2/2 $0.11 |
| py-requests-to-native-string-callers | 2/2 $0.17 | 2/2 $0.14 | 2/2 $0.13 | 2/2 $0.16 | 1/2 $0.18 | 2/2 $0.18 | 2/2 $0.12 |
| py-requests-two-tuples | 2/2 $0.08 | 2/2 $0.05 | 2/2 $0.05 | 2/2 $0.08 | 2/2 $0.06 | 2/2 $0.05 | 2/2 $0.05 |
| py-requests-redirect-limit | 1/2 $0.08 | 2/2 $0.08 | 1/2 $0.12 | 2/2 $0.10 | 2/2 $0.09 | 2/2 $0.11 | 0/2 $0.08 |

Dados brutos: [`results-2026-10-12-round7-fix-haiku.json`](outcome/results-2026-10-12-round7-fix-haiku.json),
[`results-2026-10-12-round7-read-haiku.json`](outcome/results-2026-10-12-round7-read-haiku.json).

## O que dá para ler

- **Em leitura e navegação, o context-tools ganhou de todos**: o mais preciso (21/22, empatado com o
  Serena), o mais barato entre os que acertam (−26%), e com menos da metade dos turnos e dos tokens de
  contexto de qualquer outro braço. A diferença está nas perguntas "quem usa X":
  `ensuredatetime-callers` (só ele resolveu 2/2; o agente sozinho, 0/2) e `escaperegex-users`
  (2/2 por um terço do custo do segundo colocado).
- **Em correção de bug, o context-os foi mais barato** — 45% abaixo do agente sozinho, contra 11% do
  context-tools — com um erro a mais (11/12 contra 12/12). A vantagem não vem do grafo: a injeção dele
  antes do prompt é uma lista de 5 arquivos. Vem do **CLAUDE.md** que o instalador grava ("Ultra-concise",
  "Read only files you will change", "Run tests once to verify, not to explore", "If fixing a bug, show
  only the fix"). Nos rastros, o agente dele corrige, confere com um `node -e` e para; o agente sozinho
  tenta `npm test` sem dependências, escreve arquivos de teste avulsos, lê amostras — 7 turnos contra 29
  no mesmo caso.
- **O mesmo CLAUDE.md custa acerto em leitura**: 16/22, o pior dos sete. As respostas curtas deixam de
  fora nomes que a pergunta pede (`SessionRedirectMixin`, `$ZodEnum`, os chamadores de
  `EnsureDateTime`).
- **As ferramentas baseadas em MCP não foram usadas.** Em 34 execuções cada, o agente chamou as
  ferramentas do codebase-memory **0** vezes e as do token-savior **0** vezes; as do Serena, 30 vezes
  ao todo. Elas pagam o custo de existir (definições de ferramenta, hooks, contexto injetado) sem colher
  o ganho: na correção de bug, todas saíram 25–46% mais caras que o agente sozinho. A própria
  documentação do Serena diz o mesmo sobre o Claude Code atual e sugere trocar o prompt de sistema
  inteiro para contornar.
- **read-once quase não disparou**: o Haiku lê arquivos grandes em fatias (`offset`/`limit`), e o hook
  ignora leitura parcial por desenho. Nas releituras inteiras que pegou, avisou certo.

## Limites

- Um modelo (Haiku 4.5); a correção é JavaScript; leitura com 2 repetições por caso — diferenças
  menores que ~25% num caso isolado estão dentro do ruído. A diferença de −34% (rodada 6) para −11%
  (aqui) do context-tools nos mesmos casos de correção é desse tamanho de variação.
- Medido no Windows. Os hooks do codebase-memory são mais lentos aqui (~2,8 s por chamada) do que ele
  anuncia; isso afeta tempo, não custo.
- Cada ferramenta como o instalador deixa. Nenhuma foi ajustada além do listado acima; uma ferramenta
  com MCP, num cliente que a chame por padrão, pode se sair diferente.

Custo: $16.91 (correção), $11.36 (leitura), ~$1 em testes de montagem dos braços.
