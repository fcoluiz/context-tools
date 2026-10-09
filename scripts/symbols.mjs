#!/usr/bin/env node
// 🔎 Índice de símbolos CROSS-FILE — "onde X está definido?" em uma chamada.
//
// Grep devolve toda MENÇÃO (dezenas). Isto devolve a DEFINIÇÃO. Gerado na hora
// (~0,5s para 1.500 arquivos, cache do SO quente) ⇒ sem cache, sem defasagem possível.
//
// Uso:
//   symbols.mjs <nome>            → onde está definido (regex, case-insensitive)
//   symbols.mjs <a> <b> <c>       → vários de uma vez: índice construído UMA vez só
//   symbols.mjs <nome> --all      → inclui correspondências parciais
//   symbols.mjs --stats           → tamanho do índice e como ele foi obtido
//   symbols.mjs ... --fresh       → ignora cache e reconstrói (escotilha, sempre disponível)
//   symbols.mjs ... --root=<dir>  → força a raiz (senão: CLAUDE_PROJECT_DIR, cwd, ou o repo acima)
//
// Por que lote: o custo é construir o índice (~0,5s), não consultar (<1ms). Uma chamada por
// símbolo pagava esse custo N vezes — medido: 3 símbolos em 3 chamadas = ~1,4s; em lote = ~0,5s.
//
// Se não achar símbolo, tenta NOME DE ARQUIVO antes de desistir: medição de 10 buscas reais
// mostrou 2 falhas, ambas em nome de módulo (`paymentService` existe como arquivo, não como
// símbolo) — cada falha dessas custava um round-trip inteiro. O arquivo é rotulado como
// ARQUIVO, nunca como definição: 92,9% dos basenames são únicos, mas confundir os dois
// mandaria o Read pro lugar errado.
//
// Se não achar nada, DIZ que não achou e manda pro Grep — nunca devolve vazio com cara de resposta.

import { readFileSync, writeFileSync, statSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoot, findRepos, resolveSourceDirs, rootFiles, walk, relPath, safe, loadConfig, isMain, lerTexto, INDEX_RE, EXTENSOES_LIDAS, EXTENSOES_INDICE, EXTENSOES_HISTORICO, stateDir, sanitizeModelText } from './lib/roots.mjs';
import { parserForExt } from './outline.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { loadSnapshot, saveSnapshot } from './lib/snapshot.mjs';
import { recordMetric } from './lib/telemetry.mjs';

// `.dfm`/`.fmx` ficam DE FORA do índice cross-file de propósito: nome de componente de
// formulário (`Button1`, `Panel2`, `Label3`) é genérico e repetido em todo formulário do
// projeto — afogaria a busca por símbolo de verdade. Para navegar um formulário, use
// `outline.mjs <arquivo.dfm>`, que os suporta.
// `CODE_RE` e a lista de extensões vêm de `lib/roots.mjs` — fonte única, ver o comentário lá.

// ---------------------------------------------------------------------------
// Dois tiers, escolhidos automaticamente pela contagem de arquivos.
//
// Tier A (padrão, projeto pequeno/médio): reconstrói tudo, sem cache. Nada cacheado ⇒
//   nada pode defasar. É a garantia que sustenta a confiança na ferramenta.
// Tier B (acima do limiar): cache com invalidação por mtime+tamanho.
//
// O limiar NÃO é um ponto de equilíbrio de desempenho — medido, o cache vence em TODO
// tamanho, inclusive nos menores (2026-08-04, rebuild × cache quente, Windows/NTFS):
//   cobra 36 arq: 92 ms → 19 ms  ·  flask 83: 145 ms → 26 ms  ·  679: 963 ms → 77 ms
//   864: 1.097 ms → 83 ms  ·  prometheus 974: 1.794 ms → 142 ms  ·  1.543: 1.752 ms → 130 ms
// Não existe cruzamento. O limiar é, portanto, um botão de RISCO, não de velocidade: abaixo
// dele o que se compra com o rebuild é a certeza de que nada pode defasar, nem em teoria.
//
// Onde colocá-lo é escolha de valor, e a régua usada foi o GANHO ABSOLUTO: abaixo de ~300
// arquivos economiza-se ~100 ms, que não paga abrir mão da certeza; a partir daí a conta
// vira 0,9-1,7 s POR CHAMADA, e aí paga. O valor antigo (2.000) foi escolhido supondo que
// o custo abaixo dele fosse "milissegundos" — medido, era 1,75 s no workspace real que
// motivou a ferramenta, todo dia, em toda consulta.
//
// Degradação em escala grande, medida antes: 1.517 arq → 657 ms · 5.000 → 1.859 ms ·
//   20.000 → 17.809 ms. É SUPERLINEAR — o custo é abrir arquivo, não ler bytes.
//
// Por que mtime+tamanho é seguro: NTFS tem granularidade de 100 ns, ext4/APFS de ns.
//   Arquivo alterado com o MESMO tamanho E o MESMO mtime ao nanossegundo é, na prática,
//   impossível. O par (não só mtime) cobre ainda mount de rede com relógio grosseiro — e
//   quando o FS não prova frescor, `mtimeGranularityIsFine` RECUSA o cache e diz na saída.
// ---------------------------------------------------------------------------
const CACHE_TIER_MIN_FILES = 300;
// 2: entradas passaram a guardar o fim do símbolo além do início.
const CACHE_FORMAT = 2;

const cachePath = (root) => join(stateDir(root), '.symbols-cache.json');

/**
 * Assinatura do parser. O parser real vive em outline.mjs — se aquele arquivo mudar,
 * todo símbolo cacheado passa a ser suspeito e o cache inteiro é descartado.
 * Automático de propósito: depender de alguém lembrar de subir um número à mão é
 * exatamente o tipo de defasagem silenciosa que esta ferramenta existe para evitar.
 */
function parserSignature() {
  const p = safe(() => fileURLToPath(new URL('./outline.mjs', import.meta.url)), null);
  const s = p ? safe(() => statSync(p), null) : null;
  return s ? `${s.mtimeMs}:${s.size}` : 'unknown';
}

/**
 * O cache prova frescor por `mtime`+tamanho. Isso só é seguro se o relógio do sistema de
 * arquivos tiver resolução fina: num FS de granularidade de 1 segundo, editar um arquivo
 * mantendo o mesmo tamanho dentro do mesmo segundo passaria despercebido — e o índice
 * mentiria, que é o único erro que esta ferramenta não pode cometer.
 *
 * Em vez de assumir, MEDE: grava um arquivo temporário no MESMO sistema de arquivos do
 * projeto (temp do SO pode ser outro volume, com outra granularidade) e vê se o mtime tem
 * fração de segundo. Custa ~1 ms e roda no máximo uma vez por processo.
 *
 * Falha ao sondar ⇒ trata como grosseiro e NÃO cacheia. Se não dá para escrever a sonda,
 * também não daria para escrever o cache — negar é consistente e seguro.
 */
let _granularidadeFina = null;
function mtimeGranularityIsFine(root) {
  if (_granularidadeFina !== null) return _granularidadeFina;
  _granularidadeFina = safe(() => {
    const dir = stateDir(root);
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.mtime-probe-${process.pid}`);
    let fina = false;
    try {
      for (let i = 0; i < 3 && !fina; i++) {
        writeFileSync(probe, String(i));
        if (statSync(probe).mtimeMs % 1000 !== 0) fina = true;
      }
    } finally {
      safe(() => unlinkSync(probe), null);
    }
    return fina;
  }, false);
  return _granularidadeFina;
}

function loadCache(root, parser) {
  const raw = safe(() => readFileSync(cachePath(root), 'utf8'), null);
  if (!raw) return null;
  const c = safe(() => JSON.parse(raw), null);
  // `root` entra na validação: cache copiado junto com a pasta .claude para outro
  // projeto apontaria símbolos para caminhos que não existem lá.
  if (!c || c.format !== CACHE_FORMAT || c.parser !== parser || c.root !== root) return null;
  return (c.entries && typeof c.entries === 'object') ? c.entries : null;
}

/**
 * Teto do arquivo de cache. Existe porque o cache cresce com o projeto sem nada o limitar:
 * ~6 MB em 20 mil arquivos, e nada impediria dezenas de MB num monorepo gigante — dentro da
 * pasta `.claude` do usuário, que ele não pediu para encher. Passou do teto, não grava e diz
 * por quê: reconstruir todo dia é ruim, mas ocupar disco sem avisar é pior.
 */
const CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Grava o cache de forma ATÔMICA: escreve num temporário e renomeia.
 *
 * `writeFileSync` direto não é atômico — o arquivo fica truncado e visível enquanto grava. Duas
 * sessões do Claude no mesmo repo (caso comum) podiam fazer uma ler o que a outra estava
 * escrevendo. O JSON truncado seria recusado e viraria rebuild, então nunca houve risco de
 * resposta errada; o custo era trabalho jogado fora. `rename` no mesmo volume é atômico: quem
 * lê vê a versão antiga inteira ou a nova inteira, nunca meio arquivo.
 */
function saveCache(root, parser, entries) {
  const payload = safe(() => JSON.stringify({ format: CACHE_FORMAT, parser, root, entries }), null);
  if (payload === null) return { ok: false, motivo: 'serializacao' };
  if (payload.length > CACHE_MAX_BYTES) return { ok: false, motivo: 'tamanho', bytes: payload.length };

  const dir = stateDir(root);
  safe(() => mkdirSync(dir, { recursive: true }), null);
  // PID no nome: duas sessões gravando ao mesmo tempo usam temporários diferentes e nenhuma
  // corrompe a da outra — a última a renomear vence, e ambas as versões são íntegras.
  const tmp = join(dir, `.symbols-cache.${process.pid}.tmp`);
  const ok = safe(() => {
    writeFileSync(tmp, payload);
    renameSync(tmp, cachePath(root));
    return true;
  }, false);
  if (!ok) safe(() => unlinkSync(tmp), null);   // não deixa lixo se falhar no meio
  return { ok };
}

/**
 * Onde cada símbolo TERMINA. Não é estimativa: é a linha em que começa o próximo símbolo de
 * nível igual ou superior (para o último, o fim do arquivo). Respeitar `depth` é o que faz uma
 * classe abranger seus métodos em vez de parar no primeiro deles.
 *
 * Por que importa mais do que parece: medição de 5.985 símbolos reais deste workspace —
 * mediana de **16 linhas**, p75 de 38. Sem o fim, quem recebe `arquivo.js:274` tem que chutar
 * quanto ler, e o chute usual (40 linhas) desperdiça ~2,5× no caso mediano. Com o intervalo, a
 * leitura seguinte é exata.
 *
 * O erro possível é incluir comentário ou linha em branco ENTRE dois símbolos — ou seja, ler
 * um pouco a mais. Nunca ler a menos, que cortaria o fim da função.
 */
function comIntervalos(syms, totalLinhas) {
  return syms.map((s, i) => {
    // Parser que conhece o fechamento de verdade (C#, Java, PHP: a `}` do corpo) informa `end`;
    // os demais continuam fechando no próximo símbolo de nível igual ou superior.
    if (Number.isInteger(s.end) && s.end >= s.line) return [s.line, s.name, s.end];
    let fim = totalLinhas;
    for (let j = i + 1; j < syms.length; j++) {
      if (syms[j].depth <= s.depth) { fim = syms[j].line - 1; break; }
    }
    return [s.line, s.name, Math.max(s.line, fim)];
  });
}

/** Lê e extrai símbolos, no formato compacto do cache: [[linha, tipo, fim], …]. */
function parseFile(f) {
  const parser = parserForExt(extname(f));
  if (!parser) return [];
  if (parser.maxBytes && safe(() => statSync(f).size, 0) > parser.maxBytes) return [];
  const content = lerTexto(f);
  if (content === null) return [];
  const linhas = content.split('\n');
  return comIntervalos(parser(linhas), linhas.length);
}

/**
 * Nome pesquisável a partir do rótulo do símbolo. Precisa cobrir JS e Pascal:
 *   `async foo()`            → foo
 *   `class TFoo`             → TFoo
 *   `procedure TFoo.Bar`     → Bar   (indexa pelo método, que é o que se procura;
 *                                     o rótulo completo continua aparecendo na saída)
 */
// `Classe.Metodo` → `Metodo`: como Pascal guarda o método qualificado pela classe
// (`procedure TPedido.Confirmar`), tanto a INDEXAÇÃO (`bareName`, abaixo) quanto a
// CONSULTA (`reportOne`) precisam tirar o mesmo prefixo — senão buscar `TPedido.Confirmar`
// não casa com nada, porque o índice só guarda `Confirmar`. Extraído para as duas pontas
// nunca desalinharem.
const QUALIFICADOR_RE = /^[A-Za-z_]\w*\.(?=[A-Za-z_])/;

function bareName(kind) {
  // Rust: nas duas formas de `impl` o que se procura é o TIPO, não o trait.
  //   `impl Foo`              → Foo
  //   `impl Display for Foo`  → Foo
  const impl = kind.match(/^impl\s+(?:.*\s+for\s+)?([A-Za-z_][\w]*)/);
  if (impl) return impl[1];
  // Caso de teste: o nome pesquisável é a DESCRIÇÃO inteira, devolvida antes das limpezas
  // genéricas abaixo. Elas são feitas para identificador e estragariam uma frase — `.replace`
  // do `^Ident.` transformaria o teste "montar.prompt preserva o bloco" em "prompt preserva o
  // bloco", e o `()` final sumiria de um teste que cita uma função. Como a busca casa parcial e
  // sem caixa, a frase inteira é o que faz `symbols.mjs instalador` achar o teste do instalador.
  if (kind.startsWith('test ')) return kind.slice(5);
  return kind
    .replace(/^(async |static |get |set |class |const |function |type |enum |fn |struct |trait |union |mod |macro |procedure |constructor |destructor |property |record |interface |object |unit |program |library |def |func |var |package |key |table |view |column |trigger |index |sequence |domain |event |delegate |annotation )+/gi, '')
    .replace(/\(\)$/, '')
    .replace(QUALIFICADOR_RE, '');
}

/**
 * Diagnóstico do caso "0 arquivos indexáveis": o que EXISTE ali que o índice não fala?
 *
 * Só roda no caminho de falha, então pode varrer à vontade — mas devolve `total:0` sem
 * inventar nada se a pasta estiver mesmo vazia, porque aí o remédio é outro (root/sourceDirs).
 */
function extensoesNaoSuportadas(root, cfg) {
  const contagem = new Map();
  let total = 0;
  for (const repo of findRepos(root, { requireGit: false, cfg })) {
    const arquivos = [];
    for (const d of resolveSourceDirs(repo.path, cfg)) walk(d, /\.[A-Za-z0-9]{1,10}$/, arquivos);
    if (!cfg.sourceDirs) for (const f of rootFiles(repo.path, /\.[A-Za-z0-9]{1,10}$/)) arquivos.push(f);
    for (const f of arquivos) {
      const ext = (f.match(/\.[A-Za-z0-9]{1,10}$/) || [''])[0].toLowerCase();
      if (!ext) continue;
      contagem.set(ext, (contagem.get(ext) || 0) + 1);
      total++;
    }
  }
  const list = [...contagem.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([e, n]) => `${e} (${n})`).join(', ');
  return { total, list };
}

function buildIndex(root, cfg, opts = {}) {
  const files = [];
  const truncados = [];
  const repoNomes = [];
  // requireGit:false — symbols só precisa dos ARQUIVOS; projeto sem versionamento funciona.
  // `cfg` habilita `extraRepos`: repo irmão declarado explicitamente entra mesmo sem `.git`
  // próprio e mesmo que a raiz não possa simplesmente subir um nível (workspace com muitos
  // outros projetos ao lado, onde abrir a sessão na pasta pai traria ruído demais).
  for (const repo of findRepos(root, { requireGit: false, cfg })) {
    // Nome do repo entra na resposta final (ver `escopoLabel`): o índice só enxerga o que está
    // SOB `root` (`findRepos` não sobe para pastas irmãs sozinho — ver nota de segurança abaixo,
    // `resolveSourceDirs`, e `extraRepos` para a escotilha explícita). Um projeto Delphi real
    // com dependência num repo irmão, referenciada
    // só por caminho relativo no `.dpr` (fora de `root`), gerou um "achei" confiante que era de
    // outro módulo qualquer — o índice nunca teve como saber que o repo certo existia. Calar o
    // escopo nesse caso é pior que não responder: dá a MESMA confiança de um acerto de verdade.
    repoNomes.push(repo.name === '.' ? basename(repo.path) : repo.name);
    // resolveSourceDirs recusa entrada de config que aponte para FORA do projeto — era
    // travessia de caminho real: um repo hostil com `sourceDirs: ["../vizinho"]` fazia o
    // índice ler arquivos de outro projeto no disco.
    const dirs = resolveSourceDirs(repo.path, cfg);
    for (const d of dirs) walk(d, INDEX_RE, files, 0, truncados);
    // Arquivos soltos na raiz: redundante quando `dirs` é a própria raiz, mas necessário
    // quando a config fixou `sourceDirs` — a dedupe abaixo cuida da sobreposição.
    if (!cfg.sourceDirs) for (const f of rootFiles(repo.path, INDEX_RE)) files.push(f);
  }

  // Dedupe NÃO é zelo: o mesmo arquivo entrando duas vezes duplicava cada resultado na saída
  // (medido: cobra 61 varridos para 36 reais, 41% de desperdício; gin 29%), comia o teto de
  // 40 acertos com repetição e inflava `fileCount`, que é quem escolhe o tier de cache.
  // Também cobre `sourceDirs: ["src", "src/api"]` na config, que se sobrepõem.
  const vistos = new Set();
  const unicos = files.filter((f) => (vistos.has(f) ? false : vistos.add(f)));
  files.length = 0;
  files.push(...unicos);

  // Tier B exige as três condições: volume justifica, não foi pedido rebuild, e o FS
  // consegue provar frescor. A sonda só roda se as duas primeiras passarem.
  const volumeJustifica = !opts.fresh && files.length >= CACHE_TIER_MIN_FILES;
  const fsConfiavel = volumeJustifica && mtimeGranularityIsFine(root);
  const useCache = volumeJustifica && fsConfiavel;
  const parser = useCache ? parserSignature() : null;
  const cached = useCache ? loadCache(root, parser) : null;
  const entries = useCache ? {} : null;

  const defs = new Map();
  // basename sem extensão → caminhos. Alimenta o fallback de nome de arquivo.
  const byFile = new Map();
  // arquivo → todos os símbolos DELE, na ordem em que aparecem. Alimenta `symbolsIrmaos`
  // (ver `reportOne`): "que outros símbolos deste MESMO arquivo têm nome parecido" — pergunta
  // que só faz sentido por arquivo, nunca pelo índice inteiro, senão viraria ruído global.
  const byFilePos = new Map();
  let reused = 0;
  let reread = 0;

  for (const f of files) {
    const rel = relPath(root, f);
    const base = rel.split('/').pop().replace(INDEX_RE, '');
    if (base) {
      if (!byFile.has(base)) byFile.set(base, []);
      byFile.get(base).push(rel);
    }

    let syms = null;
    if (useCache) {
      const st = safe(() => statSync(f), null);
      const prev = cached && cached[rel];
      if (st && prev && prev.m === st.mtimeMs && prev.s === st.size) {
        syms = prev.y;
        entries[rel] = prev;
        reused++;
      } else {
        syms = parseFile(f);
        // Sem stat não dá para provar frescor depois — fica fora do cache, relido sempre.
        if (st) entries[rel] = { m: st.mtimeMs, s: st.size, y: syms };
        reread++;
      }
    } else {
      syms = parseFile(f);
      reread++;
    }

    for (const [line, kind, end] of syms) {
      const bare = bareName(kind);
      if (!bare) continue;
      if (!defs.has(bare)) defs.set(bare, []);
      defs.get(bare).push({ file: rel, line, kind, end: end || line });
      if (!byFilePos.has(rel)) byFilePos.set(rel, []);
      byFilePos.get(rel).push({ name: bare });
    }
  }

  // Só grava se algo mudou (ou se arquivos sumiram) — evita reescrever um JSON grande
  // a cada consulta quando nada no projeto mudou.
  let gravacao = null;
  if (useCache) {
    const antes = cached ? Object.keys(cached).length : -1;
    if (reread > 0 || antes !== Object.keys(entries).length) {
      gravacao = saveCache(root, parser, entries);
    }
  }

  const snapshotData = {
    parser,
    tier: useCache ? 'B' : 'A',
    fileCount: files.length,
    files: files.map((f) => relPath(root, f)),
    symbols: defs.size,
  };
  const previousSnapshot = loadSnapshot(root, cfg);
  const sameSnapshot = previousSnapshot
    && previousSnapshot.parser === snapshotData.parser
    && previousSnapshot.tier === snapshotData.tier
    && previousSnapshot.fileCount === snapshotData.fileCount
    && previousSnapshot.symbols === snapshotData.symbols
    && JSON.stringify(previousSnapshot.files) === JSON.stringify(snapshotData.files);
  const snapshot = sameSnapshot ? previousSnapshot : saveSnapshot(root, cfg, snapshotData);

  return {
    defs, byFile, byFilePos, fileCount: files.length,
    files: [...files], snapshot,
    repos: repoNomes,
    tier: useCache ? 'B' : 'A', reused, reread,
    // Distingue "não cacheou porque é pequeno" de "não cacheou porque o FS não é confiável" —
    // sem isso, um projeto grande e lento pareceria estar cacheando quando não está.
    cacheRecusadoPeloFs: volumeJustifica && !fsConfiavel,
    // Recusa por tamanho precisa aparecer: sem isso o usuário veria a lentidão do rebuild
    // a cada chamada sem nunca saber que existe um teto e qual foi atingido.
    cacheRecusadoPorTamanho: gravacao && gravacao.motivo === 'tamanho' ? gravacao.bytes : 0,
    truncados,
  };
}

/** `274-284`, ou só `274` quando o símbolo ocupa uma linha só. */
const intervalo = (h) => (h.end && h.end > h.line ? `${h.line}-${h.end}` : `${h.line}`);

const EH_ROTINA_PASCAL = /^(procedure|function|constructor|destructor)\s/;

/** Maior prefixo em comum entre duas strings, em caracteres. */
function lcp(a, b) {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Abaixo disso o prefixo compartilhado é curto demais pra significar algo — medido em dois
// codebases reais e bem diferentes (Node/JS deste plugin, React/TS de um projeto à parte):
// LCP≥4 e LCP≥5 pegavam até 60% dos símbolos com médias de 9-23 "irmãos" por acerto — ruído,
// não sinal. LCP≥6 estabiliza em grupos pequenos e coerentes (`analyze`↔`analyzeSessions`,
// `Accordion`↔`AccordionItem`/`AccordionTrigger`/`AccordionContent`) sem exigir NENHUM
// conhecimento de linguagem ou convenção — é string pura sobre nomes já indexados.
const LCP_MINIMO_IRMAO = 6;
const MAX_IRMAOS_MOSTRADOS = 5;
let lastQuerySummary = null;

/**
 * "Que outros símbolos deste MESMO arquivo têm nome parecido com este?" — pergunta que só um
 * humano faria depois de já ter achado o primeiro, e que hoje custava abrir `outline.mjs` no
 * arquivo inteiro (caro num arquivo de milhares de linhas, com centenas de símbolos) só pra
 * filtrar visualmente os poucos relacionados.
 *
 * Motivado por caso real: um símbolo Pascal (`TExporter.RegistroABC`) tinha "irmãos" óbvios
 * (`RegistroXYZ`, `RegistroLMNO`…) que só um subagente de exploração ampla (custo e tempo bem
 * maiores) acabou encontrando — a busca pontual parou no primeiro acerto.
 *
 * Devolve até `MAX_IRMAOS_MOSTRADOS` nomes, ordenados pelo prefixo MAIS longo primeiro (mais
 * parecido primeiro), e o total de candidatos achados (para o "+N" quando corta).
 */
function irmaosPorPrefixo(nomeAlvo, arquivo, byFilePos) {
  const doArquivo = (byFilePos && byFilePos.get(arquivo)) || [];
  const candidatos = [];
  const vistos = new Set();
  for (const s of doArquivo) {
    if (s.name === nomeAlvo || vistos.has(s.name)) continue;
    const p = lcp(s.name, nomeAlvo);
    if (p >= LCP_MINIMO_IRMAO) { candidatos.push({ name: s.name, p }); vistos.add(s.name); }
  }
  candidatos.sort((a, b) => b.p - a.p || a.name.localeCompare(b.name));
  return { nomes: candidatos.slice(0, MAX_IRMAOS_MOSTRADOS).map((c) => c.name), total: candidatos.length };
}

/**
 * Em Pascal todo método aparece DUAS vezes: declarado no `interface`, definido no
 * `implementation`. Sem agrupar, toda busca num projeto Delphi devolve o dobro de blocos —
 * e quem lê ainda precisa descobrir qual dos dois é a definição de verdade.
 *
 * Junta o par (mesmo arquivo, mesmo nome final, um qualificado por classe e outro não) numa
 * linha só, marcando qual é qual. Só agrupa o par exato: três ou mais ocorrências são
 * ambíguas e continuam listadas uma a uma, sem inventar relação.
 */
function formatarAcertos(hits, byFilePos, t) {
  const usados = new Set();
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    if (usados.has(i)) continue;
    const h = hits[i];
    let par = null;
    if (EH_ROTINA_PASCAL.test(h.kind)) {
      const candidatos = hits
        .map((o, j) => ({ o, j }))
        .filter(({ o, j }) => j !== i && !usados.has(j) && o.file === h.file
          && EH_ROTINA_PASCAL.test(o.kind)
          && o.kind.includes('.') !== h.kind.includes('.'));
      if (candidatos.length === 1) par = candidatos[0];
    }
    if (par) {
      usados.add(i); usados.add(par.j);
      const impl = h.kind.includes('.') ? h : par.o;
      const decl = h.kind.includes('.') ? par.o : h;
      out.push(`  ${h.file} — decl :${decl.line} · impl :${intervalo(impl)}`);
      out.push(`      ${impl.kind}`);
    } else {
      usados.add(i);
      out.push(`  ${sanitizeModelText(h.file, 180)}:${intervalo(h)}`);
      out.push(`      ${sanitizeModelText(h.kind, 180)}`);
    }
    const irmaos = irmaosPorPrefixo(h.name, h.file, byFilePos);
    if (irmaos.nomes.length) {
      const resto = irmaos.total - irmaos.nomes.length;
      out.push(t('sym.siblings', { nomes: irmaos.nomes.map((n) => sanitizeModelText(n, 100)).join(', '), resto }));
    }
  }
  return out;
}

/**
 * Rótulo do escopo realmente varrido, para ir em toda resposta (acerto, arquivo ou nenhum).
 *
 * Existe porque "achei"/"não achei" sem dizer ONDE olhou é indistinguível de "olhei em todo
 * lugar que importa" — e não é: `findRepos` nunca sai de `root` para pastas irmãs (a mesma
 * fronteira que a correção de `sourceDirs: "../vizinho"` fixou como intencional, não acidental).
 * Um projeto com dependência num repo irmão referenciada por caminho relativo (comum em Delphi,
 * `.dpr` com include path tipo `..\Outroprojeto\`) fica invisível para este índice — e sem o
 * rótulo, um acerto de OUTRO módulo do mesmo repo pareceria a resposta certa.
 */
function escopoLabel(repos) {
  if (!repos || !repos.length) return '';
  const nomes = repos.map((r) => sanitizeModelText(r, 80));
  const mostrados = nomes.length > 3 ? `${nomes.slice(0, 3).join(', ')}, +${nomes.length - 3}` : nomes.join(', ');
  return mostrados;
}

/** Uma consulta contra o índice já construído. Só monta linhas; não imprime. */
function reportOne(query, { defs, byFile, byFilePos, fileCount, repos }, { wantAll, ms, t = makeT('en'), result = null }) {
  const out = [];
  const escopo = escopoLabel(repos);
  // `TExporter.RegistroABC`: o índice guarda só `RegistroABC` (ver `QUALIFICADOR_RE` em
  // `bareName`) — sem espelhar o mesmo corte aqui, a busca qualificada nunca casava com nada,
  // mesmo a definição existindo. `query` (com qualificador) continua sendo o que aparece nas
  // mensagens ao usuário; `queryNua` é só o que vai pro regex e pra comparação de exact match.
  const queryNua = query.replace(QUALIFICADOR_RE, '');
  let re;
  try { re = new RegExp(queryNua, 'i'); } catch { return [t('sym.badPattern', { q: query })]; }

  const hits = [];
  for (const [name, locs] of defs) {
    if (!re.test(name)) continue;
    for (const l of locs) hits.push({ name, ...l });
  }

  // Chave de configuração é resposta de SEGUNDA CLASSE: vale ouro quando é tudo que existe
  // (`sessionTimeoutMinutes` não era achável de jeito nenhum), mas não pode empurrar uma
  // definição real para baixo do teto de 40 acertos. Das 832 chaves medidas no workspace de referência, 31
  // colidem com um símbolo já indexado — nessas, a definição tem que vir primeiro.
  // `sort` é estável desde o ES2019, então a ordem dentro de cada grupo não muda.
  //
  // Caso de teste (`test X`) entra na MESMA classe e pelo mesmo motivo: achar o teste que cobre
  // um comportamento é resposta legítima, mas o nome do teste costuma conter o nome do símbolo
  // que ele testa — então, sem isto, buscar `montarPrompt` devolveria primeiro os testes DELE
  // em vez da definição. A pergunta "onde X está" tem uma resposta certa, e não é o teste.
  const ehSegundaClasse = (h) => /^(key|test) /.test(h.kind || '');
  hits.sort((a, b) => (ehSegundaClasse(a) ? 1 : 0) - (ehSegundaClasse(b) ? 1 : 0));

  if (hits.length) {
    if (result) result.kind = 'symbol';
    const exact = hits.filter((h) => h.name.toLowerCase() === queryNua.toLowerCase());
    const shown = (exact.length && !wantAll) ? exact : hits;
    const cap = wantAll ? 200 : 40;
    out.push(t('sym.hits', { q: query, n: shown.length, ms, escopo }));
    if (exact.length && !wantAll && hits.length > exact.length) {
      out.push(t('sym.partialHidden', { n: hits.length - exact.length }));
    }
    out.push('');
    for (const linha of formatarAcertos(shown.slice(0, cap), byFilePos, t)) out.push(linha);
    if (shown.length > cap) out.push(t('sym.more', { n: shown.length - cap }));
    return out;
  }

  // Sem símbolo: o nome pode ser um MÓDULO (arquivo), não uma definição. Caso medido como
  // a falha mais comum — resolver aqui evita um round-trip inteiro de fallback.
  const fileHits = [];
  for (const [base, paths] of byFile) {
    if (!re.test(base)) continue;
    for (const p of paths) fileHits.push({ base, path: p });
  }
  if (fileHits.length) {
    if (result) result.kind = 'file';
    const exactF = fileHits.filter((f) => f.base.toLowerCase() === query.toLowerCase());
    const shown = exactF.length ? exactF : fileHits;
    out.push(t('sym.fileHits', { q: sanitizeModelText(query, 120), n: shown.length, escopo }));
    out.push('');
    for (const f of shown.slice(0, 20)) out.push(`  ${sanitizeModelText(f.path, 180)}`);
    if (shown.length > 20) out.push(t('sym.more', { n: shown.length - 20 }));
    out.push('');
    out.push(t('sym.fileHits.hint1'));
    out.push(t('sym.fileHits.hint2', { q: query }));
    return out;
  }

  if (result) result.kind = 'miss';
  out.push(t('sym.miss', { q: sanitizeModelText(query, 120), files: fileCount, symbols: defs.size, escopo }));
  out.push(t('sym.miss.hint1'));
  out.push(t('sym.miss.hint2', { q: query }));
  return out;
}

/** Como o índice foi obtido. Observável de propósito: numa ferramenta distribuída, o
 *  usuário precisa saber se está lendo disco ou cache para confiar (ou desconfiar). */
function tierLabel(index, t) {
  if (index.cacheRecusadoPeloFs) return t('sym.tier.fsCoarse');
  if (index.tier === 'A') return t('sym.tier.fresh');
  if (index.reread === 0) return t('sym.tier.intact', { reused: index.reused });
  return t('sym.tier.partial', { reread: index.reread, reused: index.reused });
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot();
  const cfg = loadConfig(root);
  const wantAll = args.includes('--all');
  const fresh = args.includes('--fresh');
  const queries = args.filter((a) => !a.startsWith('--'));

  const t = makeT(detectLang(cfg));

  const t0 = Date.now();
  const index = buildIndex(root, cfg, { fresh });
  const ms = Date.now() - t0;

  if (index.fileCount === 0) {
    console.log(t('sym.none', { root }));
    // "Nenhum arquivo de código" tem DUAS causas muito diferentes, e o remédio de uma não
    // serve para a outra. Pasta errada ⇒ ajustar root/sourceDirs resolve. Projeto inteiro numa
    // linguagem que o índice não fala (Rust, Python, Go) ⇒ nenhum ajuste resolve, e mandar o
    // usuário mexer na config o faz perder round-trips atrás de algo que não existe.
    // Medido num repo Rust real: apontar sourceDirs para a pasta certa devolvia exatamente a
    // mesma mensagem. O `outline` já distinguia os dois casos; aqui ficou anos sem distinguir.
    const outras = extensoesNaoSuportadas(root, cfg);
    if (outras.total) console.log(t('sym.none.langs', { total: outras.total, list: outras.list, lidas: EXTENSOES_LIDAS }));
    else console.log(t('sym.none.hint'));
    return;
  }

  const how = tierLabel(index, t);
  const base = { symbols: index.defs.size, files: index.fileCount, ms, how };

  if (args.includes('--stats') || !queries.length) {
    console.log(t('sym.index', base));
    console.log(t('sym.root', { root }));
    if (index.tier === 'B') console.log(t('sym.cacheMode', { min: CACHE_TIER_MIN_FILES }));
    if (index.cacheRecusadoPorTamanho) console.log(t('sym.cacheTooBig', { mb: (index.cacheRecusadoPorTamanho/1048576).toFixed(1), max: 32 }));
    if (index.truncados?.length) console.log(t('sym.truncated', { n: index.truncados.length, dir: index.truncados[0] }));
    if (!queries.length) console.log(t('sym.usage'));
    return;
  }

  // Lote: índice construído uma vez, N consultas em cima dele. O tempo aparece só no
  // cabeçalho — repetir por consulta daria a impressão errada de custo por símbolo.
  if (queries.length > 1) console.log(t('sym.batch', { ...base, n: queries.length }) + '\n');
  const demandExtensions = new Set();
  const querySummary = { queryCount: queries.length, classifiedQueries: 0, symbolMatches: 0, fileMatches: 0, misses: 0 };
  const blocks = queries.map((q) => {
    const result = {};
    const block = reportOne(q, index, { wantAll, ms: queries.length > 1 ? null : ms, t, result }).join('\n');
    if (result.kind === 'symbol') querySummary.symbolMatches++;
    else if (result.kind === 'file') querySummary.fileMatches++;
    else if (result.kind === 'miss') querySummary.misses++;
    if (['symbol', 'file', 'miss'].includes(result.kind)) querySummary.classifiedQueries++;
    const fileExt = q.match(/(?:^|[\\/])[^\\/]+\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase();
    if (result.kind === 'miss' && fileExt && EXTENSOES_HISTORICO.includes(fileExt) && !EXTENSOES_INDICE.includes(fileExt)) {
      demandExtensions.add(fileExt);
    }
    return block;
  });
  lastQuerySummary = querySummary;
  for (const extension of demandExtensions) recordMetric(root, 'language-demand', { extension, source: 'unsupported-file-lookup' });
  console.log(blocks.join('\n\n'));
}

// Exportados para teste; o resto do módulo é CLI.
// `CACHE_TIER_MIN_FILES` é exportado só para o teste: ele precisa gerar arquivos suficientes
// para cair no tier B, e copiar o número à mão criava segunda fonte de verdade — mudar o
// limiar aqui deixaria o teste medindo outra coisa, calado.
export { bareName, buildIndex, reportOne, mtimeGranularityIsFine, CACHE_TIER_MIN_FILES, escopoLabel, irmaosPorPrefixo, QUALIFICADOR_RE };

if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot(process.argv.slice(2));
  try { main(); } catch (e) {
    console.log(makeT(detectLang())('sym.fail', { err: e && e.message }));
  } finally {
    recordMetric(root, 'symbols', {
      mode: process.argv.includes('--stats') ? 'stats' : 'query',
      queryCount: process.argv.slice(2).filter((x) => !x.startsWith('--')).length,
      fresh: process.argv.includes('--fresh'),
      durationMs: Date.now() - started,
      ...(lastQuerySummary || {}),
    });
  }
  process.exit(0);
}
