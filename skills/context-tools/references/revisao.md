# Mapa ou documento defasado

Parte da skill `context-tools`; lida sob demanda. Prefixo dos comandos: o mesmo do `SKILL.md`.

Confira as fontes citadas, corrija o texto se preciso e registre com
`ct.mjs ack <mapa-ou-documento.md> [--source=<chave>]` — ele grava `source_fingerprints`,
`source_digest` e a data. Nunca copie hashes à mão nem registre sem inspecionar a fonte.
`ct.mjs explain --file <caminho>` diz por que um arquivo entra (ou não) em revisão.

Ao relatar: releia a fonte agora; antes de dizer que algo sumiu ou não é usado, `ct.mjs refs` na
árvore inteira. Cada divergência traz o caso concreto (o texto diz X, o símbolo `Y` faz Z), em
**Corrigir** / **Completar** / **Opcional**, numeradas sem reiniciar ("faça 2 e 5"). Feche com
`Veredito:` (registrado, registrado com correções ou não registrado) e `Não verificado:` (o que
não foi lido ou depende de uso dinâmico).

Fila local (Codex): `ct.mjs review status --json` e `show --id=ID --json`; depois de conferir,
`ack --id=ID --revision=REVISION --reviewed` das versões conferidas (`--source=CHAVE` parcial;
`coverage`: crie doc que cite a fonte e use `--document=PATH --kind=map|document`),
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
