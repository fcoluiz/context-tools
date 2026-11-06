# Backend (API, regra de negócio, banco)

Parte da skill `context-tools`; lida sob demanda ao criar ou mudar rota, serviço, consulta ou
migração. Fila e job: `filas-workers.md`. Deploy e processo: `servidores.md`.

## Antes de escrever

- Siga o padrão que já existe: ache uma rota ou serviço parecido (`ct.mjs find`, `ct.mjs refs`) e
  copie a forma de validar, responder erro, logar e acessar o banco. Camada ou biblioteca nova só
  com pedido.
- Mudar contrato (campo, rota, status, assinatura): `ct.mjs impact` antes. Cliente que não está no
  repositório não aparece; campo novo é opcional, remoção passa por depreciação.

## API

- Valide na fronteira, com esquema: tipo, tamanho, faixa, enum. Rejeite campo desconhecido onde o
  projeto já faz isso.
- Um formato de erro só; status certo (400 entrada, 401/403 acesso, 404, 409 conflito, 422 regra,
  5xx só para falha do servidor). Mensagem de erro sem stack nem SQL.
- Listagem sempre paginada e com teto. Filtro e ordenação só por campos permitidos.
- `POST` que cria ou cobra aceita chave de idempotência ou é seguro repetir: cliente e proxy
  reenviam.
- Autorização em todo handler, no servidor, conferindo o dono do recurso.

## Dados

- Consulta parametrizada; nada de SQL montado com texto.
- Escritas que andam juntas na mesma transação; nada de chamada externa (HTTP, e-mail, fila)
  dentro dela — publique depois do commit ou use outbox.
- N+1: laço que consulta por item vira consulta em lote ou join.
- Índice para todo filtro e join novo em tabela grande.
- Migração: compatível com a versão anterior do código no ar (adicione, migre, remova em passos
  separados); nunca edite migração já aplicada; coluna `NOT NULL` em tabela cheia precisa de
  default ou backfill.
- Tempo em UTC no banco; dinheiro em inteiro ou decimal, nunca float.

## Erros e dependências externas

- Toda chamada de rede com timeout. Retentativa só no que é idempotente, com backoff e teto.
- Erro tratado no nível que sabe o que fazer; nada de `catch` vazio. Log com contexto (id da
  requisição, entidade), sem senha, token ou dado pessoal.

## Verificar

- `ct.mjs verify` nos arquivos mexidos e rode os testes que ele indicar; leia a saída antes de dizer
  que passou.
- Teste o caminho de erro (entrada inválida, sem permissão, recurso de outro usuário), não só o
  feliz.
- Migração: rode para frente na base de teste e diga se a volta foi testada.
