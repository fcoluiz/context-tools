# Banca de revisão

Parte da skill `context-tools`; lida sob demanda quando pedem "revisão completa", "revisão
profissional", "banca" ou "tente reprovar". Revisão comum: `revisao-codigo.md`. A banca só revisa:
não altera nada, nem escreve teste.

## Antes

- `ct.mjs changes` (ou `--base=origin/main`) dá o alvo e quem usa o código mudado fora do diff.
  Resuma numa frase o que a mudança faz; pergunte só se não der para entender.
- Cada revisor é um subagente separado, com o diff, a frase e o próprio papel, sem ver os outros
  relatórios. Use o modelo da sessão: os `ct-*` baratos não revisam. Custa cerca de 3× ler o diff.

## Os papéis

1. **Hacker:** `seguranca.md` e, se houver dado pessoal, `lgpd.md`.
2. **Usuário confuso:** usa errado de propósito — clique duplo, campo vazio, texto onde é número,
   valor no limite, voltar ou recarregar no meio do fluxo, duas abas, rede lenta, sessão expirada.
   Diz o que quebra e qual mensagem aparece. Sem rodar o app, diz "não verifiquei rodando".
3. **Sênior:** código repetido, nome que não diz o que é, função longa ou com ramos demais,
   acoplamento que `ct.mjs coupling` mostra, o que vai ser difícil de mudar.
4. **Testador:** casos que precisam funcionar; `ct.mjs verify` diz que testes cobrem e como rodar,
   e o `ct-verifier` roda e traz só as falhas. Teste que falta vira item, não arquivo.
5. **Chefe (a sessão principal):** lê os quatro, confere cada achado no código (descarta o que não
   se confirma) e dá UM veredito: **APROVADO PRA SUBIR** ou **REPROVADO**. Item em Corrigir reprova.

## Relatório

- Lista única, numerada, do mais grave ao menos grave, nos grupos Corrigir / Deveria corrigir /
  Opcional: `arquivo:linha`, papel que achou, o que dá errado e a correção mínima.
- Feche com `Não verificado:` — papel que não rodou, app não executado, uso dinâmico.
