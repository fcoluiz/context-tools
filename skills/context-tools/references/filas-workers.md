# Filas, workers e jobs agendados

Parte da skill `context-tools`; lida sob demanda ao mexer em fila (BullMQ, Bee, Sidekiq, Celery,
SQS, RabbitMQ), worker, cron ou job em segundo plano.

## Antes de escrever

- Ache quem produz e quem consome: `ct.mjs refs` no nome da fila ou do job. Produtor e consumidor
  podem estar em serviços diferentes; mudar o formato do payload quebra os jobs já enfileirados.
- Payload pequeno e versionado: ids, não o objeto inteiro (o dado muda até o job rodar).

## Comportamento do job

- **Idempotente:** rodar duas vezes deixa o mesmo estado. A entrega é "pelo menos uma vez": retry,
  worker que cai e job travado repetem. Use id de job determinístico ou chave de deduplicação para
  não enfileirar o mesmo trabalho duas vezes.
- **Pequeno:** um efeito por job. Fluxo com vários passos vira jobs encadeados (flow) ou etapas
  registradas, para retomar do ponto certo.
- **Retentativa:** número de tentativas com backoff exponencial. Erro permanente (dado inválido,
  recurso apagado) não volta para a fila: marque como falha sem retry.
- **Falha final:** o job esgotado fica visível (lista de falhas ou fila de mortos) com o motivo, e
  alguém é avisado. Falha silenciosa é dado perdido.
- **Tempo:** teto de duração. Trabalho pesado de CPU trava o laço de eventos, a trava do job
  expira e ele é dado como travado (stalled) e roda de novo: divida ou use processo separado.
- **Concorrência e taxa:** limite explícito, pensado no que o job chama (banco, API com cota).

## Operação

- Redis da fila com persistência (AOF) e `maxmemory-policy noeviction`: com despejo de chaves a
  fila perde jobs.
- Desligamento gracioso: no SIGTERM o worker para de pegar job, termina o atual e fecha a conexão.
- Retenção de concluídos e falhos com teto (quantidade ou idade); sem isso o Redis só cresce.
- Quem enfileira falha rápido se o Redis cair; o worker espera e reconecta.
- Cron: um disparo por agenda mesmo com várias réplicas (agendador da fila ou trava), fuso
  explícito, e o job aguenta rodar atrasado ou duas vezes.
- Logue início, fim, tentativa e id do job; meça fila parada e tempo de espera.

## Verificar

- Teste o job chamando o processador direto, incluindo rodar duas vezes e falhar no meio.
- Diga o que não foi exercitado: reconexão, desligamento, várias réplicas.
