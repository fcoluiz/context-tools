# Interface (frontend)

Parte da skill `context-tools`; lida sob demanda ao criar ou mudar tela, componente ou estilo.

## Antes de escrever

- Reaproveite: ache o componente, o token de cor e espaçamento e o padrão de formulário que o projeto
  já usa (`ct.mjs find`, `ct.mjs refs` num componente parecido). Biblioteca de UI ou framework de CSS
  novo só com pedido.
- Mudar a interface de um componente (prop, evento, nome): `ct.mjs impact` antes. Prop renomeada
  quebra a tela que ninguém abriu.
- Tela nova sem padrão no projeto: parta do conteúdo real e do público, não de um molde genérico.

## O que toda tela precisa

- **Estados:** carregando, vazio, erro e sucesso; sempre um próximo passo. Clique duplo e resposta
  lenta não duplicam a ação. Ação destrutiva pede confirmação ou permite desfazer.
- **Acessibilidade:** elemento nativo (`button`, `a` para navegar, `label` + `input`) antes de `div`
  com clique; rótulo em todo campo e botão só de ícone; foco visível e tudo alcançável pelo teclado;
  modal prende e devolve o foco; `alt` em imagem com conteúdo; contraste suficiente; nada só por cor.
- **Formulário:** tipo, `name` e `autocomplete` certos; colar nunca bloqueado; erro ao lado do campo
  e foco no primeiro erro ao enviar; aviso antes de sair com alteração não salva.
- **Navegação:** filtro, aba e página no URL, para link e botão voltar funcionarem.
- **Tamanho de tela:** funciona estreito (~360 px) sem rolagem lateral; texto longo e tradução não
  estouram o layout; alvo de toque confortável; zoom nunca desligado.
- **Dados:** validação no cliente é conveniência, a do servidor é a que vale. Texto do usuário nunca
  em `innerHTML`/`dangerouslySetInnerHTML`/`v-html`. Token onde o projeto já guarda.
- **Estado:** uma fonte da verdade; o derivado é calculado, não copiado e sincronizado à mão.
- **Desempenho:** lista grande paginada ou virtualizada; imagem com tamanho declarado; nenhuma
  requisição refeita a cada render; animação só em `transform`/`opacity` e respeitando
  `prefers-reduced-motion`.

## Verificar

- Rode a tela e olhe o fluxo principal e um estado de erro (e o estreito e o escuro, se o projeto os
  tem). Em teste automatizado de navegador, espere a página assentar e leia o DOM ou a captura antes
  de escolher seletores; confira o console. Sem como rodar, diga "não verifiquei visualmente".
- Lógica (formatação, validação, cálculo) testada fora da tela, na suíte que já existe.
