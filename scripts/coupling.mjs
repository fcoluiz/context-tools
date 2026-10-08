#!/usr/bin/env node
// 🔗 Acoplamento por CO-MUDANÇA — descobre correlação entre arquivos a partir do git.
//
// Mapas de contexto guardam correlação que alguém LEMBROU de escrever. Isto DESCOBRE a que
// ninguém documentou, lendo o histórico. Não depende de linguagem: é git puro.
//
// Uso:
//   coupling.mjs                   → top acoplamentos de cada repo
//   coupling.mjs <arquivo>         → o que costuma mudar junto com ele
//   coupling.mjs --changed         → alerta para o que está modificado e sem o par habitual
//   coupling.mjs --changed --hook  → idem, em JSON de hook, com trava anti-repetição
//
// Confiança é DIRECIONAL: "leva junto" = P(o outro mudar | este mudou). Sem isso o alerta vira
// ruído — um controller que muda toda semana não "exige" a rota só porque a rota nunca muda sozinha.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, dirname } from 'node:path';
import { resolveRoot, findRepos, sourceDirs, resolveSourceDirs, safe, loadConfig, isMain, statePath, stateDir, HISTORY_CODE_RE, sanitizeModelText } from './lib/roots.mjs';
import { writeHookOutput } from './lib/hook-output.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { sessionChangedFiles, currentSessionId } from './context-maps.mjs';
import { recordMetric } from './lib/telemetry.mjs';

export const DEFAULTS = {
  since: '12 months ago',
  maxFilesPerCommit: 15,   // acima disso é refactor em massa: acopla tudo com tudo, é ruído
  minTogether: 4,          // abaixo disso é coincidência
  minConfidence: 0.5,
  warnConfidence: 0.6,     // limiar do alerta em --changed
  stateTtlHours: 12,
  minSessions: 5,          // abaixo disso, sem git, é "ainda não sei" — não "sem acoplamento"
};

// Sem git: a "cesta" que substitui o commit é a sessão inteira (todo arquivo tocado nela),
// gravada em .claude/.coupling-sessions.json — ver recordSessionBasket. Precisa sobreviver
// MUITO mais tempo que o baseline de sessão do context-maps.mjs (aquele é descartável no fim da
// sessão; este É o histórico). ~400 dias aproxima o "12 months ago" do modo git; o teto de
// contagem existe só para o arquivo não crescer sem limite num projeto de anos.
const SESSION_LOOKBACK_MS = 400 * 24 * 3600e3;
const MAX_SESSIONS_STORED = 1000;

const CODE_RE = HISTORY_CODE_RE;

/**
 * Falhas do git, acumuladas para poder ser DECLARADAS no fim.
 *
 * Antes, todo erro caía num `safe()` que devolvia string vazia — então estouro de `maxBuffer`
 * (histórico muito longo) ou timeout viravam "nenhum acoplamento acima do limiar", que é
 * indistinguível de "não há acoplamento". A ferramenta afirmava com confiança justamente
 * quando não tinha conseguido olhar.
 */
const falhasGit = [];

const git = (repo, args) => {
  try {
    return execFileSync('git', args, {
      cwd: repo, encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    const causa = e && (e.code === 'ETIMEDOUT' ? 'timeout de 30s'
      : e.code === 'ENOBUFS' || /maxBuffer/i.test(String(e.message)) ? 'saída maior que o buffer de 256 MB'
        : (e.code || String(e.message).slice(0, 60)));
    falhasGit.push(`${args[0]}: ${causa}`);
    return '';
  }
};

// Comum aos dois modos: dada uma lista de "cestas" (arquivos que mudaram juntos — commit no
// modo git, sessão inteira no modo sem-git), calcula confiança direcional por par. Extraído de
// `analyze` para que os dois modos usem EXATAMENTE a mesma matemática — duplicar essa conta e
// deixar uma cópia desatualizar é o mesmo erro que `CODE_RE` já cometeu neste plugin.
function linksFromBaskets(baskets, cfg) {
  const solo = new Map(), pair = new Map();
  for (const c of baskets) {
    for (const f of c) solo.set(f, (solo.get(f) || 0) + 1);
    for (let i = 0; i < c.length; i++) {
      for (let j = i + 1; j < c.length; j++) {
        const k = [c[i], c[j]].sort().join('\t');
        pair.set(k, (pair.get(k) || 0) + 1);
      }
    }
  }

  const links = [];
  for (const [k, n] of pair) {
    if (n < cfg.minTogether) continue;
    const [a, b] = k.split('\t');
    const ca = n / solo.get(a), cb = n / solo.get(b);
    if (Math.max(ca, cb) < cfg.minConfidence) continue;
    links.push({ a, b, n, conf: Math.max(ca, cb), ca, cb, soloA: solo.get(a), soloB: solo.get(b) });
  }
  links.sort((x, y) => y.conf - x.conf || y.n - x.n);
  return links;
}

export function analyze(repoPath, cfg = DEFAULTS) {
  const rels = sourceDirs(repoPath)
    .map((d) => d.replace(repoPath, '').replace(/^[\\/]/, '').replace(/\\/g, '/'))
    .filter(Boolean);
  const pathArgs = rels.length ? ['--', ...rels] : [];
  const raw = git(repoPath, ['log', `--since=${cfg.since}`, '--name-only', '--pretty=format:__C__', ...pathArgs]);

  const commits = [];
  let cur = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (s === '__C__') { if (cur.length && cur.length <= cfg.maxFilesPerCommit) commits.push([...new Set(cur)]); cur = []; }
    else if (CODE_RE.test(s)) cur.push(s);
  }
  if (cur.length && cur.length <= cfg.maxFilesPerCommit) commits.push([...new Set(cur)]);

  return { links: linksFromBaskets(commits, cfg), commits: commits.length };
}

export function analyzeWithStatus(repoPath, cfg = DEFAULTS) {
  const failuresBefore = falhasGit.length;
  const result = analyze(repoPath, cfg);
  return { ...result, available: falhasGit.length === failuresBefore };
}

const sessionLogPath = (root) => statePath(root, '.coupling-sessions.json');

function loadSessionLog(root) {
  return safe(() => JSON.parse(readFileSync(sessionLogPath(root), 'utf8')), {}) || {};
}

// Poda por idade (SESSION_LOOKBACK_MS) e por contagem (MAX_SESSIONS_STORED, mantendo as mais
// recentes) — as duas rodam toda vez que se grava, então o arquivo nunca cresce sem limite
// mesmo num projeto usado por anos sem nunca rodar `git init`.
function pruneSessionLog(store) {
  const cutoff = Date.now() - SESSION_LOOKBACK_MS;
  const pruned = {};
  for (const [repoPath, sessions] of Object.entries(store)) {
    const entries = Object.entries(sessions)
      .filter(([, e]) => e && (e.at || 0) >= cutoff)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, MAX_SESSIONS_STORED);
    if (entries.length) pruned[repoPath] = Object.fromEntries(entries);
  }
  return pruned;
}

/**
 * Grava (sobrescrevendo) a cesta desta sessão para este repo. CRÍTICO: sobrescreve por
 * `sessionId`, nunca acrescenta uma entrada nova por chamada — o Stop dispara a cada turno, e
 * `files` já vem cumulativo desde o início da sessão (ver `sessionChangedFiles`). Se
 * cada chamada virasse uma cesta nova, uma sessão de 10 turnos infrackionaria 10 cestas
 * crescentes e inflaria artificialmente todo par que ela tocasse — o mesmo viés que
 * `maxFilesPerCommit` existe para cortar do lado do git.
 *
 * Sessão com 1 arquivo só não gera par (ignorada) e sessão gigante (refactor em massa) é
 * descartada por inteiro, igual a um commit grande demais — mesmo motivo, mesmo corte.
 */
function recordSessionBasket(root, repoPath, sid, files, cfg) {
  if (!sid || files.length < 2 || files.length > cfg.maxFilesPerCommit) return;
  const store = loadSessionLog(root);
  if (!store[repoPath]) store[repoPath] = {};
  store[repoPath][sid] = { files: [...new Set(files)], at: Date.now() };
  safe(() => {
    mkdirSync(dirname(sessionLogPath(root)), { recursive: true });
    writeFileSync(sessionLogPath(root), JSON.stringify(pruneSessionLog(store)));
  }, null);
}

function analyzeSessions(root, repoPath, cfg) {
  const sessions = loadSessionLog(root)[repoPath] || {};
  const baskets = Object.values(sessions).map((e) => e.files).filter((f) => Array.isArray(f) && f.length);
  return { links: linksFromBaskets(baskets, cfg), sessions: baskets.length };
}

const short = (p) => p.replace(/^(src|lib|app)\//, '');

// Trava anti-repetição: a condição do alerta NÃO some quando o modelo responde (os arquivos
// seguem modificados). Sem dedup, o hook repetiria o mesmo aviso a cada Stop e poderia
// sustentar um loop. Aviso idêntico ⇒ silêncio.
function alreadyWarned(root, text, ttlHours) {
  const file = statePath(root, '.coupling-state');
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  const sig = String(h);
  const prev = safe(() => JSON.parse(readFileSync(file, 'utf8')), null);
  if (prev && prev.sig === sig && (Date.now() - (prev.at || 0)) < ttlHours * 3600e3) return true;
  safe(() => {
    mkdirSync(stateDir(root), { recursive: true });
    writeFileSync(file, JSON.stringify({ sig, at: Date.now() }));
  }, null);
  return false;
}

// Alerta de --changed (git ou sessão): dos links dados, os que têm só UM lado no conjunto
// `changed` e passam do limiar de confiança. Extraído porque os dois modos chegam aqui pela
// mesma lógica — só muda como `changed` foi calculado.
function warnRows(t, links, changed, cfg) {
  const warn = [];
  for (const l of links) {
    const aIn = changed.has(l.a), bIn = changed.has(l.b);
    if (aIn === bIn) continue;
    const [touched, missing, conf] = aIn ? [l.a, l.b, l.ca] : [l.b, l.a, l.cb];
    if (conf < cfg.warnConfidence) continue;
    warn.push(t('cou.warnRow', {
      touched: sanitizeModelText(short(touched), 160),
      missing: sanitizeModelText(short(missing), 160),
      conf: (conf * 100).toFixed(0), n: l.n,
    }));
  }
  return warn;
}

function printTarget(t, label, target, links) {
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = basename(normalized);
  const matches = (p) => normalized.includes('/')
    ? p === normalized || p.endsWith('/' + normalized)
    : basename(p) === base;
  const hits = links
    .filter((l) => matches(l.a) || matches(l.b))
    .map((l) => {
      const isA = matches(l.a);
      return { other: sanitizeModelText(isA ? l.b : l.a, 180), n: l.n, fwd: isA ? l.ca : l.cb, back: isA ? l.cb : l.ca };
    })
    .sort((x, y) => y.fwd - x.fwd || y.n - x.n);
  if (!hits.length) return false;
  console.log(t('cou.forFile', { repo: sanitizeModelText(label, 80), file: sanitizeModelText(normalized, 180) }));
  console.log(t('cou.legend1'));
  console.log(t('cou.legend2'));
  for (const h of hits.slice(0, 12)) {
    console.log(t('cou.row', { fwd: (h.fwd * 100).toFixed(0).padStart(3), back: (h.back * 100).toFixed(0).padStart(3), n: String(h.n).padStart(3), other: short(h.other) }));
  }
  return true;
}

function printLinks(links) {
  for (const l of links.slice(0, 15)) {
    console.log(`  ${(l.conf * 100).toFixed(0).padStart(3)}%  ${String(l.n).padStart(3)}x  ${sanitizeModelText(short(l.a), 42).padEnd(43)}${sanitizeModelText(short(l.b), 42)}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const root = resolveRoot();
  const rawCfg = loadConfig(root);
  const t = makeT(detectLang(rawCfg));
  const cfg = { ...DEFAULTS, ...(rawCfg.coupling || {}) };
  const changedMode = args.includes('--changed');
  const hookMode = args.includes('--hook');
  const target = args.find((a) => !a.startsWith('--'));

  // `requireGit: false`: sem isso, workspace sem NENHUM .git nem aparecia como repo, e o
  // acoplamento por sessão (ver analyzeSessions) nunca tinha onde rodar. `cfg: rawCfg` (não o
  // `cfg` local, que é só a sub-config de coupling) habilita `extraRepos` no nível certo.
  const repos = findRepos(root, { requireGit: false, cfg: rawCfg });
  const hookLines = [];
  let printed = false;

  for (const repo of repos) {
    const label = repo.name === '.' ? basename(repo.path) : repo.name;

    if (repo.git) {
      const { links, commits } = analyze(repo.path, cfg);
      if (!links.length) continue;

      if (changedMode) {
        const status = git(repo.path, ['status', '--porcelain']);
        const changed = new Set(
          status.split('\n').map((l) => l.slice(3).trim()).filter((s) => s && CODE_RE.test(s))
        );
        if (!changed.size) continue;
        const warn = warnRows(t, links, changed, cfg);
        if (warn.length) hookLines.push(t('cou.warnHeader', { repo: label }), ...warn.slice(0, 6));
        continue;
      }
      if (target) { if (printTarget(t, label, target, links)) printed = true; continue; }

      printed = true;
      console.log(t('cou.repoHeader', {
        repo: label, commits, since: cfg.since,
        minTogether: cfg.minTogether, minConf: cfg.minConfidence * 100,
      }));
      printLinks(links);
      continue;
    }

    // Sem git: a cesta usa os caminhos atribuídos à sessão por `sessionChangedFiles` antes de
    // calcular. No Codex, isso vem dos eventos explícitos de edição; no Claude, do snapshot.
    // Assim toda chamada (hook ou manual) mantém o log atualizado, e não só o Stop.
    const tocadosAgora = sessionChangedFiles(repo.path, HISTORY_CODE_RE) || [];
    recordSessionBasket(root, repo.path, currentSessionId(), tocadosAgora, cfg);
    const { links, sessions } = analyzeSessions(root, repo.path, cfg);

    if (changedMode) {
      const changed = new Set(tocadosAgora);
      if (!changed.size) continue;
      const warn = warnRows(t, links, changed, cfg);
      if (warn.length) hookLines.push(t('cou.warnHeader', { repo: label }), ...warn.slice(0, 6));
      continue;
    }
    if (target) { if (printTarget(t, label, target, links)) printed = true; continue; }

    // Modo resumo: aqui, diferente do git, vale distinguir "ainda não sei" (poucas sessões
    // registradas) de "medi e não achei acoplamento" — sem isso os dois casos ficariam
    // indistinguíveis do lado de fora, e "ainda não sei" tem resposta (esperar mais sessões,
    // ou `git init`) que "não achei" não tem.
    printed = true;
    if (sessions < cfg.minSessions) {
      console.log(t('cou.coldStart', { repo: label, sessions, min: cfg.minSessions }));
    } else if (!links.length) {
      console.log(t('cou.noCoupling.sessions', { repo: label, sessions }));
    } else {
      console.log(t('cou.repoHeader.sessions', {
        repo: label, sessions, minTogether: cfg.minTogether, minConf: cfg.minConfidence * 100,
      }));
      printLinks(links);
    }
  }

  if (hookLines.length) {
    const text = hookLines.join('\n');
    if (alreadyWarned(root, text, cfg.stateTtlHours)) return;
    if (hookMode) {
      writeHookOutput(root, {
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text },
      });
    } else {
      console.log(text);
    }
    return;
  }

  if (!printed && !changedMode) {
    if (!repos.length) console.log(t('cou.noRepo', { root }));
    // "Não achei" só pode ser afirmado se a busca REALMENTE aconteceu. Com git falhando,
    // o certo é dizer que não deu para olhar — não que não há o que ver.
    else if (falhasGit.length) console.log(t('cou.gitFalhou', { causas: [...new Set(falhasGit)].join('; ') }));
    else console.log(t('cou.noCoupling'));
  }
}

// Exportado para teste; o resto do módulo é CLI.
if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot(process.argv.slice(2));
  try { main(); } catch (e) {
    console.log(makeT(detectLang())('cou.fail', { err: e && e.message }));
  } finally {
    recordMetric(root, 'coupling', {
      mode: process.argv.includes('--changed') ? 'changed' : 'summary',
      hook: process.argv.includes('--hook'),
      targeted: process.argv.slice(2).some((x) => !x.startsWith('--')),
      durationMs: Date.now() - started,
    });
  }
  process.exit(0);
}
