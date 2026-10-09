---
name: context-tools
description: Navegação de código e higiene de documentação sem re-explorar na mão. Use ao procurar onde um símbolo está definido, ao navegar arquivo grande (>1.500 linhas), ao querer saber que arquivos mudam junto com outro, explicar uma decisão de revisão de mapa ou identificar candidatos a cobertura documental pelo histórico. Também antes de commitar documentação ou quando o objetivo é reduzir leitura repetida entre sessões.
---

# Ferramentas de contexto

Os exemplos desta skill usam o caminho do plugin Codex: `${PLUGIN_ROOT}/scripts/`. Se o projeto tiver
uma instalação standalone, substitua esse prefixo por `.codex/scripts/`; não misture os dois modos.

## Instalação global e standalone

Quando esta skill vier do plugin, use os scripts do plugin diretamente. Não copie scripts,
skill ou hooks para o projeto. Se precisar inicializar a configuração local, execute
`node "${PLUGIN_ROOT}/install-codex.mjs" --mode=global`; esse modo não cria outra instalação.
A instalação standalone é uma escolha explícita para ambientes sem plugin global.

Para manutenção completa pelo terminal, `node "${PLUGIN_ROOT}/setup-codex.mjs"` instala/atualiza o
plugin, consulta a versão, executa diagnóstico e pode configurar `extraRepos` interativamente.

Os comandos abaixo **geram na hora** (nunca defasam) e **falham visível**: se não acharem,
dizem que não acharam e mandam para busca textual (`rg`/`grep`) — nunca devolvem vazio com cara
de resposta.

No Codex com instalação local no projeto, use **exatamente** `.codex/scripts/` — não execute
literalmente o placeholder `<scripts>`. No Claude local, o equivalente é `.claude/scripts/`.
Quando a skill vier de um plugin, use `${CLAUDE_PLUGIN_ROOT}/scripts/` no Claude ou
`${PLUGIN_ROOT}/scripts/` no Codex. Os scripts descobrem a raiz pelo contexto do agente, cwd ou
repositório acima; `--root=<dir>` força.

## Onde X está definido? → `symbols.mjs`

```
node "${PLUGIN_ROOT}/scripts/symbols.mjs" <nome> [--all]
```

Indexa todos os arquivos de código dos repositórios encontrados e devolve a **definição** —
não as dezenas de menções que `rg`/`grep` dariam. Use **antes** da busca textual quando procura uma função,
classe, método ou binding de topo.

## Montar contexto mínimo → `context-pack.mjs`

```
node "${PLUGIN_ROOT}/scripts/context-pack.mjs" <símbolo-ou-arquivo> --budget=2000
node "${PLUGIN_ROOT}/scripts/context-pack.mjs" <símbolo-ou-arquivo> --history --json
```

Compõe definições, outline, mapas, correspondências textuais e, sob demanda, histórico em um pacote
com orçamento de saída. Cada item identifica sua origem (`definition`, `test`, `context-map`,
`history` ou `textual-match`) e suas limitações; uma correspondência textual nunca é apresentada
como definição.

## Documentação operacional → `context-docs.mjs`

Todo projeto recebe, por padrão, uma estrutura neutra `ai-context/` na abertura da sessão. O
plugin cria somente o índice e as pastas padrão; o agente deve investigar e preencher o conteúdo,
sem inventar regras de negócio. A estrutura interna é fixa e acompanha o idioma configurado:

- Português: `00-indice.md`, `features/`, `telas/`, `decisoes/`, `integracoes/`, `banco/`.
- Inglês: `00-index.md`, `features/`, `screens/`, `decisions/`, `integrations/`, `database/`.

Use os comandos abaixo quando precisar preparar ou verificar um documento:

```
node "${PLUGIN_ROOT}/scripts/context-docs.mjs" init
node "${PLUGIN_ROOT}/scripts/context-docs.mjs" create --type=feature --name=credito-cliente
node "${PLUGIN_ROOT}/scripts/context-docs.mjs" status
node "${PLUGIN_ROOT}/scripts/context-docs.mjs" audit
```

`context-pack` consulta esses documentos como evidência adicional, sempre identificada como
`documentation`. No Codex, `UserPromptSubmit` confere offline os caminhos ou nomes exatos de arquivo citados
explicitamente no prompt; só injeta uma nota se o mapa estiver defasado, sem cobertura ou sem
verificação possível. Não chama modelo/rede nem grava o texto do prompt; prompts sem caminhos
explícitos e mapas atualizados não recebem contexto adicional. O processo local ainda tem custo de
inicialização e leitura/hash dos arquivos nomeados.

No `Stop` do Codex, mapas e documentos operacionais são selecionados pela interseção com caminhos
registrados nos eventos de edição da própria sessão (`apply_patch`, `Edit` e `Write`). O diário local
guarda caminhos e hashes, o turno e o último autor confirmado; reabrir o chat inicia outra época.
Eventos sobrepostos ficam sem atribuição automática. Antes de revisar, o Stop confere a versão
atual e o turno; uma sessão antiga não recupera autoria só porque o conteúdo voltou a ser igual.
Bash comum não atribui escrita. Para scripts que preservam encoding, declare os alvos com
`tracked-edit.mjs manifest --file=CAMINHO` e execute
`node "${PLUGIN_ROOT}/scripts/tracked-edit.mjs" --context-tools-edit=TOKEN -- EXECUTAVEL ARGUMENTOS`.
Declare todos os arquivos que o comando pode editar, inclusive em `extraRepos` configurados.
Consulte `health.mjs` para alterações sem atribuição. Claude
continua usando o baseline existente. Pendências globais antigas não iniciam uma revisão automática
numa sessão sem relação. Fontes sem cobertura só iniciam revisão automática se
dois arquivos irmãos mudarem juntos ou se a mesma fonte voltar a mudar em outra sessão nos 90 dias
seguintes; os casos isolados continuam visíveis na saúde local. Se houver pendência relevante, o Codex
inicia uma continuação limitada para o agente conferir as fontes e atualizar o material relacionado.
O script nunca escreve regras semânticas: o agente investiga o código, preserva o conteúdo existente e
só atualiza metadados de revisão depois de confirmar as fontes. O Codex permite uma continuação por
turno; o que não puder ser resolvido fica visível no encerramento. `A mapear` e `To map` nunca são
informação confirmada.

Para explicar a classificação de um arquivo específico pelo diário da sessão Codex (ou baseline Claude) e pelos mapas:

```
node "${PLUGIN_ROOT}/scripts/explain.mjs" --file <caminho> [--json]
```

Use um caminho relativo explícito ou absoluto. O diagnóstico mostra a atribuição à sessão,
os mapas que cobrem o arquivo, os documentos operacionais que o referenciam, o estado e a base do
fingerprint e a decisão prevista do `Stop`. A data de revisão dos documentos é informativa; o
comando não certifica atualidade semântica. É local, não edita mapas e não persiste fingerprints;
`unknown` significa que não há evidência suficiente para atribuir o arquivo.

Para desativar no projeto, use `"documentation": { "enabled": false }` na configuração do
plugin. `autoInit: false` preserva a consulta e os comandos, mas impede a criação automática da
estrutura na abertura da sessão. O diretório raiz pode ser ajustado; as subpastas padrão não.

## Provedores semânticos opcionais → `providers.mjs`

```
node "${PLUGIN_ROOT}/scripts/providers.mjs" --json
node "${PLUGIN_ROOT}/scripts/providers.mjs" --install-plan
```

Detecta language servers já instalados e mostra sugestões explícitas quando um parser semântico
não está disponível. Nenhum hook instala dependências ou acessa a rede automaticamente.

Não cobre variável local, chave de config nem coluna de banco. Nesses casos ele avisa e manda
para `rg`/`grep` — siga o conselho em vez de insistir.

## Medir uso local → `metrics.mjs`

```
node "${PLUGIN_ROOT}/scripts/metrics.mjs"
node "${PLUGIN_ROOT}/scripts/metrics.mjs" --json
node "${PLUGIN_ROOT}/scripts/metrics.mjs" --clear
```

Mostra contadores locais de adoção sem guardar prompts, conteúdo de arquivos ou comandos completos.

## Saúde do plugin e da documentação → `health.mjs`

```
node "${PLUGIN_ROOT}/scripts/health.mjs" [--days=30] [--audit] [--json]
```

Use quando o usuário pedir uma revisão da saúde ou adoção do context-tools neste projeto. Resume
métricas locais retidas, sinais de mapas/documentação desatualizados e, com `--audit`, problemas
estruturais da documentação. No chat do Codex, o agente pode executar esse comando com o projeto
aberto e explicar o relatório; ele não consulta dados remotos. Respostas emitidas pelo hook não
provam que foram usadas pelo agente, e um digest atualizado não prova correção semântica. O comando
pode atualizar caches locais de diagnóstico, mas não altera código nem documentos do projeto. Exibe
uma estimativa aproximada do texto de instrução do hook de revisão automática, sem guardar prompt,
fontes ou caminhos; a estimativa não representa tokens faturados nem inclui arquivos lidos ou resposta.

Para medir a sobrecarga completa do `PreToolUse` Bash no Codex, fora dos hooks normais:

```
node "${PLUGIN_ROOT}/scripts/benchmark-pretool.mjs" --samples=5
```

O benchmark inicia processos Node separados com comandos sintéticos que não são executados. Ele
mostra p50/p95 e o tempo inicial para comandos ignorados, padrões de busca textual e buscas com cara
de símbolo. Não exibe nem persiste o texto dos comandos. Na instalação standalone do Codex, use
`node .codex/scripts/benchmark-pretool.mjs --samples=5`.

## Que testes cobrem este arquivo? → `verify.mjs`

```
node "${PLUGIN_ROOT}/scripts/verify.mjs" <arquivo> [<arquivo>…] [--json]
```

Lista testes relacionados (mesmo nome ou que importam o arquivo — pista, não prova de cobertura) e
o comando de teste do projeto. Use depois de editar código e antes de declarar a tarefa concluída.
Não executa nada: rodar o teste continua sendo decisão do agente.

`symbols` também indexa `.sql`: tabelas, colunas, views, procedures, triggers, sequences.

## Navegar arquivo grande → `outline.mjs`

```
node "${PLUGIN_ROOT}/scripts/outline.mjs" <arquivo> [filtro-regex]
```

Devolve `linha → símbolo` de **um** arquivo (em `.md`, as seções). Use depois de já saber qual
arquivo, quando ele for grande demais para ler inteiro. Com filtro custa ~1 KB e dá a linha
exata; depois faça uma leitura dirigida.

**Não faça** dezenas de leituras com offset caçando algo num arquivo de milhares de linhas — é
exatamente o desperdício que este comando existe para eliminar.

## O que muda junto com este arquivo? → `coupling.mjs`

```
node "${PLUGIN_ROOT}/scripts/coupling.mjs" <arquivo>     # correlações deste arquivo
node "${PLUGIN_ROOT}/scripts/coupling.mjs"               # top acoplamentos do projeto
node "${PLUGIN_ROOT}/scripts/coupling.mjs" --changed     # o que está modificado sem o par habitual
```

Lê o histórico do git e descobre correlação que **ninguém documentou** — "toda vez que mexem
neste controller, o validator muda junto em 88% das vezes".

A confiança é **direcional**, e a distinção importa:
- `leva junto` = das vezes que você mexe NESTE, o outro muda também ← é o que interessa antes de editar
- `puxado por` = das vezes que o OUTRO muda, este vem junto

Use ao começar uma mudança (para saber o que provavelmente virá junto) e ao escrever um mapa de
contexto (a seção de correlações deve **partir da medição**, não da memória).

Para encontrar candidatos sem cobertura que co-mudam repetidamente com fontes mapeadas:

```
node "${PLUGIN_ROOT}/scripts/map-suggestions.mjs" [--json]
```

O relatório manual reaproveita os limiares de `coupling`, ignora fontes excluídas e só sugere
candidatos com relação direcional suficiente no histórico Git. Co-mudança é uma pista para
revisão, não confirmação semântica; nenhum mapa é criado ou alterado. Repositórios sem Git são
reportados sem candidatos históricos.

## Registrar revisão de mapa/documento → `ack.mjs`

```
node "${PLUGIN_ROOT}/scripts/ack.mjs" <mapa-ou-documento.md> [--source=<chave>]
```

Quando um aviso disser que um mapa ou documento `ai-context` ficou defasado: confira as fontes
citadas, corrija o texto se preciso e rode `ack`. Ele calcula e grava `source_fingerprints`,
`source_digest` e a data — nunca copie hashes à mão.

## Antes de commitar doc → `audit-docs.mjs`

```
node "${PLUGIN_ROOT}/scripts/audit-docs.mjs" [arquivo.md] [--strict]
```

Acha ponteiro de linha podre, símbolo/arquivo citado que não existe mais, hash de commit
inválido e alegação de status sem data. `--strict` sai com código 1 se houver ponteiro de linha
(serve para pre-commit).

## Regra que vale mais que as ferramentas

🚫 **Nunca escreva `arquivo:linha` em documentação.**

Numa auditoria real, das 13 referências `símbolo @ arquivo:linha` conferidas contra o código,
**nenhuma estava certa** — a pior errava por 2.861 linhas. Nenhum símbolo havia sumido; só os
números apodreceram. Cite o símbolo e deixe a linha ser resolvida na hora por `symbols`/`outline`.

O mesmo vale para status: "não commitado" escrito hoje é mentira em duas semanas. Se precisar
registrar, deixe explícito que a informação é datada.

## Configuração (opcional)

Só é necessária para fugir da convenção. Use `.claude/context-tools.json` no Claude ou
`.codex/context-tools.json` no Codex:

```json
{
  "sourceDirs": ["packages/core/src", "packages/api/src"],
  "statusLanguages": ["pt", "en"],
  "coupling": { "since": "6 months ago", "minTogether": 3, "warnConfidence": 0.7 },
  "claudeMdHint": false,
  "extraRepos": ["../AppConnection", "../shared"]
}
```

Sem o arquivo, as pastas de código são detectadas (`src`, `lib`, `app`, `packages`, `tests`…)
e os três idiomas de status ficam ativos.

`extraRepos` inclui repo(s) irmão(s) da raiz no índice — mesmo sem `.git` próprio — para quando
a raiz precisa continuar sendo um projeto específico (workspace pai tem muitos outros projetos
que não interessam). Caminhos relativos à raiz, restritos à subárvore da pasta PAI da raiz
(`../vizinho` ok, `../../mais-fundo` recusado).

**Sem configurar nada, o plugin tenta derivar `extraRepos` sozinho de um `*.code-workspace`
do VS Code** (na raiz ou na pasta pai) — quem já monta workspace multi-root no editor não
precisa repetir a curadoria numa segunda config. `extraRepos: []` explícito desliga essa
detecção automática.

Na primeira sessão com um `CLAUDE.md` ou `AGENTS.md` já existente, a integração do agente pode
anexar (uma vez só) uma nota curta sugerindo usar `context-tools` antes de abrir um subagente de
exploração ampla para "onde X está definido". `claudeMdHint: false` desliga a dica nos dois
agentes; `codexMdHint: false` desliga apenas a variante Codex.

## Regra de custo do hook

O hook tenta `symbols` primeiro. Só monta um pack pequeno (orçamento 800) quando encontra
definições ambíguas ou distribuídas em vários arquivos; se faltar evidência de definição exata,
escala para 2.000. `context-pack` não é o passo padrão de toda busca.

## Fila de revisão e políticas documentais

`node "${PLUGIN_ROOT}/scripts/review.mjs" status --json` mostra revisões locais pendentes.
Use `show --id=ID --json` para obter o manifesto completo. Após conferir as fontes e atualizar
os fatos relevantes, `ack --id=ID --revision=REVISION --reviewed` registra somente as versões listadas;
`--source=CHAVE` permite confirmação parcial. Nunca use ack sem inspecionar a fonte.
`defer --id=ID --reason=insufficient-evidence` preserva uma pendência sem outro prompt automático;
`retry --id=ID` libera uma tentativa solicitada. Revisões são deduplicadas por documento e versão,
independentemente da ordem do lote. Uma nova versão pode ser revisada novamente.

Documentos operacionais aceitam `maintenance: live|historical|manual`. Decisões são históricas
por padrão: uma mera menção a código não cria obrigação de reescrever um incidente passado.
Para uma decisão que descreve regras atuais, declare `maintenance: live`.
`review_sources: ["./src/a.js"]` restringe referências atuais explicitamente.
Opcionalmente `review_dependencies: [{"source":"./src/a.js","symbols":["function foo"]}]`
usa nomes exatos do outline para delimitar a dependência. Escopos inválidos ou linguagens sem
parser confiável voltam à comparação do arquivo inteiro e aparecem no diagnóstico.
Não declare escopo de símbolo se o comportamento também depende de fontes fora dele.
Sincronizar um digest com fingerprints completos e válidos é trabalho mecânico offline;
confirmar fatos continua exigindo inspeção. Um hash não prova correção semântica.
