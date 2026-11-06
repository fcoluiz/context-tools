# Revisão de código e auditoria

Dois modos. **Revisão** (pedido de revisar o diff, a branch, um PR): o alvo é a mudança. **Auditoria**
(pedido de auditar ou revisar o projeto inteiro): o alvo é o repositório. Só responde; não cria
arquivo de relatório sem pedido.

## Antes de ler

- Revisão: `ct.mjs changes` (árvore de trabalho contra `HEAD`) ou `ct.mjs changes --base=origin/main`
  (a branch). Ele lista, para cada símbolo mudado ou removido, os usos em arquivos **fora** do diff.
  Leia esses chamadores: é onde a mudança quebra sem ninguém ter tocado no arquivo.
- Auditoria: `ct.mjs overview` para entradas e áreas, `ct.mjs coupling --changed` e o `git log` recente
  para onde o código mexe mais; leia primeiro o caminho dos dados (entrada → validação → gravação).
- Nos dois: `ct.mjs verify <arquivo>` diz que testes cobrem o que mudou e como rodá-los.

## O que procurar, nesta ordem

1. Bug: entrada que leva a resultado errado, chamador fora do diff que quebra, erro engolido.
2. Segurança: entrada sem validação na fronteira, segredo no código, caminho ou SQL montado com texto
   do usuário (pedido de segurança: `references/seguranca.md`; interface: `references/frontend.md`).
3. Perda de dado e carga real: lote grande, laço com consulta dentro, arquivo lido inteiro.
4. Lógica com ramo, laço, parser, dinheiro ou segurança sem teste.
5. O que dá para cortar: código que não precisa existir, abstração com um uso só, dependência que a
   biblioteca padrão resolve.

## Como relatar

- Nenhum achado sem caso concreto ("com `qtd = 0`, `media()` divide por zero"). Releia as linhas antes
  de reportar; antes de dizer "não usado", `ct.mjs refs` na árvore inteira.
- Grupos **Corrigir** / **Deveria corrigir** / **Opcional**, numerados sem reiniciar ("faça 2 e 5").
- Cada achado em quatro partes curtas: o que o código faz, o que dá errado, a correção mínima, o que
  acontece se ficar.
- Na auditoria, ordene por prioridade e diga o que corrigir primeiro.
- Feche com `Veredito:` (pode seguir, seguir depois de corrigir, ou não seguir) e `Não verificado:`
  (o que não foi lido, uso dinâmico, carga que você supôs). Na auditoria, `Cobertura:` o que foi lido
  e o que ficou de fora; "nada encontrado" só vale para o que foi lido.
