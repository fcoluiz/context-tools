# Manutenção de mapas e diagnóstico de saúde

- Confiabilidade: alta para os contratos mecânicos descritos abaixo.
- Fonte principal: scripts/context-maps.mjs e scripts/health.mjs
- maintenance: live
- review_sources: ["./scripts/context-maps.mjs","./scripts/health.mjs"]
- last_reviewed: 2026-10-07
- source_fingerprints: {"./scripts/context-maps.mjs":"sha256:1091311ead045ba6670529e1acc24e1a12ee5215cd1753c8ffb81f8d3f1f0cd3","./scripts/health.mjs":"sha256:99e73470fba12fc33fe40bcdf5165c5b6f775c3237abf068023e1227a1b7052d"}
- source_digest: sha256:42ed88de945f797880193cb432e2ab1dd9f69290165c7189646120d4d0f97a8b

## Escopo automático e auditoria global

No Codex, sessionChangedFiles consulta o diário da sessão. Sem atribuição disponível, retorna null; o diff Git e o mtime compartilhados não substituem autoria. O coletor contextMapsStopReport, quando chamado com sessionOnly:true, seleciona mapas por interseção com esses arquivos e limita as fontes sinalizadas ao escopo da sessão. Um cache legado sem metadados explícitos não certifica a revisão automática.

Na abertura, o índice Codex informa o frescor dos mapas sem atribuir uma revisão de pendências à tarefa atual. A comparação global pode usar os sinais legados de Git/mtime. Hash correspondente comprova os bytes, não a correção semântica do texto.

## Consultar pendências do projeto

No plugin global, execute a partir da raiz do projeto:

```text
node "${PLUGIN_ROOT}/scripts/health.mjs" --audit --json
```

O relatório de saúde consulta mapas globalmente e documentos com deduplicação desativada. Portanto, pode mostrar pendências antigas que ficam fora da revisão automática da sessão. --audit acrescenta problemas estruturais e campos A mapear; não faz inspeção semântica nem altera código/documentação. As consultas podem atualizar caches locais.

## Interpretar o resultado

- sessionTracking: no Codex, complete exige diário ativo; snapshot auxiliar não comprova autoria. Sem ID, o rastreio é not-applicable. No Claude, a avaliação usa o snapshot.
- reviewQueue: distingue itens ready, claimed, deferred e complete; fila pendente ou indisponível contribui para attention.
- freshness: issues tornam a seção incomplete; exceções tornam error. Os detalhes de issues estão no JSON. Ausência de linhas de achados não elimina uma falha de verificação.
- metrics.storageStatus: estado corrompido/indisponível não equivale a zero uso.
- metrics.autoReview.offline: agrega leituras/bytes, hits de cache, digests sincronizados e problemas informados pelos eventos de revisão. Esses contadores não representam todas as leituras internas de atribuição.
- hookPromptEstimate: estimativa do texto emitido pelo hook, em caracteres divididos por quatro; não é consumo faturado e não inclui leituras de fontes, contexto anterior ou resposta do modelo.

attention tem prioridade quando há achados, rastreio incompleto, fila pendente ou erro. Sem esses sinais, catálogo pronto com eventos recentes produz no-findings; sem eventos, limited-data. Catálogo indisponível sem outro sinal prioritário produz documentation-unavailable. Nenhum desses estados comprova correção funcional do projeto.
