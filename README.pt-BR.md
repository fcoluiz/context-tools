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
| quem usa X, e de qual função? | `ct refs <nome>` |
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

O agente não precisa lembrar de nada disso. **Hooks** trazem as ferramentas sozinhos: antes de um
`grep` por símbolo o índice responde primeiro, a sessão começa com uma lista curta dos mapas de
contexto que ficaram defasados, e o fim da sessão aponta arquivos que historicamente mudam juntos
mas não foram editados juntos — e, uma vez por sessão, código editado depois do último teste. Sessão
que só leu código para responder uma pergunta recebe uma linha sugerindo dizer "registre no
contexto"; o agente então registra em `ai-context/`. Cada mensagem chega uma vez só, mesmo com o
plugin e uma cópia standalone instalados juntos.

## Instalar ou atualizar

Um comando instala o context-tools para **todos os agentes que você tem** (Claude Code e/ou Codex),
no seu usuário — vale para todos os projetos, não só o atual. Rodar o mesmo comando de novo
atualiza para a última versão:

```bash
npx --yes --package github:fcoluiz/context-tools context-tools-setup-all --global --yes
```

No **PowerShell do Windows**, use `npx.cmd` em vez de `npx`. A política de execução padrão bloqueia o
atalho `npx.ps1` que o npm instala ("a execução de scripts foi desabilitada neste sistema"); o
`npx.cmd` roda o mesmo programa sem mudar nenhuma configuração de segurança:

```powershell
npx.cmd --yes --package github:fcoluiz/context-tools context-tools-setup-all --global --yes
```

Requer Node.js 18+ e o CLI de pelo menos um agente (`claude` ou `codex`). Ele nunca altera a pasta
onde é executado e nunca instala o CLI de um agente que você ainda não usa. Depois, abra uma sessão
nova. No Codex, na primeira vez, abra `/hooks` e aprove os hooks do context-tools uma vez. Daí em
diante, o início da sessão avisa quando sair uma versão nova, com este mesmo comando.

O plugin traz as ferramentas **e** os hooks. Use `--target=claude` ou `--target=codex` para limitar a
um agente, e tire o `--global` para preparar só o projeto atual.

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

### Opcional: servidor MCP

O plugin (skill + hooks) é o jeito recomendado de usar o context-tools no Claude Code e no Codex. Há
também um servidor MCP para **outros clientes MCP** e para quem prefere chamada de ferramenta
tipada: cinco ferramentas só de leitura (`find_symbol`, `references`, `impact`, `outline`,
`overview`) que devolvem as mesmas respostas dos comandos, de um processo que fica vivo (sem partida
do Node a cada chamada).

Ele vem **desligado**, porque definição de ferramenta tem custo: cerca de 2.000 caracteres (~500
tokens) somados a cada requisição do cliente que as carrega — teto garantido por teste. Ligue pelo
mesmo instalador:

```bash
npx --yes --package github:fcoluiz/context-tools context-tools-setup-all --global --yes --mcp
```

O instalador copia os scripts para `~/.context-tools/runtime` (um caminho que sobrevive às
atualizações) e roda `claude mcp add` / `codex mcp add` por você. Rodar o instalador de novo mantém o
servidor atualizado; `--remove-mcp` remove o registro. Qualquer outro cliente pode iniciá-lo direto:

```json
{ "mcpServers": { "context-tools": { "command": "node", "args": ["<home>/.context-tools/runtime/scripts/mcp-server.mjs"] } } }
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
      - uses: fcoluiz/context-tools@v2.7.1
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
