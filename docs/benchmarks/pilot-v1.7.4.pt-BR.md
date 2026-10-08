# Benchmark piloto — context-tools v1.7.4

Data: 2026-08-07
Escopo: leitura somente; nenhum projeto analisado foi alterado.

## Baseline local

> Nomes de projetos, módulos, arquivos e rotinas foram anonimizados. Os números são os medidos.

O benchmark local comparou `rg`, `symbols.mjs`, `outline.mjs` e `context-pack.mjs` em oito
projetos Delphi/Web, com 48 consultas sobre os mesmos nomes.

| Medição | Resultado |
|---|---:|
| Projetos | 8 |
| Arquivos indexados | 2.997 |
| Símbolos indexados | 30.511 |
| Saída bruta do `rg` | 85.015 caracteres (~21.256 tokens) |
| Saída de localização do `symbols.mjs` | 17.070 caracteres (~4.271 tokens) |
| Redução da saída de localização | ~80% |
| Arquivos grandes usados no `outline` | 24 |
| Texto completo desses arquivos | 8.214.700 caracteres |
| Mapa compacto do `outline` | 343.667 caracteres |
| Redução do `outline` | 95,82% |
| Evidências do `context-pack` | 474 itens: 129 definições e 334 candidatos textuais |

Os tokens são estimados por `caracteres / 4` e servem apenas como direção. O `context-pack` não
deve ser comparado como simples compressão: ele devolve um pacote mais rico e estruturado, por
isso pode conter mais texto bruto que uma busca `rg`.

## Piloto com agentes

Dois agentes receberam as mesmas três tarefas, nos mesmos dois projetos:

- `AppServer` (backend Delphi);
- `web-frontend` (frontend React/TypeScript).

Um agente usou `symbols.mjs`, `outline.mjs` e `context-pack.mjs`; o outro usou somente `rg`,
`findstr`/`Select-String` e leitura manual de trechos.

| Tarefa | Sem context-tools | Com context-tools | Leitura |
|---|---|---|---|
| `A1Click` | Encontrou 3 pares de definição/implementação em `UModuloA.pas`, `UModuloB.pas` e `UMenuPrincipal.pas` | Encontrou implementações em vários arquivos, incluindo `UCadastro.pas` e `UMenuPrincipal.pas` | O nome é ambíguo e possui várias implementações; exige uma tarefa com resposta esperada fechada para medir recall |
| `getCurrentNotifications` | Definição em `notifications.ts` e uso em `useNotifications.ts` | Encontrou os mesmos pontos com `symbols.mjs` + uma busca textual auxiliar | Resultado equivalente; o ganho foi de navegação, não de volume bruto demonstrado |
| Pontos relevantes em `URelPedidos.pas` | 5 rotinas encontradas lendo faixas de linha | 5 pontos encontrados via `outline.mjs` | O outline reduziu a exploração para pontos nomeados e localizáveis |
| Pontos relevantes em `MessageList.tsx` | 5 rotinas encontradas por faixas de linha | 5 pontos encontrados via `outline.mjs` | Resultado equivalente com navegação mais direta |

O agente com context-tools registrou 7 chamadas de ferramenta e uma busca textual auxiliar,
com estimativa de aproximadamente 4.200 tokens lidos no piloto. O agente manual estimou cerca de
2.000 tokens nos trechos retornados, mas essa estimativa não inclui todo o custo mental de decidir
quais faixas abrir; portanto não é uma comparação de custo final.

## Conclusão e limites

O baseline local já demonstra o ganho de localização e compressão de arquivos grandes. O piloto
com agentes confirma que o fluxo chega aos mesmos pontos relevantes com menos exploração manual,
mas ainda não prova uma economia geral de tokens nem superioridade semântica.

O principal alerta é `A1Click`: símbolos comuns ou eventos de tela podem ter várias definições
legítimas. O próximo benchmark controlado deve usar respostas esperadas conhecidas e pontuar
recall, precisão, tempo e tokens separadamente.
