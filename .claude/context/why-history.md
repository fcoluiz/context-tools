---
area: why-history
covers:
  - "scripts/why.mjs"
verified_at: 8cacc4a
verified_date: 2026-08-11
---

# "Por que este código é assim?" — mapa de área

A única ferramenta do plugin que responde sobre **decisões**, não sobre estado. As outras dizem onde X está (`symbols`), o que tem em volta (`outline`), o que muda junto (`coupling`), o que apodreceu (`audit-docs`) — todas sobre o código como ele é agora. Esta responde a pergunta em que ler o arquivo inteiro **não ajuda**, porque a resposta não está lá: está no histórico. Roda sob demanda, nunca como hook.

## Por onde começar (símbolo → arquivo)
- `main()` → dois modos: `<arquivo> <linha>` (explícito) ou `<símbolo>` (resolvido pelo índice). `--n=` controla quantos commits (padrão 3, teto 10).
- `historicoDoTrecho(repoPath, arquivo, inicio, fim, n)` → o coração: `git log -L <ini>,<fim>:<arquivo>`. Único símbolo exportado.
- `git(repo, args)` → wrapper único; acumula falhas em `falhas` em vez de engolir.
- `CONTEXTO_LINHAS` (30) · `MAX_CORPO` (600) · `GIT_TIMEOUT_MS` (30 s) → os tetos.

## Invariantes (não dá pra inferir de um arquivo só)
- **A classe de erro que isto existe para evitar é "confiantemente errado".** Um agente remove um guard que existe por um motivo, "simplifica" o que já foi simplificado e quebrou, troca um limiar que foi medido. É a mesma falha que o resto do plugin combate, no eixo que faltava — e por isso a resposta certa quando não há o que dizer é **dizer isso**, nunca devolver vazio com cara de resposta.
- **`git log -L` (trecho), não `git log <arquivo>`.** O `-L` segue as linhas através de renomeações e reindentações. Num arquivo de 14 mil linhas o histórico do ARQUIVO é ruído quase puro e o histórico do TRECHO é a resposta — trocar um pelo outro destrói o valor da ferramenta sem quebrar nada visivelmente.
- **"Não achei" e "não consegui olhar" são coisas diferentes, e o remédio de uma não serve para a outra.** Histórico raso (`clone --depth 1`) é o caso mais comum e o conserto é `git fetch --unshallow`. Por isso `git()` empilha em `falhas` em vez de usar `safe()`, e há DUAS saídas distintas: `why.gitFalhou` quando nada saiu, e `why.parcial` quando saiu resultado mas alguma chamada falhou. **A saída parcial é a mais importante das duas** — é a única que impede um resultado incompleto de passar por completo.
- **É sob demanda e NUNCA virou hook, por custo medido:** ~1,1 s por símbolo, porque o `git log -L` percorre o histórico daquele intervalo. Promover isto a hook cobraria esse segundo de toda sessão para responder uma pergunta que quase nunca está sendo feita.
- **No modo símbolo, resolve no máximo 3 alvos**, e prefere os de nome EXATO aos parciais. Sem a preferência por exato, buscar um nome curto gastaria os três slots em símbolos cujo nome apenas o contém, e o símbolo procurado ficaria de fora.
- **O corpo do commit é cortado no primeiro marcador de diff** (`diff --git`, `@@`, `---`, `+++`): o `git log -L` sempre imprime o patch, então sem esse corte a prosa vem colada no diff e a saída vira ruído.

## Gotchas (queimam em silêncio)
- ⚠️ **O intervalo consultado é `inicio .. min(end, inicio+30)`, não o símbolo inteiro.** Função maior que `CONTEXTO_LINHAS` tem o histórico lido só do começo dela — commits que só tocaram o fim do corpo não aparecem, e nada avisa que a janela foi truncada.
- ⚠️ **A reconciliação repo × caminho é por TENTATIVA E ERRO.** O `file` do índice pode vir prefixado pelo nome do repo (workspace multi-repo), então o código testa o caminho como está e, se não existir, tenta de novo sem o primeiro segmento. Alvo que não casar em nenhum dos dois é **descartado calado** pelo `continue`; se todos caírem aí, a saída é "símbolo não encontrado" — mensagem que aponta para a causa errada.
- ⚠️ Diferente dos hooks, aqui **não vale M4**: o `catch` do `isMain` imprime `why: <erro>`. É ferramenta de linha de comando, não hook — falhar visivelmente é o comportamento certo, e copiar o silêncio dos hooks para cá seria regressão.
- ⚠️ `maxBuffer` é `1 << 26` (64 MB), **quatro vezes menor** que o de `coupling.mjs` (256 MB). Trecho com histórico muito longo pode estourar; o estouro cai em `falhas` e vira mensagem honesta, não silêncio — mas o teto é mais baixo do que se imagina por analogia.
- ⚠️ O parser da saída depende dos separadores `%x00` (registro) e `%x1f` (campo). São bytes que não aparecem em mensagem de commit normal, mas o formato é acoplado ao `--format` da linha 59: mexer num sem o outro quebra o parse **sem erro**, devolvendo lista vazia — que é indistinguível de "sem histórico".
- ⚠️ Constrói o índice inteiro (`buildIndex`) só para resolver UM símbolo. Em repo acima do limiar de cache isso é ~130 ms com cache quente, mas ~1,7 s frio — e a primeira execução num projeto novo é sempre fria.

## Não cobre (e por quê)
- `coupling.mjs` — também lê git, mas responde outra pergunta (o que muda JUNTO, por correlação estatística); mapa próprio em `change-coupling.md`.
- `symbols.mjs` / `outline.mjs` — o índice consumido aqui; mapa próprio em `symbol-lookup.md`.
- `lib/roots.mjs` — coberto por `context-maps-hook.md`.
