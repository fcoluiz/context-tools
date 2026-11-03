---
name: context-tools
description: Navegação de código e conhecimento do projeto sem re-explorar na mão. Use para achar onde um símbolo está definido, quem o usa, o que está em jogo antes de mudá-lo, o panorama do projeto, navegar arquivo grande (>1.500 linhas) ou ver o que muda junto. Também antes de commitar documentação, ao revisar mapa/documento defasado, ou quando o usuário pedir para registrar algo "no contexto".
---

# Ferramentas de contexto

Tudo passa por um comando: `node "${PLUGIN_ROOT}/scripts/ct.mjs" <verbo> …` (plugin Codex). No plugin
Claude o prefixo é `${CLAUDE_PLUGIN_ROOT}/scripts/`; numa instalação standalone, **exatamente**
`.codex/scripts/` ou `.claude/scripts/` — não misture os modos nem copie scripts do plugin para o
projeto. `ct.mjs help` lista os verbos; os scripts de antes (`symbols.mjs`, `outline.mjs`…) continuam
valendo. A raiz vem do agente, do cwd ou do repositório acima; `--root=<dir>` força.

⚠️ **Sempre `node` + prefixo completo.** As tabelas abaixo e os avisos dos hooks abreviam para
`ct.mjs …`/`symbols.mjs …`; ao rodar, escreva `node "<prefixo>/ct.mjs" …`. Nunca execute um `.mjs`
direto: no PowerShell/cmd do Windows isso não roda o script — abre a janela "Selecione um
aplicativo para abrir este arquivo .mjs" e trava a tela do usuário.

Tudo é **gerado na hora** (nunca defasa) e **falha visível**: sem resposta, diz e manda para
`rg`/`grep` — siga o conselho em vez de insistir. Variável local, propriedade aninhada e coluna fora
de `.sql` não estão no índice.

## Antes de explorar

| pergunta | comando |
|---|---|
| onde X está definido? | `ct.mjs find <nome> [<nome>…] [--all]` |
| quem usa X, e de qual função? | `ct.mjs refs <nome> [--all] [--strings]` |
| onde na tela fica "texto" (Delphi)? | `ct.mjs ui <texto da tela> [--in=<form>]` |
| o que está em jogo antes de mudar X? | `ct.mjs impact <símbolo-ou-arquivo>` |
| como navego este arquivo grande? | `ct.mjs outline <arquivo> [filtro]` |
| o que muda junto com este arquivo? | `ct.mjs coupling <arquivo>` (ou `--changed`) |
| panorama do projeto | `ct.mjs overview` |
| pacote de evidências com orçamento | `ct.mjs pack <símbolo-ou-arquivo> --budget=2000` |
| por que este código é assim? | `ct.mjs why <símbolo>` |
| que testes cobrem, e como rodar? | `ct.mjs verify <arquivo>…` |

- `find` antes da busca textual por função, classe, método, tipo ou tabela/coluna `.sql`: devolve a
  definição com o intervalo de linhas, não dezenas de menções. O hook de busca já faz isso antes de
  um grep com cara de símbolo — não repita a consulta.
- `outline` quando já sabe o arquivo e ele é grande demais: com filtro custa ~1 KB e dá a linha
  exata. **Não** faça dezenas de leituras com offset caçando algo num arquivo de milhares de linhas.
- `refs` e `impact` são por nome, não por tipo: nomes iguais não são distinguidos e uso dinâmico não
  aparece. Use `impact` antes de mudar assinatura, renomear ou apagar.
- `coupling` é direcional: `leva junto` = quando você mexe NESTE, o outro muda também (o que importa
  antes de editar); `puxado por` é o inverso. Correlação escrita em mapa parte dessa medição.
- `verify` depois de editar e antes de declarar concluído; ele não executa nada.

## Conhecimento escrito: mapas e `ai-context/`

Mapas de contexto (`.claude/context/`, `.codex/context/`) e a documentação operacional `ai-context/`
(`00-indice.md`, `features/`, `telas/`, `decisoes/`, `integracoes/`, `banco/`; em inglês `00-index.md`,
`screens/`, `decisions/`, `integrations/`, `database/`) roteiam a investigação; não substituem o
código. "Atualizado" significa que a fonte não mudou desde a revisão — nunca que o texto está certo.
`A mapear`/`To map` nunca é informação confirmada. O plugin só cria estrutura e templates
(`ct.mjs docs init|status|audit`, `ct.mjs docs create --type=<tipo> --name=<nome>`); o conteúdo vem do
agente, depois de investigar, sem inventar regra de negócio.

### Pedido "registre no contexto" ("save this to context")

Vale para o que ESTA conversa investigou; não exige pasta nem tipo. Tipo pelo conteúdo: fluxo
entre telas/units → `feature`; tela → `tela`; tabelas → `banco`; sistema externo →
`integracao`; escolha técnica → `decisao`. Documento que já cobre a área é atualizado; senão,
`ct.mjs docs create --type=<tipo> --name=<nome>`. Só o que o código confirmou, sem
`arquivo:linha`; o resto fica `A mapear`. Some uma linha ao índice e mostre o que registrou. O
`Stop` sugere a frase ao usuário quando a sessão só leu código sem cobertura; não registre por
conta própria (`"captureHint": false` desliga).

### Mapa ou documento defasado

Confira as fontes citadas antes de registrar e nunca copie hashes à mão. O passo a passo (`ack`,
`explain`, a fila local do Codex, `tracked-edit` e os metadados de documento) está em
`references/revisao.md`, ao lado deste arquivo: leia antes de registrar uma revisão.

## Antes de commitar documentação

`ct.mjs check [arquivo.md] [--strict]` acha ponteiro de linha podre, símbolo/arquivo que não existe
mais, hash de commit inválido e status sem data (`--strict` serve para pre-commit).

🚫 **Nunca escreva `arquivo:linha` em documentação.** Numa auditoria real, nenhuma das 13 referências
conferidas estava certa — a pior errava por 2.861 linhas. Cite o símbolo; a linha se resolve na hora
com `find`/`outline`. Status ("não commitado") vira mentira em semanas: se registrar, deixe datado.

## Diagnóstico e configuração

`health`, `providers`, `drift`, métricas e as chaves de `context-tools.json`: leia
`references/diagnostico.md` (ao lado deste arquivo) quando o pedido for sobre isso.
