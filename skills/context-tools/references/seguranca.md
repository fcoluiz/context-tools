# Segurança

Parte da skill `context-tools`; lida sob demanda quando o pedido é de segurança. Mesmos dois modos da
revisão: orientação (só responde) ou auditoria (com pedido explícito); relatório em arquivo só se
pedirem. Nunca rode código do alvo para provar um achado fora de um ambiente isolado.

## Antes de ler

- Ache as fronteiras: onde entra dado de fora (rota, formulário, upload, fila, CLI, variável de
  ambiente, arquivo lido, outro processo). `ct.mjs overview` dá as entradas; `ct.mjs refs` no handler.
- Siga um dado da entrada até onde ele é usado: SQL, shell, caminho, HTML, resposta, log.

## Por área

- **Injeção:** SQL, shell ou consulta montados com texto; use parâmetro e lista de argumentos.
  Caminho vindo do usuário com `..` ou absoluto.
- **Web:** saída sem escape (XSS), mudança de estado sem proteção CSRF, redirect aberto, CORS `*`
  com credencial, URL do usuário buscada pelo servidor (SSRF).
- **Acesso:** checagem só no cliente, rota nova sem autorização (o padrão é negar), id de outro
  usuário aceito sem conferir dono (IDOR), token sem expiração, senha sem hash lento
  (bcrypt/argon2/scrypt), login sem limite de tentativas.
- **Sessão:** cookie sem `HttpOnly`, `Secure` e `SameSite`; id de sessão mantido após o login;
  logout que não invalida no servidor.
- **Segredos e configuração:** chave no código, no log ou em `.env` versionado; debug ou stack de
  erro em produção; senha, token ou dado pessoal em log.
- **Dados e carga:** upload sem limite de tipo e tamanho, desserialização de entrada, regex com
  retrocesso explosivo, laço ou lote sem teto.
- **Dependências:** vulnerabilidade só com fonte (`npm audit`, advisory, CVE); pacote novo que a
  biblioteca padrão resolve.
- **Cripto:** algoritmo próprio, MD5/SHA-1 para senha, `Math.random` ou similar para token.

## Como relatar

- Achado só com caminho concreto: quem ataca, por qual entrada, o que obtém. Sem isso é hipótese, e
  vai para `Não verificado:`.
- Severidade pelo impacto real no sistema, não pelo nome da falha.
- Correção mínima no lugar certo (validar na fronteira, parametrizar), não uma camada nova.
- Feche com `Cobertura:` — as fronteiras e arquivos lidos e o que ficou de fora. "Nada encontrado"
  só vale para o que foi lido.

## Verificar

- Correção feita: `ct.mjs verify` nos arquivos mexidos e um teste com a entrada do ataque, que
  agora é recusada.
