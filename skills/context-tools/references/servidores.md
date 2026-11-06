# Servidores, deploy e configuração

Parte da skill `context-tools`; lida sob demanda ao mexer em deploy, Docker, CI, proxy, variável de
ambiente, processo ou monitoramento.

## Antes de mudar

- Ache onde a configuração mora hoje (`ct.mjs refs` na variável, `Dockerfile`, CI, compose) e siga
  o mesmo lugar. Ferramenta de infraestrutura nova só com pedido.
- Mudança em produção (servidor, banco, DNS, firewall, segredo) só com pedido explícito e com a
  volta dita antes. Nunca rode comando destrutivo em servidor "para testar".

## Processo e configuração

- Configuração por variável de ambiente, validada na partida: faltou uma, o processo não sobe e diz
  qual. Segredo fora do repositório e fora da imagem.
- O mesmo artefato vai para todos os ambientes; só a configuração muda.
- Processo sem estado local: sessão, upload e cache no serviço próprio (banco, Redis, storage),
  não no disco do contêiner.
- Log em stdout, uma linha por evento, com nível e id da requisição. Sem segredo.
- SIGTERM: para de aceitar conexão, termina o que está em curso com prazo, fecha banco e fila.
- Health check separado: vivo (o processo responde) e pronto (dependências ok). O de vivo não
  consulta o banco, senão o banco lento reinicia tudo.
- Tarefa administrativa (migração, script) roda como processo à parte, com o mesmo código e
  configuração.

## Deploy

- Migração compatível com as duas versões no ar durante a troca.
- Imagem com versão fixa (nada de `latest`), usuário sem root, só o necessário para rodar.
- Rollback conhecido e rápido; deploy que não volta é aposta.
- Atrás de proxy: confie no IP do cliente só pelo proxy conhecido; HTTPS e limite de corpo nele.
- Limite de recurso (memória, CPU, conexões do pool) coerente com o número de réplicas.

## Observabilidade

- Erro com contexto vai para um lugar que alguém olha; alerta por sintoma (erro, latência, fila
  parada), não por cada exceção.
- Métrica de taxa, erro e duração nas rotas e jobs principais.

## Verificar

- Suba localmente ou em contêiner com a configuração nova e chame o health check.
- Sem acesso ao ambiente, diga o que não foi verificado e o comando para conferir.
