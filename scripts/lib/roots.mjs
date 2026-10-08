// Descoberta automática de raiz, repositórios e pastas de código.
//
// Precisa funcionar em três modos, sem configuração:
//   1. plugin      — script vive fora do projeto; raiz vem de CLAUDE_PROJECT_DIR
//   2. standalone  — script copiado para <projeto>/.claude/scripts/; raiz é dois níveis acima
//   3. avulso      — rodado de qualquer lugar; raiz é o cwd (ou --root=)
//
// Suporta os dois layouts comuns: repositório único (raiz tem .git) e workspace com vários
// repositórios lado a lado (cada subpasta tem .git). Sem essa distinção o mesmo script não
// serve para os dois, que é o principal motivo de ferramenta assim não viajar entre projetos.

import { readdirSync, existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, sep, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', 'out',
  'vendor', 'target', '__pycache__', '.venv', 'venv', '.cache', 'tmp', '.claude', '.codex',
]);

/**
 * Extensões que o índice cross-file lê. FONTE ÚNICA — mora aqui, e não em `symbols.mjs`,
 * porque `outline.mjs` também precisa dela para a mensagem de "formato não coberto" e não pode
 * importar de `symbols.mjs` (que já importa `outline.mjs`: seria ciclo).
 *
 * Existe porque a lista repetida à mão no texto das mensagens JÁ MENTIU: Python e Go entraram
 * no índice em 2026-08-04 e o diagnóstico seguiu dizendo "Lê: js/…/rs" — afirmando não ler a
 * linguagem que acabara de passar a ler, e mandando o usuário embora sem motivo. Numa
 * ferramenta cuja tese é "falha visível", errar na própria mensagem de falha é o pior lugar.
 *
 * `.dfm`/`.fmx` NÃO entram: nome de componente de formulário afogaria a busca cross-file.
 * Eles são suportados só no `outline`.
 */
export const LANGUAGE_CAPABILITIES = Object.freeze([
  Object.freeze({ id: 'javascript', name: 'JavaScript/TypeScript', extensions: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'], parser: 'code', crossFile: true }),
  Object.freeze({ id: 'pascal', name: 'Delphi/Pascal', extensions: ['pas', 'dpr', 'dpk', 'inc'], parser: 'pascal', crossFile: true }),
  Object.freeze({ id: 'rust', name: 'Rust', extensions: ['rs'], parser: 'rust', crossFile: true }),
  Object.freeze({ id: 'python', name: 'Python', extensions: ['py', 'pyi'], parser: 'python', crossFile: true }),
  Object.freeze({ id: 'go', name: 'Go', extensions: ['go'], parser: 'go', crossFile: true }),
  Object.freeze({ id: 'delphi-form', name: 'Delphi forms', extensions: ['dfm', 'fmx'], parser: 'dfm', crossFile: false }),
  Object.freeze({ id: 'markdown', name: 'Markdown', extensions: ['md'], parser: 'markdown', crossFile: false }),
]);

export const EXTENSOES_CODIGO = LANGUAGE_CAPABILITIES
  .filter((c) => c.crossFile)
  .flatMap((c) => c.extensions);
export const EXTENSOES_LIDAS = EXTENSOES_CODIGO.join('/');
export const CODE_RE = new RegExp(`\\.(${EXTENSOES_CODIGO.join('|')})$`);

// Extensões que devem entrar em histórico/documentação mesmo quando ainda não têm parser local.
// Isso preserva a utilidade language-agnostic de coupling/audit sem fingir que symbols as lê.
export const EXTENSOES_HISTORICO = Object.freeze([
  ...EXTENSOES_CODIGO, 'rb', 'java', 'kt', 'php', 'cs', 'sql', 'swift', 'scala',
]);
export const HISTORY_CODE_RE = new RegExp(`\\.(${EXTENSOES_HISTORICO.join('|')})$`);

export function capabilityForExtension(ext) {
  const e = String(ext || '').replace(/^\./, '').toLowerCase();
  return LANGUAGE_CAPABILITIES.find((c) => c.extensions.includes(e)) || null;
}

/** Texto que chega ao modelo: remove controle/ANSI e limita campos de origem não confiável. */
export function sanitizeModelText(value, max = 120) {
  let out = '';
  for (const ch of String(value ?? '')) {
    const c = ch.codePointAt(0);
    out += (c < 0x20 || (c >= 0x7f && c <= 0x9f)) ? ' ' : ch;
  }
  out = out.replace(/\\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

// Não existe mais lista de "pastas de código prováveis": ver `sourceDirs`. Adivinhar onde o
// código mora escondia repositórios inteiros em silêncio; hoje varre-se tudo menos `IGNORED`.
/** Onde documentação costuma morar. */
const DOC_HINTS = ['docs', 'doc', 'documentation'];

export function scriptDir() {
  return dirname(dirname(fileURLToPath(import.meta.url)));   // .../scripts
}

/** Host da integração atual. Ausência mantém exatamente o comportamento Claude anterior. */
export function runtimeHost(env = process.env, script = process.argv[1]) {
  if (env.CONTEXT_TOOLS_HOST === 'codex') return 'codex';
  if (env.CONTEXT_TOOLS_HOST === 'claude') return 'claude';

  // Os scripts standalone são executados diretamente pela skill. Nesse caminho não existe o
  // adaptador codex-hook para injetar CONTEXT_TOOLS_HOST; o diretório instalado é a fonte segura
  // para decidir qual configuração o comando deve carregar.
  const caminho = String(script || '').replace(/\\/g, '/');
  if (/(^|\/)\.codex\/scripts\//i.test(caminho)) return 'codex';
  return 'claude';
}

/** Diretório de estado gerado: isolado por host para uma instalação não interferir na outra. */
export function stateDir(root) {
  if (process.env.CONTEXT_TOOLS_STATE_DIR) return resolve(process.env.CONTEXT_TOOLS_STATE_DIR);
  return runtimeHost() === 'codex'
    ? join(root, '.codex', 'context-tools')
    : join(root, '.claude');
}

export function statePath(root, ...parts) {
  return join(stateDir(root), ...parts);
}

/** Caminho relativo usado para excluir o estado do próprio agente dos handoffs. */
export function stateRelPrefix(root) {
  const rel = relative(root, stateDir(root)).replace(/\\/g, '/').replace(/\/+$/, '');
  return rel ? `${rel}/` : '';
}

/**
 * "Fui chamado direto na linha de comando?" — guarda obrigatória em todo script que roda
 * `main()` no topo. Sem ela, importar o módulo (para teste, ou para reusar uma função)
 * dispara `main()` + `process.exit(0)` como efeito colateral e o processo morre calado.
 *
 * Compara caminho RESOLVIDO, não basename: existem duas cópias de cada script (a fonte e a
 * instalada em `.claude/scripts/`), e comparar só o nome do arquivo confundiria as duas.
 */
export function isMain(importMetaUrl) {
  try {
    if (!process.argv[1]) return false;
    return resolve(fileURLToPath(importMetaUrl)) === resolve(process.argv[1]);
  } catch { return false; }
}

/**
 * Raiz do trabalho. Ordem: --root= > CLAUDE_PROJECT_DIR > cwd que contenha repo >
 * dois níveis acima do script (layout standalone .claude/scripts) > cwd.
 */
export function resolveRoot(argv = process.argv) {
  const flag = argv.find((a) => a.startsWith('--root='));
  if (flag) return resolve(flag.slice('--root='.length));

  if (process.env.CONTEXT_TOOLS_PROJECT_DIR && existsSync(process.env.CONTEXT_TOOLS_PROJECT_DIR)) {
    return resolve(process.env.CONTEXT_TOOLS_PROJECT_DIR);
  }

  if (process.env.CLAUDE_PROJECT_DIR && existsSync(process.env.CLAUDE_PROJECT_DIR)) {
    return resolve(process.env.CLAUDE_PROJECT_DIR);
  }

  const cwd = process.cwd();
  if (looksLikeRoot(cwd)) return cwd;

  // standalone: <raiz>/.claude/scripts/lib/roots.mjs  →  sobe até <raiz>
  const standalone = dirname(dirname(scriptDir()));
  if (looksLikeStandalone(standalone) || looksLikeRoot(standalone)) return standalone;

  // sobe do cwd procurando um repo ou workspace
  let cur = cwd;
  for (let i = 0; i < 6; i++) {
    const up = dirname(cur);
    if (up === cur) break;
    if (looksLikeRoot(up)) return up;
    cur = up;
  }
  return cwd;
}

function looksLikeRoot(dir) {
  if (!existsSync(dir)) return false;
  if (isGitRepo(dir)) return true;
  return safe(() => readdirSync(dir, { withFileTypes: true }), [])
    .some((e) => e.isDirectory() && !IGNORED.has(e.name) && isGitRepo(join(dir, e.name)));
}

function looksLikeStandalone(dir) {
  return existsSync(join(dir, '.claude', 'scripts', 'lib', 'roots.mjs'))
    || existsSync(join(dir, '.codex', 'scripts', 'lib', 'roots.mjs'));
}

/**
 * A presenca de `.git` nao basta: pode ser uma pasta vazia, metadado corrompido ou um
 * repositorio que o Git instalado nao consegue abrir. Validar aqui preserva o fallback sem Git.
 * A raiz devolvida pelo Git tambem precisa ser a propria pasta, para nao aceitar um repositorio
 * pai por engano quando o `.git` local estiver quebrado.
 */
export function isGitRepo(dir) {
  if (!existsSync(join(dir, '.git'))) return false;
  const topo = safe(() => execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
    timeout: 1000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim(), '');
  if (!topo) return false;
  return samePath(topo, dir);
}

/**
 * Identidade de caminho no disco. O Git devolve `--show-toplevel` já resolvido (symlink,
 * junction, nome curto 8.3), enquanto `os.tmpdir()`/cwd podem chegar pelo apelido: no macOS
 * `/var/...` é `/private/var/...`; no Windows o TEMP do runner é `C:\Users\RUNNER~1\...`.
 * Comparar a string crua fazia um repositório válido parecer "sem git" e os hooks ficavam
 * calados. `realpathSync.native` canoniza os dois lados; se falhar, cai no `resolve`.
 */
export function canonicalPath(p) {
  const abs = resolve(String(p));
  const real = safe(() => realpathSync.native(abs), abs);
  const semBarra = real.replace(/(.)[\\/]+$/, '$1');
  return process.platform === 'win32' ? semBarra.toLowerCase() : semBarra;
}

export function samePath(a, b) {
  return canonicalPath(a) === canonicalPath(b);
}

/**
 * Repos adicionais, declarados EXPLICITAMENTE em `extraRepos` (`.claude/context-tools.json`).
 *
 * Existe para o caso que nem a raiz sozinha nem o workspace-misto (acima) resolvem: um
 * monorepo lado a lado com MUITOS outros projetos, onde abrir a sessão na pasta pai (que
 * deixaria `findRepos` achar tudo sozinho) traria ruído demais — a raiz PRECISA continuar
 * sendo um projeto específico, não o workspace inteiro. Caso real: sessão precisa ficar em
 * `AppServer`, mas só uns poucos vizinhos (`AppConnection`, `shared`) importam; os
 * outros dezenas de projetos na mesma pasta pai não deveriam entrar no índice.
 *
 * `extraRepos` é o OPOSTO de `sourceDirs`: ali a saída do projeto é sempre recusada (proteção
 * contra `.claude/context-tools.json` hostil apontando pra fora); aqui a saída é o PONTO. O
 * limite que sobra é a SUBÁRVORE: qualquer caminho tem que resolver para dentro da pasta PAI da
 * raiz (a mesma pasta que já contém a raiz) — `../AppConnection` e
 * `../AppConnection/algo/mais/fundo` passam, `../../qualquer-coisa` (sobe mais um nível,
 * sai da subárvore do pai) é recusado. Isso não fecha o vetor por completo (um
 * `context-tools.json` hostil ainda pode nomear qualquer pasta que já esteja ao lado do
 * projeto, se ela existir), mas limita o estrago ao que já está na mesma pasta pai, nunca à
 * árvore inteira do disco.
 *
 * **Sem `extraRepos` configurado à mão, deriva de um `.code-workspace` do VS Code** (ver
 * `extraReposDoCodeWorkspace`) — quem já monta workspace multi-root no editor já fez essa
 * curadoria uma vez; pedir para repetir numa segunda config, editada à mão, é atrito puro e
 * mais uma fonte pra desatualizar. Config explícita sempre vence: a chave `extraRepos`
 * PRESENTE (mesmo vazia) desliga a detecção automática — é a forma de dizer "decidi não usar
 * nenhum" sem que o `.code-workspace` volte a valer.
 */
export function resolveExtraRepos(root, cfg = {}) {
  if (Array.isArray(cfg.extraRepos)) {
    const pai = resolve(root, '..');
    const out = [];
    for (const d of cfg.extraRepos) {
      const abs = resolve(root, String(d));
      if (abs !== pai && !abs.startsWith(pai + sep)) {
        process.stderr.write(`context-tools: extraRepos "${d}" sai de mais de um nível acima da raiz — ignorado\n`);
        continue;
      }
      if (!safe(() => statSync(abs).isDirectory(), false)) {
        process.stderr.write(`context-tools: extraRepos "${d}" não existe ou não é uma pasta — ignorado\n`);
        continue;
      }
      out.push(abs);
    }
    return out;
  }
  return extraReposDoCodeWorkspace(root);
}

/**
 * Deriva `extraRepos` automaticamente de um `*.code-workspace` do VS Code, quando o usuário
 * não configurou nada à mão (ver `resolveExtraRepos`, que decide quando chamar isto).
 *
 * Procura em duas pastas, nesta ordem: a própria raiz, depois a pasta PAI dela — o arquivo
 * pode estar salvo dentro de um dos projetos ou solto na pasta que contém todos (é assim que o
 * VS Code deixa o usuário escolher). Usa o PRIMEIRO `.code-workspace` que achar com pelo menos
 * uma pasta válida; múltiplos arquivos seriam ambíguos, e desambiguar é conversa (trabalho do
 * agente que lê a sessão), não algo que este script headless possa decidir sozinho.
 *
 * `folders[].path` no formato do VS Code é relativo ao PRÓPRIO ARQUIVO `.code-workspace`, não
 * à raiz do projeto — resolve a partir de onde o arquivo está. Mesma trava de
 * `resolveExtraRepos`: só aceita o que fica dentro da subárvore da pasta PAI da raiz, e só
 * pasta que existe de verdade; a própria raiz é descartada da lista (não é "extra").
 */
export function extraReposDoCodeWorkspace(root) {
  const pai = resolve(root, '..');
  for (const dir of [root, pai]) {
    const arquivo = safe(() => readdirSync(dir).find((f) => f.endsWith('.code-workspace')), null);
    if (!arquivo) continue;
    const conteudo = safe(() => JSON.parse(readFileSync(join(dir, arquivo), 'utf8')), null);
    if (!conteudo || !Array.isArray(conteudo.folders)) continue;
    const out = [];
    for (const f of conteudo.folders) {
      const p = f && typeof f.path === 'string' ? f.path : null;
      if (!p) continue;
      const abs = resolve(dir, p);
      if (resolve(abs) === resolve(root)) continue;
      if (abs !== pai && !abs.startsWith(pai + sep)) continue;
      if (!safe(() => statSync(abs).isDirectory(), false)) continue;
      out.push(abs);
    }
    if (out.length) return out;
  }
  return [];
}

/**
 * Repositórios sob a raiz. Cobre repo único (a própria raiz) e workspace multi-repo.
 * `name` é sempre relativo e legível; `path` é absoluto; `git` diz se há versionamento.
 *
 * `requireGit` (padrão true) existe porque os consumidores se dividem em dois grupos:
 * quem PRECISA de git (context-maps, coupling — leem histórico/diff) e quem só precisa
 * dos ARQUIVOS (symbols, audit-docs). Sem essa distinção, projeto sem versionamento —
 * ou com svn/hg — recebia "nenhum arquivo de código encontrado" e a ferramenta ficava
 * 100% morta, mesmo para as perguntas que não dependem de git.
 */
export function findRepos(root, { requireGit = true, cfg = {}, gitProbe = isGitRepo } = {}) {
  // O probe é injetável para testes que não podem criar processos filhos; em produção, o default
  // sempre valida pelo Git real.
  const isRepo = typeof gitProbe === 'function' ? gitProbe : isGitRepo;
  const out = [];
  const rootTemGit = isRepo(root);
  if (rootTemGit) out.push({ name: '.', path: root, git: true });
  const semGit = [];
  for (const e of safe(() => readdirSync(root, { withFileTypes: true }), [])) {
    if (!e.isDirectory() || IGNORED.has(e.name)) continue;
    if (isRepo(join(root, e.name))) out.push({ name: e.name, path: join(root, e.name), git: true });
    else semGit.push(e.name);
  }
  /**
   * Workspace MISTO: a raiz não tem `.git`, mas pelo menos uma subpasta tem e outra(s) não.
   *
   * Sem isto, as subpastas sem `.git` eram descartadas em SILÊNCIO — o `if (out.length ||
   * requireGit) return out` abaixo só caía no fallback "trata a raiz como projeto único sem
   * git" quando NENHUMA subpasta em lugar nenhum tivesse `.git`; bastava UM repo git existir
   * no workspace para apagar todo vizinho sem versionamento da lista, mesmo com
   * `requireGit: false` passado explicitamente (o flag só relaxava o caso "zero git em
   * qualquer lugar", nunca o caso misto).
   *
   * Caso real (2026-08-05): workspace Delphi com `AppServer` (tem `.git`) e três
   * dependências-irmãs — `AppConnection`, `AppDesktop`, `shared` — sem `.git` próprio,
   * só pastas soltas do mesmo workspace. `symbols.mjs` respondia "nenhuma definição" para um
   * símbolo real (`TExporter.RegistroXYZ`) que existia dentro de `AppConnection`: a pasta
   * nunca chegava a entrar em `findRepos`, então nunca era varrida — não era bug de parser
   * nem de escopo de sessão, era este gate.
   *
   * Só dispara quando a RAIZ também não tem `.git`: se a raiz tiver, `sourceDirs(root)` já
   * devolve a raiz inteira e o `walk` recursivo já cobre as subpastas sem `.git` sozinho —
   * adicioná-las de novo aqui duplicaria arquivo.
   */
  if (!requireGit && !rootTemGit && out.length && semGit.length) {
    for (const nome of semGit) out.push({ name: nome, path: join(root, nome), git: false });
  }

  // Uma configuração explícita de `extraRepos` fixa a sessão nesta raiz, mesmo quando o
  // projeto não tem `.git` próprio. Sem esta entrada, a lista começa vazia, os extras entram
  // abaixo e a raiz some do índice — exatamente o caso de um projeto Delphi sem versionamento
  // local acompanhado por dependências irmãs. O workspace misto continua preservado: quando há
  // repositórios Git filhos, a raiz sem Git segue sendo apenas a pasta de agrupamento.
  if (!requireGit && !rootTemGit && out.length === 0 && Array.isArray(cfg.extraRepos) && cfg.extraRepos.length > 0) {
    out.push({ name: '.', path: root, git: false });
  }

  // `extraRepos` entra sempre que declarado, mesmo com `requireGit: true` — foi o usuário quem
  // apontou a pasta, não uma detecção automática, então a mesma trava de "não quero git" não
  // se aplica aqui. Dedupe por caminho resolvido: uma pasta já achada via `.git` filho não
  // pode virar entrada duplicada só porque também foi citada em `extraRepos`.
  for (const abs of resolveExtraRepos(root, cfg)) {
    if (out.some((r) => resolve(r.path) === abs)) continue;
    out.push({ name: basename(abs), path: abs, git: isRepo(abs) });
  }

  if (out.length || requireGit) return out;
  // Nenhum .git em lugar nenhum: trata a própria raiz como projeto. Só para quem não usa git.
  return [{ name: '.', path: root, git: false }];
}

/**
 * Pastas de código de um repositório: a RAIZ, sempre. Quem filtra o lixo é `IGNORED`
 * dentro do `walk` (node_modules, vendor, target, dist, __pycache__, .venv…).
 *
 * Isto já foi detecção por convenção (`src`, `lib`, `app`, `tests`, `scripts`…) e era o bug
 * mais grave da ferramenta: bastava UMA pasta da lista existir para todo o resto do repo
 * ficar invisível — e invisível em SILÊNCIO, que é o modo de falha que o plugin existe para
 * não ter. Medido em repos reais (2026-08-03):
 *
 *   prometheus  →     0 de   974 arquivos indexados (100% invisível: existe `scripts/`,
 *                     e o código real mora em tsdb/, discovery/, storage/, promql/…)
 *   django      → 2.026 de 2.970 (32% invisível)
 *   flask       →    65 de    83 (22% invisível)
 *   workspace ref→ escondia 2 arquivos no backend e 4 no frontend
 *
 * O custo de varrer tudo é irrisório — django (2.970 arquivos) leva 443 ms, prometheus 59 ms,
 * os repos do workspace de referência 13-16 ms — e o tier B de cache existe justamente para volume.
 * `cfg.sourceDirs` continua valendo para quem QUER restringir à mão (ver `resolveSourceDirs`).
 */
export function sourceDirs(repoPath) {
  return [repoPath];
}

/**
 * Pastas de código a varrer, respeitando `sourceDirs` da config MAS sem deixar sair do projeto.
 *
 * Vulnerabilidade real e confirmada em teste: `.claude/context-tools.json` é conteúdo do
 * repositório, e um `sourceDirs: ["../projeto-vizinho"]` fazia o índice ler arquivos FORA do
 * projeto — bastava abrir um repo hostil para que símbolos de outro lugar do disco fossem
 * lidos e exibidos.
 *
 * A checagem compara o caminho RESOLVIDO com a raiz do repo. Comparar string antes de resolver
 * não serve: `a/../../b` só revela o destino depois de normalizado. O `sep` no fim evita que
 * `/projeto-malicioso` passe por estar dentro de `/projeto`.
 *
 * Entrada recusada avisa no stderr (não no stdout, que é a saída útil e pode ser JSON de hook).
 */
export function resolveSourceDirs(repoPath, cfg = {}) {
  if (!Array.isArray(cfg.sourceDirs) || !cfg.sourceDirs.length) return sourceDirs(repoPath);
  const base = resolve(repoPath);
  const dentro = [];
  for (const d of cfg.sourceDirs) {
    const abs = resolve(base, String(d));
    if (abs === base || abs.startsWith(base + sep)) dentro.push(abs);
    else process.stderr.write(`context-tools: sourceDirs "${d}" aponta para fora do projeto — ignorado\n`);
  }
  // Se todas foram recusadas, cai na detecção por convenção em vez de devolver vazio:
  // vazio faria a ferramenta dizer "nenhum arquivo", escondendo a causa real.
  return dentro.length ? dentro : sourceDirs(repoPath);
}

/**
 * Arquivos de código soltos na RAIZ do repo, sem recursão.
 *
 * Existem porque `sourceDirs` só devolve a raiz quando NENHUMA pasta de convenção existe —
 * então, num projeto com `src/`, tudo que estivesse solto na raiz ficava invisível. Bug real
 * e grave: no backend do workspace de referência isso escondia o próprio `index.js`, o entrypoint. Pior,
 * falhava calado — o índice respondia "não existe" quando o certo era "não procurei ali".
 *
 * Sem recursão de propósito: subpasta que importe já é pasta de convenção ou está em
 * `sourceDirs`; recursar aqui varreria o repo inteiro duas vezes.
 */
export function rootFiles(repoPath, re) {
  return safe(() => readdirSync(repoPath, { withFileTypes: true }), [])
    .filter((e) => e.isFile() && !e.name.startsWith('.') && re.test(e.name))
    .map((e) => join(repoPath, e.name));
}

/**
 * Onde procurar documentação: a RAIZ do repo, sempre — mesma decisão de `sourceDirs`, e pelo
 * mesmo motivo. Adivinhar a pasta era ainda pior aqui: `docDirs` não tinha nem fallback, então
 * repositório sem `docs/` devolvia lista VAZIA e a auditoria não olhava nada, calada.
 *
 * Medido nos repos do workspace de referência (2026-08-04): 144 de 228 `.md` do backend estavam em `docs/`
 * e 98 de 156 no frontend — **142 arquivos de documentação nunca eram auditados**, entre eles
 * todo README, CHANGELOG e doc solta ao lado do código. O próprio README deste plugin é o
 * exemplo: ele carregava uma "limitação conhecida" já corrigida havia tempo, e nenhum auditor
 * podia perceber porque nenhum auditor o lia.
 *
 * `IGNORED` no `walk` continua podando `node_modules` e afins, que é onde mora o `.md` de
 * dependência que ninguém quer auditar.
 */
export function docDirs(repoPath) {
  return [repoPath];
}

/**
 * Lê um arquivo de CÓDIGO como texto, sobrevivendo ao que existe em projeto de verdade.
 *
 * `readFileSync(f, 'utf8')` puro falha em dois casos comuns, e falha em SILÊNCIO — o símbolo
 * simplesmente não entra no índice, e a busca responde "não existe":
 *
 *   1. BOM (`EF BB BF`). Editor da Microsoft grava assim por padrão, e o `﻿` fica colado
 *      na primeira linha: `^export function` deixa de casar e o PRIMEIRO símbolo do arquivo
 *      some. Medido em fixture hostil: `export function depoisDoBom()` era invisível.
 *   2. Arquivo que não é UTF-8. Delphi/Pascal legado é quase sempre cp1252 — justamente a
 *      linguagem com mais código antigo é a mais atingida. `function Endereço` virava
 *      `function Endere<FFFD>o`, então buscar por `Endereço` não achava nada.
 *
 * Estratégia: decodifica em UTF-8 ESTRITO; se o arquivo não for UTF-8 válido, cai para latin1
 * (superconjunto de bytes, nunca lança). Erra para o lado de ler o arquivo de algum jeito —
 * nunca para o lado de sumir com o símbolo.
 */
const decodificadorEstrito = new TextDecoder('utf-8', { fatal: true });
export function lerTexto(caminho) {
  const buf = safe(() => readFileSync(caminho), null);
  if (buf === null) return null;
  const semBom = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ? buf.subarray(3) : buf;
  try { return decodificadorEstrito.decode(semBom); }
  catch { return semBom.toString('latin1'); }
}

/** Caminho relativo à raiz do repo, sempre com barra normal (comparável entre SOs). */
export function relPath(root, file) {
  return file.replace(root, '').replace(/^[\\/]/, '').replace(/\\/g, '/');
}

/**
 * Profundidade máxima da varredura. Existe como guarda contra ciclo de symlink, não como
 * limite de projeto — por isso é generosa: um monorepo típico
 * (`packages/app/src/features/x/components/forms/fields/Input.tsx`) já usa 9 níveis, e o
 * limite antigo de 10 escondia arquivos de qualquer estrutura um pouco mais funda.
 */
const MAX_DEPTH = 24;

/**
 * Varredura recursiva com poda das pastas ignoradas.
 *
 * `truncated` é opcional: passe um array para saber se a profundidade máxima foi atingida.
 * Truncar em silêncio seria justamente o erro que esta ferramenta existe para evitar — o
 * índice ficaria incompleto e ainda assim responderia "não existe" com confiança.
 */
export function walk(dir, re, acc = [], depth = 0, truncated = null) {
  if (depth > MAX_DEPTH) {
    if (truncated) truncated.push(dir);
    return acc;
  }
  for (const e of safe(() => readdirSync(dir, { withFileTypes: true }), [])) {
    if (IGNORED.has(e.name) || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, re, acc, depth + 1, truncated);
    else if (re.test(e.name)) acc.push(full);
  }
  return acc;
}

/**
 * Config opcional. Procurada em <raiz>/.claude/context-tools.json e <raiz>/context-tools.json.
 * Tudo tem default sensato — o arquivo existe só para quem precisa fugir da convenção.
 */
export function loadConfig(root, env = process.env) {
  const hostConfig = runtimeHost(env) === 'codex'
    ? join(root, '.codex', 'context-tools.json')
    : join(root, '.claude', 'context-tools.json');
  for (const p of [hostConfig, join(root, 'context-tools.json')]) {
    const raw = safe(() => readFileSync(p, 'utf8'), null);
    if (raw) {
      // Windows PowerShell 5.1 grava UTF-8 com BOM por padrão. O BOM é válido no arquivo de
      // configuração, mas não faz parte da gramática JSON e faria JSON.parse falhar em silêncio.
      const cfg = safe(() => JSON.parse(raw.replace(/^\uFEFF/, '')), null);
      if (cfg) return cfg;
      process.stderr.write(`context-tools: ${p} não é JSON válido — ignorado, usando defaults\n`);
    }
  }
  return {};
}
