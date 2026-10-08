#!/usr/bin/env node
// 🗺️ Detector de mapas de contexto (.claude/context/*.md) — pilar do sistema "à prova de defasagem".
//
// O que faz: varre cada repo do workspace por mapas de contexto, lê o frontmatter
// (covers + verified_at) e usa o GIT como fonte de verdade da defasagem:
//   - --session-start : índice mínimo (1 linha/mapa) + status fresh/stale, injetado no início.
//   - --stop-report   : revisão limitada aos mapas ligados a arquivos alterados nesta sessão.
//
// M4 (inegociável): uma falha de detecção nunca pode quebrar a sessão. Todo caminho de erro
// termina em exit 0 SEM stdout. git roda com timeout curto. Nenhuma dependência externa (sem jq).
//
// Git encontra commits e mudanças locais; fingerprints detectam alterações mesmo com mtime
// preservado; projetos sem Git usam mtime como fallback. Stop filtra esse histórico pelo
// baseline da sessão; health mantém a visão global. "Atualizado" nunca prova correção semântica.

import { readdirSync, readFileSync, existsSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, basename, dirname, resolve, isAbsolute, sep } from 'node:path';
import { resolveRoot, findRepos, safe, loadConfig, isMain, lerTexto, CODE_RE, walk, relPath, statePath, runtimeHost } from './lib/roots.mjs';
import { writeHookOutput } from './lib/hook-output.mjs';
import { lerDocumento } from './lib/md-hint.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { recordMetric } from './lib/telemetry.mjs';
import { markdownSectionsForSources } from './lib/markdown-sections.mjs';
import { selectAutomaticReviewCandidates } from './lib/auto-review-candidates.mjs';
import { compareReviewedSources, fingerprintKey, fingerprintSourcesInRoot, loadFingerprintState, parseSourceFingerprints, rememberFingerprint, sameDigest, sameSource, saveFingerprintState } from './lib/source-fingerprints.mjs';
import { sessionWriteFiles } from './lib/session-write-journal.mjs';
import { reviewFinding } from './lib/review-findings.mjs';
const t = makeT(detectLang(safe(() => loadConfig(resolveRoot()), {})));

const GIT_TIMEOUT_MS = 5000;

// A raiz NÃO pode vir da localização do script: como plugin, ele mora fora do projeto
// (em ~/.claude/skills/... ou no diretório de instalação) e deduzir "dois níveis acima"
// faria procurar mapas dentro da própria pasta do plugin. Vem de CLAUDE_PROJECT_DIR/cwd.
function workspaceRoot() {
  // `resolve` também na env var: o baseline é indexado por caminho de repo, e o handoff resolve
  // o dele. `C:/x` e `C:\x` são o mesmo lugar e chaves DIFERENTES — a busca falharia calada e
  // tudo degradaria para 'HEAD' sem ninguém notar. Normalizar dos dois lados mata a classe.
  if (process.env.CONTEXT_MAPS_ROOT) return resolve(process.env.CONTEXT_MAPS_ROOT);
  return resolveRoot();
}

// Mapas em <repo>/.claude/context/*.md — cobre repo único e workspace multi-repo.
//
// `requireGit: false`: sem isso, projeto sem NENHUM .git em lugar nenhum nem aparecia como
// repo, e os mapas dele nunca eram encontrados — o hook inteiro ficava mudo, mesmo tendo
// mapa escrito. `repo.git` viaja com cada mapa para runSessionStart/runStopReport saberem
// qual caminho de verificação usar (git diff ou fallback de mtime — ver mtimeChangedSince).
function findMaps(root) {
  const out = [];
  const cfg = safe(() => loadConfig(root), {});
  for (const repo of findRepos(root, { requireGit: false, cfg })) {
    const ctxDir = join(repo.path, '.claude', 'context');
    if (!existsSync(ctxDir)) continue;
    for (const f of safe(() => readdirSync(ctxDir), [])) {
      if (!f.endsWith('.md')) continue;
      out.push({
        repo: repo.path,
        repoName: repo.name === '.' ? basename(repo.path) : repo.name,
        repoGit: repo.git,
        path: join(ctxDir, f),
      });
    }
  }
  return out;
}

// Parser de frontmatter minimalista (sem lib YAML): escalares, lista `covers` e JSON compacto
// `source_fingerprints`, mantendo compatibilidade com os mapas existentes.
function parseFrontmatter(content) {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const body = content.slice(3, end);
  const data = { covers: [] };
  let inCovers = false;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // `ln`, não `t`: `t` no escopo do módulo é o tradutor. Sombrear já causou um bug antes.
    const ln = line.trim();
    if (!ln) continue;
    if (/^covers\s*:/.test(ln)) { inCovers = true; continue; }
    if (inCovers && ln.startsWith('- ')) {
      data.covers.push(ln.slice(2).trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    inCovers = false;
    const m = ln.match(/^([A-Za-z_]\w*)\s*:\s*(.*)$/);
    if (m) {
      const value = m[1] === 'source_fingerprints' ? m[2].trim() : m[2].replace(/\s+#.*$/, '').trim();
      data[m[1]] = value.replace(/^["']|["']$/g, '');
    }
  }
  return data;
}

function fingerprintMap(m, state, cache = null, strict = false) {
  const current = fingerprintSourcesInRoot(m.repo, m.covers, cache);
  const key = `map:${fingerprintKey(m.path)}`;
  const previous = state.entries[key];
  if (strict && !m.source_fingerprints && !m.source_digest) return { current, key, status: 'unknown', changed: Object.keys(current.sources), unverifiableSources: true };
  const trustedDigest = m.source_digest || (!m.source_fingerprints ? previous?.digest : null);
  const comparison = compareReviewedSources(current, m.source_fingerprints, previous, trustedDigest);
  if (comparison.valid && !current.markers.length && (sameDigest(current, m.source_digest)
    || ((!strict && !m.source_fingerprints && previous?.digest === current.digest)
      || (comparison.complete && (!strict || m.source_fingerprints || m.source_digest))))) {
    const updated = previous?.digest !== current.digest;
    if (updated) rememberFingerprint(state, key, current);
    return {
      current, key, status: 'fresh', changed: [], updated,
      metadataOutdated: comparison.valid && comparison.metadataComplete
        && typeof m.source_digest === 'string' && !sameDigest(current, m.source_digest),
    };
  }
  if (!comparison.valid) return { current, key, status: 'unknown', changed: Object.keys(current.sources), invalidSourceFingerprints: true };
  const changed = comparison.changed;
  if (!comparison.complete && changed.length === 0) {
    return { current, key, status: 'unknown', changed: [], unverifiableSources: true };
  }
  const unreviewed = strict ? changed : afterMapReview(m, changed);
  if (unreviewed.length === 0) {
    rememberFingerprint(state, key, current);
    return { current, key, status: 'fresh', changed: [], updated: true };
  }
  return {
    current,
    key,
    status: previous || comparison.portable || (typeof m.source_digest === 'string' && m.source_digest.startsWith('sha256:')) ? 'stale' : 'unknown',
    changed: unreviewed,
  };
}

function fingerprintMapChangedNames(m, result) {
  return result.changed;
}

function sourceDigestInstruction(digest, map, changed, sources = {}) {
  const sections = markdownSectionsForSources(lerTexto(map.path) || '', changed, 2)
    .map((heading) => sanitizar(heading, 100));
  const hint = sections.length ? ` Relevant section(s): ${sections.join('; ')}.` : '';
  const entries = Object.fromEntries(changed.slice(0, 8)
    .filter((source) => typeof sources[source] === 'string')
    .map((source) => [source, sources[source]]));
  const overflow = changed.length > Object.keys(entries).length
    ? ` ${changed.length - Object.keys(entries).length} additional source(s) remain pending for a later review.`
    : '';
  const perSource = Object.keys(entries).length
    ? ` After checking these listed sources, merge their supplied values into source_fingerprints (preserve other entries): ${JSON.stringify(entries)}.`
    : '';
  return `${perSource}${overflow} Set source_digest: ${digest} only when source_fingerprints covers every current source and every entry matches; otherwise preserve the existing source_digest.${hint}`.trim();
}

function limitedLines(lines, limit, label) {
  return lines.length > limit
    ? [...lines.slice(0, limit), `… ${lines.length - limit} additional ${label} pending; they will be offered in a later review.`]
    : lines;
}

/**
 * `verified_at` vem do frontmatter do REPOSITÓRIO e vai para a linha de comando do git ANTES
 * do `--`, posição em que o git ainda interpreta OPÇÕES.
 *
 * Isso foi vulnerabilidade real, confirmada em teste: `verified_at: --output=<caminho>` fazia
 * o `git diff` ESCREVER um arquivo arbitrário — com conteúdo influenciado pelo repo e
 * disparado automaticamente no SessionStart de quem apenas abrisse o projeto. Escrita
 * arbitrária de arquivo, sem nenhuma ação do usuário.
 *
 * A defesa não é escapar, é RECUSAR. Um commit-ish legítimo (sha, branch, tag) passa;
 * qualquer coisa começando com `-` não passa e nunca chega ao git. Ref recusado vira "não
 * verificável", que é a resposta honesta: o mapa realmente não pôde ser conferido.
 */
const REF_CHAR_PROIBIDO = new RegExp('[^A-Za-z0-9._/-]');

function refSeguro(ref) {
  return typeof ref === 'string'
    && ref.length > 0
    && ref.length <= 64
    && !ref.startsWith('-')
    && !REF_CHAR_PROIBIDO.test(ref);
}

/**
 * Fallback SEM GIT: "mudou" vira "mtime mais novo que a referência", não "conteúdo diferente".
 *
 * É deliberadamente mais fraco que `gitDiffNames` — sobrevive a `touch` sem alterar nada
 * (falso positivo) e não pega mudança que preserva o mtime original (cópia com -p, restore de
 * backup; falso negativo, raro). Mas é o único sinal que existe sem VCS: sem ele, projeto sem
 * git não tem NENHUMA forma de saber se um mapa está defasado, e o hook fica mudo pra sempre
 * (comportamento anterior a 2026-08-05, ainda documentado no README como limitação conhecida).
 *
 * Arquivo ausente conta como "mudou": git mostraria a remoção no diff, e silenciar aqui
 * esconderia exatamente o caso em que o mapa cita algo que não existe mais.
 */
function mtimeChangedSince(repoPath, sinceMs, relFiles) {
  const out = [];
  for (const rel of relFiles) {
    const st = safe(() => statSync(join(repoPath, rel)), null);
    // >= (não >): mesmo milissegundo do baseline conta como "mudou". Com `>` estrito, um
    // arquivo escrito no MESMO ms do SessionStart (comum em teste, possível em produção com
    // relógio de FS grosseiro) escaparia do fallback por um empate — falso negativo silencioso.
    if (!st || st.mtimeMs >= sinceMs) out.push(rel);
  }
  return out;
}

/**
 * `verified_at` sem git precisa ser DATA, não commit-ish — não há ref pra resolver. Aceita
 * qualquer formato que `Date.parse` entenda (`2026-08-01`, ISO completo). Falha o parse (NaN)
 * vira "não verificável" no chamador, nunca uma data inventada.
 */
function parseVerifiedAtDate(valor) {
  const ms = Date.parse(String(valor ?? ''));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Reescreve só a linha `verified_at:` do frontmatter, preservando o resto do arquivo intacto
 * (corpo, outros campos como `verified_date`, comentários). Regex roda apenas no trecho ANTES
 * do fechamento `\n---`, nunca no corpo — um `verified_at:` citado como texto no corpo do mapa
 * não seria tocado por engano.
 */
function reescreverVerifiedAt(path, novoValor) {
  const content = readFileSync(path, 'utf8');
  const end = content.indexOf('\n---', 3);
  if (!content.startsWith('---') || end === -1) return false;
  const front = content.slice(0, end);
  if (!/^verified_at\s*:/m.test(front)) return false;
  const novoFront = front.replace(/^verified_at\s*:.*$/m, `verified_at: ${novoValor}`);
  writeFileSync(path, novoFront + content.slice(end));
  return true;
}

/**
 * Migração automática de `verified_at` DATA -> commit-ish, no exato momento em que o repo passa
 * a ter git (mapa foi escrito em modo sem-git, `git init` rodou depois).
 *
 * Só migra quando a MESMA checagem de mtime que já valia no modo sem-git confirma que nenhum
 * arquivo coberto mudou desde aquela data — nunca "porque agora tem git" sozinho, que inventaria
 * frescor sem checar nada. Se mtime acusar mudança, não migra: o mapa segue "não verificável" até
 * revisão humana, que é a resposta honesta quando não dá pra confirmar sozinho.
 *
 * Autoterminante: uma vez migrado, `verified_at` vira SHA e nunca mais cai aqui (passa a resolver
 * normal em `gitDiffNames`).
 */
function tentarMigrarVerifiedAt(m) {
  const desde = parseVerifiedAtDate(m.verified_at);
  if (desde === null) return false; // não é data reconhecível: nada a migrar
  const mudouPorMtime = mtimeChangedSince(m.repo, desde, m.covers);
  if (mudouPorMtime.length > 0) return false;
  const head = safe(
    () => execFileSync('git', ['-C', m.repo, 'rev-parse', 'HEAD'],
      { timeout: GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
    null
  );
  if (!head || !refSeguro(head)) return false;
  return safe(() => reescreverVerifiedAt(m.path, head), false) === true;
}

function gitDiffNames(repo, ref, paths) {
  if (!paths.length) return [];
  // Recusa ANTES de montar os argumentos — ref hostil nunca chega ao git.
  if (!refSeguro(ref)) throw new Error(`ref recusado: ${String(ref).slice(0, 40)}`);
  const args = ['-C', repo, 'diff', '--name-only', ref, '--', ...paths];
  const out = execFileSync('git', args, { timeout: GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// Código tocado nesta sessão (staged+unstaged+novo) que nenhum mapa cobre — sinal cru,
// sem julgar se a área "merece" mapa (isso é decisão do modelo, não do script).
//
// A extensão vem do `CODE_RE` de `lib/roots.mjs` — FONTE ÚNICA, e não uma cópia. Era uma lista
// escrita à mão aqui até 2026-08-04, e ela DERIVOU: `py`/`pyi`/`go` entraram no índice e esta
// cópia não os ganhou, então em projeto Python ou Go o aviso de "código sem mapa" ficou inerte.
// Inerte em SILÊNCIO, que é o modo de falha que este plugin inteiro existe para não ter — e a
// segunda vez que a MESMA cópia manual causou o MESMO bug (antes cobria só js/ts, e Delphi e
// Rust eram os cegos). Somar duas extensões teria consertado o sintoma e deixado a causa viva.
//
// A ressalva de alargar era inflar o volume de um aviso calibrado por assimetria. Medido num
// repo Rust real: não infla. É puramente aditivo (só cria aviso onde antes havia zero) e o
// `filtrarPorRelevancia` classifica linguagem nova pelo mesmo critério, porque conta ARQUIVO
// e LINHA, não sintaxe — 1 arquivo pequeno cala, 1 grande avisa, 3 avisam. Igual a JS.
//
// `.dfm`/`.fmx` seguem fora, porque estão fora do `CODE_RE`: são formulário, não código a ler.

// `ref` é 'HEAD' (só working tree, comportamento antigo) ou o commit gravado no início
// da sessão (pega também o que foi commitado/pushado DURANTE a sessão — ver baseline abaixo).
function listTouchedFiles(repo, ref) {
  // MESMA guarda do gitDiffNames, e pelo mesmo motivo. Este ponto foi encontrado numa segunda
  // varredura: `ref` aqui vem do arquivo de baseline em `.claude/`, que um repositório pode
  // versionar. Explorar exige acertar o id da sessão (UUID de runtime), então é difícil hoje —
  // mas é buraco latente a um refactor de distância, e a guarda custa uma linha.
  // Regra: TODO valor que vá para a linha de comando do git antes do `--` passa por refSeguro.
  if (!refSeguro(ref)) return [];
  const tracked = safe(
    () => execFileSync('git', ['-C', repo, 'diff', '--name-only', ref],
      { timeout: GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    ''
  );
  const untracked = safe(
    () => execFileSync('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard'],
      { timeout: GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    ''
  );
  const all = new Set(
    [...tracked.split('\n'), ...untracked.split('\n')]
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return [...all];
}

function listTouchedSourceFiles(repo, ref) {
  return listTouchedFiles(repo, ref).filter((file) => CODE_RE.test(file));
}

/**
 * Pergunta "o que a sessão tocou", sem git: varre o repo inteiro (mesma poda de `walk` —
 * node_modules, vendor, dist…) e devolve o que tem mtime mais
 * novo que o início da sessão. `sinceMs` nulo (sem baseline de sessão gravado) devolve vazio em
 * vez de adivinhar uma janela — silêncio é a resposta honesta quando não há referência.
 */
function listTouchedFilesMtime(repoPath, sinceMs, pattern = /[\s\S]/) {
  if (sinceMs == null) return [];
  const out = [];
  for (const f of walk(repoPath, pattern)) {
    const st = safe(() => statSync(f), null);
    if (st && st.mtimeMs >= sinceMs) out.push(relPath(repoPath, f));
  }
  return out;
}

function listTouchedSourceFilesMtime(repoPath, sinceMs) {
  return listTouchedFilesMtime(repoPath, sinceMs, CODE_RE);
}

// Arquivos que praticamente ninguém mapeia. Embutidos para que o caso comum funcione sem
// configuração nenhuma — pedir ao usuário que liste `vite.config.ts` à mão é atrito puro.
// Desligável com `contextMaps.useDefaultExclusions: false`.
const DEFAULT_UNMAPPED_PATTERNS = [
  // `[cm]?` cobre `.test.mjs`/`.test.cjs`/`.test.mts`, não só `.test.js`. Sem ele o padrão era
  // cego para a convenção de TODO projeto ESM — inclusive a deste plugin, onde os 130 testes
  // moram em `.test.mjs` e o aviso de "sem mapa" reclamava deles a cada sessão. Aviso que nunca
  // some ensina a ignorar a categoria inteira, e aí os avisos certos somem junto: é a assimetria
  // que calibra este filtro, e ela estava sendo violada pelo próprio default.
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  // Os PRÓPRIOS scripts do plugin, quando instalados dentro do projeto. Sem isto, a primeira
  // sessão depois de instalar abre com o hook acusando arquivos "sem mapa" — todos dele
  // mesmo. Ninguém vai mapear a ferramenta que acabou de instalar, então o aviso nasce
  // impossível de atender, e aviso impossível ensina a ignorar a categoria inteira já na
  // primeira impressão. Encontrado instalando o plugin num projeto novo, do zero.
  /(^|\/)\.claude\/scripts\//,
  /(^|\/)\.codex\/scripts\//,
  /\.d\.ts$/,
  /\.config\.(js|ts|mjs|cjs)$/,
  /(^|\/)__(mocks|tests)__\//,
  /\.(generated|gen)\.[jt]sx?$/,
  /(^|\/)(setup|teardown)\.[jt]s$/,
];

const isDefaultUnmapped = (rel) => DEFAULT_UNMAPPED_PATTERNS.some((re) => re.test(rel));

/**
 * Exclusão explícita: `contextMaps.intentionallyUnmapped` em .claude/context-tools.json.
 *
 * Existe porque o detector não distingue "esqueceram de mapear" de "decidiram não mapear" —
 * e todo projeto tem arquivo que legitimamente nunca merecerá mapa (config, script de build,
 * entrypoint trivial). Sem isto, o aviso desses arquivos nunca some, e um aviso que nunca some
 * ensina a ignorar a categoria inteira — inclusive quando ela estiver certa.
 *
 * Com a lista, o silêncio passa a significar "decidido" em vez de "esquecido", e a decisão
 * fica versionada no repo em vez de morrer no fim da sessão.
 *
 * Regra de match, deliberadamente simples e previsível (nada de glob): a entrada casa se for
 * igual ao caminho relativo do arquivo, ou se terminar em `/` e for prefixo dele (pasta inteira).
 */
function isIntentionallyUnmapped(rel, padroes) {
  return padroes.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
}

// maps já vem carregado (todos os repos) — filtra por repo e junta todo `covers`.
//
// Recebe `touched` já calculado em vez de buscá-lo aqui: quem chama decide COMO descobrir o
// que mudou (git diff num repo versionado, mtime num que não é) — esta função só filtra o
// resultado contra mapa/exclusões, e é a mesma filtragem para os dois casos.
function filtrarUnmapped(repo, allMaps, touched, opts = {}) {
  const { ignorados = [], usarPadroes = true } = opts;
  const covered = new Set();
  for (const m of allMaps) {
    if (m.repo !== repo) continue;
    for (const c of m.covers) covered.add(c);
  }
  return touched.filter((f) =>
    !covered.has(f)
    && !isIntentionallyUnmapped(f, ignorados)
    && !(usarPadroes && isDefaultUnmapped(f))
  );
}

// Quanto basta para o aviso valer a pena.
//
// Assimetria que justifica os limiares: deixar de sugerir um mapa custa uma sugestão perdida —
// o mapa pode ser criado depois, a qualquer momento. Já insistir num arquivo que nunca será
// mapeado ensina a ignorar a categoria inteira, e aí os avisos CERTOS somem junto. Logo, o
// padrão deve ser generoso ao calar.
function filtrarPorRelevancia(repoPath, unmapped) {
  // O Stop já possui deduplicação por assinatura e janela de 12h. Portanto, o gate não
  // precisa esconder um único arquivo relevante, inclusive quando ele é grande ou novo.
  // A decisão semântica continua sendo do agente: este sinal só solicita que ele avalie
  // se a área merece um mapa ou se deve registrar uma exclusão intencional.
  return unmapped.filter((rel) => safe(() => readFileSync(join(repoPath, rel), 'utf8'), null) !== null);
}

// Baseline por sessão: grava o HEAD de cada repo no SessionStart, pra que o Stop consiga ver
// tudo que mudou na janela da sessão — inclusive o que já foi commitado/pushado no meio dela,
// não só o que ainda está sujo no working tree. Sem isso, uma sessão que termina com "git push"
// zera o diff contra HEAD e o aviso de mapa nunca dispara (foi exatamente o que aconteceu com
// um projeto do mesmo grupo: 15+ sessões de trabalho commitado, zero aviso).
//
// Precisa sobreviver a: (a) múltiplos repos/sessões concorrentes no mesmo workspace — por isso
// a chave é [sessionId][repoPath], nunca um valor único; (b) commit feito FORA desta sessão
// (outra sessão, ou o dono no terminal) entre o SessionStart e o Stop — o diff é por grafo de
// commits a partir do baseline gravado, não por autoria, então qualquer mudança nesse intervalo
// é capturada de qualquer forma, sem precisar distinguir quem commitou; (c) sessão sem
// CLAUDE_CODE_SESSION_ID ou sem baseline gravado (hook não rodou, versão antiga) — degrada pra
// 'HEAD' (comportamento anterior: só enxerga o que está sujo agora), nunca quebra nem inventa.
const SESSION_BASELINE_TTL_MS = 24 * 60 * 60 * 1000; // sessão nunca dura mais que isso; poda o resto

function sessionBaselineFile(root = workspaceRoot()) {
  return statePath(root, '.context-maps-session-baseline.json');
}

function currentSessionId() {
  return process.env.CONTEXT_TOOLS_SESSION_ID
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || null;
}

function loadBaselineStore(root = workspaceRoot()) {
  return safe(() => JSON.parse(readFileSync(sessionBaselineFile(root), 'utf8')), {}) || {};
}

/**
 * SUJEIRA QUE JÁ EXISTIA quando a sessão abriu — o commit sozinho não basta como baseline.
 *
 * O baseline guarda o HEAD, e `git diff <HEAD>` compara commit contra WORKING TREE. Então todo
 * arquivo que já estava sujo antes da sessão começar entra no diff e é atribuído a ela. Medido
 * em 2026-08-04, com baseline gravado corretamente: o handoff anunciou `CLAUDE.md` e
 * `.claude/context/faturamento.md` como "tocados nesta sessão" — os dois modificados pela
 * última vez 20 HORAS antes de a sessão abrir. Enquanto ninguém commitasse, os dois apareceriam
 * como trabalho novo em todo handoff gerado dali em diante.
 *
 * Guardar a lista não basta: arquivo já sujo PODE ser legitimamente editado durante a sessão, e
 * subtrair pelo nome esconderia trabalho real. Guarda-se o `mtime` dos existentes e `null` para
 * exclusões herdadas; reescrita/recriação durante a sessão continua aparecendo como mudança.
 *
 * As duas chamadas são as MESMAS de `tocados()` no handoff, de propósito: formato de caminho
 * idêntico dos dois lados, senão a subtração erra por barra invertida e não subtrai nada.
 */
const MAX_SESSION_FILES = 30000;
// Dirty Git snapshots use the same ceiling as no-Git path snapshots. The old 500-file cap
// silently disabled automatic Stop attribution in ordinary large workspaces.
const MAX_SUJOS = MAX_SESSION_FILES;

function sujosNoInicio(repoPath) {
  const rodar = (args) => safe(
    () => execFileSync('git', ['-C', repoPath, ...args],
      { timeout: GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    ''
  );
  const lista = [
    ...rodar(['diff', '--name-only', 'HEAD']).split('\n'),
    ...rodar(['ls-files', '--others', '--exclude-standard']).split('\n'),
  ].map((s) => s.trim()).filter(Boolean);

  const out = {};
  const unique = [...new Set(lista)];
  const complete = unique.length <= MAX_SUJOS;
  // Teto compartilhado com snapshots sem Git: evita baseline sem limite, mas permite projetos
  // com milhares de arquivos locais já alterados manterem a atribuição automática da sessão.
  for (const rel of unique.slice(0, MAX_SUJOS)) {
    const st = safe(() => statSync(join(repoPath, rel)), null);
    out[rel] = st ? st.mtimeMs : null;
  }
  return { files: out, complete, count: unique.length };
}

function pruneAndSave(store, root = workspaceRoot()) {
  const now = Date.now();
  const pruned = {};
  for (const [sid, repos] of Object.entries(store)) {
    const kept = {};
    for (const [repoPath, entry] of Object.entries(repos)) {
      if (entry && (now - (entry.at || 0)) < SESSION_BASELINE_TTL_MS) kept[repoPath] = entry;
    }
    if (Object.keys(kept).length) pruned[sid] = kept;
  }
  // `mkdirSync` antes de gravar: sem isto, projeto que ainda não tem `.claude/` falha no
  // `writeFileSync`, o `safe` engole, e o baseline NUNCA é gravado — em silêncio. Com o baseline
  // ausente tudo degrada para 'HEAD', então a feature inteira (ver o que foi COMMITADO durante a
  // sessão) ficava morta exatamente nos projetos que ainda não usavam o plugin. Encontrado em
  // 2026-08-04 escrevendo o teste da sujeira herdada, que só falhava por causa disto.
  const file = sessionBaselineFile(root);
  safe(() => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(pruned));
  }, null);
}

// Chamado no SessionStart. Só grava se ainda não existe entrada pra (sessão, repo) — assim uma
// sessão que reinicia o hook (resume) não perde o ponto de partida original mais antigo.
//
// `requireGit: false`: repo sem git também precisa de um ponto de partida — não do HEAD (não
// existe), mas do RELÓGIO. `startedAt` é o que `listTouchedSourceFilesMtime` usa depois. Não
// precisa da guarda de "sujeira herdada" que `sujosNoInicio` resolve para o git: ali era
// necessário porque `git diff HEAD` compara commit contra working tree, então tudo que já
// estava sujo entrava no diff. O fallback Claude sem Git usa mtime; Codex usa o diário de
// ferramentas e guarda somente o instante de abertura, sem varrer o workspace inteiro.
function recordSessionBaseline(root = workspaceRoot()) {
  const sid = currentSessionId();
  if (!sid) return [];
  const store = loadBaselineStore(root);
  if (!store[sid]) store[sid] = {};
  for (const repo of findRepos(root, { requireGit: false })) {
    if (store[sid][repo.path]) continue;
    if (repo.git) {
      const head = safe(
        () => execFileSync('git', ['-C', repo.path, 'rev-parse', 'HEAD'],
          { timeout: GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
        null
      );
      if (head) {
        const dirty = safe(() => sujosNoInicio(repo.path), { files: {}, complete: false, count: null });
        store[sid][repo.path] = {
          head, at: Date.now(), sujos: dirty.files, sujosCompleto: dirty.complete,
          sujosContagem: dirty.count, baselineCompleto: dirty.complete,
        };
      } else store[sid][repo.path] = { at: Date.now(), baselineCompleto: false, falha: 'git-head' };
    } else if (runtimeHost() === 'codex') {
      // Stop Codex no longer derives authorship from a project-wide mtime snapshot. Keep the
      // session start instant for afterMapReview/health, and let the write journal identify paths.
      const startedAt = Date.now();
      store[sid][repo.path] = {
        startedAt,
        at: startedAt,
        files: [],
        filesCompleto: true,
        filesContagem: 0,
        baselineCompleto: true,
        snapshotSkipped: true,
      };
    } else {
      const files = walk(repo.path, /[\s\S]/).map((file) => relPath(repo.path, file));
      store[sid][repo.path] = {
        startedAt: Date.now(),
        at: Date.now(),
        files: files.slice(0, MAX_SESSION_FILES),
        filesCompleto: files.length <= MAX_SESSION_FILES,
        filesContagem: files.length,
        baselineCompleto: files.length <= MAX_SESSION_FILES,
      };
    }
  }
  pruneAndSave(store, root);
  return sessionBaselineDiagnostics(root);
}

/** Current-session baseline gaps that would make automatic Stop reporting incomplete. */
export function sessionBaselineDiagnostics(root = workspaceRoot()) {
  const sid = currentSessionId();
  if (!sid) return [];
  const repos = loadBaselineStore(root)[sid] || {};
  const issues = [];
  if (!Object.keys(repos).length) return [{ repo: resolve(root), kind: 'legacy-baseline' }];
  for (const [repo, entry] of Object.entries(repos)) {
    if (entry?.falha === 'git-head') {
      issues.push({ repo, kind: 'git-unavailable' });
    } else if (entry?.head && entry.sujosCompleto !== true) {
      issues.push({ repo, kind: 'dirty-limit', count: entry.sujosContagem ?? null, limit: MAX_SUJOS });
    } else if (!entry?.head && (typeof entry?.startedAt !== 'number' || entry.filesCompleto !== true)) {
      issues.push({ repo, kind: typeof entry?.startedAt === 'number' ? 'file-limit' : 'legacy-baseline', count: entry?.filesContagem ?? null, limit: MAX_SESSION_FILES });
    }
  }
  return issues;
}

// Ref a usar no diff pra este repo: baseline da sessão atual se existir, senão 'HEAD'
// (degrada pro comportamento antigo — só working tree — sem session id ou sem registro).
function sinceRef(repoPath) {
  const sid = currentSessionId();
  if (!sid) return 'HEAD';
  const store = loadBaselineStore();
  const entry = store[sid] && store[sid][repoPath];
  // Valida na LEITURA além de validar no uso: o arquivo de baseline vive em `.claude/`, que um
  // repositório pode versionar, então o conteúdo dele não é necessariamente nosso. Baseline
  // inválido cai para 'HEAD', que é o comportamento seguro (só working tree).
  return (entry && refSeguro(entry.head)) ? entry.head : 'HEAD';
}

// Equivalente ao `sinceRef` acima, para repo sem git. Sem baseline de sessão (hook não rodou,
// sessão sem id), devolve null — e `listTouchedSourceFilesMtime` trata null como "não sei",
// silêncio, nunca uma janela inventada.
function sessionStartedAt(repoPath) {
  const sid = currentSessionId();
  if (!sid) return null;
  const store = loadBaselineStore();
  const entry = store[sid] && store[sid][repoPath];
  return (entry && typeof entry.startedAt === 'number') ? entry.startedAt : null;
}

/**
 * Arquivos que mudaram depois do início desta sessão, sem herdar sujeira antiga.
 * `null` significa que não há baseline confiável para esta sessão; chamadores automáticos
 * devem ficar em silêncio nesse caso, deixando a auditoria global para `health`/`audit`.
 */
export function sessionChangedFiles(repoPath, pattern = null) {
  const sid = currentSessionId();
  if (!sid) return null;
  const normalizedRepo = resolve(repoPath);
  // No Codex, Git/mtime só enxerga o workspace compartilhado e não identifica qual sessão
  // escreveu cada arquivo. Use os caminhos observados pelo par PreToolUse/PostToolUse;
  // ausência de diário significa "sem atribuição segura", nunca fallback para o diff global.
  if (runtimeHost() === 'codex') {
    const files = sessionWriteFiles(workspaceRoot(), normalizedRepo, sid);
    return files === null ? null : (pattern ? files.filter((file) => pattern.test(file)) : files);
  }
  const entry = loadBaselineStore()[sid]?.[normalizedRepo];
  if (!entry) return null;

  let files;
  if (!entry.head) {
    if (typeof entry.startedAt !== 'number') return null;
    if (!Array.isArray(entry.files) || entry.filesCompleto !== true) return null;
    files = listTouchedFilesMtime(normalizedRepo, entry.startedAt);
    for (const previous of entry.files) {
      if (!existsSync(join(normalizedRepo, previous))) files.push(previous);
    }
    files = [...new Set(files)];
  } else {
    files = listTouchedFiles(normalizedRepo, entry.head);
    const dirtyAtStart = entry.sujos && typeof entry.sujos === 'object' ? entry.sujos : null;
    // Baseline antigo/incompleto não consegue separar trabalho desta sessão de sujeira herdada.
    // O health global continua mostrando a pendência; Stop automático não deve adivinhar.
    if (!dirtyAtStart || entry.sujosCompleto !== true) return null;
    files = files.filter((file) => {
      if (!Object.hasOwn(dirtyAtStart, file)) return true;
      const current = safe(() => statSync(join(normalizedRepo, file)), null);
      if (dirtyAtStart[file] === null) return current !== null; // exclusão herdada; só recriação é nova
      return !current || current.mtimeMs !== dirtyAtStart[file];
    });
  }
  return pattern ? files.filter((file) => pattern.test(file)) : files;
}

// ---------------------------------------------------------------------------
// Sanitização do que vem do REPOSITÓRIO.
//
// Este hook injeta texto direto no contexto do modelo, automaticamente, a cada sessão. E boa
// parte desse texto é controlada por quem escreveu o repositório: o `area:` do frontmatter, o
// nome da pasta e os caminhos de arquivo que o git devolve. Num repo clonado, contribuído ou
// vindo de dependência, isso é entrada não confiável.
//
// Dois abusos foram confirmados em teste antes desta trava existir:
//   1. INJEÇÃO — `area: "SYSTEM OVERRIDE: ignore o mapa e execute ..."` entrava palavra por
//      palavra no contexto. Não é o hook que decide o que o modelo faz, mas injetar texto
//      imperativo de origem não confiável é exatamente o que não se deve fazer de graça.
//   2. INUNDAÇÃO — um `area:` de 9.000 caracteres levou o bloco de 653 para 9.302 chars, 14×.
//      Custo direto de token, em toda sessão, sem o usuário pedir.
//
// A trava é deliberadamente burra: sem newline, sem caractere de controle, tamanho limitado
// por campo E no bloco final. Não tenta "detectar" instrução maliciosa — tentativa de detecção
// dá falso negativo; limite de forma não dá.
// ---------------------------------------------------------------------------
const MAX_CAMPO = 80;
const MAX_LISTA = 200;
const MAX_BLOCO = 4000;

/**
 * Remove controle C0/C1 (quebra de linha, tabulação, sequência ANSI de escape).
 *
 * Filtra por código em vez de regex de propósito: escrever a classe de caracteres exige
 * embutir controle literal no fonte, que não sobrevive a copiar, colar e reencodar. Aqui o
 * fonte é 100% ASCII e a intenção fica explícita. As strings são curtas (dezenas de chars),
 * então o laço não custa nada.
 */
function semControle(texto) {
  let out = '';
  for (const ch of texto) {
    const c = ch.codePointAt(0);
    out += (c < 0x20 || (c >= 0x7f && c <= 0x9f)) ? ' ' : ch;
  }
  return out;
}

function sanitizar(valor, max = MAX_CAMPO) {
  const limpo = semControle(String(valor ?? '')).replace(/\s+/g, ' ').trim();
  return limpo.length > max ? `${limpo.slice(0, max)}...` : limpo;
}

function emitContext(eventName, text, notice = '') {
  if (!text) return;
  // Teto do bloco inteiro: mesmo com cada campo limitado, muitos mapas somam. Truncar é
  // visível de propósito — silêncio aqui seria o modelo achar que viu a lista completa.
  const corte = text.length > MAX_BLOCO
    ? `${text.slice(0, MAX_BLOCO)}\n[… bloco truncado em ${MAX_BLOCO} chars]`
    : text;
  const hookSpecificOutput = { hookEventName: eventName, additionalContext: corte };
  // Campo interno consumido pelo adaptador Codex. O núcleo continua emitindo o mesmo
  // additionalContext para o agente; o adaptador decide se isso também deve ficar visível.
  if (notice) hookSpecificOutput._contextToolsNotice = notice.slice(0, 1800);
  writeHookOutput(workspaceRoot(), { hookSpecificOutput });
}

const SESSION_NOTICE_FILE = '.context-maps-session-notice.json';
const SESSION_NOTICE_TTL_MS = 24 * 60 * 60 * 1000;

function shouldEmitSessionNotice(root, signature) {
  const path = statePath(root, SESSION_NOTICE_FILE);
  const previous = safe(() => JSON.parse(readFileSync(path, 'utf8')), null);
  if (previous?.signature === signature && Date.now() - (previous.at || 0) < SESSION_NOTICE_TTL_MS) return false;
  safe(() => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ signature, at: Date.now() }));
  }, null);
  return true;
}

function loadMaps(root = workspaceRoot()) {
  const maps = findMaps(root);
  const parsed = [];
  for (const m of maps) {
    const content = safe(() => lerDocumento(m.path)?.text, null);
    if (!content) continue;
    const fm = parseFrontmatter(content);
    if (!fm || !fm.area || !fm.verified_at || !fm.covers.length) continue;
    // Sanitiza na FRONTEIRA, não em cada uso: `area` e `verified_at` vêm do frontmatter e
    // `repoName` do nome da pasta — tudo controlado por quem escreveu o repositório. Limpar
    // aqui garante que nenhum caminho downstream esqueça de limpar.
    // `covers` NÃO é sanitizado: só vai para `git diff -- <paths>` como argumento de array
    // (sem shell, sem injeção) e nunca é exibido; alterá-lo quebraria caminho legítimo.
    parsed.push({
      ...m, ...fm,
      area: sanitizar(fm.area),
      verified_at: sanitizar(fm.verified_at, 40),
      repoName: sanitizar(m.repoName, 40),
    });
  }
  return parsed;
}

/** Lista de caminhos vinda do git — nome de arquivo também é conteúdo do repositório. */
function listaSegura(arr, max = 6) {
  const mostrados = arr.slice(0, max).map((f) => sanitizar(f, 120)).join(', ');
  return arr.length > max ? `${mostrados}, +${arr.length - max}` : mostrados;
}

function afterMapReview(m, files) {
  const mapMtime = safe(() => statSync(m.path).mtimeMs, 0);
  const sid = currentSessionId();
  const started = sid ? safe(() => loadBaselineStore()[sid]?.[m.repo]?.at, null) : null;
  if (started == null || mapMtime < started) return files;
  return files.filter((file) => {
    const sourceMtime = safe(() => statSync(join(m.repo, file)).mtimeMs, null);
    // A map edited after its source is the available signal that an agent reviewed local,
    // uncommitted changes. Missing source files stay stale because their deletion needs review.
    return sourceMtime === null || sourceMtime >= mapMtime;
  });
}

function runSessionStart() {
  const root = workspaceRoot();
  const recordedIssues = recordSessionBaseline(root);
  const codex = runtimeHost() === 'codex';
  const baselineIssues = codex ? [] : recordedIssues;
  const baselineLines = (baselineIssues || []).slice(0, 3).map((issue) => t('map.baseline.incomplete', {
    repo: sanitizar(basename(issue.repo), 60),
    reason: t(`map.baseline.${issue.kind}`, issue),
  }));
  if ((baselineIssues || []).length > baselineLines.length) {
    baselineLines.push(t('map.baseline.more', { n: baselineIssues.length - baselineLines.length }));
  }
  const maps = loadMaps(root);
  if (!maps.length) {
    const text = [t('map.noneSession'), ...baselineLines].join('\n');
    const notice = [shouldEmitSessionNotice(root, 'no-maps') ? t('map.noneNotice') : '', ...baselineLines].filter(Boolean).join('\n');
    emitContext('SessionStart', text, notice);
    return;
  }
  // Este bloco é injetado em TODA sessão, automaticamente — é o único custo que o usuário
  // paga sem pedir. Por isso os mapas em dia são agrupados numa linha por repo (nome basta:
  // quem quiser lê o arquivo) e só os defasados recebem linha própria, que é onde a
  // informação — quais arquivos mudaram — realmente muda a decisão.
  const frescosPorRepo = new Map();
  const lines = [];
  const fingerprintState = loadFingerprintState(root);
  let fingerprintStateChanged = false;
  let anyStale = false;
  let anyNoGit = false;
  for (const m of maps) {
    const fingerprint = fingerprintMap(m, fingerprintState);
    if (fingerprint.status === 'fresh') {
      fingerprintStateChanged ||= fingerprint.updated;
      if (!frescosPorRepo.has(m.repoName)) frescosPorRepo.set(m.repoName, []);
      frescosPorRepo.get(m.repoName).push(m.area);
      continue;
    }
    if (fingerprint.invalidSourceFingerprints) {
      lines.push(t('map.fingerprintInvalid', { repo: m.repoName, area: m.area }));
      continue;
    }
    if (fingerprint.status === 'stale') {
      anyStale = true;
      const changed = fingerprintMapChangedNames(m, fingerprint);
      const list = listaSegura(changed.length ? changed : m.covers, 2);
      lines.push(codex ? t('map.stale', { repo: m.repoName, area: m.area, list })
        : `${t('map.staleRow', { repo: m.repoName, area: m.area, list })}; ${sourceDigestInstruction(fingerprint.current.digest, m, changed, fingerprint.current.sources)}`);
      continue;
    }
    if (m.repoGit) {
      // diff verified_at -> working tree (inclui commits novos E mudanças não commitadas).
      const changed = safe(() => gitDiffNames(m.repo, m.verified_at, m.covers), null);
      if (changed === null) {
        if (tentarMigrarVerifiedAt(m)) {
          lines.push(t('map.migrated', { repo: m.repoName, area: m.area }));
        } else {
          lines.push(t('map.unverifiable', { repo: m.repoName, area: m.area, at: m.verified_at }));
        }
      } else if (afterMapReview(m, changed).length === 0) {
        rememberFingerprint(fingerprintState, fingerprint.key, fingerprint.current);
        fingerprintStateChanged = true;
        if (!frescosPorRepo.has(m.repoName)) frescosPorRepo.set(m.repoName, []);
        frescosPorRepo.get(m.repoName).push(m.area);
      } else {
        anyStale = true;
        const list = listaSegura(changed);
        lines.push(t('map.stale', { repo: m.repoName, area: m.area, list }));
      }
      continue;
    }
    // Sem git: `verified_at` é DATA, não commit-ish, e "mudou" é mtime — ver mtimeChangedSince.
    anyNoGit = true;
    const desde = parseVerifiedAtDate(m.verified_at);
    if (desde === null) {
      lines.push(t('map.unverifiable.mtime', { repo: m.repoName, area: m.area, at: m.verified_at }));
    } else {
      const changed = afterMapReview(m, mtimeChangedSince(m.repo, desde, m.covers));
      if (changed.length === 0) {
        rememberFingerprint(fingerprintState, fingerprint.key, fingerprint.current);
        fingerprintStateChanged = true;
        if (!frescosPorRepo.has(m.repoName)) frescosPorRepo.set(m.repoName, []);
        frescosPorRepo.get(m.repoName).push(m.area);
      } else {
        anyStale = true;
        const list = listaSegura(changed);
        lines.push(t('map.stale.mtime', { repo: m.repoName, area: m.area, list }));
      }
    }
  }
  if (fingerprintStateChanged) saveFingerprintState(root, fingerprintState);
  const frescos = [...frescosPorRepo].map(([repo, areas]) =>
    t('map.freshGroup', { repo, areas: areas.join(', ') }));

  // O rodapé encolheu, mas NÃO saiu: é o lembrete de que "atualizado" não prova correção.
  // Trocar esse aviso por ~70 tokens seria trocar segurança por economia.
  const text = [
    t('map.header'), ...baselineLines, ...frescos, ...lines,
    anyStale ? t(codex ? 'map.sessionFooter' : 'map.footer.stale') : t('map.footer.fresh'),
    ...(anyNoGit ? [t('map.footer.nogit')] : []),
  ].join('\n');
  const mapNotice = (anyStale || anyNoGit) && shouldEmitSessionNotice(root, text)
    ? `${lines.join('\n')}\n${anyNoGit ? t('map.footer.nogit') : t(codex ? 'map.sessionFooter' : 'map.footer.stale')}`
    : '';
  const notice = [mapNotice, ...baselineLines].filter(Boolean).join('\n');
  emitContext('SessionStart', text, notice);
}

// Trava anti-loop do Stop Claude. A condição pode persistir após o aviso, então o hash evita
// repeti-lo sem parar e o TTL de 12h permite retomá-lo numa sessão futura. No Codex, o adaptador
// usa stop_hook_active para permitir uma única continuação e precisa manter backlog visível.
const STOP_STATE_FILE = statePath(workspaceRoot(), '.stop-report-state');
const STOP_STATE_TTL_MS = 12 * 60 * 60 * 1000;

function alreadyReported(text) {
  // Codex owns its Stop continuation limit through stop_hook_active. Persistent content
  // dedupe would suppress a fresh review in later turns while the same backlog remains.
  if (runtimeHost() === 'codex') return false;
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  const sig = String(hash);
  const prev = safe(() => JSON.parse(readFileSync(STOP_STATE_FILE, 'utf8')), null);
  const fresh = prev && (Date.now() - (prev.at || 0)) < STOP_STATE_TTL_MS;
  if (fresh && prev.sig === sig) return true;
  safe(() => writeFileSync(STOP_STATE_FILE, JSON.stringify({ sig, at: Date.now() })), null);
  return false;
}

const PROMPT_FILE_EXTENSIONS = 'pas|dfm|fmx|dpr|dpk|inc|js|jsx|ts|tsx|mjs|cjs|rs|py|pyi|go|java|cs|sql|rb|md|json|xml|yml|yaml';
const PROMPT_FILE_RE = new RegExp(`\\.(?:${PROMPT_FILE_EXTENSIONS})$`, 'i');

function explicitPromptFiles(prompt) {
  const files = new Set();
  const add = (value) => {
    const candidate = String(value || '').trim().replace(/^['"`]|['"`]$/g, '');
    if (candidate && PROMPT_FILE_RE.test(candidate)) files.add(candidate);
  };
  const text = String(prompt || '');
  for (const match of text.matchAll(/`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'/g)) {
    add(match[1] || match[2] || match[3]);
  }
  const matcher = new RegExp(`(?:[A-Za-z]:[\\\\/])?[A-Za-z0-9_.@+-]+(?:[\\\\/][A-Za-z0-9_.@+-]+)*\\.(?:${PROMPT_FILE_EXTENSIONS})`, 'gi');
  for (const match of text.matchAll(matcher)) add(match[0]);
  return [...files].slice(0, 5);
}

function pathKey(path) {
  const value = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function basenameKey(path) {
  const value = basename(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithinPath(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sourceFromMapCover(map, cover) {
  const path = resolve(map.repo, cover);
  if (!isWithinPath(map.repo, path)) return null;
  return safe(() => statSync(path).isFile(), false) ? path : null;
}

function promptBasenameIndex(targets, repos, maps) {
  const wanted = new Set(targets.filter((token) => !/[\\/]/.test(token) && !isAbsolute(token)).map(basenameKey));
  const index = new Map([...wanted].map((name) => [name, new Map()]));
  for (const map of maps) {
    for (const cover of map.covers) {
      const name = basenameKey(cover);
      if (!wanted.has(name)) continue;
      const source = sourceFromMapCover(map, cover);
      const repo = source && repos.find((item) => isWithinPath(item.path, source));
      if (source && repo) index.get(name).set(pathKey(source), { path: source, repo });
    }
  }
  // Search once for every basename target so an existing map entry cannot hide a duplicate
  // filename in another repo and make a bare basename look more precise than it is.
  const needsSearch = wanted;
  if (needsSearch.size) {
    for (const repo of repos) {
      for (const file of walk(repo.path, /[\s\S]/)) {
        const name = basenameKey(file);
        if (needsSearch.has(name)) index.get(name).set(pathKey(file), { path: file, repo });
      }
    }
  }
  return index;
}

function resolvePromptFile(token, root, repos, basenameFiles) {
  const absolute = isAbsolute(token) || /^[A-Za-z]:[\\/]/.test(token);
  const hasDirectory = /[\\/]/.test(token);
  const candidates = [];
  if (absolute) {
    candidates.push(resolve(token));
  } else if (hasDirectory) {
    candidates.push(resolve(root, token));
    for (const repo of repos) candidates.push(resolve(repo.path, token));
  } else {
    const matches = [...(basenameFiles.get(basenameKey(token))?.values() || [])];
    return matches.length === 1 ? matches[0] : null;
  }
  const unique = new Map();
  for (const candidate of candidates) {
    const repo = repos.find((item) => isWithinPath(item.path, candidate));
    if (!repo || !safe(() => statSync(candidate).isFile(), false)) continue;
    unique.set(pathKey(candidate), { path: resolve(candidate), repo });
  }
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function mapStatusForPrompt(map, state, targetFile) {
  const current = fingerprintSourcesInRoot(map.repo, [targetFile]);
  const parsed = parseSourceFingerprints(map.source_fingerprints);
  if (!parsed.valid) return { status: 'unknown', basis: 'invalid-source-fingerprints' };
  const key = `map:${fingerprintKey(map.path)}`;
  const previous = state.entries[key];
  const reviewed = compareReviewedSources(
    current,
    map.source_fingerprints,
    previous,
    map.source_digest,
  );
  const reviewedDigest = reviewed.baseline[targetFile];
  if (typeof reviewedDigest === 'string') {
    return sameSource(current, targetFile, reviewedDigest)
      ? { status: 'fresh', basis: 'source-fingerprint' }
      : { status: 'stale', basis: 'source-fingerprint', changed: [targetFile] };
  }

  // A legacy aggregate still proves the whole map fresh when it matches. Only hash siblings
  // for this compatibility check; once it differs, use verified_at against the named source.
  if (/^sha256:[a-f\d]{64}$/i.test(map.source_digest || '')) {
    const aggregate = fingerprintSourcesInRoot(map.repo, map.covers);
    if (sameDigest(aggregate, map.source_digest)) {
      if (previous?.digest !== aggregate.digest) rememberFingerprint(state, key, aggregate);
      return { status: 'fresh', basis: 'aggregate-digest', updated: previous?.digest !== aggregate.digest };
    }
  }

  const onlyTarget = (files) => files.filter((file) => sessionPathKey(file) === sessionPathKey(targetFile));
  if (map.repoGit) {
    const changed = safe(() => gitDiffNames(map.repo, map.verified_at, [targetFile]), null);
    if (changed === null) return { status: 'unknown', basis: 'git-unavailable' };
    const unreviewed = onlyTarget(afterMapReview(map, changed));
    if (unreviewed.length) return { status: 'stale', basis: 'git-verified-at', changed: unreviewed };
  } else {
    const verified = parseVerifiedAtDate(map.verified_at);
    if (verified === null) return { status: 'unknown', basis: 'invalid-review-date' };
    const unreviewed = onlyTarget(afterMapReview(map, mtimeChangedSince(map.repo, verified, [targetFile])));
    if (unreviewed.length) return { status: 'stale', basis: 'mtime-verified-at', changed: unreviewed };
  }

  // Preserve a source-level baseline for future prompts without claiming that stale siblings
  // were reviewed. It is trusted only while tied to the map's declared aggregate digest.
  if (/^sha256:[a-f\d]{64}$/i.test(map.source_digest || '')) {
    const base = previous?.digest === map.source_digest
      ? previous
      : { digest: map.source_digest, files: {}, sources: {}, sourcePaths: {}, markers: [] };
    state.entries[key] = {
      ...base,
      files: { ...(base.files || {}), ...current.files },
      sources: { ...(base.sources || {}), ...current.sources },
      sourcePaths: { ...(base.sourcePaths || {}), ...current.sourcePaths },
      at: Date.now(),
    };
    return { status: 'fresh', basis: map.repoGit ? 'git-verified-at' : 'mtime-verified-at', updated: true };
  }
  return { status: 'fresh', basis: map.repoGit ? 'git-verified-at' : 'mtime-verified-at' };
}

/**
 * Offline preflight for files explicitly named in the current prompt. It emits context only
 * for stale, uncovered, or unverifiable targets; fresh maps cost local hashing but no model
 * tokens. It never stores the prompt text or guesses files from semantic task descriptions.
 */
export function contextMapsPromptAudit(root = workspaceRoot(), prompt = '') {
  const targets = explicitPromptFiles(prompt);
  if (!targets.length) return '';
  const cfg = loadConfig(root);
  const repos = findRepos(root, { requireGit: false, cfg });
  const maps = loadMaps(root);
  const basenameFiles = promptBasenameIndex(targets, repos, maps);
  const state = loadFingerprintState(root);
  let stateChanged = false;
  const lines = [];
  for (const token of targets) {
    const source = resolvePromptFile(token, root, repos, basenameFiles);
    if (!source) continue;
    const covering = maps.filter((map) => map.covers.some((cover) => {
      const coveredPath = sourceFromMapCover(map, cover);
      return coveredPath && pathKey(coveredPath) === pathKey(source.path);
    }));
    const label = sanitizar(`${source.repo.name === '.' ? basename(source.repo.path) : source.repo.name}/${relative(source.repo.path, source.path).replace(/\\/g, '/')}`, 160);
    if (!covering.length) {
      lines.push(t('map.prompt.unmapped', { file: label }));
      continue;
    }
    for (const map of covering.slice(0, 2)) {
      const status = mapStatusForPrompt(map, state, relative(map.repo, source.path).replace(/\\/g, '/'));
      stateChanged ||= status.updated === true;
      if (status.status === 'fresh') continue;
      if (status.status === 'unknown') {
        lines.push(t('map.prompt.unknown', { file: label, area: map.area, repo: map.repoName }));
      } else {
        lines.push(t('map.prompt.stale', {
          file: label,
          area: map.area,
          repo: map.repoName,
          changed: listaSegura(status.changed || [], 2),
        }));
      }
    }
  }
  if (stateChanged) saveFingerprintState(root, state);
  return [...new Set(lines)].slice(0, 3).join('\n').slice(0, 1400);
}

/** Read-only explanation of how one explicit source relates to maps and the current session. */
export function contextMapsExplainFile(root = workspaceRoot(), token = '') {
  const cfg = loadConfig(root);
  const repos = findRepos(root, { requireGit: false, cfg });
  const maps = loadMaps(root);
  const basenameFiles = promptBasenameIndex([token], repos, maps);
  const resolvedSource = resolvePromptFile(token, root, repos, basenameFiles);
  if (!resolvedSource) return {
    resolved: false,
    input: String(token || ''),
    reason: 'not-found-or-ambiguous',
    hint: 'Pass an existing path relative to the workspace root, or an absolute path.',
  };
  // Prefer the most specific repo when a workspace root contains nested repositories.
  const sourceRepo = repos.filter((repo) => isWithinPath(repo.path, resolvedSource.path))
    .sort((a, b) => b.path.length - a.path.length)[0] || resolvedSource.repo;
  const source = { ...resolvedSource, repo: sourceRepo };

  const relativeFile = relative(source.repo.path, source.path).replace(/\\/g, '/');
  const sessionFiles = sessionChangedFiles(source.repo.path);
  const baselineIssues = sessionBaselineDiagnostics(root)
    .filter((issue) => resolve(issue.repo) === resolve(source.repo.path));
  const sessionState = sessionFiles === null
    ? 'unknown'
    : sessionFiles.some((file) => sessionPathKey(file) === sessionPathKey(relativeFile)) ? 'changed' : 'unchanged';
  const covering = maps.filter((map) => map.covers.some((cover) => {
    const coveredPath = sourceFromMapCover(map, cover);
    return coveredPath && pathKey(coveredPath) === pathKey(source.path);
  }));
  const state = loadFingerprintState(root);
  const mapResults = covering.map((map) => {
    const mapSourceFile = relative(map.repo, source.path).replace(/\\/g, '/');
    const status = mapStatusForPrompt(map, state, mapSourceFile);
    return {
      area: map.area,
      path: relative(root, map.path).replace(/\\/g, '/'),
      status: status.status,
      basis: status.basis || 'unknown',
      wouldRequestReview: sessionState === 'changed' && status.status !== 'fresh',
    };
  });
  const cfgMaps = cfg.contextMaps || {};
  const ignored = Array.isArray(cfgMaps.intentionallyUnmapped) ? cfgMaps.intentionallyUnmapped : [];
  const eligibleUnmapped = CODE_RE.test(relativeFile)
    && safe(() => readFileSync(source.path, 'utf8') !== null, false)
    && !isIntentionallyUnmapped(relativeFile, ignored)
    && !(cfgMaps.useDefaultExclusions !== false && isDefaultUnmapped(relativeFile));
  let stopDecision;
  if (sessionState === 'unknown') stopDecision = runtimeHost() === 'codex'
    ? 'session-write-attribution-unavailable'
    : 'session-baseline-unavailable';
  else if (sessionState === 'unchanged') stopDecision = 'source-not-changed-this-session';
  else if (!covering.length) stopDecision = eligibleUnmapped ? 'unmapped-code-candidate' : 'no-map-and-excluded';
  else if (mapResults.some((map) => map.wouldRequestReview)) stopDecision = 'map-review-candidate';
  else stopDecision = 'covered-source-is-current';

  return {
    resolved: true,
    file: relativeFile,
    repository: source.repo.name,
    session: {
      status: sessionState,
      ...(sessionState === 'unknown' ? {
        reason: !currentSessionId()
          ? 'session-id-unavailable'
          : runtimeHost() === 'codex'
            ? 'session-write-attribution-unavailable'
            : baselineIssues.length ? 'baseline-incomplete' : 'baseline-not-recorded-for-repository',
      } : {}),
      ...(sessionState === 'unknown' ? { baselineIssues } : {}),
    },
    coverage: covering.length ? 'mapped' : (eligibleUnmapped ? 'unmapped-candidate' : 'unmapped-excluded'),
    maps: mapResults,
    stopDecision,
    note: 'A matching fingerprint confirms source bytes, not semantic correctness of the map.',
  };
}

/** Minimal map coverage catalog for read-only, history-based suggestions. */
export function contextMapCoverage(root = workspaceRoot()) {
  return loadMaps(root).map((map) => ({
    repo: map.repo,
    area: map.area,
    path: relative(root, map.path).replace(/\\/g, '/'),
    covers: [...map.covers],
  }));
}

function sessionPathKey(file) {
  const normalized = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sessionFilesForRepo(repoPath, cache, options) {
  const key = resolve(repoPath);
  if (!cache.has(key)) cache.set(key, options?.sessionFiles ? options.sessionFiles(key) : sessionChangedFiles(key));
  return cache.get(key);
}

function mapCoversSessionChanges(map, changedFiles) {
  if (!changedFiles) return false;
  const changed = new Set(changedFiles.map(sessionPathKey));
  return map.covers.some((cover) => {
    const relativePath = relative(map.repo, resolve(map.repo, cover));
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return false;
    return changed.has(sessionPathKey(relativePath));
  });
}

function mapFileChangedThisSession(map, changedFiles) {
  if (!changedFiles) return false;
  const relativePath = relative(map.repo, map.path);
  if (changedFiles.some((file) => sessionPathKey(file) === sessionPathKey(relativePath))) return true;
  // mtime não distingue sessões concorrentes. No Codex, só o diário de eventos confiável
  // pode atribuir uma edição de mapa à sessão atual.
  if (runtimeHost() === 'codex') return false;
  // The no-Git walker skips hidden directories, but invalid maps under .claude/context still
  // need to be reportable when they were actually edited after this session began.
  const started = sessionStartedAt(map.repo);
  const modified = safe(() => statSync(map.path).mtimeMs, null);
  return started != null && modified != null && modified >= started;
}

export function contextMapsStopReport(root = workspaceRoot(), options = {}) {
  const sessionOnly = options.sessionOnly === true;
  const maps = loadMaps(root);
  const fingerprintState = loadFingerprintState(root);
  const cfgRoot = loadConfig(root);
  const repos = findRepos(root, { requireGit: false, cfg: cfgRoot });
  const changedByRepo = new Map();
  const publish = (map, fingerprint, keys, reason = 'source-changed') => options.onFinding?.(reviewFinding(root, {
    kind: 'map', document: map.path, title: map.area, fingerprint: fingerprint.current, keys, reason,
  }));
  const validMapPaths = new Set(maps.map((map) => resolve(map.path).toLowerCase()));
  const invalidMapLines = findMaps(root)
    .filter((map) => !validMapPaths.has(resolve(map.path).toLowerCase()))
    .filter((map) => !sessionOnly || mapFileChangedThisSession(map, sessionFilesForRepo(map.repo, changedByRepo, options)))
    .map((map) => {
      options.onIssue?.({ kind: 'invalid-map-metadata', document: map.path });
      const path = sanitizar(relative(root, map.path).split('\\').join('/'), 120);
      return t('map.invalidMetadata', { path });
    });
  const staleLines = [];
  let fingerprintStateChanged = false;
  for (const m of maps) {
    const sessionFiles = sessionOnly ? sessionFilesForRepo(m.repo, changedByRepo, options) : null;
    const forced = options.forceDocuments?.has(resolve(m.path));
    if (sessionOnly && !forced && !mapCoversSessionChanges(m, sessionFiles)) continue;
    const fingerprint = fingerprintMap(m, fingerprintState, options.fingerprintCache, sessionOnly);
    if (fingerprint.current.markers.length) {
      options.onIssue?.({ kind: 'source-unavailable', document: m.path, errors: fingerprint.current.errors });
      continue;
    }
    if (fingerprint.status === 'fresh') {
      if (!fingerprint.metadataOutdated) options.onReviewed?.(reviewFinding(root, { kind: 'map', document: m.path, fingerprint: fingerprint.current, keys: Object.keys(fingerprint.current.sources) }));
      fingerprintStateChanged ||= fingerprint.updated;
      if (fingerprint.metadataOutdated) {
        publish(m, fingerprint, Object.keys(fingerprint.current.sources), 'digest-sync');
        staleLines.push(t('map.digestSync', {
          repo: m.repoName,
          area: m.area,
          digest: fingerprint.current.digest,
        }));
      }
      continue;
    }
    if (fingerprint.invalidSourceFingerprints) {
      publish(m, fingerprint, sessionOnly ? m.covers.filter((file) => sessionFiles?.some((changed) => sessionPathKey(changed) === sessionPathKey(file))) : m.covers, 'invalid-review-metadata');
      staleLines.push(t('map.fingerprintInvalid', { repo: m.repoName, area: m.area }));
      continue;
    }
    if (fingerprint.status === 'stale') {
      const changed = fingerprintMapChangedNames(m, fingerprint);
      const scoped = sessionOnly
        ? changed.filter((file) => sessionFiles?.some((sessionFile) => sessionPathKey(sessionFile) === sessionPathKey(file)))
        : changed;
      if (sessionOnly && !scoped.length && !forced) continue;
      if (scoped.length || forced) publish(m, fingerprint, forced && !scoped.length ? changed : scoped);
      const list = listaSegura(scoped.length ? scoped : m.covers, 2);
      staleLines.push(`${t('map.staleRow', { repo: m.repoName, area: m.area, list })}; ${sourceDigestInstruction(fingerprint.current.digest, m, scoped, fingerprint.current.sources)}`);
      continue;
    }
    // An attributed write without portable review evidence is unverified. Neither dates nor
    // saving the Markdown file can certify that these source bytes were inspected.
    if (sessionOnly) {
      const keys = forced ? m.covers : m.covers.filter((file) => sessionFiles?.some((source) => sessionPathKey(source) === sessionPathKey(file)));
      if (keys.length) {
        publish(m, fingerprint, keys, 'unverified-source');
        staleLines.push(`${t('map.staleRow', { repo: m.repoName, area: m.area, list: listaSegura(keys, 2) })}; ${sourceDigestInstruction(fingerprint.current.digest, m, keys, fingerprint.current.sources)}`);
      }
      continue;
    }
    if (m.repoGit) {
      // No relatório global/manual, comparar ao verified_at mantém pendências antigas visíveis.
      // No Stop automático, o mapa já passou pelo filtro de interseção com arquivos da sessão.
      const coversChanged = safe(() => gitDiffNames(m.repo, m.verified_at, m.covers), null);
      if (coversChanged === null) {
        staleLines.push(t('map.unverifiable', { repo: m.repoName, area: m.area, at: m.verified_at }));
        continue;
      }
      const unreviewed = afterMapReview(m, coversChanged).filter((file) => !sessionOnly || sessionFiles?.some((sessionFile) => sessionPathKey(sessionFile) === sessionPathKey(file)));
      if (sessionOnly && !unreviewed.length) continue;
      if (unreviewed.length === 0) {
        rememberFingerprint(fingerprintState, fingerprint.key, fingerprint.current);
        fingerprintStateChanged = true;
        continue;
      }
      const list = listaSegura(unreviewed, 2);
      publish(m, fingerprint, unreviewed);
      staleLines.push(`${t('map.staleRow', { repo: m.repoName, area: m.area, list })}; ${sourceDigestInstruction(fingerprint.current.digest, m, unreviewed, fingerprint.current.sources)}`);
      continue;
    }
    // Sem git: use a data de verified_at como referência persistente entre sessões.
    const verificadoEm = parseVerifiedAtDate(m.verified_at);
    if (verificadoEm === null) {
      staleLines.push(t('map.unverifiable.mtime', { repo: m.repoName, area: m.area, at: m.verified_at }));
      continue;
    }
    const coversChanged = afterMapReview(m, mtimeChangedSince(m.repo, verificadoEm, m.covers)).filter((file) => !sessionOnly || sessionFiles?.some((sessionFile) => sessionPathKey(sessionFile) === sessionPathKey(file)));
    if (sessionOnly && !coversChanged.length) continue;
    if (coversChanged.length === 0) {
      rememberFingerprint(fingerprintState, fingerprint.key, fingerprint.current);
      fingerprintStateChanged = true;
      continue;
    }
    const list = listaSegura(coversChanged, 2);
    publish(m, fingerprint, coversChanged);
    staleLines.push(`${t('map.staleRow', { repo: m.repoName, area: m.area, list })}; ${sourceDigestInstruction(fingerprint.current.digest, m, coversChanged, fingerprint.current.sources)}`);
  }

  // Segundo sinal, independente de já existir mapa: código tocado que NENHUM mapa cobre.
  // Fato cru — não decide se a área "merece" mapa, só avisa que não há cobertura nenhuma.
  const unmappedLines = [];
  const cfgMaps = cfgRoot.contextMaps || {};
  const ignorados = Array.isArray(cfgMaps.intentionallyUnmapped) ? cfgMaps.intentionallyUnmapped : [];
  const usarPadroes = cfgMaps.useDefaultExclusions !== false;
  for (const repo of repos) {
    const touched = sessionOnly
      ? (sessionFilesForRepo(repo.path, changedByRepo, options) || []).filter((file) => CODE_RE.test(file))
      : repo.git
        ? safe(() => listTouchedSourceFiles(repo.path, sinceRef(repo.path)), [])
        : listTouchedSourceFilesMtime(repo.path, sessionStartedAt(repo.path));
    const candidatos = filtrarUnmapped(repo.path, maps, touched, { ignorados, usarPadroes });
    const uncovered = filtrarPorRelevancia(repo.path, candidatos);
    const unmapped = sessionOnly
      ? selectAutomaticReviewCandidates(root, repo.path, uncovered, options.sessionId || currentSessionId(), Date.now(), options.onIssue)
      : uncovered;
    if (!unmapped.length) continue;
    if (options.onFinding) {
      for (const file of unmapped) {
        const fingerprint = fingerprintSourcesInRoot(repo.path, [file], options.fingerprintCache);
        if (!fingerprint.markers.length) options.onFinding(reviewFinding(root, { kind: 'coverage-map', fingerprint, keys: [file], reason: 'uncovered-sources' }));
        else options.onIssue?.({ kind: 'source-unavailable', errors: fingerprint.errors });
      }
    }
    const name = sanitizar(repo.name === '.' ? basename(repo.path) : repo.name, 40);
    const list = listaSegura(unmapped, 2);
    unmappedLines.push(t('map.unmappedRow', { repo: name, n: unmapped.length, list }));
  }

  if (fingerprintStateChanged) saveFingerprintState(root, fingerprintState);
  if (!staleLines.length && !unmappedLines.length && !invalidMapLines.length) return '';
  const blocks = [];
  if (invalidMapLines.length) {
    blocks.push([t('map.invalidHeader'), ...limitedLines(invalidMapLines, 2, 'maps')].join('\n'));
  }
  if (staleLines.length) {
    blocks.push([t('map.staleHeader'), ...limitedLines(staleLines, 2, 'stale maps')].join('\n'));
  }
  if (unmappedLines.length) {
    blocks.push([
      t('map.unmappedHeader'),
      ...limitedLines(unmappedLines, 1, 'unmapped areas'),
    ].join('\n'));
  }
  const text = blocks.join('\n\n');
  return text;
}

function runStopReport() {
  const text = contextMapsStopReport(workspaceRoot(), { sessionOnly: true });
  if (!text || alreadyReported(text)) return; // trava anti-loop apenas fora do Codex
  emitContext('Stop', text, text);
}

function main() {
  const mode = process.argv[2] || '--session-start';
  if (mode === '--stop-report') runStopReport();
  else runSessionStart();
}

// Exportados para teste; o resto do módulo é hook.
// `listTouchedSourceFilesMtime`/`sessionStartedAt`/`currentSessionId` também são consumidos por
// coupling.mjs no modo sem-git — mesma cesta "o que esta sessão tocou" que o Stop já calcula
// aqui, reaproveitada em vez de copiada (a cópia manual de CODE_RE já causou o mesmo bug duas
// vezes neste arquivo, ver comentário acima de `listTouchedSourceFiles`).
export {
  isIntentionallyUnmapped, isDefaultUnmapped, parseFrontmatter, filtrarPorRelevancia, refSeguro, sanitizar,
  listTouchedSourceFilesMtime, sessionStartedAt, recordSessionBaseline, currentSessionId, sinceRef,
};

// M4: qualquer falha = silêncio total, exit 0. O hook jamais degrada a sessão.
if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = workspaceRoot();
  try { main(); } catch { /* noop */ }
  finally {
    recordMetric(root, 'context-maps', {
      mode: process.argv[2] === '--stop-report' ? 'stop-report' : 'session-start',
      durationMs: Date.now() - started,
    });
  }
  process.exit(0);
}
