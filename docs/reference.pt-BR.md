# context-tools — referência completa

> Esta é a referência completa: cada ferramenta, hook, configuração e medição. Para começar rápido,
> veja o [README](../README.pt-BR.md).

Navegação de código e higiene de documentação para Claude Code e Codex.
Zero dependência (só `node:` builtins), zero configuração, **geradas na hora** — nunca defasam.

> **Tradução.** O documento canônico é o [reference.md](reference.md), em inglês — mesma língua da saída
> padrão da ferramenta. Esta versão acompanha a versão publicada no `CHANGELOG.md`; se as duas divergirem, o inglês
> vence. Duas cópias do mesmo texto são exatamente o defeito que a seção *"A segunda regra"* descreve,
> então o rodapé existe para tornar a defasagem visível em vez de silenciosa.

Todo número neste documento foi **medido**, e cada um diz onde. Nenhum é estimativa.

Inclusive os que desfavorecem a ferramenta:

> **89,1% do custo de uma sessão é o contexto sendo carregado**, não o modelo gerando resposta —
> mas resultado de ferramenta é só 2% disso. Economizar token com navegação de código rende
> **1-3%**, não os 20% que uma conta apressada sugere.
> [Como isso foi medido ↓](#a-economia-de-token-medida--e-ela-é-pequena)

---

## O problema, medido

> **De onde vêm os números deste documento.** As medições internas saem de um mesmo **workspace de
> referência** — dois repositórios lado a lado, um backend (679 arquivos) e um frontend (864),
> 1.543 no total, mais o histórico de 70 sessões reais de agente sobre eles. Ele aparece
> anonimizado; os números são os medidos. As medições de precisão de parser saem de **projetos de
> código aberto**, nomeados, para que qualquer um possa repetir.

Instrumentação de **66 sessões reais** de trabalho num projeto de 14 MB:

| | |
|---|---|
| antes da primeira edição | mediana de **24 chamadas** e **86 KB** lidos |
| de onde vinham os bytes | **66,7% código**, 12,5% documentação |
| leituras dos arquivos quentes | **55% eram releitura em cadeia** — tateando |
| o arquivo mais lido | 577 leituras em 38 sessões, **sempre por janela, nunca inteiro** |

O custo não é ler o arquivo. É **procurar onde a coisa está**, sessão após sessão — e os mesmos
`grep` se repetiam entre sessões: conhecimento derivado, usado e jogado fora.

## Ferramentas principais e diagnósticos

| pergunta | comando |
|---|---|
| onde X está definido? | `symbols.mjs <nome> [<nome>…]` |
| como navego este arquivo gigante? | `outline.mjs <arquivo> [filtro]` |
| o que muda junto com este arquivo? | `coupling.mjs <arquivo>` |
| esta documentação ainda é verdade? | `audit-docs.mjs [--strict]` |
| **por que este código é assim?** | `why.mjs <símbolo>` |
| o que a próxima sessão precisa saber? | `handoff.mjs [--salvar]` |
| revisei este mapa/documento — registrar | `ack.mjs <mapa-ou-doc.md>` |
| como montar um pacote de evidências limitado? | `context-pack.mjs <símbolo-ou-arquivo> [--budget=N]` |
| quais provedores semânticos opcionais estão disponíveis? | `providers.mjs [--json] [--install-plan]` |
| como está a saúde e o uso local do plugin? | `health.mjs [--days=30] [--audit] [--json]` |
| quanto custa o hook Bash do Codex? | `npm run benchmark:pretool -- --samples=5` |
| quanto custa a checagem de prompt do Codex? | `npm run benchmark:prompt-audit -- --samples=7` |

`health.mjs` resume métricas locais limitadas e sinais mecânicos de atualização dos mapas de
contexto e da documentação operacional. Ele roda localmente; respostas emitidas pelos hooks não
provam que o agente as usou, e um digest correspondente não prova correção semântica. Também agrupa
buscas sem resultado por extensão ainda sem parser e mostra a duração do handler nas buscas por
símbolo reconhecidas. Também distingue consultas diretas a `symbols` resolvidas como símbolo,
arquivo ou sem resultado, sem guardar o termo pesquisado. São sinais para priorizar investigação,
não justificativa isolada para criar um parser nem prova de que o agente usou a resposta.
O relatório também avisa quando o snapshot auxiliar da sessão excede o limite. No Codex, o `Stop`
usa o diário local de escritas observadas para atribuir alterações à sessão.

`benchmark:pretool` inicia o hook do Codex em processos Node separados com entradas Bash sintéticas.
Mostra o tempo ponta a ponta de um comando não relacionado, uma busca textual por regex e uma busca
com cara de símbolo; não executa nem imprime esses comandos. É um diagnóstico sob demanda, então as
chamadas Bash normais não passam a gravar métricas extras.

`benchmark:prompt-audit` mede o caminho do `UserPromptSubmit` do Codex em um projeto sintético
temporário: prompt comum, arquivo mapeado citado explicitamente e nome simples que percorre o
workspace. Informa os tempos inicial, p50 e p95 sem salvar prompts, caminhos do projeto ou tempos.
O hook normal não grava uma métrica em cada prompt.

**`symbols`** devolve a **definição**, não as dezenas de menções do Grep. Aceita vários nomes numa
chamada — o custo é construir o índice, não consultar, então 3 símbolos em 3 chamadas custavam
~1,4 s e em lote custam uma consulta só.

Se o nome não for símbolo mas existir como **arquivo**, ele diz isso em vez de desistir. O arquivo
é rotulado como ARQUIVO, nunca apresentado como definição — mandar o `Read` para a linha errada é
o erro que a ferramenta inteira existe para evitar.

Ele também encontra **chave de configuração** (`sessionTimeoutMinutes`, `max_restarts`,
`enableFallback`), que antes não era achável de jeito nenhum. A regra é estreita de propósito — só
literal de objeto aberto no topo do arquivo, só os filhos diretos: no workspace de referência isso dá 1.329
chaves com média de 1,6 ocorrência por nome, enquanto a regra larga daria 75.454 e afogaria a busca.
Elas aparecem rotuladas como `key`, nunca como definição, e ficam **abaixo** dos símbolos reais no
resultado.

**`outline`** dá `linha → símbolo` de um arquivo só (em `.md`, as seções). Substitui a caça por
janelas de 2 KB. Cada símbolo carrega **onde termina**, não só onde começa: medidos 5.985 símbolos
reais, a mediana é de **16 linhas** (p75 = 38) — quem recebe só a linha inicial chuta 40 e lê ~2,5×
mais que o necessário.

**`coupling`** lê o histórico do git e **descobre** correlação que ninguém documentou. Num projeto
real achou `controllers/orders.js ↔ services/paymentService.js` (100%, 7 commits) e a tríade
`messaging.js + MessagingConnection + validators/messagingConnection` — nenhuma estava em doc algum.
É git puro: funciona em qualquer linguagem.

**`audit-docs`** acha ponteiro de linha podre, símbolo/arquivo que não existe mais, hash de commit
inválido e alegação de status sem data.

**`why`** é a única que não pergunta sobre o estado do código, e sim sobre as **decisões** que o
produziram — a pergunta em que ler mais código não ajuda, porque a resposta não está lá. Usa
`git log -L` no intervalo de linhas do símbolo (não no arquivo: num arquivo de 14 mil linhas o
histórico do arquivo é ruído quase puro) e devolve os commits que o moldaram, com a justificativa.
É onde um agente erra com mais confiança: remove um guard que existe por um motivo, "simplifica" o
que já foi simplificado e quebrou, troca um limiar que foi medido.

Custa ~1,3 s por consulta, e por isso é **sob demanda** — caro demais para virar hook. Se o
histórico não tiver o que dizer, ele diz isso; e se o git falhar, distingue "não achei" de "não
consegui olhar" (clone raso é o caso comum, e o remédio é `git fetch --unshallow`).

**`handoff`** existe por causa do maior custo medido, e ele não é ferramenta nenhuma: **o custo por
mensagem cresce 3,4× com o tamanho da sessão**. Ele monta o que é mecânico — arquivos tocados desde
o início da sessão, mapas que cobrem essa área — e deixa **em branco** o que só existe na cabeça de
quem trabalhou: o que foi tentado, o que falhou, qual hipótese está de pé. Preencher isso por
palpite viraria um handoff que mente, e handoff que mente é pior que não ter.

Ele usa o índice para dizer **quais símbolos** mudaram, não só quais arquivos — `src/servico.js →
function segunda, class Motor, parar()`. Num arquivo de 14 mil linhas essa é a diferença entre
saber e não saber onde retomar. Custa ~130 ms porque o índice já está em cache; sem cache não
valeria a pena rodar isso num hook. Também marca **mapa defasado**: o arquivo coberto mudou depois
do `verified_at`, então ler sem conferir é confiar em doc velha.

No Claude, um hook de `Stop` avisa quando a sessão passa de 200k de contexto — o ponto onde o custo
por mensagem já dobrou na curva medida — e **já grava o handoff junto**, para que ele esteja pronto
na hora de fechar. Avisa **uma vez só por sessão**. No Codex, o `Stop` permanece silencioso quanto a
contexto e tempo; as métricas normalizadas continuam registradas no handoff para análise posterior.
O arquivo não é regravado sozinho depois (mudaria embaixo de quem está lendo) — `--salvar` atualiza
sob demanda.

**O mesmo aviso pede ao AGENTE que preencha o bloco volátil** — não ao humano. Essa parte não é
automatizável sem LLM: "o que foi tentado e falhou" não está no git, está na cabeça de quem
trabalhou. Mas o agente já tem a sessão inteira em contexto, então para ele custa um turno e nada
mais. Depender de alguém lembrar era apostar o ganho de 19-27% na memória de quem volta — e o único
handoff auto-gerado que existiu em disco tinha o bloco **em branco**. (Extração por heurística já
foi tentada e descartada: detectar reversão por palavra-chave dava quase só falso positivo.)

**`--prompt` devolve o handoff como texto para colar numa sessão nova**, com o enquadramento que
falta no arquivo ("continuando o trabalho de uma sessão anterior; não refaça o que já está feito").
O arquivo serve a quem abre o repositório; o prompt serve a quem abre uma sessão — que é o momento
em que o handoff vale alguma coisa. Ele **prefere o arquivo já salvo**: regenerar apagaria o bloco
volátil que alguém acabou de preencher.

### O laço que faltava: dividir a sessão compensou?

O plugin manda dividir desde que existe, e até 2026-08-04 **ninguém sabia se dividir tinha
funcionado**. Um hook de `SessionStart` fecha o laço: julga o par (sessão que fechou cara → sessão
que a sucedeu) e diz se **ganhou, empatou ou perdeu**, com quanto.

```
📊 A última divisão de sessão COMPENSOU: a sessão anterior a ela fechou com 694k de contexto,
   e a que veio depois voltou a produzir em 49 mensagens (0.9x o aquecimento típico de 52)
   — economia estimada de ~21%.
   Estimativa, não medição: a contagem de mensagens é real, o % vem da curva simulada.
```

Julga o par **anterior**, não o atual, e o motivo é honestidade: no início de uma sessão o
aquecimento dela ainda não aconteceu, e julgar o que não aconteceu seria inventar. Sem LLM, sem
rede, uma vez por sessão. E **cala quando não há divisão para julgar** — sessão anterior barata não
foi "dividida", e veredito sobre divisão que não houve seria ruído com cara de medida.

---

## A parte que importa: ela não mente

Uma ferramenta de busca que responde com confiança e manda para a linha errada é **pior que não
ter ferramenta** — o erro fica invisível e o custo é pago em silêncio. Por isso cada parser é
conferido contra **código de produção de terceiros**, não contra exemplo escrito para passar.

O critério é o mesmo em todos: para cada símbolo indexado, a linha reportada é lida crua do arquivo
e tem que conter mesmo a declaração; e todo símbolo que o `grep` vê e o índice não reportou é
classificado um a um.

| linguagem | corpus real | arquivos | símbolos | linha errada |
|---|---|---:|---:|---:|
| Python | flask · requests · django | 3.047 | 45.985 | **0** |
| Go | cobra · gin · prometheus | 861 | 21.170 | **0** |
| Delphi/Pascal | HeidiSQL · Double Commander | 1.164 | 72.179 | **0** |
| Rust | rayon · um app desktop privado | 219 | 5.778 | **0** |
| TypeScript | frontend de referência · projeto de terceiro | 864 | 1.617 **tipos** | **0** |

**≈ 6.200 arquivos e 147 mil símbolos**, onze projetos independentes, dois dialetos de Pascal.

A linha do TypeScript mede só `interface`/`type`/`enum`, que era a lacuna investigada; o mesmo
parser rodou nos 593 arquivos JS do backend de referência para provar o outro lado — **0 símbolos
novos**, ou seja, `type: 'foo'` (propriedade de objeto, comum em JS) não virou declaração.

### O que essa verificação encontrou

Nenhum desses bugs aparece em teste sintético. Todos vieram do corpus real:

- **Comentário virando definição.** Pascal usa `{ }` e `(* *)`, e o parser só pulava `//`. Resultado
  medido: **168 símbolos fantasma**, e **84 nomes que existiam SÓ dentro de comentário** — perguntar
  por qualquer um devolvia 100% lixo. O caso caro: `ContentGetValueW` respondia `wdxplugin.pas:87`
  com arquivo e linha exatos, apontando para dentro de um `(* *)` que documenta a API de plugin do
  Double Commander. Prosa de documentação virava símbolo chamado `function is`.
- **A mesma armadilha em Python, prevista e evitada.** Docstring `"""…"""` atravessa linhas e o
  exemplo de código dentro dela é o estilo dominante de documentação em Python: **92 definições
  fantasma** evitadas em flask/django (`def index():` de exemplo, dentro do docstring da rota).
- **Bloco agrupado em Go.** Sem rastrear aninhamento, os campos de um literal dentro de `var (…)`
  viram declaração: `prometheus.GaugeOpts{ Name: …, Help: … }` gerava `var Name` e `var Help` —
  **613 símbolos falsos** no corpus.
- **Tipos do TypeScript invisíveis.** `interface`/`type`/`enum` não entravam no índice: 1.592 tipos
  faltando só no frontend do workspace de referência. Pior que "não achei" — como a busca casa parcial, perguntar
  por `Status` devolvia **`function StatusBadge` como se fosse a resposta**.

### E o pior de todos, que não era parser

A descoberta de arquivos devolvia só as pastas de convenção que existissem (`src`, `lib`, `tests`,
`scripts`…). Bastava **uma** existir para todo o resto do repositório sumir do índice — em silêncio,
respondendo "não existe" com confiança:

| repositório | indexava | existe | invisível |
|---|---:|---:|---:|
| prometheus | **0** | 974 | **100%** |
| django | 2.026 | 2.970 | 32% |
| flask | 65 | 83 | 22% |

O Prometheus tem uma pasta `scripts/`; o código real mora em `tsdb/`, `discovery/`, `storage/`.
A ferramenta lia a pasta de scripts de build e concluía que o projeto não tinha código.

Hoje varre a raiz e deixa a lista de exclusão podar (`node_modules`, `vendor`, `target`, `dist`,
`__pycache__`, `.venv`). **Custo medido da correção: zero** — 1.752 ms antes, 1.752 ms depois no
mesmo workspace, porque listar diretório é 34 ms do total; o gasto real é ler bytes.

A **mesma** falha estava na busca de documentação, e ali era pior: `docDirs` não tinha nem fallback,
então repositório sem `docs/` devolvia lista vazia e a auditoria não olhava nada. Corrigida junto —
nos repositórios do workspace de referência passaram a ser auditados **20 documentos** que nunca tinham sido,
entre eles `README.md`, `AGENTS.md` e `CLAUDE.md`: os arquivos que instruem o agente em toda sessão,
justamente onde documentação podre custa mais caro.

> Este README é a prova viva: até esta revisão ele carregava uma "limitação conhecida" sobre o
> `coupling` engolir falha do git em silêncio — **corrigida havia tempo**, e ninguém percebeu porque
> nenhum auditor lia o README.

---

## A economia de token, medida — e ela é pequena

Ferramenta desse tipo costuma prometer "economizar contexto". Aqui está o número real, e ele
**não** favorece a promessa: entre **1% e 3% do custo de uma sessão**, com teto absoluto de 3,6%.

Medido em **65 sessões reais de trabalho** (28.422 mensagens), lendo o `usage` que o Claude Code
grava em disco. As 3 sessões em que o próprio plugin foi construído ficaram de fora — clonar
corpus e minerar transcript não representa desenvolvimento normal.

> **Correção registrada.** A primeira versão desta seção anunciava "20% menos contexto". Estava
> errada, e o erro era de denominador: 20% é a fatia de tatear dentro do **volume de resultado de
> ferramenta** — mas resultado de ferramenta é só **2% de tudo que entra no cache**. Confundir os
> dois inflava o ganho em uma ordem de grandeza. Fica aqui porque o mesmo erro é fácil de repetir.

### O custo não é o modelo pensando. É o contexto sendo carregado.

| | tokens | peso no custo |
|---|---:|---:|
| `cache_read` | 8.311 M | **62,7%** |
| `cache_creation` | 277 M | **26,1%** |
| `output` | 28,9 M | 10,9% |
| `input` | 3,4 M | 0,3% |

**89,1% do custo é o contexto**, não a geração. Isso muda a régua: não adianta "ler menos uma
vez" — o que pesa é **carregar adiante**. Um token que entra na mensagem 10 é relido em todas as
seguintes, então o mesmo byte custa muito mais quando entra cedo.

### De onde vem o contexto

| ferramenta | chamadas | volume | |
|---|---:|---:|---:|
| **Read** | 3.574 | 14,02 M chars | **69%** |
| Bash | 3.915 | 2,90 M | 14% |
| Grep | 1.626 | 1,70 M | 8% |
| Edit | 3.499 | 0,79 M | 4% |

### Dentro do Read, o desperdício é localizado

| | volume | |
|---|---:|---|
| primeira leitura do arquivo | 7,75 M | inevitável |
| **tateando** — outra janela de um arquivo já aberto | **3,98 M** | **recuperável** |
| verificação depois de editar | 2,18 M | legítimo |
| duplicata pura (mesma janela) | 0,10 M | 0,7% — a higiene já é boa |

O tatear é **28% do volume de Read** — 1.215 chamadas, média de 3.278 chars. É exatamente o padrão
que o `outline` existe para cortar: abrir uma janela atrás da outra até achar o trecho, quando um
mapa `linha → símbolo` resolveria de primeira.

### Por que isso ainda dá só 1-3% do custo

Porque **resultado de ferramenta é 2% de tudo que entra no cache**. O conteúdo visível do
transcript inteiro — leituras, respostas, raciocínio, mensagens — soma 9,6 M tokens contra
**277 M de `cache_creation`**. Os outros 97% são prompt de sistema, schema das ferramentas e
reescrita de prefixo: custo fixo por requisição, que **nenhuma ferramenta de navegação alcança**.

A conta foi feita por simulação contrafactual sobre as sessões reais, não por regra de três —
cada leitura evitada rende `1,25×` (não entrou no cache) mais `0,1× × mensagens seguintes` (não
foi relida), então a posição na sessão importa:

| premissas | economia líquida |
|---|---:|
| conservadora (50% do tatear evitável, outline a 1.500 chars) | **1,0 – 1,3%** |
| central (70% evitável) | **1,6 – 2,0%** |
| otimista (100% evitável) | **2,5 – 3,1%** |
| **teto absoluto** (100% evitável, outline de graça) | **3,6%** |

A faixa cobre chars-por-token de 3,2 a 4,0; a conclusão não depende dessa escolha.

### O que compensa mesmo assim

O retorno sobre o `outline` é de **5×** — cada token gasto nele evita cinco. E no arquivo campeão
do workspace medido (um service de 14.249 linhas, lido **576 vezes em 38 sessões**):

| | custo |
|---|---:|
| uma releitura média tateando | 3.278 chars |
| `outline` completo | 14.773 chars → se paga em 4 releituras |
| `outline` com filtro | **546 chars** → se paga na primeira |

### O maior botão de custo não é ferramenta nenhuma

A mesma medição achou algo muito maior que os 1-3%: **o custo por mensagem cresce 3,4× com a
duração da sessão**, porque cada mensagem relê o contexto inteiro.

| duração | msgs (med) | contexto (med) | custo/msg | reescritas de prefixo |
|---|---:|---:|---:|---:|
| 0-1 h | 105 | 119k | **16k** | **0** |
| 1-3 h | 224 | 273k | 32k (2,0×) | 2 |
| 3-6 h | 503 | 438k | 39k (2,5×) | 2 |
| 6-12 h | 658 | 494k | 45k (2,9×) | 4 |
| 12 h+ | 726 | 573k | **54k (3,4×)** | **5** |

Sessão abaixo de 1 h **nunca** reescreve o prefixo cacheado. Acima de 12 h, cinco vezes — e cada
reescrita grava 275k-445k tokens de uma vez. As **33 sessões de 6 h+ consumiram 83% de todo o custo
medido**.

#### Essas reescritas NÃO são compactação automática — hipótese testada e descartada

Era a suspeita natural: se a sessão longa reescreve 275k-445k tokens de uma vez, talvez esses
eventos *sejam* a compactação automática, e aí "dividir" estaria competindo com um mecanismo que já
existe. O transcript **declara** a compactação em campos próprios, então deu para cruzar os dois
conjuntos em vez de supor. Nas mesmas 70 sessões:

| | |
|---|---:|
| reescritas de prefixo detectadas | **243**, em 57 sessões |
| compactações **declaradas** | **4**, em 2 sessões |

Duas ordens de grandeza de diferença, e sem correlação nenhuma: a sessão com mais reescritas (16)
teve **zero** compactações. São fenômenos distintos — a reescrita é o cache do prefixo morrendo e
sendo regravado, não o contexto sendo resumido.

O efeito colateral é mais interessante que a hipótese original: **a compactação automática quase
não acontece neste corpus** (2 de 70 sessões). As sessões ficam caras e *continuam* caras, sem nada
reclamando o contexto de volta — o que reforça o caso de dividir em vez de enfraquecê-lo.

**O que segue em aberto, e por quê:** comparar o CUSTO de dividir contra o de compactar continua
inconclusivo. Com n=2 não dá para levantar curva de custo, e inventar uma a partir de duas sessões
seria exatamente o erro que esta seção inteira existe para não cometer.

O pedágio de dividir foi medido, não suposto: o aquecimento até a primeira edição custa **0,64×**
por mensagem (o contexto ainda é pequeno), e o custo/msg das sessões curtas **já inclui** o
aquecimento delas. Sobra só o custo de repetir exploração:

| se blocos curtos custarem | resultado |
|---|---:|
| 1,0× mensagens | economia de **58%** |
| 1,5× | 46% |
| 2,0× | **33%** |
| 3,4× | empate |

**Dá para gastar 3,4× mais mensagens em blocos curtos e ainda empatar.**

### A economia de dividir, simulada mensagem a mensagem

Os 58% acima são **teto**, não estimativa: supõem que o bloco curto custe 1,0× por mensagem. A
estimativa real veio de simulação contrafactual sobre as **69 sessões** (1.460 M unidades
ponderadas), replicando o crescimento de contexto medido de cada uma e cortando quando ele passa do
limiar — cada corte paga o reaquecimento de novo, e `cache_creation` foi mantido igual (na prática
cairia, porque bloco curto quase não reescreve prefixo; a conta subestima de propósito).

| corta acima de | reaquecimento repetido | cortes | economia |
|---|---|---:|---:|
| 200k | **1,0× (o handoff não ajuda em nada)** | 301 | **19,3%** |
| 200k | 0,7× | 301 | **27,0%** |
| 200k | 0,5× | 301 | 32,2% |
| 300k | 1,0× | 236 | 19,1% |
| 400k | 1,0× | 202 | 15,6% |

Nas 37 sessões de 6 h+, que são 85% do custo, a economia vai de **22,6% a 30,1%**.

A linha que importa é a primeira: **19,3% de economia mesmo supondo que o handoff não encurte nada
do aquecimento** — exatamente o que a medição da seção seguinte concluiu. O ganho vem de *dividir*;
o handoff só torna a divisão prática para quem trabalha. E ele é barato o bastante para não mudar a
conta: engordá-lo de 557 para 8.000 tokens leva a economia de 27,0% para 26,1%.

**É a maior alavanca medida deste plugin** — uma ordem de grandeza acima dos 1-3% de navegação. O
que o plugin faz aqui é concreto e pequeno: o hook de `Stop` avisa quando a sessão cruza 200k (o
ponto onde o custo por mensagem já dobrou) e deixa o handoff pronto em disco. Quem decide fechar é
o usuário — o plugin não divide sessão nenhuma sozinho.

#### Quando dividir GANHA, empata e PERDE

A economia não é incondicional, e a condição é uma só: **quanto custa voltar a produzir depois de
reabrir.** Chamemos isso de *reaquecimento*. Nas 69 sessões medidas, o aquecimento original — do
"oi" até a primeira edição de arquivo — foi de **52 mensagens e ~16 minutos** (medianas). Essa é a
unidade da tabela: `1,0×` significa "reabrir custou tanto quanto o começo original custou".

| se reabrir custar | em mensagens (aprox.) | resultado |
|---|---|---:|
| 0,7× o aquecimento original | ~36 | ganha **27,0%** |
| 1,0× — refaz o começo inteiro | ~52 | ganha **19,2%** |
| 1,5× | ~78 | ganha 6,3% |
| **1,75× — ponto de equilíbrio** | **~91** | **empata** |
| 2,0× | ~104 | **perde 6,6%** |
| 3,0× | ~156 | **perde 32,5%** |

Em português: **você tem cerca de 90 mensagens de folga para retomar o trabalho.** Gastou menos que
isso, ganhou; gastou mais, teria saído mais barato não ter fechado a sessão. E a queda é simétrica
e rápida — passar do dobro do aquecimento já custa mais do que a divisão economiza.

É por isso que o **bloco volátil do handoff não é opcional**. A parte automática (arquivos,
símbolos, mapas) não segura sozinha essas 90 mensagens: quem segura é o "o que foi tentado, o que
falhou, qual hipótese está de pé". Fechar sem preencher é apostar o ganho inteiro na memória de
quem volta.

> **A honestidade da conta.** A tabela acima assume que o trabalho entregue é o mesmo dos dois
> lados. Retrabalho de verdade — a sessão nova refazendo uma decisão que a anterior já tinha
> tomado — entra aqui como reaquecimento maior, e é assim que 19% viram −7%. Não medimos essa
> frequência: exigiria comparar o trabalho entregue, não o custo, e para isso a amostra de um
> usuário só não serve.

### O handoff injetado no SessionStart: medido e descartado

O passo seguinte parecia óbvio: se dividir a sessão economiza até 58% e o handoff é o que barateia
o recomeço, então o `SessionStart` deveria **injetar o handoff da sessão anterior sozinho**, em vez
de depender de alguém lembrar de ler. Medido em **69 transcripts reais** (2026-06-15 a 2026-08-04),
antes de escrever uma linha. Não sobreviveu.

**O teto é pequeno.** O aquecimento — tudo até a primeira edição — é **5,9% do custo da sessão**
(mediana) e apenas **3,5% nas sessões de 6 h+**, que carregam 86% do custo. Os 58% da tabela acima
são a economia de **dividir**, não do handoff: dividir uma sessão em quatro paga três aquecimentos
extras, ~7%, contra ~58% economizados. **O pedágio já era pequeno — dividir já compensa sem handoff
nenhum.** O handoff não é o que destrava a divisão.

**O mecanismo não funciona.** O aquecimento é 74% `Read`+`Grep`, então em tese seria endereçável.
Mas o dono já escreve briefing à mão no primeiro prompt, e às vezes ele **nomeia arquivos** — um
experimento natural de graça. Unidade: (sessão, arquivo), para todo arquivo que a sessão anterior
editou, nos 40 pares de continuação (gap < 12 h e sobreposição de edição):

| | relido antes da 1ª edição | não relido | taxa |
|---|---:|---:|---:|
| citado no 1º prompt | 25 | 30 | **45%** |
| não citado | 68 | 893 | 7% |

A associação está confundida — arquivo é citado **porque** é o que vai ser mexido —, então isto não
prova que citar cause leitura. Prova o que basta: **citar não impede ler.** Faz sentido, e é o
ponto: o modelo precisa do *conteúdo*, e nome de arquivo não é conteúdo. O bloco mecânico do
handoff (arquivos + símbolos) é justamente a parte que dá para gerar sozinho — e é a parte que não
encurta nada.

**E não é barato.** Com dados reais, o bloco mecânico daria **557 tokens** na sessão mediana (15
arquivos editados) e **1.057** no p90 (41 arquivos; o máximo real foi 65). O `SessionStart` inteiro
custa **175** hoje. Seria 4-6× o custo fixo, pago por **toda** sessão — inclusive os 30% que não
continuam nada.

**"A sessão anterior" nem sempre existe.** O gap mediano entre fim e início é de 0,1 h, então TTL
quase nunca seria o problema. Mas **14 de 68 sessões começaram antes de a anterior terminar** —
janelas simultâneas. Em 21% dos casos, injetar "o handoff anterior" significaria injetar o de uma
janela ainda rodando.

> **O defeito que a medição achou de brinde.** Rodando o `handoff.mjs` para medir, ele anunciou dois
> arquivos como "tocados nesta sessão" — modificados pela última vez **20 h antes de a sessão
> abrir**. O baseline guarda o HEAD, e `git diff <HEAD>` compara commit contra *working tree*: toda
> sujeira herdada entrava como trabalho novo, e continuaria entrando até alguém commitar. Como
> documento que alguém lê, é uma linha para ignorar; **injetado automaticamente, seria mentira fixa
> em toda sessão** — exatamente o modo de falha que este plugin existe para não ter. Corrigido
> (o `SessionStart` grava o `mtime` da sujeira existente e o handoff a subtrai), e a mesma
> investigação achou que o baseline **nunca era gravado** em projeto sem pasta `.claude/`: o
> `writeFileSync` falhava, o `safe` engolia, e a feature ficava morta em silêncio.

**O que sobra.** Só o **bloco volátil** — e a evidência a favor dele é n=1, não medição. Se algo for
injetado um dia, o desenho que os números sustentam é o mínimo: só o bloco volátil, só quando
preenchido, só quando a sessão anterior fechou de verdade. O bloco mecânico não entra.

> **Duas economias de tamanhos muito diferentes — não confunda as duas.** Navegar melhor
> (`symbols`, `outline`, `coupling`) rende **1-3%**, e isso sozinho não justificaria ferramenta
> nenhuma; o que justifica esse lado é **0 linha errada em 6.200 arquivos**, os **183 round-trips**
> que o hook de Grep teria cortado e o índice **13× mais rápido** — a tese ali é não mandar o
> `Read` para o lugar errado. A economia de verdade é a outra: **dividir a sessão rende 19-27%**,
> uma ordem de grandeza acima, e é o que o aviso de `Stop` mais o `handoff` existem para tornar
> prático.

---

## O que o plugin cobra

### Velocidade

Medido em Windows/NTFS, rebuild completo × cache quente:

| projeto | arquivos | sem cache | com cache |
|---|---:|---:|---:|
| cobra | 36 | 92 ms | **19 ms** |
| flask | 83 | 145 ms | **26 ms** |
| backend de referência | 679 | 963 ms | **77 ms** |
| frontend de referência | 864 | 1.097 ms | **83 ms** |
| prometheus | 974 | 1.794 ms | **142 ms** |
| workspace de referência inteiro | 1.543 | 1.752 ms | **130 ms** |

Onde o tempo vai, no workspace de 1.543 arquivos: **listar 34 ms · ler 17,5 MB do disco ~1.590 ms ·
parsear 160 ms.** O gargalo é abrir arquivo, não interpretar código — e é isso que torna o cache
viável, porque `stat` custa ~30× menos que `read`.

Em escala grande a degradação é **superlinear**: 1.517 arquivos → 657 ms · 5.000 → 1.859 ms ·
20.000 → **17.809 ms** (com cache, 20 mil caem para ~1,2 s).

### Tokens

O `SessionStart` é o único custo que você paga sem pedir. Medido no workspace de referência:
**630 bytes, ~175 tokens** — cerca de 5% de uma única leitura de arquivo médio, uma vez por sessão.
Mapas em dia são agrupados numa linha por repositório; só os defasados ganham linha própria, que é
onde a lista de arquivos muda a decisão.

Os avisos de `Stop` custam **zero quando não há o que avisar**. No Claude, avisos idênticos são
deduplicados por hash. No Codex, `stop_hook_active` permite uma continuação automática por turno;
uma pendência ainda aberta fica visível no fechamento e pode ser retomada em outra tarefa.

### O cache não pode mentir

Descartado por inteiro quando: um arquivo muda (mtime **e** tamanho), some ou aparece; **o parser
muda** (assinatura derivada do próprio `outline.mjs` — automática, não depende de ninguém lembrar de
subir um número); o cache é de outro projeto; ou está corrompido (aí reconstrói, nunca dá erro).
`--fresh` força rebuild. Seis testes cobrem exatamente esses cenários.

E antes de confiar no relógio do sistema de arquivos, ele **mede**: grava uma sonda na mesma
partição do projeto (o temp do SO pode ser outro volume) e, se a granularidade de mtime for
grosseira, **recusa o cache** e diz isso na saída.

A saída sempre informa o modo (`gerado agora` / `cache íntegro` / `cache + N relidos`) — num plugin
distribuído, quem usa precisa poder desconfiar.

---

## Linguagens

| extensão | `symbols` (cross-file) | `outline` (um arquivo) |
|---|---|---|
| `.js .jsx .ts .tsx .mjs .cjs` | ✅ | ✅ |
| `.py .pyi` | ✅ | ✅ |
| `.go` | ✅ | ✅ |
| `.rs` | ✅ | ✅ |
| `.pas .dpr .dpk .inc` (Delphi/Pascal) | ✅ | ✅ |
| `.dfm .fmx` (formulário Delphi) | — de propósito | ✅ |
| `.md` | — | ✅ (seções) |

`coupling` e `audit-docs` são **agnósticos**: funcionam em qualquer linguagem.

Cada parser trata o que quebra a intuição de quem vem de outra linguagem. **Pascal** é
case-insensitive e todo método aparece duas vezes (declarado no `interface`, definido no
`implementation`). **Rust** tem `impl Foo` e `impl Trait for Foo`, e nas duas o que se procura é o
tipo — e `fn` difere de `Fn` (trait em cláusula `where`) só pela caixa. **Go** tem receptor genérico
(`func (b Bucket[BC]) String()`) e blocos agrupados. **Python** tem docstring.

`.dfm`/`.fmx` ficam fora do índice cross-file de propósito: nome de componente (`Button1`, `Panel2`)
se repete em todo formulário e afogaria a busca por símbolo de verdade.

### Adicionar uma linguagem são quatro passos

1. escreva o parser em `outline.mjs` e registre a extensão em `parserForExt`;
2. some a extensão a `EXTENSOES_CODIGO` em `lib/roots.mjs` — fonte única de onde `CODE_RE` deriva;
   sem isso o arquivo nem entra na varredura;
3. **ensine os rótulos novos ao `bareName`**, também em `symbols.mjs`;
4. troque a extensão de exemplo nos dois testes de "linguagem não suportada".

O passo 3 é o que morde: sem ele o símbolo entra no índice pelo rótulo (`struct Session`) mas a
consulta pelo nome nu (`Session`) não o encontra — falha que não aparece em teste de parser nenhum,
só na consulta ponta a ponta. TypeScript e Rust esbarraram nele. O passo 4 já quebrou o CI duas
vezes: o exemplo era `.rs`, virou `.py`, e cada um falhou sozinho quando a linguagem entrou.

### Todas falham visível

Se não acharem, dizem que não acharam e mandam pro Grep. Nenhuma devolve vazio com cara de resposta
— um detector que falha "aberto" é pior que não ter detector.

E "0 arquivos indexáveis" tem **duas** causas com remédios diferentes: pasta errada (ajustar
`--root`) ou projeto inteiro numa linguagem que o índice não lê. Ele distingue as duas e diz qual
é, com as extensões que encontrou e quantas — porque falha visível não basta se o diagnóstico manda
o usuário para um beco sem saída.

---

## Instalação

### Instalar ou atualizar globalmente (recomendado)

```bash
npx --yes --package github:fcoluiz/context-tools context-tools-setup-all --global --yes
```

Instala ou atualiza a última versão para todo agente cujo CLI existe na máquina (Claude Code no
escopo `user`, Codex de forma global), sem tocar em nenhum projeto. Rodar de novo atualiza: no
Claude usa `claude plugin update` quando o plugin já está instalado; no Codex adiciona de novo o
marketplace na tag nova, o que o CLI do Codex exige para trocar de versão. `--target=claude|codex`
limita a um agente. As seções abaixo descrevem as alternativas por projeto e manuais.

### Como plugin (recomendado)

```bash
claude --plugin-dir /caminho/para/context-tools
```

Traz as ferramentas **e os hooks**. Usa `${CLAUDE_PLUGIN_ROOT}`, então não há caminho absoluto para
ajustar em máquina nenhuma.

### Standalone (copiado para o projeto)

```bash
node /caminho/para/context-tools/install.mjs /caminho/do/projeto
```

Copia os scripts para `<projeto>/.claude/scripts/` e registra os hooks usando `$CLAUDE_PROJECT_DIR`.
Idempotente. `--dry-run` simula, `--no-hooks` instala só os scripts.

Também cria `.claude/.gitignore` cobrindo os arquivos de estado (cache, travas, baseline), para não
poluírem seu `git status`. O `.gitignore` da raiz não é tocado: ele é seu.

### Claude e Codex no mesmo repositório

Este repositório contém as duas camadas de integração e um único núcleo Node.js compartilhado. O
Claude mantém seu `.claude-plugin/`, `hooks/hooks.json`, estado em `.claude/` e comportamento com
`CLAUDE.md`. O Codex usa `.codex-plugin/plugin.json`, `hooks/codex-hooks.json`, estado em `.codex/`
e `AGENTS.md`. Os scripts são compartilhados, mas os adaptadores de hook e o estado gerado ficam
isolados.

Para um projeto que deve suportar os dois agentes, use o instalador unificado:

```bash
node /caminho/para/context-tools/install.mjs /caminho/do/projeto --target=both
```

`--target=claude` preserva a instalação original, `--target=codex` instala apenas a camada Codex,
e `--target=auto` seleciona Codex quando executado em um ambiente Codex; caso contrário instala
as duas camadas. `--dry-run` e `--no-hooks` valem para qualquer alvo. A forma somente Codex também
está disponível como `node /caminho/para/context-tools/install-codex.mjs /caminho/do/projeto`.

A instalação standalone do Codex grava `.codex/scripts/`, `.agents/skills/context-tools/` e
`.codex/.gitignore`; ela nunca modifica `.claude/`.
O plugin Codex fornece a skill, os metadados e os hooks de ciclo de vida pela fonte
`hooks/codex-hooks.json`. O setup guiado inicializa a configuração com `--mode=global`, sem
copiar scripts, skill ou hooks. Standalone é uma escolha explícita para ambientes sem plugin.
A skill global usa `${PLUGIN_ROOT}/scripts/`. Sem pasta informada, o instalador usa o cwd.
O diagnóstico distingue os modos; a confiança dos hooks precisa ser conferida em `/hooks`.

```bash
node /caminho/context-tools/install-codex.mjs /caminho/projeto --mode=global
# standalone, quando necessário:
node /caminho/context-tools/install-codex.mjs /caminho/projeto --mode=standalone
```

Se `.claude/context-tools.json` já existir e `.codex/context-tools.json` não, a primeira instalação
do Codex inicializa o segundo a partir do primeiro; depois disso, as mudanças permanecem próprias
de cada host.

### Codex pelo marketplace do Git

O repositório também contém o marketplace do Codex em `.agents/plugins/marketplace.json`. Qualquer
pessoa pode configurar esse marketplace e instalar a versão marcada diretamente pelo Codex:

```bash
codex plugin marketplace add fcoluiz/context-tools --ref v2.5.0
codex
/plugins
```

A fonte fica presa à tag da release. Depois da instalação, o setup prepara o projeto e você deve iniciar uma nova sessão
do Codex. Na primeira máquina, se o Codex pedir confiança, abra `/hooks` e aprove os hooks do
context-tools uma vez. Esse é o caminho de distribuição do Codex; ele não altera o marketplace do
Claude nem instala a camada Claude.

### Claude pelo marketplace

O repositório também contém um marketplace de plugin do Claude Code em
`.claude-plugin/marketplace.json`. O CLI do Claude Code tem subcomandos não interativos
`plugin marketplace`/`plugin` que espelham os do Codex acima:

```bash
claude plugin marketplace add fcoluiz/context-tools@v2.5.0 --scope project
claude plugin install context-tools@context-tools --scope project
```

Diferente do Codex, o Claude não exige um passo separado de "confiar nos hooks": os hooks de um
plugin rodam automaticamente assim que ele é habilitado. Esse é o caminho de distribuição do
Claude; ele não altera o marketplace do Codex nem instala a camada Codex. O `setup-claude.mjs`
(abaixo) automatiza os dois comandos.

### Manutenção em um comando

Depois que o plugin estiver disponível, o utilitário integrado detecta automaticamente o projeto
atual. Três pontos de entrada compartilham o mesmo motor e aceitam os mesmos comandos
(`install`/`update`/`status`/`doctor`/`latest`/`configure`) e opções:

```bash
node /caminho/para/context-tools/setup-codex.mjs    # só Codex
node /caminho/para/context-tools/setup-claude.mjs   # só Claude
node /caminho/para/context-tools/setup.mjs          # escolhe o agente
```

`setup.mjs` é o ponto de entrada unificado: passe `--target=claude`, `--target=codex` ou
`--target=both` para escolher explicitamente. Sem `--target`, ele detecta o que o projeto já tem
(`.codex`/`AGENTS.md` para Codex, `.claude`/`CLAUDE.md` para Claude); se encontrar os dois ou
nenhum e o terminal for interativo, ele pergunta; sem interação (`--yes` ou sem TTY) e nada
detectado, instala os dois.

A partir do diretório do projeto, os utilitários podem ser iniciados sem conhecer o caminho onde
o plugin está instalado:

```bash
npx --yes --package github:fcoluiz/context-tools context-tools-setup         # Codex
npx --yes --package github:fcoluiz/context-tools context-tools-setup-claude  # Claude
npx --yes --package github:fcoluiz/context-tools context-tools-setup-all     # escolhe o agente
```

Se o Git não conseguir acessar o repositório, o launcher informa a etapa que falhou e não fecha
silenciosamente; corrija a causa e execute o mesmo arquivo novamente. Ao concluir, ele informa explicitamente o
sucesso e mantém a janela guiada aberta até você pressionar Enter.

Para uma instalação guiada por arquivo, use o launcher correspondente ao sistema:

- Windows: `setup.bat`.
- PowerShell: `setup.ps1`.
- Linux: `setup.sh`.
- macOS: clique duas vezes em `setup.command`.

Há uma família de launchers, não uma por agente: todos repassam os argumentos ao `setup.mjs`,
então `setup.bat --target=codex` instala só a camada Codex. Sem `--target`, o launcher pergunta qual
agente instalar ou detecta pelo projeto.

Cada launcher faz instalação e atualização. Se estiver no checkout do plugin, usa o utilitário local;
se for apenas o arquivo do launcher, baixa a versão atual pelo `npx`. Eles perguntam o projeto quando
não são iniciados dentro de um e delegam todo o trabalho ao mesmo utilitário Node.js.
O launcher não armazena credenciais.
Na configuração do workspace, informe números dos itens detectados e/ou caminhos relativos ou
absolutos adicionais separados por vírgula; os `extraRepos` existentes são preservados.
Em um projeto novo, o launcher pergunta se o `ai-context` deve usar português ou inglês; português
é o padrão. Use `--lang=pt` ou `--lang=en` para escolher sem interação. Índices `ai-context` já
existentes preservam o idioma detectado.

Ele oferece `install`, `update`, `status`, `doctor`, `latest` e `configure`. Pode atualizar a
referência do marketplace, reinstalar a versão selecionada, preparar o projeto atual, mostrar
as versões atual e mais recente e configurar `extraRepos` depois de confirmação. Execute dentro do
projeto; `--project <caminho>` só é necessário ao administrar outro projeto.

## Os hooks

| evento | o que faz | custo |
|---|---|---|
| `PreToolUse` (Grep / Bash) | responde antes do Grep do Claude, de um `grep`/`rg` digitado no Bash do Claude (filtro `if` do hook: sem custo nos outros comandos) ou de um `rg`/`grep` do Codex quando o padrão é um símbolo; anota os arquivos indicados para o `health.mjs` dizer se o agente os usou (Claude) | só quando responde |
| `UserPromptSubmit` (Codex) | confere cada arquivo citado contra o fingerprint próprio no mapa; só injeta contexto se estiver defasado, sem cobertura ou sem verificação possível | sem chamada a modelo; um processo local por prompt |
| `Stop` | Claude avisa quando a sessão fica cara e grava o handoff; Codex apenas registra métricas | **uma vez por sessão** |
| `Stop` | entrega o prompt de retomada, assim que o bloco volátil é preenchido | uma vez por sessão |
| `SessionStart` | lista mapas de contexto e marca os defasados; mostra aviso visível quando há ação necessária | ~175 tokens |
| `SessionStart` | garante a estrutura padrão do `ai-context`, aponta o índice e avisa a primeira configuração | só quando a documentação está habilitada |
| `SessionStart` | diz se a última divisão de sessão ganhou, empatou ou perdeu | só quando houve divisão |
| `SessionStart` | avisa o usuário (não o agente) que há versão nova, com o comando de atualização; lê um cache e o renova com um `git ls-remote --tags` destacado quando tem mais de 24 h | só quando há versão nova; de novo após 7 dias sem atualizar |
| `Stop` | Codex revisa somente as fontes alteradas nesta sessão que estão ligadas a mapas/documentos; fontes antigas do mesmo mapa continuam no relatório global | só para mudanças relevantes da sessão; mesma revisão em cooldown por 24h |
| `Stop` | avisa se você editou A e não tocou em B, que muda junto historicamente | só quando ocorre |
| `Stop` (Claude) | aponta código editado depois do último teste, com testes relacionados e o comando de teste | **uma vez por sessão**; calado sem estrutura de teste |
| `Stop` | sessão que só **leu** código (sem editar código), 3 arquivos ou mais em 2+ pastas sem mapa nem documento `ai-context`, recebe uma linha sugerindo ao usuário pedir o registro do fluxo; offline, pela transcrição local do host, nunca escreve nada | **uma vez por sessão**; lê só os bytes que a transcrição ganhou desde o `Stop` anterior |

Toda mensagem de hook passa por um ponto único de deduplicação: o mesmo (evento, sessão, texto) é
entregue uma vez a cada 90 s, então plugin mais cópia standalone — ou um hook registrado duas
vezes — não dobra o contexto. `CONTEXT_TOOLS_HOOK_DEDUPE=0` desliga.

### Caminhos e comandos protegidos

Não existe hook de proteção, de propósito. Um `PreToolUse` em todo Edit e Bash custaria uma
partida de Node (~130 ms) por chamada em todo projeto, e o Claude Code já faz isso nativamente, sem
custo, pelas `permissions` do `.claude/settings.json`:

```json
{ "permissions": { "deny": ["Edit(legacy/**)", "Bash(git push --force:*)"], "ask": ["Bash(git reset --hard:*)"] } }
```

Quando um handoff lista algo que "não pode ser repetido nem desfeito", transformar isso numa dessas
regras faz a restrição valer de verdade, em vez de depender de memória.

### O `PreToolUse` é o único ponto em que a ferramenta chega sozinha

As demais entradas são **pull**: alguém precisa lembrar de chamá-las, e depender de hábito é
frágil. O `PreToolUse` inverte isso para **push** — quando o padrão do Grep tem cara de símbolo
(`processIncomingMessage`, `parseA|parseB`), a definição chega antes do Grep rodar.

Dimensionado no histórico real de um workspace (68 sessões, 15.612 chamadas de ferramenta):
**649 dos 1.633 Greps — 40% — procuram algo com cara de símbolo.** Interceptar `Read` de arquivo
grande também foi avaliado e **descartado por medição**: só 25 de 3.690 leituras (1%) seriam
candidatas, e não paga o custo de rodar em toda leitura.

E foi **validado retroativamente**, sem esperar uso: cada um dos 649 Greps históricos foi
reproduzido contra o índice, e comparado com o que o agente fez em seguida.

| | |
|---|---|
| o hook teria respondido | **309 (48% dos 649)** |
| desses, apontou o arquivo que o agente abriu nas 6 chamadas seguintes | **183 (59%)** |

São **183 de 1.633 Greps (11%)** em que a resposta certa estaria disponível antes da busca. O número
é um **piso**: o índice reflete o código de hoje, então símbolo renomeado ou removido desde o Grep
conta como "não teria respondido". E ele mede **disponibilidade da resposta**, não economia
garantida — se o agente aproveita, isso só o uso diz.

Ele **nunca bloqueia**: o Grep roda de qualquer jeito, isto é contexto a mais. E cala mais do que
fala — sem acerto, com acertos demais (aí o Grep é melhor), em busca textual com metacaractere, em
nome curto demais, ou se já tiver respondido aquilo na sessão.

**O que ele custa, medido e sem maquiagem:** ~180 ms por Grep, dos quais **128 ms são a partida do
Node** — piso de qualquer hook, que nenhuma otimização alcança. Os módulos pesados só carregam
depois que o padrão passa no teste de "cara de símbolo", o que devolve ~10 ms nos ~60% de Greps
descartados. Num projeto que o índice não consegue ler, esses 180 ms são desperdício puro: quem
não quiser pagar remove a linha do `PreToolUse` do `settings.json` — as outras ferramentas
seguem funcionando.

O hook legado do Claude e os relatórios globais usam `HEAD`/`verified_at` para encontrar alterações,
inclusive commits feitos durante a sessão. No Codex, a atribuição automática do `Stop` usa outro
caminho: observa chamadas explícitas de escrita e confere os hashes resultantes. Isso importa num
workspace compartilhado, onde um diff não identifica qual janela do Codex fez a edição.

O detector encontra mapas defasados, mapas sem metadados e código alterado sem documentação relacionada.
No Codex, esses achados iniciam uma única continuação automática por turno: o agente confere as fontes,
atualiza o mapa/documento quando houver evidência suficiente e só então registra a revisão. O script
calcula SHA-256 local dos arquivos cobertos/referenciados. Depois de uma referência legada limpa, salva
um baseline local; mudanças de `mtime` sem mudança de conteúdo deixam de disparar revisão, e alterações
que preservam o `mtime` passam a ser detectadas. A revisão fornece `source_fingerprints` apenas das
fontes efetivamente conferidas. O `source_digest` agregado só é atualizado quando os fingerprints por
fonte cobrem todas as fontes atuais; irmãs antigas continuam no relatório global de saúde até serem
revisadas. O hook nunca inventa conteúdo semântico. A fila identifica documento e versão exata,
independentemente da ordem dos lotes. Versões novas podem abrir outra revisão; um relatório vazio
nunca comprova conclusão. Pendências incompletas ficam adiadas, sem prompts automáticos repetidos.
Somente metadados explícitos que correspondem às fontes atuais confirmam a revisão.

O Stop usa o turno atual e o último autor confirmado. Retomar o chat inicia uma nova época;
retornar aos bytes antigos não devolve autoria a um chat antigo. Edições sobrepostas são ambíguas.
Bash pode declarar alvos pelo `tracked-edit.mjs`; comandos comuns ficam na auditoria global/manual.
Somente caminhos do projeto e extraRepos configurados são aceitos, com validação de symlinks.
Stop sem fontes atribuídas termina antes de descobrir ou calcular hashes das referências documentais.
Coletores ativos compartilham cache por execução; prompts contêm itens completos, com consulta CLI
para manifestos extensos. Sincronizar digest com fingerprints completos é offline e não inventa data
de revisão. Atualizar fatos continua exigindo inspeção. Claude preserva seu baseline existente.

O preflight Codex `UserPromptSubmit` lê o prompt atual em memória e procura caminhos ou nomes de arquivos
citados explicitamente. Calcula hashes localmente, sem chamar modelo ou rede, e não grava o texto do prompt. Se o
arquivo tem mapa atualizado, não injeta nada, mesmo que outra fonte do mesmo mapa esteja defasada. Uma fonte
citada defasada, sem cobertura ou impossível de verificar
gera uma nota curta antes do trabalho. Prompt sem nome explícito segue em silêncio; o processo local ainda
tem um pequeno custo de inicialização e leitura de arquivos.

### Quando o hook sugere um mapa (e por que ele cala tanto)

Ele não distingue "esqueceram de mapear" de "decidiram não mapear", e a assimetria entre os dois
erros é grande:

> Deixar de sugerir um mapa custa uma sugestão perdida — você cria depois, quando quiser.
> Insistir num arquivo que nunca será mapeado ensina a ignorar a categoria inteira, e aí os avisos
> **certos** somem junto.

Por isso o padrão usa exclusões embutidas (`*.config.*`, `*.test.*`, `*.d.ts`, `__mocks__/`,
`*.generated.*`) e `intentionallyUnmapped` como escotilha manual. Um único arquivo pode ser sinalizado;
o agente decide se aquela área merece mapa com base na evidência e no contexto do projeto.

---

## Configuração

Nenhuma é necessária. Detecta raiz, layout (repo único ou workspace multi-repo) e pastas de doc.
Para fugir da convenção, `.claude/context-tools.json`:

```json
{
  "sourceDirs": ["packages/core/src", "packages/api/src"],
  "coupling": { "since": "6 months ago", "minTogether": 3, "warnConfidence": 0.7 },
  "contextMaps": { "intentionallyUnmapped": ["scripts/legacy/"] },
  "claudeMdHint": false,
  "extraRepos": ["../AppConnection", "../shared"],
  "verify": { "command": "npm run test:unit", "testPatterns": ["make check"] }
}
```

`verify.command` substitui o comando de teste detectado; `verify.testPatterns` acrescenta comandos que
contam como teste; `verify.enabled: false` desliga o aviso do `Stop`.

### Documentação operacional

A documentação operacional fica habilitada por padrão. Em um projeto novo, o hook cria de forma
idempotente apenas o esqueleto padrão, sem inventar regras:

```text
ai-context/
├── 00-indice.md
├── features/
├── telas/
├── decisoes/
├── integracoes/
└── banco/
```

O idioma físico segue `lang` (`pt` ou `en`). As categorias lógicas são fixas; apenas seus nomes
físicos e o índice são localizados. Para desligar a feature em um projeto:

```json
{
  "documentation": {
    "enabled": false
  }
}
```

O diretório raiz pode ser configurado, mas a estrutura interna não:

```json
{
  "lang": "pt",
  "updateCheck": true,
  "documentation": {
    "enabled": true,
    "autoInit": true,
    "captureHint": true,
    "root": "ai-context"
  }
}
```

`captureHint: false` desliga a sugestão para sessões que só leram código. Vem ligada porque só mostra
uma linha ao usuário (`systemMessage` no Claude e no Codex); o agente nunca é instruído a agir sobre ela.

`updateCheck: false` (ou `CONTEXT_TOOLS_UPDATE_CHECK=0` para todos os projetos) desliga a verificação
de versão nova, a única chamada de rede dos hooks. Ela também fica desligada sempre que `CI` existe.

Comandos disponíveis:

```text
context-docs init
context-docs create --type feature --name credito-cliente
context-docs status
context-docs audit
```

`init` e `create` criam somente estrutura ou template. O agente deve investigar e preencher o
conteúdo semântico. Documentos existentes nunca são sobrescritos, e `A mapear` nunca é promovido
automaticamente a regra confirmada.

> Este próprio repositório **não tem** `context-tools.json` — os padrões dão conta.

**`claudeMdHint`**: se o projeto já tem um `CLAUDE.md`, o plugin anexa a ele — uma vez só,
nunca de novo — uma nota curta sugerindo tentar `context-tools` antes de abrir um subagente de
exploração ampla para perguntas de "onde X está definido". Existe porque o Claude, por padrão,
tende a delegar busca exploratória a um subagente sem cogitar se há um skill instalado que
resolveria mais barato — e um subagente devolve só uma síntese, então mesmo quando o hook
`PreToolUse` dispara (ele dispara também dentro de subagentes), a informação pode não chegar de
volta. `false` desliga; não cria `CLAUDE.md` que o projeto não tinha, só anexa ao existente.

**`codexMdHint`**: equivalente para um `AGENTS.md` existente quando o hook roda no Codex. O
bloco é escolhido em português ou inglês observando o próprio arquivo; `lang` explícito continua
tendo precedência. O texto deixa claro que as regras existentes permanecem como autoridade e usa
o caminho de navegação do host (`.codex/scripts/`). `false` desliga a alteração.

**`extraRepos`**: inclui repo(s) irmão(s) da raiz no índice, mesmo sem `.git` próprio — para o
caso em que a raiz PRECISA continuar sendo um projeto específico (workspace pai tem dezenas de
outros projetos que não interessam), então nem "reabrir a sessão na pasta pai" nem o fallback
automático de workspace misto resolvem. Caminhos relativos à raiz, restritos à subárvore da
pasta PAI da raiz — `../vizinho` é aceito, `../../mais-fundo` é recusado (mesma lógica de
`sourceDirs` proibir sair do projeto, só que invertida: aqui sair é o ponto, mas com limite).
Sem configurar nada, deriva sozinho de um `.code-workspace` do VS Code (na raiz ou na pasta
pai) — `extraRepos: []` explícito desliga essa detecção automática. O projeto raiz continua
sempre no índice, inclusive quando não tem `.git` e usa `extraRepos` explícito; os irmãos nunca
substituem o projeto analisado.

**Idioma**: o fallback da biblioteca é inglês. O instalador guiado grava português por padrão em
projetos novos; use `--lang=en` ou `{ "lang": "en" }` (por projeto) para escolher inglês.
`CONTEXT_TOOLS_LANG=pt` continua disponível para execuções pontuais. Sem escolha explícita, índices
existentes são detectados e, caso contrário, o fallback é inglês em vez de quebrar — mensagem em
idioma inesperado é irritante; erro no meio de um hook é pior.
Para os hints de `CLAUDE.md` e `AGENTS.md`, o idioma do próprio arquivo tem precedência quando a
configuração não é explícita, evitando inserir texto em inglês num projeto documentado em português.

## Instalado onde ele não serve

Um plugin pode acabar num projeto sem git, ou numa linguagem que ele não lê, ou numa pasta vazia.
A regra é: **continuar ajudando quando pode, e não atrapalhar quando não pode** — o que inclui não
quebrar, não mentir e não cobrar caro por nada. Verificado montando esses ambientes:

| situação | o que acontece |
|---|---|
| **sem git** | `symbols` e `audit-docs` funcionam (só precisam dos arquivos). `why` continua **dizendo** que não há histórico e nunca finge resposta — não existe substituto para "por que esta linha é assim" sem commit de verdade. `coupling` usa edições atribuídas à sessão no Codex e mantém o snapshot atual no Claude. Os dois apontam o remédio: `git init` local, sem remoto. A atualização global dos mapas ainda usa **mtime** em vez de `git diff`; a atribuição do `Stop` Codex usa o diário explícito de escritas. Ver abaixo |
| **linguagem não lida** (Ruby, C#…) | diz quantos arquivos achou, **qual** extensão, e que mexer em `--root` **não** vai resolver — a causa é a linguagem. Hooks mudos |
| **pasta vazia / só dados** | o remédio de configuração, que aí é o correto. Nenhum ruído |
| **diretório de estado do host sem permissão de escrita** | responde normalmente, só não cacheia |
| **duas sessões no mesmo repo** | gravação atômica (temporário + rename). Testado com 8 processos simultâneos: todos corretos, cache íntegro |

Nada disso derruba nem atrasa: no pior caso todos os scripts saem com status 0 em menos de 250 ms.

### O fallback de mtime nos hooks de mapa, e por que continua honesto

Sem git, `verified_at` não pode ser um commit-ish — não há o que resolver contra. Então num repo
sem `.git` em lugar nenhum, ele é lido como **data** (`2026-08-01`, ou timestamp ISO completo): o
hook de mapa compara o mtime de cada arquivo coberto contra essa data, inclusive no `Stop`, para
que uma pendência antiga continue detectável em sessões futuras. Arquivo escrito depois de
`verified_at` conta como mudado.

É um sinal estritamente mais fraco que `git diff`, e a ferramenta diz isso **na própria mensagem**,
toda vez: um `touch` sem mudar conteúdo parece idêntico a uma edição real, e uma escrita que por
acaso preserva o mtime original (raro — um `cp -p`, restauração de backup) passaria despercebida.
Nenhum dos dois modos de falha é silencioso — o rodapé nomeia a troca, e nomeia o remédio: `git
init` local, sem remoto, totalmente reversível com `rm -rf .git`. `why` continua recusando o
substituto por inteiro, porque não existe equivalente de mtime para "por que esta linha é assim" —
essa pergunta precisa de histórico de commit de verdade, não de um único timestamp, e inventar um
violaria a regra que este plugin inteiro existe para manter: nunca responder com confiança quando a
resposta honesta é "não dá para saber".

`coupling` segue outro caminho, porque correlação de co-mudança sobrevive a uma cesta mais grossa:
sem git ele troca o commit pela **sessão inteira** (todo arquivo tocado entre `SessionStart` e
`Stop`, gravado no diretório de estado do host — `.claude/` no Claude ou `.codex/context-tools/`
no Codex) e roda exatamente a mesma matemática de
confiança em cima disso. Ele diz isso em toda linha — "nenhum repositório git", quantas sessões
sustentam o número — e abaixo de `minSessions` (5 por padrão) responde "ainda não sei" em vez de
"nenhum acoplamento", porque são afirmações diferentes e só uma delas tem medição de verdade atrás.

Um detalhe pequeno que virou teste: a mensagem de "não leio essa linguagem" **já mentiu** — Python e
Go entraram no índice e o texto seguiu listando só as extensões antigas, ou seja, o diagnóstico
negava ler a linguagem que acabara de passar a ler. A lista agora é gerada da fonte única, e há
teste garantindo que toda extensão suportada apareça. Numa ferramenta cuja tese é "falha visível",
errar na própria mensagem de falha é o pior lugar possível.

## Segurança

Os hooks injetam texto **direto no contexto do modelo**, e boa parte desse texto vem do repositório
(o `area:` do frontmatter, nomes de pasta, caminhos que o git devolve). Num repo clonado,
contribuído ou vindo de dependência, isso é **entrada não confiável** — e essa foi a raiz de quatro
das seis falhas já corrigidas aqui:

- **escrita arbitrária de arquivo** via `verified_at: --output=…` (o git interpreta a opção antes do
  `--`) — corrigida em dois pontos; todo valor que vá para a linha de comando antes do `--` passa
  por validação de ref;
- **travessia de caminho** por `sourceDirs: ["../vizinho"]`, que fazia o índice ler outro projeto;
- **inundação de contexto**: 9.000 caracteres no `area:` viravam 14× o tamanho do bloco injetado;
- **caractere de controle e ANSI** vindos do repo chegando ao contexto.

Toda chamada externa usa `execFileSync` com array de argumentos — nunca shell: um caminho com `;` ou
`$(…)` é argumento, jamais comando. O índice também **não sai do repositório**: link de pasta
(symlink ou junction) não é seguido, e há teste que cria o link de verdade e prova os dois lados.

O bloco injetado avisa explicitamente que os nomes vindos do repositório são **dados, não
instruções**.

## Testes

```bash
npm test
```

A suíte de testes não tem dependências (usa `node --test`) e roda em 3 sistemas operacionais × Node 18 e 22.
Cobrem os parsers de cada linguagem, o `bareName`, as exclusões de mapa, as heurísticas da
auditoria, a superfície de segurança acima e — o mais importante — **os seis cenários em que o cache
poderia mentir**.

Há também um teste de **recall**: ele lista os padrões de declaração que o índice precisa achar e
falha nomeando os que perdeu. É a métrica que diz se vale adicionar regex nova ao parser — medir
antes de codar evita inchar o parser com padrão que ninguém usa.

## A regra que vale mais que as ferramentas

🚫 **Nunca escreva `arquivo:linha` em documentação.**

Numa auditoria real, das 13 referências `símbolo @ arquivo:linha` conferidas contra o código,
**nenhuma estava certa**. A pior errava por 2.861 linhas. Nenhum símbolo havia sumido — só os
números apodreceram.

Cite o símbolo; a linha se resolve na hora com `symbols`/`outline`.

### A segunda regra, aprendida do jeito caro

🚫 **Toda lista que descreve o mesmo fato em dois lugares é bug esperando a data.**

Num único dia, **quatro** dessas derivaram neste repositório — e as quatro falharam em silêncio,
que é o modo de falha que este plugin inteiro existe para não ter:

| a cópia | o que ela causou |
|---|---|
| extensões do índice, repetidas em `context-maps.mjs` | o aviso de "código sem mapa" ficou **inerte para sempre** em projeto Delphi e Rust; depois, de novo, em Python e Go |
| hooks, repetidos entre `hooks/hooks.json` e `install.mjs` | quem instalava **como plugin** — o caminho recomendado — recebia metade dos hooks |
| arquivos de estado, repetidos em `install.mjs` | `.gitignore` incompleto; dava para commitar um handoff gerado sem perceber |
| `.test.[jt]sx?` no filtro padrão | o filtro nasceu cego para `.test.mjs`, a convenção do próprio repositório |

Nos quatro casos, somar o item que faltava teria consertado o sintoma e deixado a causa viva. O que
sobreviveu foi **apagar a cópia** e derivar do original: `EXTENSOES_CODIGO` em `lib/roots.mjs`,
`hooks/hooks.json`, `.claude/.gitignore`.

A regra prática: **fonte única nova exige teste que prove a derivação**, não que descreva o valor de
hoje. Teste que repete a lista é a quinta cópia.

---

## Limitações conhecidas

- **`symbols` vê definições de topo, métodos de classe e chave de config de primeiro nível** — não
  vê variável local, propriedade aninhada nem coluna de banco fora de arquivo `.sql` (tabelas e
  colunas de `CREATE TABLE`/`ALTER TABLE … ADD` são indexadas). Medido, o ponto cego são ~97.500
  identificadores num workspace de 1.543 arquivos, e as chaves de config cobrem 1.329 deles (1,4%)
  — escolhidos por serem os que se procuram entre arquivos, mas **isso é hipótese: não temos log de
  consultas reais para provar**. Fechar o resto exigiria AST, e aí o custo não é desempenho e sim
  dependência: “zero dependência” aqui é um teste de CI que falha se alguém adicionar um pacote.
  Nos casos que ele não vê, avisa e manda pro Grep.
- **Ruby, Java, C#, PHP e outras não têm parser.** Não é dificuldade, é método: parser novo só entra
  com corpus real para conferir que aponta para a linha certa. Enquanto não entra, o `symbols`
  diagnostica o caso em vez de dizer que o projeto está vazio.
- **Nenhum teste roda o plugin dentro do Claude Code de verdade** — os E2E rodam os scripts como
  processo, com o mesmo contrato de JSON e código de saída, que é o mais próximo possível sem
  automatizar o próprio agente.
- **Sistema de arquivos de rede e WSL não foram testados.** O CI cobre os três sistemas
  operacionais, mas sempre em disco local — e é justamente a granularidade de `mtime` desses
  ambientes que decide se o cache pode ser usado. O número de 20 mil arquivos é simulado, não um
  monorepo real.
- **Identificador de API externa citado num doc vira "símbolo fantasma"** na auditoria. A existência
  é conferida por texto dentro do código do projeto, então nome que existe *em outro lugar* não tem
  como ser distinguido. Erra para o lado de acusar, que é o barato: o contrário esconderia doc podre.

## Fora de escopo — por desenho, não por falta

Resolver cada uma destruiria justamente o que dá valor à ferramenta:

- **`audit-docs` não valida afirmação técnica em prosa.** "O guard X roda antes de Y" exigiria uma
  chamada a LLM, quebrando quatro propriedades de uma vez: funcionar offline, ser determinístico,
  custar zero por execução e não inventar falso positivo.
- **O hook nunca bumpa `verified_at` sozinho.** No Codex, a continuação automática só grava `source_digest` ou atualiza metadados de revisão depois de ler as fontes.
- **O cache confia em mtime+tamanho, nunca em hash de conteúdo.** Hash exigiria LER o arquivo —
  exatamente o custo que o cache existe para evitar.

## Review queue / Fila local de revisão

```bash
node "${PLUGIN_ROOT}/scripts/review.mjs" status --json
node "${PLUGIN_ROOT}/scripts/review.mjs" show --id=ID --json
# After inspecting exact source versions / Após conferir as versões exatas:
node "${PLUGIN_ROOT}/scripts/review.mjs" ack --id=ID --revision=REVISION --reviewed
node "${PLUGIN_ROOT}/scripts/review.mjs" defer --id=ID --reason=insufficient-evidence
node "${PLUGIN_ROOT}/scripts/review.mjs" retry --id=ID
```

`ack --source=CHAVE` permite revisão parcial. O helper preserva fingerprints de outras fontes e
conteúdo existente, recusa alterações concorrentes e mantém UTF-8, BOM, Windows-1252 e UTF-16.
Documentos aceitam `maintenance: live|historical|manual`; decisões são históricas por padrão.
`review_sources: ["./src/a.js"]` declara referências atuais. Opcionalmente
`review_dependencies: [{"source":"./src/a.js","symbols":["function foo"]}]` delimita dependências
por nomes exatos do outline e `dependency_fingerprints` portáveis. Escopos inválidos ou linguagens
sem suporte voltam à comparação do arquivo inteiro e aparecem na saúde. O escopo é um contrato
explicitado pelo autor; o parser não infere todas as dependências semânticas.
Use `tracked-edit.mjs manifest --file=CAMINHO` para obter o token e execute
`node "${PLUGIN_ROOT}/scripts/tracked-edit.mjs" --context-tools-edit=TOKEN -- EXECUTAVEL ARGUMENTOS`.
Declare todos os possíveis alvos; o wrapper não infere comportamento de shell nem recodifica arquivos.

---

## Licença

[MIT](../LICENSE) — Copyright (c) 2026 Luiz Nogueira.
