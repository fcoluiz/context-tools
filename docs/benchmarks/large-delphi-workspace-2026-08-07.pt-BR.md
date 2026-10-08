# Métricas reais — workspace Delphi grande

Data da execução: 2026-08-07  
Diretório analisado: um workspace Delphi multi-módulo (servidor, aplicativo desktop, bibliotecas
compartilhadas), sem Git na raiz.

> Nomes de projetos, módulos, arquivos e rotinas foram anonimizados. Os números são os medidos.

## Resultado resumido

| Medição | Resultado |
|---|---:|
| Arquivos indexados | 1.878 |
| Símbolos indexados | 23.514 |
| Escopos/repositórios detectados | 23 |
| Índice frio (`--fresh`) | 2.822 ms ponta a ponta |
| Índice quente | 893 ms ponta a ponta |
| Tempo interno reportado pelo índice quente | 731 ms |
| Documentos auditados | 146 |
| Documentos com apontamentos | 19 |
| Provedores semânticos opcionais disponíveis | 0 de 4 |
| Eventos locais registrados | 5 consultas `context-pack` |

## Consultas reais do `context-pack`

| Consulta | Status | Frescor | Itens | Definições |
|---|---|---|---:|---:|
| `TFrmRelatorioA` | ok | cache validado | 26 | 2 exatas |
| `CalculaIndiceB` | ok | cache validado | 10 | 4 |
| `URelatorioA.pas` | ok | cache validado | 28 | 28 |
| `SimboloQueNaoExiste` | not-found | cache validado | 0 | 0 |

O primeiro resultado encontrou tanto `AppServer/URelatorioA.pas` quanto a cópia em
`__recovery`, ambas classificadas como definição exata. O símbolo inexistente retornou `not-found`
com duas limitações explícitas, sem transformar correspondência textual em definição.

## Diagnósticos

- `audit-docs`: 146 documentos analisados e 19 com apontamentos. Há referências históricas e
  marcações de remoção entre os achados; isso exige triagem antes de tratar tudo como defeito.
- `coupling`: não encontrou relação acima do limiar. O workspace não é um repositório Git válido e
  não há histórico de sessões suficiente para sustentar uma conclusão de acoplamento.
- `providers`: `tsserver`, `pyright-langserver`, `gopls` e `rust-analyzer` não foram encontrados.
  Nenhum foi instalado. O parser Delphi/Pascal local funcionou normalmente e não depende deles.
- `context-pack --history`: as definições e correspondências funcionaram, mas não houve evidência
  histórica/coalteração porque o workspace não fornece Git/histórico suficiente.

## Conclusão

As novidades funcionaram no cenário real: o índice cobre o workspace grande, o cache quente reduz
o tempo ponta a ponta de 2.822 ms para 893 ms, e o pacote de contexto entregou definições exatas
para símbolos Delphi reais. O principal limite observado não é do parser: é a ausência de Git e de
histórico de sessões, que impede validar `why`/`coupling` com confiança.

Os testes gravaram apenas estado local esperado em `.claude/` na raiz do workspace, principalmente
`.context-tools-snapshot.json` e `.context-tools-metrics.json`; nenhum arquivo-fonte do workspace
foi alterado.
