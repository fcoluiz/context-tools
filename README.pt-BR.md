# context-tools

[![test](https://github.com/fcoluiz/context-tools/actions/workflows/test.yml/badge.svg)](https://github.com/fcoluiz/context-tools/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-339933)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Conhecimento do projeto que não apodrece — para agentes de IA (Claude Code e Codex).**

Toda sessão de agente redescobre o mesmo projeto: `grep` encadeado, arquivo lido janela por janela,
a mesma investigação repetida, e o que se aprendeu jogado fora quando a sessão acaba. Anotação
escrita ajuda até o código mudar por baixo dela e ela começar a mentir em silêncio. O context-tools
faz três coisas sobre isso:

1. **Encontrar** — índice de símbolos entre arquivos, quem usa o quê, outline de arquivo enorme,
   acoplamento de mudanças extraído do git e um briefing de impacto antes da mudança, tudo gerado na
   hora a partir do seu código.
2. **Lembrar** — o que uma sessão investigou vira um documento curto em `ai-context/` ou um mapa de
   contexto, ligado por fingerprint aos arquivos-fonte que descreve.
3. **Verificar** — quando o código sob um mapa ou documento muda, a próxima sessão (ou o CI) fica
   sabendo qual, e por quê. "Atualizado" nunca afirma mais do que sabe.

- **Zero dependência.** Só builtins `node:`. Nada a instalar além do Node 18+.
- **Zero configuração.** Descobre sozinho repositórios, linguagens e documentação.
- **Honesto por desenho.** Quando não sabe, diz que não sabe — resposta confiante e errada é tratada
  como pior que nenhuma resposta.
- **Medido, não estimado.** Cada número da documentação diz de onde veio, inclusive os que deixam a
  ferramenta pior na foto.
- **Econômico em tokens.** Os hooks calam quando não há o que dizer, e todo custo fixo tem teto
  garantido por teste.

*[Read in English →](README.md)*

## O que ele responde

Uma porta de entrada, verbos curtos: `node scripts/ct.mjs <verbo>` (a skill do plugin já conhece o
caminho). Os scripts individuais continuam funcionando como antes.

| pergunta | verbo |
|---|---|
| onde X está definido? | `ct find <nome> [<nome>…]` |
| quem usa X, e de qual função? | `ct refs <nome> [--strings]` |
| onde fica na tela "Código do cliente", e que código o lê? (Delphi) | `ct ui <texto da tela>` |
| o que está em jogo antes de mudar X? | `ct impact <símbolo-ou-arquivo>` |
| como é este projeto? | `ct overview` |
| como navegar este arquivo enorme? | `ct outline <arquivo> [filtro]` |
| o que muda junto com este arquivo? | `ct coupling <arquivo>` |
| por que este código é assim? | `ct why <símbolo>` |
| que testes cobrem este arquivo, e como rodá-los? | `ct verify <arquivo> [<arquivo>…]` |
| um pacote de evidências com orçamento para um símbolo ou arquivo | `ct pack <símbolo-ou-arquivo> [--budget=N]` |
| esta documentação ainda é verdade? | `ct check [--strict]` |
| revisei este mapa/documento — registrar | `ct ack <mapa-ou-doc.md>` |
| o que a próxima sessão precisa saber? | `ct handoff [--salvar]` |
| como está a saúde da instalação local? | `ct health [--days=30] [--audit] [--json]` |
| o mesmo em JSON versionado, para CI ou painel | `ct snapshot [--days=30] [--sessions=20]` |

O agente não precisa lembrar de nada disso. **Hooks** trazem as ferramentas sozinhos: antes de um
`grep` por símbolo o índice responde primeiro, a sessão começa com uma lista curta dos mapas de
contexto que ficaram defasados, e o fim da sessão aponta arquivos que historicamente mudam juntos
mas não foram editados juntos — e, uma vez por sessão, código editado depois do último teste. Sessão
que só leu código para responder uma pergunta recebe uma linha sugerindo dizer "registre no
contexto"; o agente então registra em `ai-context/`. Cada mensagem chega uma vez só, mesmo com o
plugin e uma cópia standalone instalados juntos.

## Instalar ou atualizar

Um comando, sem nada para responder. Ele instala o context-tools para **os dois agentes** (Claude
Code e Codex), no seu usuário — vale para todos os projetos, não só o atual. Rode de
novo para atualizar:

```bash
npx -y github:fcoluiz/context-tools
```

No **PowerShell do Windows**, digite `npx.cmd` em vez de `npx` (a política de execução padrão
bloqueia o atalho `npx.ps1`; o `npx.cmd` é o mesmo programa e não muda nenhuma configuração de
segurança).

Depois, abra uma sessão nova — é só isso. Os hooks funcionam sozinhos: antes de um Grep dizem onde o
símbolo está definido, depois dele em qual função cai cada linha, e no início da sessão como rodar os
testes e quando sair uma versão nova (com este mesmo comando). No Codex, na primeira vez, abra
`/hooks` e aprove os hooks do context-tools uma vez.

Requer Node.js 18+. O CLI de agente que faltar (`claude` ou `codex`) é instalado com o npm no
caminho; para um agente só, acrescente `--target` (abaixo). Ele nunca altera a pasta onde é executado.

| quer | acrescente ao comando |
|---|---|
| só um agente | `--target=claude` ou `--target=codex` |
| só o projeto atual, não o seu usuário | `--project .` |
| o servidor MCP também (veja abaixo) | `--mcp` (e `--remove-mcp` para tirar) |
| ver o que ele faria, sem mudar nada | `--dry-run` |

### Servidor MCP (opcional, desligado por padrão)

Para Claude Code e Codex o plugin basta: em todas as rodadas medidas o ganho veio dos hooks, e os
agentes nunca precisaram chamar uma ferramenta para isso. O servidor MCP é para **outros clientes
MCP**, ou para quem prefere chamada de ferramenta tipada: cinco ferramentas só de leitura
(`find_symbol`, `references`, `impact`, `outline`, `overview`) com as mesmas respostas dos comandos.
Ele vem desligado porque definição de ferramenta é paga em toda requisição: cerca de 2.000
caracteres (~500 tokens), teto garantido por teste. Para ligar:

```bash
npx -y github:fcoluiz/context-tools --mcp
```

Isso o registra com `claude mcp add` / `codex mcp add` e o mantém atualizado a cada execução.
Qualquer outro cliente pode iniciá-lo direto:

```json
{ "mcpServers": { "context-tools": { "command": "node", "args": ["<home>/.context-tools/runtime/scripts/mcp-server.mjs"] } } }
```

### Pelo próprio CLI do agente

Claude Code:

```bash
claude plugin marketplace add fcoluiz/context-tools
claude plugin install context-tools@context-tools
```

Codex:

```bash
codex plugin marketplace add fcoluiz/context-tools
codex plugin add context-tools@context-tools-codex
```

### Standalone, sem plugin

```bash
node /caminho/para/context-tools/install.mjs /caminho/para/projeto --target=both
```

Copia os scripts para o projeto e registra os hooks. Idempotente; `--dry-run` simula e `--no-hooks`
instala só os scripts. Também cria um `.gitignore` dentro de `.claude/` para que o estado local da
ferramenta nunca apareça no seu `git status`.

## Experimente

```bash
node scripts/symbols.mjs buildIndex
```

O `symbols` responde com o arquivo, a linha onde a **definição** começa e a linha onde termina — não
dezenas de ocorrências textuais — e diz quais repositórios varreu. Quando não acha nada, diz isso em
vez de devolver vazio. Se o nome não é símbolo mas é arquivo, ele diz isso — rotulado como arquivo,
nunca apresentado como definição.

## Linguagens

| extensão | `symbols` (entre arquivos) | `outline` (um arquivo) |
|---|---|---|
| `.js .jsx .ts .tsx .mjs .cjs` | ✅ | ✅ |
| `.py .pyi` | ✅ | ✅ |
| `.go` | ✅ | ✅ |
| `.rs` | ✅ | ✅ |
| `.cs` (C#) | ✅ | ✅ |
| `.java` | ✅ | ✅ |
| `.php` | ✅ | ✅ |
| `.pas .dpr .dpk .inc` (Delphi/Pascal) | ✅ | ✅ |
| `.dfm .fmx` (forms Delphi) | — de propósito | ✅ |
| `.md` | — | ✅ (seções) |
| `.sql` (tabelas, colunas, views, procedures…) | ✅ só no índice | ✅ |

`coupling` e `audit-docs` funcionam com qualquer linguagem. Cada parser é conferido contra código de
produção de terceiros — cerca de **9.000 arquivos e 192.000 símbolos** em projetos Python, Go,
Delphi/Pascal, Rust, TypeScript, C#, Java e PHP — com **zero símbolos apontando a linha errada**.

## O que está provado, o que é sinal, o que ainda é hipótese

As afirmações deste projeto, ordenadas pela evidência que há por trás. "Provado" é medido, com os
dados brutos publicados; "sinal" é quando há evidência apontando nessa direção, mas não uma medida
que resolva; "hipótese" é para o que o desenho existe, ainda sem medida.

**Provado** — um agente terminando a mesma tarefa, em repositórios públicos, com e sem o plugin
([rodadas 2–7](docs/benchmarks/)):

- **Nunca fez o agente resolver menos tarefas.** Em toda rodada e modelo, pelo menos tantas respostas
  certas com o plugin quanto sem ele.
- **Perguntas sobre o código saem mais baratas e mais certas**: de 15% a 36% mais baratas em todas as
  rodadas. O ganho é maior em "quem usa X" e "onde exatamente": um hook diz em qual método ou classe
  cada resultado da busca cai — é o que um agente respondendo só com linhas de `grep` erra.
- **Ganhou de cinco ferramentas com o mesmo propósito nas perguntas** (rodada 7): o mais preciso
  (21/22, empatado com o Serena) e o mais barato entre os que acertaram (−26%), na metade dos turnos.
- **Hooks chegam ao agente; ferramentas a mais, em geral, não.** Na rodada 7 o agente chamou as
  ferramentas MCP do codebase-memory e do token-savior zero vezes em 34 execuções cada, e elas
  deixaram a correção de bug 25–46% mais cara. Por isso o context-tools age por hooks e vem com o
  servidor MCP desligado.
- **Os custos fixos têm teto:** o aviso do `SessionStart` é ~175 tokens, o índice leva ~1,75 s do zero
  e ~130 ms do cache local, e cada teto é garantido por um teste
  ([referência](docs/reference.pt-BR.md#tokens)).
- **A economia de token só pela navegação é pequena: 1–3%** do custo de uma sessão real, porque a
  maior parte é contexto sendo relido ([como foi medido](docs/reference.pt-BR.md#a-economia-de-token-medida--e-ela-é-pequena)).
  O valor está em menos caminhos errados, não em menos tokens por busca.

**Sinal** — a evidência aponta nessa direção, mas não está resolvido:

- **Correção de bug sai mais barata, numa medida que varia.** Mais barata em 4 de 5 medidas (−11% a
  −36%) e 19% mais cara em uma (rodada 5, Haiku), que motivou correções. Os mesmos casos deram −34% na
  rodada 6 e −11% na 7: o efeito é real na direção e instável no tamanho, com 12 execuções por braço.
- **Dizer menos no início da sessão e uma regra de trabalho ajudam na correção de bug** (2.7.7). Saiu
  dos rastros da rodada 7, em que a ferramenta que mandava o agente "conferir uma vez e parar" foi a
  mais barata; ainda não medido de novo.
- **O mesmo vale no Codex.** Os hooks são os mesmos e o adaptador do Codex é coberto por testes de ponta
  a ponta, mas toda rodada de resultado rodou o Claude Code (`claude -p`). Os modelos do Codex podem
  também usar ferramentas MCP com mais facilidade do que os do Claude usaram aqui.
- **Dividir uma sessão longa compensa.** O custo por mensagem cresce 3,4× com a duração da sessão
  (medido); o aviso "a divisão compensou, ~N%" no início da sessão conta mensagens reais, mas tira a
  porcentagem de uma curva simulada, e diz isso.

**Hipótese** — para o que o desenho existe, ainda sem medida:

- **Conhecimento que sobrevive às sessões.** Todo benchmark começa de um clone novo: índice frio, sem
  mapas de contexto, sem documentos no `ai-context`, sem handoff — o pior caso do plugin. Se uma área
  mapeada é retomada mais rápido na sessão seguinte, e quanto os avisos de mapa e documento defasados
  evitam, não foi medido.
- **Bases maiores e privadas, outros modelos.** As rodadas usam repositórios públicos de algumas
  centenas a alguns milhares de arquivos, com Sonnet e Haiku. O desenho mira workspaces grandes, com
  vários repositórios, onde reexplorar custa mais.
- **Times.** O fluxo de pull request que deixa conhecimento para a próxima pessoa é testado como
  código, não medido como resultado.

## Ajuda? O que foi medido

Um agente real (`claude -p`) faz a mesma tarefa numa cópia limpa de um repositório público, uma vez
sem o plugin e outra com ele, e a resposta é conferida contra um gabarito verificado à mão (uma
correção é conferida executando o código). Quatro ou cinco execuções por braço em cada caso:

| rodada | modelo | casos | sem | com | custo com × sem |
|---|---|---|---:|---:|---:|
| 2 | Sonnet 5 | 6 (C#, Java, uma correção) | 26/30 | 28/30 | −15% |
| 3 — **casos novos** | Sonnet 5 | 5 novos (TypeScript, Python) | 21/25 | 24/25 | −24% |
| 3 | Haiku 4.5 | 11 | 48/55 | 50/55 | −36% |
| 4 | Sonnet 5 | os 5 novos | 21/25 ¹ | **25/25** | −30% |
| 4 | Haiku 4.5 | 11 | 48/55 ¹ | **53/55** | −18% |
| 5 — **casos novos** | Sonnet 5 | 3 correções + 1 pergunta (JavaScript) | 16/16 | 16/16 | −23% |
| 5 — **casos novos** | Haiku 4.5 | 3 correções + 1 pergunta (JavaScript) | 16/16 | 16/16 | **+19%** |
| 6 — **independente** ² | Sonnet 5 | 3 correções, 2 repositórios novos (JavaScript) | 12/12 | 12/12 | −36% |
| 6 — **independente** ² | Haiku 4.5 | 3 correções, 2 repositórios novos (JavaScript) | 12/12 | 12/12 | −34% |

¹ A rodada 4 mediu só o braço com o plugin (2.7.3); o braço sem ele é o da rodada 3.
² Casos escritos antes de o plugin rodar nesses repositórios (js-yaml, commander.js), com o plugin
como publicado depois da rodada 5; os dois braços medidos.

- **Nunca resolveu menos.** Em todas as rodadas o plugin resolveu pelo menos tanto quanto o agente
  sozinho.
- **Mais barato em 8 das 9 linhas.** A diferença é maior em perguntas de "quem usa X" e de "onde
  exatamente". A exceção é a rodada 5, Haiku corrigindo bug: 19% mais caro. O registro do que os hooks
  injetavam mostrou o porquê (um pacote de evidências cheio de ruído, turnos gastos em testes que não
  rodavam); os dois foram corrigidos, e a rodada 6 — bugs novos em dois repositórios que o plugin
  nunca tinha visto — mediu o Haiku 34% mais barato e o Sonnet 36% mais barato em correção, com todas
  as tarefas resolvidas nos dois braços. A linha da rodada 5 fica como foi medida.
- **De onde vem o ganho de acerto:** o Grep devolve linhas sem o método em volta, e o agente que
  responde só com isso nomeia o método ou a classe errada. Um hook diz em qual símbolo cai cada linha
  encontrada, e avisa quando uma busca qualificada (`Classe\.metodo`) vai perder as chamadas feitas
  de dentro da classe sem o prefixo.
- **O que ainda não mostra:** poucas execuções por braço, código público, trabalho real em várias
  sessões.

### Comparado com outras ferramentas

A rodada 7 pôs cinco ferramentas de terceiros com o mesmo propósito no mesmo harness, cada uma montada
como o próprio instalador deixa o Claude Code (Haiku 4.5, mesmos casos):

| braço | leitura e navegação (11 casos × 2) | correção de bug (3 casos × 4) |
|---|---|---|
| agente sozinho | 18/22 · $1.82 | 11/12 · $2.11 |
| **context-tools** | **21/22 · $1.34 (−26%)** | **12/12** · $1.87 (−11%) |
| [Serena](https://github.com/oraios/serena) (LSP, MCP) | 21/22 · $1.80 (−1%) | 11/12 · $2.96 (+40%) |
| [read-once](https://github.com/Bande-a-Bonnot/Boucle-framework/tree/main/tools/read-once) (guarda de releitura) | 20/22 · $1.67 (−8%) | 12/12 · $3.09 (+46%) |
| [token-savior](https://github.com/Mibayy/token-savior) (MCP + hooks) | 19/22 · $1.78 (−2%) | 12/12 · $3.07 (+45%) |
| [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (grafo, MCP + hooks) | 18/22 · $1.66 (−9%) | 12/12 · $2.64 (+25%) |
| [context-os](https://github.com/sravan27/context-os) (grafo antes do prompt + regras no CLAUDE.md) | 16/22 · $1.29 (−29%) | 11/12 · **$1.16 (−45%)** |

- **Leitura e navegação:** o context-tools foi o mais preciso e o mais barato entre os que acertaram,
  com menos da metade dos turnos de qualquer outro braço.
- **Correção de bug:** o context-os saiu mais barato. A vantagem vem do CLAUDE.md que o instalador dele
  grava ("ultra-concise", "run tests once to verify, not to explore"), não do grafo — e as mesmas regras
  custam acerto nas perguntas (16/22, o pior).
- **As ferramentas MCP quase não foram usadas:** em 34 execuções cada, o agente chamou as ferramentas do
  codebase-memory e do token-savior zero vezes; as do Serena, 30. Pagam por estar ali sem colher o ganho.

Montagem de cada braço, ajustes e dados por caso: [relatório da rodada 7](docs/benchmarks/outcome-round7-2026-10-12.pt-BR.md).

Relatórios, casos e os dados brutos de cada execução: [docs/benchmarks](docs/benchmarks/).

## Quanto custa

- **Velocidade:** um workspace de 1.543 arquivos indexa em ~1,75 s do zero e ~130 ms com cache. O
  cache é invalidado por mudança de arquivo e por mudança no próprio parser, e é recusado quando o
  relógio do sistema de arquivos é grosseiro demais para confiar.
- **Tokens:** o único custo que você paga sem pedir é o aviso do `SessionStart`, ~175 tokens, mais
  ~30 da linha com o comando de teste quando o projeto tem um. Os demais avisos custam zero quando
  não há o que dizer.
- **A parte honesta:** em sessões reais, 89% do custo é contexto sendo recarregado, e a saída de
  ferramentas é uma fatia pequena disso. Navegar melhor economiza **1–3%** dos tokens, não 20%. O
  valor real está em menos caminhos errados e menos re-exploração — a
  [referência](docs/reference.pt-BR.md) mostra como isso foi medido e onde estão as alavancas maiores.

## Em equipe: conhecimento deixado para trás num pull request

Mapas e documentos `ai-context/` commitados no repositório são conhecimento compartilhado — e só
continuam valendo a leitura se quem muda o código também confere o que está escrito sobre ele. A
checagem de deriva lista cada mapa ou documento live cuja fonte citada mudou num pull request **sem
revisão registrada** (o `ack` grava no próprio arquivo o fingerprint da fonte revisada, a única
prova que vale em CI):

```yaml
# .github/workflows/conhecimento.yml
on: pull_request
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # o branch base é necessário para calcular o diff
      - uses: fcoluiz/context-tools@v2.9.10
        with:
          strict: 'false'         # 'true' falha o job em vez de só anotar
```

Localmente ou em outro CI: `node scripts/ct.mjs drift --base=origin/main [--strict]`. Ele anota o
pull request, escreve um resumo do job e sai com 2 — nunca 0 — quando não conseguiu calcular o diff.
O `ct health` mostra o mesmo como número: a fração dos mapas e documentos verificáveis cujas fontes
não mudaram desde a revisão, e como a fração dos mapas andou nas sessões recentes.

## Segurança

Os hooks injetam texto no contexto do modelo, e boa parte desse texto vem do repositório analisado
— num repositório clonado ou de terceiros, isso é entrada não confiável. Todo comando externo roda
sem shell, o índice nunca segue links para fora do projeto, o texto vindo do repositório é
sanitizado e limitado em tamanho, e o bloco injetado declara que nomes vindos do repositório são
dados, não instruções. As ferramentas não enviam telemetria. A única chamada de rede é a verificação
de versão nova: no máximo uma vez por dia, em segundo plano, um `git ls-remote --tags` neste
repositório — nada do seu projeto é enviado. Desligue com `"updateCheck": false` ou
`CONTEXT_TOOLS_UPDATE_CHECK=0`.

Encontrou uma vulnerabilidade? Reporte de forma privada — veja [SECURITY.md](SECURITY.md).

## Documentação

- **[Referência completa](docs/reference.pt-BR.md)** — cada ferramenta, hook e configuração, as
  medições por trás de cada afirmação, limitações conhecidas e o que fica fora de escopo por desenho.
- [Benchmarks](docs/benchmarks/) — benchmarks controlados e como reproduzi-los.
- [Formato de conhecimento verificável v1](docs/spec/knowledge-format.md) — a especificação aberta, em
  inglês e independente de ferramenta, de como um mapa ou documento registra contra quais versões das
  fontes foi revisado (com JSON Schema).
- [CHANGELOG](CHANGELOG.md) — o que mudou em cada versão.

## Contribuindo

Issues e pull requests são bem-vindos. Leia antes o [CONTRIBUTING.md](CONTRIBUTING.md): ele explica
como rodar os testes (`npm test`, sem setup), as três regras que toda mudança segue e como adicionar
uma linguagem. Siga o [Código de Conduta](CODE_OF_CONDUCT.md).

## Licença

[MIT](LICENSE) © 2026 Luiz Nogueira
