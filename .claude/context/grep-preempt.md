---
area: grep-preempt
covers:
  - "scripts/pre-tool.mjs"
  - "scripts/benchmark-pretool.mjs"
verified_at: ce96046
verified_date: 2026-10-08
source_digest: sha256:0dcc4f6f91b64106d104e1c83d09e3d87009f61d98e1dd32c6df5d6077dfbe54
source_fingerprints: {"scripts/pre-tool.mjs":"sha256:eff3a1cd62a820f051f7c19860425da44f9aa169bd675c0ab24c621418466e2d","scripts/benchmark-pretool.mjs":"sha256:51123bc7c90c3f02139bb5f674b7f9cc7bd2721d4241170983eb0845ed3e762c"}
---

# Resposta antes do Grep — mapa de área

Hook `PreToolUse` que responde ANTES do Grep quando o padrão procurado tem cara de símbolo. **É o único ponto PUSH do plugin** — todo o resto é PULL e depende de alguém lembrar de chamar. É pequeno (86 linhas) e ganhou mapa por causa disso: quase toda linha aqui é uma decisão medida, e o arquivo não conta essa história sozinho.

## Por onde começar (símbolo → arquivo)
- `main()` → lê o stdin e delega para `executarPreTool`; escreve no stdout só se ela devolver algo.
- `executarPreTool(entrada)` → núcleo reutilizável e EXPORTADO do hook: aceita string (CLI Claude,
  via `stdin()`) ou objeto já parseado (adaptador Codex) e devolve a string JSON pronta ou `''`,
  sem escrever por conta própria. Isso permite ao Codex evitar um segundo processo Node sem mudar
  o contrato Claude.
- `precisaPack(indice, padrao)` / `definicoesExatas(indice, padrao)` → decidem se a resposta curta
  basta ou se o padrão é ambíguo o bastante (mais de 2 locais, ou locais em mais de 1 arquivo, para
  o mesmo nome exato) para justificar um "context pack". Alternância (`A|B`) nunca entra nessa rota
  — não é uma pergunta inequívoca sobre UM nome.
- Rota de pack → importa `buildContextPack` de `context-pack.mjs` e `formatEvidence` de
  `lib/evidence.mjs` (import tardio, mesma doutrina do `symbols.mjs`). Tenta com orçamento
  `PACK_BUDGET` (800); se nenhum item vier com definição `confidence: 'exact'`, tenta de novo com
  `PACK_ESCALATION_BUDGET` (2000). Falha no pacote (`try/catch`) cai de volta para a rota curta ou
  o silêncio — nunca derruba o hook.
- `CARA_DE_SIMBOLO` → a regex que decide se o padrão é "onde X está?" ou busca textual. Único símbolo exportado além de `executarPreTool` (para o teste).
- `jaRespondido(root, chave)` → dedupe por `(sessão, padrão)` em `.pre-tool-state.json` no diretório de estado do host (`.claude/` ou `.codex/context-tools/`), TTL de 6 h.
- `MAX_ACERTOS` (6) · `MAX_BLOCO` (1200) · `TTL_MS` (6 h) → os tetos da rota curta. `PACK_BUDGET` (800) · `PACK_ESCALATION_BUDGET` (2000) · `MAX_PACK_BLOCO` (3200) → os tetos da rota de pack.
- Cada desfecho (`miss`/`ambiguous`/`hit`/`pack`) é gravado via `recordMetric` (`lib/telemetry.mjs`), local ao diretório de estado do host.
- Para buscas que passaram pelo filtro de símbolo, o evento inclui `durationMs` do handler (índice, pack e preparação da resposta; sem startup Node). O benchmark sob demanda `benchmark-pretool.mjs` mede o processo inteiro, comparando uma chamada rápida, regex textual e busca de símbolo sem adicionar gravações a todas as chamadas Bash.

## Invariantes (não dá pra inferir de um arquivo só)
- **NUNCA bloqueia a ferramenta.** O Grep roda de qualquer jeito; isto é contexto a mais, jamais um veto. Um `PreToolUse` que negasse o Grep transformaria uma otimização em ponto único de falha.
- **Silêncio é o padrão, e o teto superior existe — mas só na rota curta.** Sem acerto **ou com mais de `MAX_ACERTOS` (6)**, cala — acima disso o Grep responde melhor que o índice, e insistir seria trocar a ferramenta certa pela ferramenta que estava com a mão levantada. Essa checagem só roda se `precisaPack` decidiu que o padrão NÃO é ambíguo; padrão ambíguo (>2 locais ou locais em mais de 1 arquivo) tenta a rota de pack primeiro, e só cai na rota curta (e no teto de `MAX_ACERTOS`) se o pacote vier vazio.
- **O texto de "não achei" do `reportOne` é DESCARTADO aqui.** Ele serve quando o usuário chamou `symbols.mjs` de propósito; num hook, o Grep já ia rodar e é exatamente a ferramenta certa para esse caso. Mesma saída, valor oposto conforme quem perguntou.
- **O import de `symbols.mjs` é TARDIO, e isso é medição, não estilo.** O hook roda em TODO Grep e 60% dos padrões não têm cara de símbolo — nesses ele desiste em duas linhas. Import estático carregava os módulos pesados mesmo assim: 167 ms contra 128 ms de um Node vazio. O `await import` devolve ~39 ms por Grep descartado, e **100% deles num projeto que o índice nem consegue ler** — que é justamente onde o plugin não pode cobrar nada. **Mover o import para o topo é regressão silenciosa:** nada quebra, só fica mais caro para quem menos se beneficia.
- **`main` é async por causa disso, e o `.catch(() => {})` é obrigatório.** Sem ele uma rejeição escapa do `try` e derruba o processo com exit ≠ 0 — exatamente o que M4 proíbe.
- **`CARA_DE_SIMBOLO` reprova QUALQUER metacaractere de regex** (`\d`, `^`, `.*`, classe): a presença deles significa que a intenção é busca textual, não "onde X está". O mínimo de 4 caracteres existe porque nome curto casa com meio mundo e a resposta viraria ruído. Alternância (`A|B`) passa, porque é a forma natural de procurar dois símbolos.
- **Dimensionado no histórico real, e a medição impediu metade do trabalho errado.** Em 68 sessões / 15.612 chamadas: Grep teve 1.633 chamadas, 649 delas (40%) com cara de símbolo. **`Read` de arquivo grande sem offset foi medido e DESCARTADO como gatilho: 25 de 3.690 (1%)** — interceptar `Read` não valia o custo.
- **O dedupe é por `(sessão, padrão)`, não por padrão.** Repetir a mesma resposta na mesma sessão gasta token sem informar nada; em outra sessão o contexto se perdeu e a resposta volta a valer.

## Gotchas (queimam em silêncio)
- ⚠️ **Este hook é o mais caro de errar em desempenho**, porque roda em toda chamada de Grep de toda sessão. Qualquer trabalho acrescentado ANTES do `CARA_DE_SIMBOLO.test` é pago 100% das vezes, inclusive nos 60% que serão descartados.
- O benchmark de custo ponta a ponta é manual por desenho: medir e gravar cada Bash alteraria o custo do próprio caminho rápido que se quer observar.
- ⚠️ `MAX_BLOCO` corta em 1200 caracteres **no meio**, sem reticências. Com ≤6 acertos isso praticamente não acontece; se acontecer, a saída termina abrupta.
- ⚠️ A contagem de acertos é feita por REGEX sobre o texto formatado (`/^\s{2}\S/` — linhas com recuo de 2). Mudar o formato de saída de `reportOne` quebra a contagem **em silêncio**: o teto de 6 deixa de valer e o hook passa a falar quando deveria calar.
- ⚠️ `resolveRoot()` é chamado sem `argv` — o hook não recebe `--root=`, então depende de `CLAUDE_PROJECT_DIR` ou do cwd.
- ⚠️ Sem `CLAUDE_CODE_SESSION_ID` a chave do dedupe vira `'sem-sessao'`, e todas as sessões passam a compartilhar o mesmo balde de padrões já respondidos.

## Não cobre (e por quê)
- `symbols.mjs` / `outline.mjs` — o índice em si; mapa próprio em `symbol-lookup.md`. Aqui só se consome `buildIndex` e `reportOne`.
- `context-pack.mjs` / `lib/evidence.mjs` — a rota de pack só CONSOME `buildContextPack`/`formatEvidence` de lá; ainda sem mapa próprio.
- `lib/roots.mjs` — coberto por `context-maps-hook.md`.
- Os hooks de `SessionStart`/`Stop` — outra área (`context-maps-hook.md`, `session-cost.md`). Este é o único `PreToolUse`.
