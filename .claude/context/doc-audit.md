---
area: doc-audit
covers:
  - "scripts/audit-docs.mjs"
verified_at: ce96046
verified_date: 2026-10-08
source_fingerprints: {"scripts/audit-docs.mjs":"sha256:455fdcd57f25ed0794b17af7eb17045f18d4f36f597eed6830347c282b388293"}
source_digest: sha256:ea8ae60dca1feeb0a2b5169bf50ddb6f6d842b13e165b39e59f0e0995c9c60f2
---

# Auditoria de documentação — mapa de área

Confere doc contra código: ponteiro de linha podre, símbolo fantasma, arquivo inexistente, hash de commit inválido, alegação de status sem data. Roda sob demanda (não é hook).

## Por onde começar (símbolo → arquivo)
- `main()` → resolve alvos (um `.md` específico ou todos os `docs/` de cada projeto), monta o índice de código uma vez e itera.
- `auditDoc(file, code, root, checkHashes, cfg)` → **as 5 checagens**, na ordem: ponteiros → símbolos fantasma → arquivos fantasma → hashes → alegações de status.
- `collectCandidates(targets)` → fase 1: lê cada doc uma vez, guarda o texto e colhe todo token em crase que seja candidato a símbolo.
- `resolveExistence(root, cfg, tokens)` → fase 2: passe único pelo código, **um arquivo por vez**, marcando quais candidatos existem; devolve `{encontrados, names}`. A existência é testada por substring no conteúdo do arquivo, não por análise sintática.
- `nomeCitado(tok)` → normaliza o token em crase para o nome pesquisável, desmontando `nome(args)`. **As duas fases precisam usar a mesma normalização** — a fase 1 povoa o índice pelo nome nu, então comparar na fase 2 com o token cru não casaria nada e tudo viraria fantasma.
- `makeHashChecker(repoList)` → valida hashes de commit em **lote** via `git cat-file --batch-check`.
- `plausible(s)` → filtro que decide se uma string em crase parece nome de símbolo.

## Invariantes (não dá pra inferir de um arquivo só)
- **Símbolo é validado por substring no conteúdo dos arquivos, não por parsing.** Barato e sem falso negativo, mas significa que um símbolo citado no doc "existe" se aquela sequência de caracteres aparecer em QUALQUER lugar do código — inclusive dentro de um comentário ou de outro identificador maior. Assimetria consciente: prefere-se não acusar do que acusar errado.
- **`plausible()` é o que segura o ruído.** Só considera candidato quem tem ≥5 caracteres, mistura maiúscula/minúscula (camelCase ou PascalCase) e não está na `STOPW`. Sem esse filtro, toda crase do doc (`true`, `npm`, `main`) viraria "símbolo inexistente".
- **`documentsRemoval` rebaixa severidade, não silencia.** Doc que registra remoção (`REMOVIDO`, `deprecated`, `registro histórico`…) cita legitimamente símbolos que não existem mais — nesse caso o achado vira `baixo` com a nota "provavelmente legítimo". Sem isso a auditoria gritava justamente nos docs já anotados corretamente.
- **Hash é checado em lote, com cache.** Um spawn de git por hash por doc levava ~15 s; em lote, ~2 s. Todo hash entra no cache como `false` antes da consulta — ausência de resposta = inválido.
- **Os MAPAS DE CONTEXTO são auditados; o resto de `.claude/` não.** `walk` pula toda entrada iniciada por `.` e `IGNORED` contém `.claude` — regra certa para cache, travas e baseline, e errada para os mapas, que são documentação escrita à mão e eram os **únicos documentos do projeto que ninguém auditava**. `main()` os acrescenta como alvo explícito, e **não** afrouxando o `walk`: afrouxar traria `.symbols-cache.json` e companhia junto, e a poda protege todo projeto que usa o plugin. Ao ligar isto nos 7 mapas deste repo: 4 achados, **1 real** (um mapa citava o nome antigo de uma guarda de execução direta).
- **Token de arquivo iniciado por PONTO é ignorado, junto com o glob.** `.d.ts`, `.test.mjs`, `.spec.js` são PADRÃO de arquivo, não arquivo — e é assim que documentação sobre filtro os escreve; eram 3 dos 4 achados acima. O preço é não acusar um dotfile real que suma, porque as duas formas são indistinguíveis por estrutura. É o mesmo lado de errar já escolhido na checagem de símbolo: **achado falso que nunca some ensina a ignorar a categoria inteira.**
- **Duas listas de projeto, de propósito:** `repoList` (`requireGit:true`) alimenta só o verificador de hash, que não faz sentido sem git; `projectList` (`requireGit:false`, e recebe `cfg` desde 2026-08-05 para habilitar `extraRepos` — ver `symbol-lookup`) descobre os docs, o que vale mesmo em projeto sem versionamento.
- **Doc passado como argumento precisa estar DENTRO da raiz indexada, ou é recusado.** O índice de código vem da raiz; auditar um `.md` de outro projeto compara o doc com um repositório sem relação e acusa quase todo símbolo de inexistente. Medido em projeto de terceiro: **93 achados `[alto]` + 13 `[medio]` viraram 1 `[medio]` com a raiz certa — 105 dos 106 eram artefato**. A recusa sai com exit 0 e diz para reapontar `--root=`, porque não auditar não é erro; afirmar "não existe" sobre código que não foi olhado, sim.
- **`--strict` sai com exit 1 apenas por ponteiro de linha**, não pelos outros achados — foi desenhado para pre-commit, e ponteiro é o único achado 100% mecânico (os demais têm heurística).

- **Duas fases, e a ordem é obrigatória:** `collectCandidates` (docs) precisa rodar ANTES de `resolveExistence` (código) — é conhecer todos os candidatos de antemão que permite varrer o código um arquivo por vez, descartando o conteúdo. Memória O(candidatos), não O(codebase). Medido: 12,9 s → 6,9 s no mesmo corpus, mesmo resultado (85/242).
- **`t` no escopo de `auditDoc` é o TRADUTOR.** Usar `t` como variável de laço ali já quebrou o código uma vez; os laços usam `tok`/`alvo`.

## Gotchas (queimam em silêncio)
- ⚠️ **O relatório corta em 25 docs** (`report.slice(0, 25)`), mas o contador do cabeçalho conta todos. Num corpus grande (o workspace de referência tem 242 docs, 85 com achados) o que aparece na tela **não é a lista completa** — a diferença é sinalizada com "… +N doc(s)", fácil de não ver.
- ✅ **CORRIGIDO (2026-08-04): símbolo que só existe em arquivo da RAIZ não é mais falso positivo.** Era o caso do próprio README deste repo, que acusava `$CLAUDE_PROJECT_DIR` como inexistente porque ele só aparece em `install.mjs`, na raiz, enquanto `scripts/` existia. Duas mudanças fecharam isso: `sourceDirs()` passou a devolver **a raiz do repo, sempre** (adivinhar pasta de convenção escondia repositório inteiro em silêncio — ver `symbol-lookup`), e `resolveExistence` acrescenta `rootFiles(repo.path, CODE_RE)` quando não há `cfg.sourceDirs`. **O `if (!cfg.sourceDirs)` é a condição certa e não uma economia:** quem restringiu as pastas à mão não quer a raiz de volta por baixo do pano.
- A lista de arquivos é **deduplicada** antes do laço (`vistos`). Com `sourceDirs` devolvendo a raiz, o `walk` já traz os arquivos soltos dela e o `rootFiles` os traz de novo — sem a dedupe cada um seria LIDO duas vezes. Mesma correção que `symbols.mjs` precisou, pela mesma causa.
- **Arquivo de código é lido por `lerTexto`, não `readFileSync(...,'utf8')`** — BOM removido e fallback para latin1. Aqui isso importa mais que em outros lugares: a existência é testada por `content.includes(tok)`, então arquivo cp1252 mal decodificado transformava símbolo acentuado real em **fantasma acusado com confiança**.
- ⚠️ `STATUS_PATTERNS` cobre pt/en/es. Doc em outro idioma passa batido na checagem de status **sem avisar** que não foi checado. Configurável por `statusLanguages` no `context-tools.json`.
- ⚠️ Diferente de `symbols.mjs`, aqui **não há cache nem tier**: todo arquivo de código é lido a cada execução. O pico de memória, esse sim, já foi resolvido — a fase 2 descarta o conteúdo de cada arquivo, então a memória é O(candidatos), não O(codebase).
- ⚠️ **Símbolo citado com assinatura escapava da checagem inteira** até 2026-08-03. `ehCandidato` rejeita token com parêntese ou vírgula, e citar função como `nome(args)` é a convenção natural em doc — então a forma mais comum de citar função nunca era conferida. Achado no mapa DESTE arquivo, que citava por 2 commits uma função já renomeada enquanto a auditoria dizia "0 achados". `nomeCitado` desmonta a assinatura; chamada qualificada (`Foo.bar(x)`) segue fora de propósito.
- ⚠️ **Escrever o nome de um símbolo fantasma dentro do CÓDIGO o faz "existir".** Consequência direta da validação por substring: um comentário que menciona o nome antigo desarma a checagem daquele nome. Aconteceu ao documentar a correção acima — o comentário explicativo citava o fantasma e zerava o achado. **E aconteceu DE NOVO em 2026-08-04**, no comentário que explicava o achado real da auditoria dos mapas, enquanto se escrevia a própria feature que o detecta: o achado sumiu do relatório entre uma execução e a seguinte. É a armadilha mais fácil de cair deste script — ao documentar um fantasma, descreva-o **sem escrever o nome**.
- ⚠️ **Identificador de API EXTERNA citado em crase vira fantasma**, e o script não tem como distinguir. Documentar o formato de transcript do Claude Code (campos como o que marca resumo de compactação) rende achado `medio`/`baixo` sobre nomes que existem — só não neste repositório. Mesma raiz da validação por substring: "existe" significa "aparece no código daqui". **Contorno:** citar o campo externo sem crase, ou explicar em prosa. Não vale afrouxar a checagem — o falso positivo é barato e o falso negativo esconde doc podre.
- Hash de 7–10 hex em crase é sempre tratado como commit. Um valor hex legítimo que não seja commit (cor, id, checksum) vira falso positivo `medio`.
- A checagem NÃO valida afirmação em prosa ("o guard X roda antes de Y") — está declarado no cabeçalho do script e é limitação de escopo, não lacuna a preencher.

## Não cobre (e por quê)
- `symbols.mjs` / `outline.mjs` — mapa próprio em `symbol-lookup.md`.
- `context-maps.mjs` / `lib/roots.mjs` — mapa próprio em `context-maps-hook.md`.
- `coupling.mjs` — concern independente (histórico do git), ainda sem mapa.
- `install.mjs` / `install-codex.mjs` — avaliados e **decididos sem mapa de área próprio**: são entradas de bootstrap executadas na instalação/atualização; os modos e comandos estão no README, e os detalhes de cópia de scripts/registro de hooks estão em `context-maps-hook.md`. Não justificam um documento operacional separado para tarefas de rotina.
