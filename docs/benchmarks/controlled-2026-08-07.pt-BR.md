# Benchmark controlado — localização de definições

Data: 2026-08-07
Escopo: leitura somente; nenhum projeto Delphi/Web foi alterado.

> Nomes de projetos e de rotinas de negócio foram anonimizados. Os números são os medidos.
> O script que gerou esta medição é `scripts/benchmark-controlled.mjs`; o gold set real fica em um
> arquivo local fora do repositório (veja [README](README.md)).

## O que foi medido

Foram executados 10 casos, em quatro raízes, com três repetições por caso:

- AppServer (backend Delphi): `BuscarPedidosPorItem`, `RelatorioPedidosGeral`;
- AppConnection (biblioteca Delphi compartilhada): `LimparDadosPedido`, `GetConnection`;
- AppDesktop (aplicativo desktop Delphi): `prepareStatement`, `preencheButton`;
- web-frontend (frontend React/TypeScript): `getCurrentNotifications`, `useNotifications`, `groupMessagesByDate`, `getMessageText`.

O gold set tem 25 localizações conhecidas, identificadas por arquivo relativo e linha.
Declarações Pascal e implementações entram como definições esperadas.

Comparações:

- busca manual: busca textual fixa, equivalente ao `rg` usado manualmente, mas executada em memória para não depender da permissão de subprocesso do ambiente;
- `symbols`: índice reconstruído uma vez por raiz, depois consultas exatas;
- `context-pack`: orçamento 2.000, sem histórico; a pontuação considera somente itens `definition` cujo símbolo é exatamente o consultado. Candidatos parciais e textuais continuam contabilizados no volume do pacote.

## Resultado por caso

P/R/F1 = precisão/recall/F1. Tokens são uma estimativa direcional de caracteres/4.

| Caso | Esperado | Busca manual | symbols | context-pack | Tokens manual/symbols/pack |
|---|---:|---:|---:|---:|---:|
| `BuscarPedidosPorItem` | 2 | 50,0%/100,0%/66,7% | 100,0%/100,0%/100,0% | 100,0%/100,0%/100,0% | 84/72/414 |
| `RelatorioPedidosGeral` | 2 | 33,3%/100,0%/50,0% | 100,0%/100,0%/100,0% | 100,0%/100,0%/100,0% | 120/80/523 |
| `LimparDadosPedido` | 2 | 50,0%/100,0%/66,7% | 100,0%/100,0%/100,0% | 100,0%/100,0%/100,0% | 79/51/396 |
| `GetConnection` | 5 | 55,6%/100,0%/71,4% | 100,0%/100,0%/100,0% | 100,0%/100,0%/100,0% | 220/95/892 |
| `prepareStatement` | 4 | 1,1%/100,0%/2,2% | 100,0%/100,0%/100,0% | 100,0%/100,0%/100,0% | 10.315/96/1.898 |
| `preencheButton` | 4 | 16,7%/100,0%/28,6% | 100,0%/100,0%/100,0% | 100,0%/100,0%/100,0% | 765/75/1.988 |
| `getCurrentNotifications` | 1 | 33,3%/100,0%/50,0% | 100,0%/100,0%/100,0% | 100,0%/100,0%/100,0% | 65/42/260 |
| `useNotifications` | 1 | 12,5%/100,0%/22,2% | 100,0%/100,0%/100,0% | 100,0%/100,0%/100,0% | 189/49/1.052 |
| `groupMessagesByDate` | 2 | 40,0%/100,0%/57,1% | 100,0%/100,0%/100,0% | 100,0%/100,0%/100,0% | 126/65/473 |
| `getMessageText` | 2 | 12,5%/100,0%/22,2% | 100,0%/100,0%/100,0% | 100,0%/100,0%/100,0% | 377/60/1.105 |

## Agregado

- Busca manual textual: precisão **5,6%**, recall **100,0%**, F1 **10,6%**.
- `symbols`: precisão **100,0%**, recall **100,0%**, F1 **100,0%**.
- `context-pack`: precisão **100,0%**, recall **100,0%**, F1 **100,0%** para definições exatas.
- Saída estimada total: busca manual **~12.340 tokens**, `symbols` **~685**, `context-pack` **~9.001**.
- O `symbols` reduziu a saída de localização em aproximadamente **94,4%** contra a busca manual.
- O `context-pack` reduziu o volume bruto em aproximadamente **27,0%**, mas entregou evidências textuais e contexto adicional; não é uma ferramenta de compressão simples.
- O índice frio das quatro raízes custou aproximadamente **3,1 s** localmente. Depois disso, as consultas de `symbols` ficaram na ordem de milissegundos.

## Interpretação

Este benchmark responde a dúvida principal: para a pergunta fechada “onde estão as definições exatas?”, o resultado é **bom**. O ganho não é só sensação de navegação: houve recall completo e a precisão saiu de 5,6% na busca textual para 100% com os localizadores semânticos.

O `symbols` é o caminho econômico quando o agente precisa apenas localizar a definição. O `context-pack` também localizou corretamente, mas deliberadamente carrega mais evidência; ele faz sentido quando o agente precisa entender usos, candidatos textuais ou contexto ao redor.

Limites: são 10 consultas selecionadas e um único snapshot dos projetos. Isso valida fortemente a capacidade de localização, mas ainda não mede a qualidade de uma tarefa completa executada por um agente. O próximo passo, se quisermos fechar essa última lacuna, é repetir essas mesmas consultas com agentes e avaliar a resposta final contra o mesmo gold set.
