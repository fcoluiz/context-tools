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

Tudo é **gerado na hora** (nunca defasa) e **falha visível**: sem resposta, diz e manda para
`rg`/`grep` — siga o conselho em vez de insistir. Variável local, propriedade aninhada e coluna fora
de `.sql` não estão no índice.

## Antes de explorar

| pergunta | comando |
|---|---|
| onde X está definido? | `ct.mjs find <nome> [<nome>…] [--all]` |
| quem usa X, e de qual função? | `ct.mjs refs <nome> [--all]` |
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

Confira as fontes citadas, corrija o texto se preciso e registre com
`ct.mjs ack <mapa-ou-documento.md> [--source=<chave>]` — ele grava `source_fingerprints`,
`source_digest` e a data. Nunca copie hashes à mão nem registre sem inspecionar a fonte.
`ct.mjs explain --file <caminho>` diz por que um arquivo entra (ou não) em revisão.

Fila local (Codex): `ct.mjs review status --json` e `show --id=ID --json`; depois de conferir,
`ack --id=ID --revision=REVISION --reviewed` só para as versões conferidas (`--source=CHAVE` parcial),
`defer --id=ID --reason=insufficient-evidence` ou `retry --id=ID`. O Codex permite uma continuação
por turno; o que sobrar fica visível no fim.

No Codex o `Stop` atribui edições pelos eventos `apply_patch`/`Edit`/`Write`; Bash comum não conta.
Script que edita arquivos declara os alvos:
`node "${PLUGIN_ROOT}/scripts/tracked-edit.mjs" manifest --file=CAMINHO` e depois
`node "${PLUGIN_ROOT}/scripts/tracked-edit.mjs" --context-tools-edit=TOKEN -- EXECUTAVEL ARGUMENTOS`
(todos os arquivos possíveis, inclusive em `extraRepos`).

Metadados opcionais de documento: `maintenance: live|historical|manual` (decisões são históricas
por padrão), `review_sources: ["./src/a.js"]` e
`review_dependencies: [{"source":"./src/a.js","symbols":["function foo"]}]` (nomes exatos do
outline; não declare escopo de símbolo se o comportamento depende de fontes fora dele).

## Antes de commitar documentação

`ct.mjs check [arquivo.md] [--strict]` acha ponteiro de linha podre, símbolo/arquivo que não existe
mais, hash de commit inválido e status sem data (`--strict` serve para pre-commit).

🚫 **Nunca escreva `arquivo:linha` em documentação.** Numa auditoria real, nenhuma das 13 referências
conferidas estava certa — a pior errava por 2.861 linhas. Cite o símbolo; a linha se resolve na hora
com `find`/`outline`. Status ("não commitado") vira mentira em semanas: se registrar, deixe datado.

## Diagnóstico e configuração

- `ct.mjs health [--days=30] [--audit] [--json]`: saúde local, atualidade do conhecimento e uso.
  Resposta emitida por hook não prova uso; digest em dia não prova correção. Contadores crus:
  `node "${PLUGIN_ROOT}/scripts/metrics.mjs" [--json|--clear]`.
- `ct.mjs providers [--install-plan]`: language servers opcionais; nenhum hook instala nada.
- `map-suggestions.mjs`: arquivos sem mapa que co-mudam com fontes mapeadas (pista, não confirmação).
- Configuração opcional em `.claude/context-tools.json` ou `.codex/context-tools.json`:
  `sourceDirs`, `ignoreDirs` (pastas descartáveis, por nome), `extraRepos` (repos irmãos; derivado
  de um `*.code-workspace` quando existe, `[]` desliga), `coupling`, `lang`,
  `claudeMdHint`/`codexMdHint`, `documentation.{enabled,autoInit,captureHint,root}`, `updateCheck`.
