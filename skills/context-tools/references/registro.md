# Pedido "registre no contexto" ("save this to context")

Parte da skill `context-tools`; lida sob demanda. Prefixo dos comandos: o mesmo do `SKILL.md`.

Vale para o que ESTA conversa investigou; não exige pasta nem tipo. Tipo pelo conteúdo: fluxo
entre telas/units → `feature`; tela → `tela`; tabelas → `banco`; sistema externo →
`integracao`; escolha técnica → `decisao`. Documento que já cobre a área é atualizado; senão,
`ct.mjs docs create --type=<tipo> --name=<nome>`. Só o que o código confirmou, sem
`arquivo:linha`; o resto fica `A mapear`. Some uma linha ao índice e mostre o que registrou.

Sem esse pedido, responda na conversa e não crie arquivo (na dúvida, pergunte uma vez). O `Stop`
só sugere a frase quando a sessão leu código sem cobertura (`"captureHint": false` desliga).
