# Benchmark de resultado — piloto de 2026-10-09

Primeira execução de `scripts/benchmark-outcome.mjs` com os três casos de
[`outcome/cases.pilot.json`](outcome/cases.pilot.json), uma repetição por braço. É um piloto: mostra
que o harness funciona e onde vale uma rodada maior. **Não sustenta conclusão a favor nem contra o
plugin.**

- Plugin: context-tools 2.7.0 (commit da release), carregado só no braço "com" via `--plugin-dir`.
- CLI: Claude Code 2.1.227, modelo padrão do CLI, conta claude.ai. O custo abaixo é o que o CLI
  informa por execução (`total_cost_usd`); numa conta de assinatura ele estima o consumo, não é
  cobrança.
- Comando: `node scripts/benchmark-outcome.mjs --cases=docs/benchmarks/outcome/cases.pilot.json --per-run-cost=3 --max-cost=15`
- Dados brutos, com a resposta final de cada execução: [`outcome/results-2026-10-09.json`](outcome/results-2026-10-09.json).

## Resultado

| braço | resolvidos | custo total | custo mediano | turnos (mediana) | duração (mediana) | tokens de contexto (mediana) |
|---|---:|---:|---:|---:|---:|---:|
| sem | 3/3 | $0.67 | $0.13 | 6 | 16 s | 159.313 |
| com | 2/3 | $0.74 | $0.12 | 5 | 19 s | 128.337 |

| caso | braço | resolvido | custo | turnos | duração | conferência |
|---|---|---|---:|---:|---:|---|
| qa-newtonsoft-maxdepth (C#) | sem | sim | $0.11 | 4 | 16 s | resposta conferiu |
| qa-newtonsoft-maxdepth (C#) | com | **não** | $0.10 | 2 | 12 s | faltou `Push` |
| qa-commons-lang-abbreviate (Java) | sem | sim | $0.13 | 6 | 16 s | resposta conferiu |
| qa-commons-lang-abbreviate (Java) | com | sim | $0.12 | 5 | 19 s | resposta conferiu |
| fix-qualified-lookup (correção aqui) | sem | sim | $0.43 | 13 | 175 s | `exit 0` |
| fix-qualified-lookup (correção aqui) | com | sim | $0.52 | 17 | 292 s | `exit 0` |

## O que dá para ler — e o que não dá

- **A falha do braço "com" foi do agente, não do índice.** A pergunta era onde `JsonReader` impõe a
  profundidade máxima, qual o padrão e qual exceção sai. A resposta, dada em 2 turnos, apontou
  `JsonReader.SetToken` e disse que o padrão em `JsonReader` é `null`. No commit do caso o limite é
  checado em `JsonReader.Push` e o construtor faz `_maxDepth = 64`. O `outline` do 2.7.0 sobre o
  mesmo arquivo lista `JsonReader.Push()` na linha 337 e o construtor na 326, ou seja, a resposta
  certa estava a uma consulta de distância. O harness não registra quais ferramentas o agente chamou,
  então não dá para dizer se ele consultou o índice e leu errado ou se nem consultou.
- **Contexto menor, custo igual.** Nos dois casos de leitura o braço "com" usou menos tokens de
  contexto e custou um pouco menos; na correção, custou mais e levou mais turnos. Com uma repetição
  por braço, essas diferenças estão dentro da variação de uma execução para outra.
- **Ruído no caso de correção.** Os dois braços relataram falhas de teste pré-existentes na cópia
  limpa deste repositório (arquivos de configuração do agente que o caso remove), e ambos
  concluíram que eram alheias à correção. A conferência objetiva (o comando do caso) passou nos dois.

## Segunda rodada, com rastro das ferramentas

Para separar "não consultou" de "consultou e errou", o harness passou a gravar o transcript de cada
execução (`--output-format stream-json`) e a lista de ferramentas chamadas. Mesmo dia, mesmo plugin:
os dois casos de leitura com 3 repetições por braço e o de correção com 2.

| caso | braço | resolvidos | custo total | turnos |
|---|---|---:|---:|---|
| qa-newtonsoft-maxdepth | sem | 3/3 | $0.34 | 4, 2, 3 |
| qa-newtonsoft-maxdepth | com | 3/3 | $0.29 | 4, 3, 2 |
| qa-commons-lang-abbreviate | sem | 3/3 | $0.42 | 5, 5, 6 |
| qa-commons-lang-abbreviate | com | 3/3 | $0.40 | 4, 5, 4 |
| fix-qualified-lookup | sem | 2/2 | $1.03 | 12, 21 |
| fix-qualified-lookup | com | 2/2 | $0.91 | 13, 13 |

Somando as duas rodadas: sem o plugin, 11/11; com o plugin, 10/11. A falha do piloto não se repetiu, e
o custo extra do caso de correção também não. O que os rastros mostram:

- **Em nenhuma execução o agente chamou a skill ou o `ct.mjs`.** Tudo o que o plugin entregou chegou
  pelos hooks: o pacote de evidências antes do `Grep` e as notas de `SessionStart`.
- **O risco da resposta errada é o Grep sem contexto.** Nos casos de leitura, o agente costuma
  responder depois de um único `Grep`, que devolve linhas soltas (`356: if (_maxDepth != null && …`)
  sem o método que as contém. Quando ele não abre o arquivo, o nome do método é inferido — e no
  piloto foi inferido errado.
- **O pacote de evidências pode puxar para a resposta errada.** Para `MaxDepth`, ele lista as
  propriedades `MaxDepth`, testes e, em destaque, `JsonSerializerSettings.DefaultMaxDepth` — a
  mesma constante que a resposta errada do piloto apontou como origem do padrão.
- **Num repositório novo, o `SessionStart` cria `ai-context/` e manda ler o índice**, que acabou de
  ser criado vazio: arquivos escritos no projeto durante uma pergunta de leitura, e uma instrução
  sem nada útil por trás.
- **O caso de correção gasta de 3 a 8 turnos descobrindo como rodar os testes** (`node --test
  tests/`, `cat package.json`, rodar de novo filtrando a saída), nos dois braços. O plugin conhece o
  comando de teste do projeto, mas só o informa no `Stop`.
- **Os casos são fáceis demais para mostrar diferença**: os dois braços resolvem quase tudo. Uma
  rodada que mostre ganho precisa de casos onde o agente sem o plugin tropeça — arquivos grandes,
  nomes ambíguos, "quem usa X" num repositório grande — e de pelo menos 5 repetições por braço.

## O que mudou por causa disso

Corrigido logo depois (ver *Unreleased* no [CHANGELOG](../../CHANGELOG.md)), todos nos hooks — o
único canal que de fato chegou ao agente:

- depois de um Grep com número de linha, um hook diz em qual função/método/classe cai cada linha;
- o `SessionStart` informa o comando de teste e como rodar um arquivo só;
- índice de `ai-context` sem documentos deixa de ser "leia antes de explorar";
- o pacote de evidências põe código de produção antes de teste e nome exato antes de parcial;
- o harness grava o transcript e as ferramentas de cada execução.

O efeito dessas mudanças ainda não foi medido: é o objetivo da próxima rodada.
