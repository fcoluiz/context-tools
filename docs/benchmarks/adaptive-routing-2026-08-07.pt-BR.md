# Benchmark econômico — roteamento de contexto

Data: 2026-08-07
Escopo: leitura somente; nenhum projeto analisado foi alterado e nenhuma chamada de modelo foi feita.

## Objetivo

Medir se o `context-pack` precisa ser usado sempre ou se uma política adaptativa preserva a
qualidade gastando menos contexto.

Foram reutilizados os mesmos 10 casos, 25 definições esperadas, quatro raízes de projeto e três
repetições do benchmark controlado.

Estratégias comparadas:

- busca manual textual;
- `symbols`;
- `context-pack` fixo com orçamento 2.000;
- adaptativo: `symbols` primeiro; usa `context-pack@800` somente quando há mais de duas definições
  exatas ou quando a resposta atravessa mais de um arquivo.

## Resultado

| Estratégia | Precisão | Recall | F1 | Saída estimada |
|---|---:|---:|---:|---:|
| Busca manual | 5,6% | 100,0% | 10,6% | ~12.340 tokens |
| `symbols` | 100,0% | 100,0% | 100,0% | ~685 tokens |
| Pack fixo | 100,0% | 100,0% | 100,0% | ~9.001 tokens |
| Adaptativo | 100,0% | 100,0% | 100,0% | ~5.800 tokens |

O roteamento adaptativo usou `symbols` em cinco casos e `context-pack@800` nos outros cinco.
Mesmo com orçamento 800, a saída final serializada pode passar desse número porque o orçamento
limita principalmente os itens de evidência, não todo o envelope JSON.

## Leitura econômica

- Contra o pack sempre ligado, o adaptativo economizou aproximadamente **35,6%** de saída.
- Contra a busca manual, economizou aproximadamente **53,0%**.
- Contra `symbols` sozinho, gastou cerca de 8,5 vezes mais, mas entregou contexto adicional nos
  casos ambíguos ou distribuídos em vários arquivos.
- A precisão e o recall permaneceram em **100%** no conjunto controlado.

## Conclusão

O pack não deve ser padrão universal. A primeira política economicamente razoável é:

1. tentar `symbols`;
2. observar quantidade e distribuição dos resultados;
3. chamar um pack menor apenas quando a pergunta realmente exigir contexto adicional;
4. ampliar o orçamento somente se a evidência inicial não bastar.

Este benchmark prova o custo do roteamento no nível das ferramentas, sem gastar tokens de agentes.
Ainda não prova que o pack melhora a conclusão de uma tarefa completa; para isso, o próximo teste
deve ser pequeno, com no máximo dois cenários e comparação de resultado final, retrabalho e tokens.
