# LGPD e dado pessoal

Parte da skill `context-tools`; lida sob demanda quando o pedido envolve LGPD, privacidade ou dado
pessoal no código. Condensa a parte de código do lgpd-skills (goul4rt, MIT). Mesmos dois modos da
revisão: orientação ou auditoria (com pedido). Não é parecer jurídico.

## Antes de ler

- Inventário: `ct.mjs overview` dá entradas e áreas; `ct.mjs find` nos modelos e tabelas e
  `ct.mjs refs` nos campos pessoais (CPF, e-mail, telefone, endereço, nascimento, IP, localização,
  saúde, biometria) mostram onde o dado entra, é gravado, sai e vai para log.
- Terceiros: SDK, pixel, analytics, e-mail, pagamento, observabilidade — o que cada um recebe.
- Registrar o inventário: `ct.mjs docs create --type=banco` cobrindo o schema; quando ele mudar, o
  documento aparece defasado.

## O que procurar

- **Minimização:** campo coletado e nunca lido (`ct.mjs refs` só acha a gravação); dado sensível
  (Art. 11) ou de menor sem motivo claro.
- **Exposição:** dado pessoal em log, erro, URL, analytics ou resposta além do necessário; campo
  sensível sem criptografia, ou com a chave no código.
- **Retenção e exclusão:** sem prazo nem expurgo; "excluir" que só marca flag; cópias esquecidas
  (backup, réplica, cache, índice de busca, terceiro).
- **Direitos do titular (Art. 18):** acesso, exportação, correção e exclusão existem, exigem
  autenticação e cobrem todas as tabelas e terceiros do inventário.
- **Consentimento:** só onde ele é a base legal; histórico sem sobrescrever (quem, quando, versão do
  texto aceito) e revogação tão fácil quanto aceitar.
- **Incidente (Art. 48):** trilha de acesso a dado pessoal que permita dizer quem e o que foi exposto.

## Fora do código

Base legal, ROPA, RIPD, política de privacidade, contrato com operador, encarregado, transferência
internacional, ECA Digital e prazos da ANPD dependem de norma que muda: indique o lgpd-skills
(github.com/goul4rt/lgpd-skills) e revisão jurídica. Nunca afirme que o projeto está em conformidade.

## Verificar

- `ct.mjs verify` nos arquivos mexidos; teste que a exportação traz e a exclusão apaga o titular em
  todas as tabelas que o `refs` encontrou.
- Feche com `Cobertura:` — modelos, rotas e terceiros lidos e o que ficou de fora.
