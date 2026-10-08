# context-tools

[![test](https://github.com/fcoluiz/context-tools/actions/workflows/test.yml/badge.svg)](https://github.com/fcoluiz/context-tools/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-339933)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Navegação de código e higiene de documentação para agentes de IA — Claude Code e Codex.**

Agentes gastam boa parte de cada sessão *procurando onde as coisas estão*: `grep` encadeado, arquivo
lido janela por janela, a mesma exploração repetida sessão após sessão. O context-tools dá ao agente
um índice de símbolos entre arquivos, outline de arquivos grandes, acoplamento de mudanças extraído
do git e uma auditoria que avisa quando a documentação envelheceu — tudo gerado na hora a partir do
seu código, então nunca fica defasado.

- **Zero dependência.** Só builtins `node:`. Nada a instalar além do Node 18+.
- **Zero configuração.** Descobre sozinho repositórios, linguagens e documentação.
- **Honesto por desenho.** Quando não sabe, diz que não sabe — resposta confiante e errada é tratada
  como pior que nenhuma resposta.
- **Medido, não estimado.** Cada número da documentação diz de onde veio, inclusive os que deixam a
  ferramenta pior na foto.

*[Read in English →](README.md)*

## O que ele responde

| pergunta | comando |
|---|---|
| onde X está definido? | `symbols.mjs <nome> [<nome>…]` |
| como navegar este arquivo enorme? | `outline.mjs <arquivo> [filtro]` |
| o que muda junto com este arquivo? | `coupling.mjs <arquivo>` |
| esta documentação ainda é verdade? | `audit-docs.mjs [--strict]` |
| por que este código é assim? | `why.mjs <símbolo>` |
| o que a próxima sessão precisa saber? | `handoff.mjs [--salvar]` |
| um pacote de evidências com orçamento para um símbolo ou arquivo | `context-pack.mjs <símbolo-ou-arquivo> [--budget=N]` |
| como está a saúde da instalação local? | `health.mjs [--days=30] [--audit] [--json]` |

O agente não precisa lembrar de nada disso. **Hooks** trazem as ferramentas sozinhos: antes de um
`grep` por símbolo o índice responde primeiro, a sessão começa com uma lista curta dos mapas de
contexto que ficaram defasados, e o fim da sessão aponta arquivos que historicamente mudam juntos
mas não foram editados juntos.

## Instalar ou atualizar

Um comando instala o context-tools para **todos os agentes que você tem** (Claude Code e/ou Codex),
no seu usuário — vale para todos os projetos, não só o atual. Rodar o mesmo comando de novo
atualiza para a última versão:

```bash
npx --yes --package github:fcoluiz/context-tools context-tools-setup-all --global --yes
```

Requer Node.js 18+ e o CLI de pelo menos um agente (`claude` ou `codex`). Ele nunca altera a pasta
onde é executado e nunca instala o CLI de um agente que você ainda não usa. Depois, abra uma sessão
nova. No Codex, na primeira vez, abra `/hooks` e aprove os hooks do context-tools uma vez.

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
| `.pas .dpr .dpk .inc` (Delphi/Pascal) | ✅ | ✅ |
| `.dfm .fmx` (forms Delphi) | — de propósito | ✅ |
| `.md` | — | ✅ (seções) |

`coupling` e `audit-docs` funcionam com qualquer linguagem. Cada parser é conferido contra código de
produção de terceiros — cerca de **6.200 arquivos e 147.000 símbolos** em projetos Python, Go,
Delphi/Pascal, Rust e TypeScript — com **zero símbolos apontando a linha errada**.

## Quanto custa

- **Velocidade:** um workspace de 1.543 arquivos indexa em ~1,75 s do zero e ~130 ms com cache. O
  cache é invalidado por mudança de arquivo e por mudança no próprio parser, e é recusado quando o
  relógio do sistema de arquivos é grosseiro demais para confiar.
- **Tokens:** o único custo que você paga sem pedir é o aviso do `SessionStart`, ~175 tokens. Os
  demais avisos custam zero quando não há o que dizer.
- **A parte honesta:** em sessões reais, 89% do custo é contexto sendo recarregado, e a saída de
  ferramentas é uma fatia pequena disso. Navegar melhor economiza **1–3%** dos tokens, não 20%. O
  valor real está em menos caminhos errados e menos re-exploração — a
  [referência](docs/reference.pt-BR.md) mostra como isso foi medido e onde estão as alavancas maiores.

## Segurança

Os hooks injetam texto no contexto do modelo, e boa parte desse texto vem do repositório analisado
— num repositório clonado ou de terceiros, isso é entrada não confiável. Todo comando externo roda
sem shell, o índice nunca segue links para fora do projeto, o texto vindo do repositório é
sanitizado e limitado em tamanho, e o bloco injetado declara que nomes vindos do repositório são
dados, não instruções. As ferramentas não fazem chamadas de rede nem enviam telemetria.

Encontrou uma vulnerabilidade? Reporte de forma privada — veja [SECURITY.md](SECURITY.md).

## Documentação

- **[Referência completa](docs/reference.pt-BR.md)** — cada ferramenta, hook e configuração, as
  medições por trás de cada afirmação, limitações conhecidas e o que fica fora de escopo por desenho.
- [Benchmarks](docs/benchmarks/) — benchmarks controlados e como reproduzi-los.
- [CHANGELOG](CHANGELOG.md) — o que mudou em cada versão.

## Contribuindo

Issues e pull requests são bem-vindos. Leia antes o [CONTRIBUTING.md](CONTRIBUTING.md): ele explica
como rodar os testes (`npm test`, sem setup), as três regras que toda mudança segue e como adicionar
uma linguagem. Siga o [Código de Conduta](CODE_OF_CONDUCT.md).

## Licença

[MIT](LICENSE) © 2026 Luiz Nogueira
