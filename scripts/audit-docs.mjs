#!/usr/bin/env node
// 🔍 Auditoria de documentação — acha o que apodrece em silêncio.
//
// Numa auditoria real de dois docs canônicos, estas checagens acharam:
//   218 ponteiros de linha podres (0 de 13 conferidos estavam certos; pior errava 2.861 linhas)
//   um subsistema inteiro documentado DEPOIS de ter sido deletado do código
//   23 de 28 alegações "não commitado" que já estavam commitadas há semanas
//
// Uso:
//   audit-docs.mjs                    → audita a documentação viva de cada repo
//   audit-docs.mjs <arquivo.md>       → audita um doc específico
//   audit-docs.mjs --strict           → exit 1 se houver ponteiro de linha (para pre-commit)
//   audit-docs.mjs --root=<dir>       → força a raiz
//
// O que NÃO faz: validar afirmação técnica em prosa ("o guard X roda antes de Y"). Isso exige
// ler código seção a seção e não é mecanizável. Cobre ponteiro, referência, hash e status.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, resolve, sep, join } from 'node:path';
import { resolveRoot, findRepos, resolveSourceDirs, rootFiles, docDirs, walk, relPath, safe, loadConfig, isMain, lerTexto, HISTORY_CODE_RE } from './lib/roots.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { recordMetric } from './lib/telemetry.mjs';

// Padrões de status por idioma. Sem isto o script só serve para quem escreve doc em português.
const STATUS_PATTERNS = {
  pt: /N[ÃA]O commitad|AINDA N[ÃA]O COMMITADO|n[ãa]o commitad|falta deploy|n[ãa]o deployad/gi,
  en: /not committed|uncommitted|not yet committed|pending deploy|not deployed/gi,
  es: /no commiteado|sin commitear|pendiente de despliegue/gi,
};
const HAS_DATED_WARNING = /(status|estado).{0,40}(do dia|datad|point-in-time|as of)/i;

const PTR_PATTERNS = [
  [/\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rb|java|rs|php|sql):~?\d{1,5}/g, 'arquivo.ext:NNNN'],
  [/`:\d{1,5}/g, '`:NNNN`'],
  [/`[A-Za-z_$][\w$.]*\s*:\s*\d{3,5}`/g, '`simbolo:NNNN`'],
  [/`[A-Za-z_$][\w$.]*\s+:\s*\d{1,5}`/g, '`simbolo :NNNN`'],
];

const STOPW = new Set(['true', 'false', 'null', 'undefined', 'string', 'number', 'boolean',
  'object', 'async', 'await', 'return', 'const', 'export', 'import', 'default', 'this',
  'main', 'master', 'origin', 'HEAD', 'npm', 'node', 'git', 'docker', 'yarn', 'pnpm']);
const plausible = (s) =>
  (/^[a-z_$][A-Za-z0-9_$]{4,}$/.test(s) && /[A-Z]/.test(s) && !STOPW.has(s)) ||
  (/^[A-Z][A-Za-z0-9_$]{4,}$/.test(s) && /[a-z]/.test(s) && !STOPW.has(s));

const CODE_RE = HISTORY_CODE_RE;

/** Um token em crase é candidato a "símbolo fantasma"? Mesmo critério nas duas fases. */
const ehCandidato = (t) =>
  !/[\s(){}[\],:'"=<>|/\\.]/.test(t) && !/^[0-9a-f]{7,10}$/.test(t) && plausible(t);

/**
 * Nome pesquisável de um token em crase, ou null se não for candidato.
 *
 * Existe porque citar o símbolo COM a assinatura — `minhaFuncao(root, cfg)` — é a convenção
 * natural em doc, e `ehCandidato` rejeita qualquer coisa com parêntese ou vírgula. Resultado:
 * a checagem de símbolo fantasma pulava exatamente a forma mais comum de citar função.
 * Achado no próprio mapa deste repo: a função de montar o índice foi renomeada e ficou 2
 * commits citada pelo nome ANTIGO num doc que a auditoria declarava "0 achados".
 *
 * Cuidado ao editar este comentário: a existência é testada por substring no código, então
 * escrever o nome fantasma aqui o faz "existir" e desarma a própria checagem — aconteceu.
 *
 * Só desmonta `nome(...)` simples. Chamada qualificada (`Foo.bar(x)`) segue fora, de propósito:
 * exigiria decidir se o dono ou o método é o símbolo, e errar aí vira falso positivo.
 */
function nomeCitado(tok) {
  const m = tok.match(/^([A-Za-z_$][\w$]*)\s*\([^()]*\)$/);
  const nome = m ? m[1] : tok;
  return ehCandidato(nome) ? nome : null;
}

/**
 * FASE 1 — lê os docs uma vez, guarda o texto e colhe todo candidato citado em crase.
 *
 * Precisa vir antes de tocar no código: saber TODOS os candidatos de antemão é o que permite
 * a fase 2 varrer o código sem acumular nada.
 */
function collectCandidates(targets) {
  const textos = new Map();
  const tokens = new Set();
  for (const t of targets) {
    const text = lerTexto(t);
    if (text === null) continue;
    textos.set(t, text);
    let m;
    const re = /`([^`\n]{3,60})`/g;
    while ((m = re.exec(text))) {
      const nome = nomeCitado(m[1].trim());
      if (nome) tokens.add(nome);
    }
  }
  return { textos, tokens };
}

/**
 * FASE 2 — passe único pelo código, UM ARQUIVO POR VEZ, marcando quais candidatos existem.
 *
 * Antes, isto concatenava o codebase inteiro numa única string (51 MB num repo de 20 mil
 * arquivos) e testava `blob.includes(t)`. Aqui o conteúdo é descartado assim que o arquivo é
 * processado, então a memória é O(candidatos) em vez de O(codebase) — mesmo I/O, mesma
 * resposta, sem o pico.
 *
 * Dois ganhos de brinde: candidato achado sai de `pendentes` e não é procurado de novo (o
 * custo cai conforme avança), e some o falso "achou" de token que só existia na EMENDA entre
 * dois arquivos concatenados — artefato do blob, nunca foi resultado legítimo.
 */
function resolveExistence(root, cfg, tokens) {
  const encontrados = new Set();
  const names = new Set();
  const pendentes = new Set(tokens);
  // requireGit:false — o núcleo da auditoria (símbolo/arquivo citado no doc existe?) não
  // depende de git. Só a checagem de hash de commit depende, e ela degrada sozinha.
  for (const repo of findRepos(root, { requireGit: false, cfg })) {
    const dirs = resolveSourceDirs(repo.path, cfg);
    const arquivos = [];
    for (const d of dirs) walk(d, CODE_RE, arquivos);
    // Arquivos soltos na raiz do repo: sem isto, símbolo que só vive no entrypoint aparecia
    // como "inexistente" na auditoria — falso positivo com causa real.
    if (!cfg.sourceDirs) for (const f of rootFiles(repo.path, CODE_RE)) arquivos.push(f);

    // Mesmo motivo do dedupe em symbols.mjs: sem isto o arquivo da raiz é LIDO duas vezes.
    const vistos = new Set();
    for (const f of arquivos.filter((x) => (vistos.has(x) ? false : vistos.add(x)))) {
      names.add(basename(f));
      // Sem candidato pendente ainda é preciso completar `names` (é só basename, não lê nada).
      if (!pendentes.size) continue;
      const content = lerTexto(f);
      if (content === null) continue;
      // Deletar do Set durante o for..of é seguro em JS (o elemento atual já foi visitado e
      // os não visitados que somem não deveriam ser visitados mesmo) — verificado.
      for (const t of pendentes) {
        if (content.includes(t)) { encontrados.add(t); pendentes.delete(t); }
      }
    }
  }
  return { encontrados, names };
}

// Um spawn de git por hash por doc levava 15s. Em lote, ~2s.
function makeHashChecker(repoList) {
  const cache = new Map();
  return (hashes) => {
    const todo = [...hashes].filter((h) => !cache.has(h));
    if (todo.length) {
      for (const h of todo) cache.set(h, false);
      for (const r of repoList) {
        const out = safe(() => execFileSync('git', ['cat-file', '--batch-check'], {
          cwd: r.path, input: todo.join('\n'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
        }), '');
        out.split('\n').forEach((line, i) => { if (/\bcommit\b/.test(line) && todo[i]) cache.set(todo[i], true); });
      }
    }
    return [...hashes].filter((h) => !cache.get(h));
  };
}

// `code` = { encontrados: Set, names: Set }, resolvido na fase 2. `text` já vem lido da fase 1
// (o doc não é lido duas vezes).
function auditDoc(file, text, code, root, checkHashes, cfg, t = makeT(detectLang(cfg))) {
  if (text == null) return null;
  const issues = [];
  // Doc que DOCUMENTA uma remoção cita legitimamente símbolos que não existem mais.
  // Sem isto a auditoria grita justamente nos docs já anotados corretamente.
  const documentsRemoval = /REMOVID[OA]|obsolesc[eê]ncia|registro hist[óo]rico|deprecated|removed in/i.test(text);

  let ptr = 0; const kinds = [];
  for (const [re, label] of PTR_PATTERNS) {
    const n = (text.match(re) || []).length;
    if (n) { ptr += n; kinds.push(`${n}x ${label}`); }
  }
  if (ptr) issues.push({ sev: 'alto', msg: t('aud.ptr', { n: ptr, kinds: kinds.join(', ') }) });

  const ticked = new Set();
  let m; const re = /`([^`\n]{3,60})`/g;
  while ((m = re.exec(text))) ticked.add(m[1].trim());

  // `tok`, não `t`: `t` aqui é o tradutor, e sombrear silenciosamente já causou um bug.
  // As duas fases precisam normalizar IGUAL: a fase 1 procurou pelo nome nu, então comparar
  // aqui com o token cru (`minhaFuncao(root, cfg)`) nunca casaria e tudo viraria fantasma.
  const ghosts = [...new Set([...ticked].map(nomeCitado).filter(Boolean))]
    .filter((tok) => !code.encontrados.has(tok));
  if (ghosts.length) issues.push({
    sev: documentsRemoval ? 'baixo' : (ghosts.length > 8 ? 'alto' : 'medio'),
    msg: t('aud.ghosts', {
      n: ghosts.length,
      list: ghosts.slice(0, 6).join(', ') + (ghosts.length > 6 ? '…' : ''),
      removal: documentsRemoval,
    }),
  });

  const files = new Set();
  const fre = /`([A-Za-z0-9_./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rb|java|rs|php|sql))`/g;
  while ((m = fre.exec(text))) files.add(basename(m[1]));
  // `*` já era ignorado como glob. O nome iniciado por PONTO entra pelo mesmo motivo: `.d.ts`,
  // `.test.mjs` e `.spec.js` são PADRÃO de arquivo, não arquivo — e é assim que documentação
  // sobre filtro os escreve. Medido: 3 dos 4 achados ao ligar a auditoria dos mapas eram isso.
  //
  // O preço é não acusar um dotfile real (`.eslintrc.js`) que tenha sumido, porque as duas
  // formas são indistinguíveis por estrutura. É o lado certo de errar, e o mesmo já escolhido
  // na checagem de símbolo: prefere-se NÃO acusar a acusar errado — achado falso que nunca some
  // ensina a ignorar a categoria inteira, e aí os achados certos somem junto.
  const ghostFiles = [...files].filter((f) => !code.names.has(f) && !f.includes('*') && !f.startsWith('.'));
  if (ghostFiles.length) issues.push({
    sev: documentsRemoval ? 'baixo' : 'medio',
    msg: t('aud.ghostFiles', { n: ghostFiles.length, list: ghostFiles.slice(0, 5).join(', ') + (ghostFiles.length > 5 ? '…' : '') }),
  });

  const hashes = new Set();
  const hre = /`([0-9a-f]{7,10})`/g;
  while ((m = hre.exec(text))) hashes.add(m[1]);
  const badHash = checkHashes(hashes);
  if (badHash.length) issues.push({ sev: 'medio', msg: t('aud.badHash', { n: badHash.length, list: badHash.slice(0, 5).join(', ') }) });

  const langs = cfg.statusLanguages || Object.keys(STATUS_PATTERNS);
  let claims = 0;
  for (const l of langs) {
    const p = STATUS_PATTERNS[l];
    if (p) claims += (text.match(p) || []).length;
  }
  if (claims > 3 && !HAS_DATED_WARNING.test(text)) {
    issues.push({ sev: 'baixo', msg: t('aud.staleStatus', { n: claims }) });
  }

  return { rel: relPath(root, file), issues, ptr };
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot();
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));
  const strict = args.includes('--strict');
  const only = args.find((a) => !a.startsWith('--'));

  // Duas listas de propósito: o verificador de hash só faz sentido em repo git de verdade;
  // a descoberta de docs vale mesmo em projeto sem versionamento.
  const repoList = findRepos(root);
  const projectList = findRepos(root, { requireGit: false, cfg });
  const checkHashes = makeHashChecker(repoList);

  const targets = [];
  if (only) {
    if (!existsSync(only) || !statSync(only).isFile()) { console.log(t('aud.notFound', { f: only })); return; }
    // Doc FORA da raiz indexada é o pior caso possível desta ferramenta: o blob de código vem
    // do projeto errado e a auditoria acusa "símbolo inexistente" para praticamente tudo.
    // Medido num projeto de terceiro: 93 achados [alto] + 13 [medio] que viraram 1 [medio]
    // com a raiz certa — 105 dos 106 eram artefato. Dizer "não existe" só é legítimo se a
    // busca aconteceu no lugar certo; então aqui a ferramenta recusa e explica, em vez de
    // afirmar com confiança sobre um repositório que nem chegou a olhar.
    const abs = resolve(only);
    const base = resolve(root);
    if (abs !== base && !abs.startsWith(base + sep)) {
      console.log(t('aud.outsideRoot', { f: only, root }));
      return;
    }
    targets.push(only);
  } else {
    for (const repo of projectList) {
      for (const d of docDirs(repo.path)) walk(d, /\.md$/, targets);
      // Os MAPAS DE CONTEXTO, explicitamente. O `walk` pula toda entrada iniciada por `.` e
      // `IGNORED` contém `.claude` — regra certa para o resto da pasta, que é estado de
      // ferramenta (cache, travas, baseline) e não conteúdo. Os mapas são a exceção: são
      // documentação de verdade, escrita à mão, e eram os ÚNICOS documentos do projeto que
      // ninguém auditava. Medido nos 7 mapas deste repo ao ligar isto: 4 achados, e um era
      // real — um mapa citava, como se existisse, o nome ANTIGO da guarda de execução direta.
      //
      // O nome antigo não está escrito aqui de propósito: a existência é testada por substring
      // no código, então citá-lo neste comentário faria a checagem dele passar a encontrá-lo e
      // o achado sumiria. É o gotcha registrado em `doc-audit.md`, e ele mordeu exatamente aqui,
      // enquanto se escrevia a feature que o detecta.
      //
      // Acrescentado aqui, e não afrouxando o `walk`: afrouxar traria `.symbols-cache.json` e
      // companhia junto, e a poda de `.claude` protege todo projeto que usa o plugin.
      const mapas = join(repo.path, '.claude', 'context');
      if (existsSync(mapas)) walk(mapas, /\.md$/, targets);
    }
  }

  if (!targets.length) {
    console.log(t('aud.noDocs', { root }));
    return;
  }

  // Fase 1 (docs) precisa vir antes da fase 2 (código): é conhecer todos os candidatos de
  // antemão que permite varrer o código sem acumular nada.
  const { textos, tokens } = collectCandidates(targets);
  const code = resolveExistence(root, cfg, tokens);

  let totalPtr = 0;
  const report = [];
  for (const alvo of targets) {
    const res = auditDoc(alvo, textos.get(alvo), code, root, checkHashes, cfg, t);
    if (!res || !res.issues.length) continue;
    totalPtr += res.ptr;
    report.push(res);
  }

  console.log(t('aud.header', { docs: targets.length, withIssues: report.length, root }));
  const order = { alto: 0, medio: 1, baixo: 2 };
  report.sort((a, b) => Math.min(...a.issues.map((i) => order[i.sev])) - Math.min(...b.issues.map((i) => order[i.sev])));
  for (const r of report.slice(0, 25)) {
    console.log(`  ${r.rel}`);
    for (const i of r.issues) console.log(`     [${i.sev}] ${i.msg}`);
  }
  if (report.length > 25) console.log(t('aud.more', { n: report.length - 25 }));
  if (!report.length) console.log(t('aud.clean'));

  if (strict && totalPtr > 0) {
    console.log(t('aud.strict', { n: totalPtr }));
    process.exit(1);
  }
}

// Exportados para teste; o resto do módulo é CLI.
export { plausible, ehCandidato, collectCandidates, resolveExistence, auditDoc };

if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot(process.argv.slice(2));
  process.once('exit', () => recordMetric(root, 'audit-docs', {
    strict: process.argv.includes('--strict'),
    singleDoc: process.argv.slice(2).some((x) => !x.startsWith('--')),
    durationMs: Date.now() - started,
  }));
  try { main(); } catch (e) {
    console.log(makeT(detectLang())('aud.fail', { err: e && e.message }));
  }
  process.exit(0);
}
