---
area: change-coupling
covers:
  - "scripts/coupling.mjs"
  - "scripts/map-suggestions.mjs"
verified_at: ce96046
verified_date: 2026-10-08
source_fingerprints: {"scripts/coupling.mjs":"sha256:bea26030bf75161de2653e5b21658024afd99026042cc72b47f37aebad00364e","scripts/map-suggestions.mjs":"sha256:7e50c0860685dbb21258a4f66a22237dc2ce204d6a2af19564916a23d700f17e"}
source_digest: sha256:49c919f86ceca3d3ae563c2cba9d7644dccf5c615ad6ae390b8abeeb9e81b2e7
---

# Acoplamento por co-mudança — mapa de área

Descobre quais arquivos mudam juntos. Complementa os mapas de contexto: mapa guarda correlação que alguém **lembrou** de escrever; isto **descobre** a que ninguém documentou. Roda sob demanda e também como hook de `Stop` (modo `--changed --hook`).

A "cesta" que vira estatística é o **commit** quando há git. Sem `.git` em lugar nenhum, a cesta vem das mudanças atribuídas à sessão e é persistida no diretório de estado do host (`.claude/` no Claude; `.codex/context-tools/` no Codex). No Codex, entram caminhos capturados em eventos explícitos de `apply_patch`, `Edit` e `Write`, com confirmação por hash antes/depois; no Claude, permanece o snapshot local. Os dois modos rodam a MESMA matemática de confiança (`linksFromBaskets`) em cima de cestas diferentes — não são dois algoritmos, é um algoritmo com fontes de cesta diferentes.

O núcleo é compartilhado entre os dois hosts. A configuração correspondente é lida de `.claude/context-tools.json` no Claude e `.codex/context-tools.json` no Codex; a primeira instalação Codex pode copiar a configuração Claude uma única vez, depois elas evoluem separadamente.

## Por onde começar (símbolo → arquivo)
- `linksFromBaskets(baskets, cfg)` → o algoritmo de confiança em si, comum aos dois modos: conta ocorrência solo e por par, calcula confiança direcional, filtra pelos limiares. Extraído de dentro de `analyze` para que git e sessão nunca possam divergir na conta.
- `analyze(repoPath, cfg)` → modo GIT: lê `git log --name-only`, agrupa por commit em cestas, chama `linksFromBaskets`.
- `analyzeWithStatus(repoPath, cfg)` → envolve `analyze()` e distingue histórico vazio válido de falha ao executar Git; consumidores de sugestões não devem traduzir falha em "sem relações".
- `scripts/map-suggestions.mjs` / `suggestMapCoverage()` → cruza os pares Git aprovados pelos mesmos limiares de `analyze()` com os mapas existentes. Sugere arquivos de código sem cobertura que co-mudam com fontes mapeadas; é um roteiro de revisão, nunca cria ou altera mapas.
- `analyzeSessions(root, repoPath, cfg)` → modo SESSÃO: lê `.coupling-sessions.json` do diretório de estado do host, cada sessão registrada vira uma cesta, chama `linksFromBaskets`.
- `recordSessionBasket(root, repoPath, sid, files, cfg)` → grava (SOBRESCREVENDO) a cesta da sessão atual. Chamada em toda invocação sem git, não só no hook — ver invariante abaixo sobre sobrescrita.
- `loadSessionLog` / `pruneSessionLog` → leitura e poda (por idade `SESSION_LOOKBACK_MS` ~400 dias, e por contagem `MAX_SESSIONS_STORED` 1000) do log de sessões.
- `main()` → despacha os 3 modos de CLI (sem argumento, `<arquivo>`, `--changed`) × 2 modos de cesta (git/sessão, decidido por `repo.git`).
- `git(repo, args)` → wrapper único de `execFileSync`; **toda** chamada de git passa por aqui, com timeout de 30 s e `maxBuffer` de 256 MB. Classifica a falha (timeout / buffer estourado / outra) e empilha em `falhasGit`.
- `falhasGit` → acumulador de falhas do git, no escopo do módulo, para que o fim do `main()` possa **declarar** que a busca não aconteceu.
- `alreadyWarned(root, text, ttlHours)` → trava anti-repetição do hook, em `.coupling-state` dentro do diretório de estado do host — vale para os dois modos.
- `DEFAULTS` → `since` 12 meses, `maxFilesPerCommit` 15, `minTogether` 4, `minConfidence` 0.5, `warnConfidence` 0.6, `minSessions` 5 (só o modo sessão usa este último). Sobrescrevível por `coupling` na configuração do host (`.claude/context-tools.json` ou `.codex/context-tools.json`).

## Invariantes (não dá pra inferir de um arquivo só)
- **A confiança é DIRECIONAL, e isso é o coração do desenho.** Para o par (A,B) guarda-se `ca = n/solo(A)` e `cb = n/solo(B)` separadamente: "leva junto" = P(B mudar | A mudou); "puxado por" = P(A mudar | B mudou). Sem essa distinção o alerta vira ruído — um controller que muda toda semana passaria a "exigir" a rota só porque a rota nunca muda sozinha. No modo `--changed`, o alerta usa a direção **do arquivo que você tocou**, não o máximo. Vale igual nos dois modos de cesta.
- **Commit (ou sessão) com mais de `maxFilesPerCommit` (15) arquivos é descartado inteiro.** Refactor em massa acopla tudo com tudo e envenenaria as estatísticas — o mesmo corte serve para "sessão gigante" no modo sem git.
- **É agnóstico de linguagem por construção** — não faz parsing de nada, só lê nomes de arquivo. Por isso o `CODE_RE` daqui (`HISTORY_CODE_RE`, importado de `lib/roots.mjs`) é bem mais amplo que o de `symbols` (soma rb, java, kt, php, cs, sql, swift, scala às extensões que `symbols` já lê). Deixou de ser lista literal local — é derivado da mesma fonte única que `EXTENSOES_CODIGO`/`CODE_RE`, para não repetir a derivação silenciosa em duas cópias que já queimou `context-maps-hook`.
- **O `git log` varre o REPO INTEIRO, e isso é deliberado.** O código ainda monta `pathArgs` a partir de `sourceDirs(repoPath)`, mas `sourceDirs` passou a devolver sempre a raiz do repo — então `rels` sai vazio, `pathArgs` sai vazio e não há pathspec. Era o contrário até 2026-08-03 ("escopado pelas `sourceDirs`, mantém migrations e lockfile fora da conta"), e a mudança foi de propósito: adivinhar pasta de código escondia repositório inteiro em silêncio (ver `context-maps-hook`). O custo é que migrations e lockfiles voltaram para a conta.
- ⚠️ **`cfg.sourceDirs` não tem efeito aqui.** `resolveSourceDirs` está importado no topo e **nunca é chamado** — quem restringir as pastas pelo `.claude/context-tools.json` vai ver a config ser obedecida por `symbols`/`audit-docs` e ignorada por este script, sem aviso nenhum. Vale nos dois modos.
- 🔄 **`findRepos(root, {requireGit:false})` desde 2026-08-05** — antes disso era `requireGit:true` e um workspace 100% sem git nem aparecia como repo. A mudança NÃO significa que coupling passou a dispensar histórico: significa que ganhou um substituto mais fraco (sessão) para quando não há commit. `why.mjs` continua recusando qualquer substituto — não existe equivalente de sessão para "por que esta linha é assim".
- **`findRepos` recebe `cfg: rawCfg` (a config INTEIRA, não o `cfg` local de coupling que já é só a sub-chave `coupling`)** — habilita `extraRepos`: repo irmão sem `.git` próprio, declarado explicitamente em `.claude/context-tools.json`, entra no acoplamento mesmo quando a raiz não pode simplesmente subir um nível (workspace com muitos outros projetos ao lado). Ver `resolveExtraRepos` em `lib/roots.mjs`, documentado no mapa `symbol-lookup`.
- **`recordSessionBasket` SOBRESCREVE por `sessionId`, nunca acrescenta.** O `Stop` dispara a cada turno, e `files` já vem cumulativo desde o início da sessão (`sessionChangedFiles`, importado de `context-maps.mjs`). Se cada chamada virasse uma cesta nova, uma sessão de 10 turnos geraria 10 cestas crescentes e inflaria artificialmente todo par que ela tocasse. A gravação acontece em QUALQUER invocação (hook ou manual), não só `--changed`.
- **Dois limiares distintos:** `minConfidence` (0.5) filtra o que entra na lista; `warnConfidence` (0.6, mais alto) filtra o que vira alerta no hook. Alerta é mais caro que listagem, então exige mais evidência. `minSessions` (5) é um TERCEIRO limiar, exclusivo do modo sessão: abaixo dele a resposta é "ainda não sei" (`cou.coldStart`), nunca "sem acoplamento" (`cou.noCoupling.sessions`) — são afirmações diferentes, e confundi-las mentiria sobre ter medido algo que ainda não foi medido.
- **`sessionChangedFiles`/`currentSessionId` são IMPORTADOS de `context-maps.mjs`, não copiados.** É a mesma pergunta ("quais arquivos foram atribuídos a esta sessão") que o hook de mapas responde. No Codex, usar o diário explícito evita misturar janelas concorrentes; no Claude, mantém o snapshot. Duplicar a lógica repetiria o erro que `CODE_RE` já cometeu duas vezes neste plugin (ver `context-maps-hook.md`).

## Gotchas (queimam em silêncio)
- ⚠️ **O modo `<arquivo>` casa por caminho completo quando o argumento tem barra, e por basename quando não tem.** Passar só o nome do arquivo (sem barra) ainda casa **todo** arquivo do repo terminado naquele basename, misturando resultados de módulos diferentes sem avisar; passar um caminho com `/` restringe ao arquivo exato (ou a quem termina em `/<caminho>`). Passe um caminho mais específico quando o basename se repetir pelo projeto.
- ⚠️ **Falha do git é declarada, MAS só no modo de listagem (e só no modo GIT).** Estouro de `maxBuffer` (256 MB) e timeout (30 s) já não viram "nenhum acoplamento": o fim do `main()` troca `cou.noCoupling` por `cou.gitFalhou` quando `falhasGit` tem algo. **A guarda é `if (!printed && !changedMode)`** — então no modo `--changed` (que é o que roda como hook de `Stop`) a falha continua invisível, e ali ela se parece exatamente com "nada a alertar". É justamente o modo que roda sozinho, sem ninguém olhando. O modo sessão não tem esse ponto cego: `recordSessionBasket`/`analyzeSessions` só falham em `safe()`-wrapped I/O local, que degrada calado por design (mesma doutrina do resto do plugin), não por lacuna de cobertura.
- ⚠️ Repo novo ou com menos de 12 meses de história devolve pouco ou nada — o `minTogether:4` exige o par ter mudado junto 4 vezes. "Nada encontrado" aqui costuma significar "histórico curto", e a mensagem final já sugere ajustar os limiares. No modo sessão o equivalente é `minSessions:5` — mesma doutrina, unidade diferente.
- ⚠️ **O log de sessões cresce indefinidamente sem os dois cortes.** `pruneSessionLog` roda a CADA gravação (não é uma tarefa separada) — sem isso um projeto usado por anos sem nunca rodar `git init` acumularia uma cesta por sessão para sempre. `SESSION_LOOKBACK_MS` (~400 dias) aproxima o `since: '12 months ago'` do modo git; `MAX_SESSIONS_STORED` (1000) é o teto duro que segura o caso de um projeto com sessões diárias por anos.
- A trava anti-repetição usa hash do texto completo do aviso (mesmo mecanismo do `context-maps`): mudou um arquivo na lista, o texto muda, e o aviso dispara de novo. TTL de 12 h é o limite real.
- `short()` remove o prefixo `src/`/`lib/`/`app/` **só na exibição** — não confundir com o caminho real ao copiar de um relatório.

## Não cobre (e por quê)
- `context-maps.mjs` — o outro hook de `Stop`; mapa próprio em `context-maps-hook.md`. São independentes: um mede defasagem de mapa, o outro correlação histórica. `coupling.mjs` importa três funções de lá (ver invariante acima) — é a única dependência entre os dois.
- `symbols.mjs` / `outline.mjs` (`symbol-lookup.md`) e `audit-docs.mjs` (`doc-audit.md`).
- `lib/roots.mjs` — coberto por `context-maps-hook.md`.
