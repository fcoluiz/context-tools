---
area: health-report
covers:
  - "scripts/health.mjs"
  - "scripts/lib/telemetry.mjs"
  - "scripts/codex-hook.mjs"
  - "scripts/lib/documentation.mjs"
  - "scripts/context-maps.mjs"
  - "scripts/lib/roots.mjs"
  - "scripts/lib/source-fingerprints.mjs"
  - "scripts/lib/markdown-sections.mjs"
  - "scripts/symbols.mjs"
  - "scripts/outline.mjs"
  - "scripts/pre-tool.mjs"
  - "scripts/benchmark-pretool.mjs"
  - "scripts/benchmark-prompt-audit.mjs"
  - "scripts/lib/session-write-journal.mjs"
  - "package.json"
  - "scripts/lib/auto-review-state.mjs"
  - "scripts/lib/review-engine.mjs"
  - "scripts/lib/state-store.mjs"
verified_at: HEAD
verified_date: 2026-10-07
source_fingerprints: {"package.json":"sha256:f41040167722fde787b9bd70879c50a3be2d69470678d80214c4b9827f9f589a","scripts/codex-hook.mjs":"sha256:5ff736bffd03260406c4453e0a477c5cc195b355998cedb181d0453107567383","scripts/context-maps.mjs":"sha256:1091311ead045ba6670529e1acc24e1a12ee5215cd1753c8ffb81f8d3f1f0cd3","scripts/health.mjs":"sha256:99e73470fba12fc33fe40bcdf5165c5b6f775c3237abf068023e1227a1b7052d","scripts/lib/session-write-journal.mjs":"sha256:1f0a91563bf4562019affc01058071547b6b98c10f014e201e1416fee16f282a","scripts/lib/telemetry.mjs":"sha256:8b0caf83a91c53aed331e82e0764e7d2b131d2431083139bc73f6b5d5333fd44","scripts/lib/documentation.mjs":"sha256:e436eb9dc4f350d4ca55d719530959635a2a40aed268abb8f2a3c730ccf4831c","scripts/lib/source-fingerprints.mjs":"sha256:b274b3be934e68b20b02ddba3b58c8e22e2880c0d20fd5f8c9bf2c18ba749189","scripts/lib/auto-review-state.mjs":"sha256:6a831cf5c976ce2380e277bda08e9d6398c65b106ebe36731a0c88badb24a4d6","scripts/lib/review-engine.mjs":"sha256:2bf245816b6636b8f19f9d792911e746ffd9762fe849e69a886b80afb73139f4","scripts/lib/state-store.mjs":"sha256:a212a2d921648dd44e00ad3fd29d56f63dc54ccbf0ed895b795a9aa8dea4ac79"}
source_digest: sha256:e8fc8886a47055b6f7aca330d96a2ccdef4699a449d31aded273bd0b13dbdc4b
---

# Relatório local de saúde

## Entradas e fluxo

- `scripts/health.mjs` resolve a raiz pelo contexto atual e aceita `--days=1..365`, `--audit` e `--json`. O padrão resume os últimos 30 dias.
- `sessionTracking` usa o diário como integridade principal no Codex e o snapshot no Claude; no Codex, `method` identifica o diário de eventos e `writeAttribution` mostra somente contagens de chamadas observadas, arquivos ainda iguais ao hash registrado, eventos pendentes e escritas explícitas ignoradas por limites/formato, sem caminhos. O `Stop` automático Codex usa esse diário, não o snapshot compartilhado. Escritas por Bash ou ferramentas sem caminho explícito podem ficar fora da revisão automática.
- No Claude, snapshot acima de 30.000 arquivos ou HEAD inicial indisponível contribui para `attention`. No Codex, a integridade principal vem do diário; o snapshot auxiliar não promove nem rebaixa esse status de atribuição.
- `summarizeMetrics()` lê o anel local de `readMetrics()`, limitado a 2.000 eventos, e agrega contagens por tipo, resultados/durações do handler `pretool`, classificação das consultas diretas a `symbols`, buscas sem resultado agrupadas por extensão não indexada e outcomes de `auto-review`.
- Eventos `auto-review` distinguem prompt enviado, sem achados, revisão concluída, aviso informativo, deduplicação, limite de continuação e falha; guardam somente contagens/caracteres e uma estimativa de tokens do texto do hook (`chars / 4`). A estimativa não é uso faturado e não inclui contexto anterior, leituras de fontes ou resposta do modelo. A fila compartilhada é local ao projeto e guarda caminhos/hashes para consultar e confirmar versões, sem texto de prompt nem conteúdo-fonte.
- `responsesEmitted` soma resultados `hit` e `pack`; registra que o hook ofereceu contexto, não que o agente o consumiu.
- `pretool.durationMs` cobre buscas parecidas com símbolos aceitas pelo handler; não inclui a inicialização do Node nem as chamadas que saem no caminho rápido. `benchmark:pretool` mede o processo Codex inteiro sob demanda com entradas sintéticas.
- `benchmark:prompt-audit` mede, sob demanda, o processo inteiro de `UserPromptSubmit` em projeto sintético: prompt comum, caminho explícito mapeado e basename que percorre o workspace. Mostra tempo inicial e p50/p95, sem usar nem persistir prompts ou caminhos do projeto atual.
- `language-demand` registra só a extensão de consulta sem resultado por `symbols` ou pedido a `outline` sem parser, sem caminho/nome de arquivo ou termo buscado. É evidência agregada para decidir o que investigar, não prova de demanda suficiente para implementar um parser.
- Eventos `symbols` registram apenas quantas consultas localizaram símbolo, arquivo ou nada; não armazenam os termos pesquisados nem provam que o agente consumiu o resultado.
- `reportFindings()` chama `contextMapsStopReport()` sem `sessionOnly` e `documentationStopReport(..., { dedupe: false })`: o relatório de saúde continua global e mostra backlog antigo mesmo que o `Stop` automático passe a filtrar pela sessão.
- O preflight `UserPromptSubmit` não registra métricas por mensagem nem persiste prompts; ele usa hashes locais. Sem arquivo explicitamente nomeado, não faz varredura nem hash. Para arquivo citado, prioriza o fingerprint individual; mapas legados podem validar o digest agregado e, se ele divergir, consultam Git/mtime apenas para o alvo, sem injetar contexto por um irmão stale no mesmo mapa.
- `--audit` chama `auditDocumentation()` e resume problemas estruturais e placeholders `A mapear`/`To map`.
- `documentationReferencesForFile()` é usado pelo diagnóstico `explain.mjs`: monta catálogo novo com `persist:false`, encontra documentos operacionais que referenciam uma fonte e não altera o cache. A data `last_reviewed` é exibida como metadado, sem equivaler a uma validação semântica.

## Limites e efeitos

- Métricas são locais e não incluem prompts, conteúdo-fonte ou comandos completos. A retenção pode truncar janelas antigas; o relatório sinaliza quando o anel chega ao limite.
- A estimativa de tokens de revisão mede apenas a instrução emitida pelo hook no Codex; use a página de uso do host para o consumo faturado real.
- O relatório não registra duração por prompt: isso adicionaria I/O ao hook mais frequente. Use `benchmark:prompt-audit` para medir p50/p95 local com entradas sintéticas e `benchmark:pretool` para comparar caminhos Bash rápido, regex e símbolo.
- No Codex, diário de escrita ausente deixa o `Stop` automático em silêncio para aquele repositório; o relatório de saúde mostra se o diário foi inicializado e quantas fontes ainda coincidem com os hashes observados. A auditoria global de mapas/documentos permanece disponível; o snapshot auxiliar não substitui o diagnóstico de autoria.
- Uma seção só é sugerida quando o próprio texto Markdown relaciona explicitamente a fonte alterada a ela; ausência/ambiguidade não remove o aviso de revisão.
- Fingerprints verificam igualdade dos bytes cobertos; não certificam que o texto do mapa/documento continua semanticamente correto.
- As verificações podem atualizar caches locais de catálogo/fingerprint, mas não editam código ou documentação do projeto.
- O estado geral é `attention` quando há achados ou falhas; `no-findings` quando o catálogo está pronto, houve atividade recente e nada foi detectado; `limited-data` quando não há eventos na janela; `documentation-unavailable` quando o catálogo não está pronto e nenhum achado ou erro prioritário já produziu `attention`. Os detalhes de `issues` das seções incompletas estão no JSON.

## Fila, diagnóstico e custo offline (1.23.0)

- reviewQueueDiagnostics expõe ready/claimed/deferred/complete, capacidade e migração de claims
  legados. O relatório humano também mostra contagem de pendências; nenhuma saída vazia conclui revisão.
- No Codex, diário ausente/inválido/limitado torna sessionTracking incompleto. O snapshot auxiliar
  não o promove a completo. Coletores retornam issues explícitas; erro não é relatório limpo.
- Métricas auto-review incluem duração, leituras/bytes, hits de cache, digests sincronizados e issues.
  Cache é por execução; os contadores medem coletores documentais, não toda leitura interna do journal.
- No caminho sem fontes atribuídas, review-engine termina antes de descobrir/hash de referências.
  Medição AppServer: 119 docs, 7 amostras, handler mediano 0,56 ms; processo completo 186,82 ms;
  zero fontes lidas e zero prompt. Estado/caches ficaram no Temp e nenhum arquivo do projeto mudou.
  Evidência local: context-stop-benchmark-123.json, de 2026-10-07; não representa revisão ativa nem tempo de LLM.
- explain acrescenta a fila relacionada e diagnóstico de autoria, preservando consulta local de leitura.
