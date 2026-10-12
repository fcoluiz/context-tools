#!/usr/bin/env node
// 📸 Retrato do projeto em JSON versionado — para CI, scripts próprios e painéis.
//
// Junta o que o plugin já sabe, sem ler nada novo: a saúde do conhecimento (`health`), os números
// das sessões recentes (do transcript do Claude Code), a identidade dos repositórios e o inventário
// de mapas e documentos com o estado de cada um. É o ponto de extensão para quem quiser agregar
// vários projetos ou várias máquinas.
//
// O QUE NUNCA SAI DAQUI: conteúdo de arquivo, de mapa ou de documento; texto de prompt, de resposta
// ou de comando; o transcript. Só contagens, durações, caminhos relativos, estados e hashes.
// `tests/snapshot-export.test.mjs` procura conteúdo na saída para garantir isso.
//
// Uso:
//   snapshot-export.mjs [--root=<dir>] [--days=30] [--sessions=20]
//   (`ct snapshot` é o mesmo comando)

import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { resolveRoot, findRepos, isMain, safe, sanitizeModelText, runtimeHost } from './lib/roots.mjs';
import { buildReport } from './health.mjs';
import { metricasDaSessao, transcriptsRecentes, transcriptsCodexRecentes } from './lib/sessao.mjs';

export const SNAPSHOT_SCHEMA = 'context-tools/snapshot@1';

const git = (cwd, ...args) => safe(() => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(), '') || null;

/**
 * Remote sem credencial: `https://token@github.com/o/r.git` vira `https://github.com/o/r.git`.
 * Um token no remote é comum em CI e não pode sair num relatório.
 */
export function remoteSemCredencial(url) {
  if (!url) return null;
  return sanitizeModelText(String(url).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1'), 300);
}

/** `owner/repo` do GitHub a partir do remote, em https ou ssh; null fora do GitHub. */
export function githubSlug(url) {
  const m = String(url || '').match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Identificador anônimo desta máquina: um UUID aleatório gravado uma vez em `~/.context-tools`
 * (`CONTEXT_TOOLS_HOME`, a mesma pasta do aviso de atualização). Não deriva de nome de usuário,
 * hostname nem hardware; apagar o arquivo gera outro.
 */
export function machineId(env = process.env) {
  const file = join(env.CONTEXT_TOOLS_HOME || join(homedir(), '.context-tools'), 'machine-id');
  const lido = safe(() => readFileSync(file, 'utf8').trim(), '');
  if (/^[0-9a-f-]{36}$/.test(lido)) return lido;
  const novo = randomUUID();
  safe(() => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${novo}\n`); }, null);
  return novo;
}

function repositorios(root) {
  const repos = safe(() => findRepos(root), []) || [];
  const lista = repos.length ? repos : [{ name: '.', path: root }];
  return lista.map((repo) => {
    const remote = remoteSemCredencial(git(repo.path, 'config', '--get', 'remote.origin.url'));
    return {
      path: relative(root, repo.path).replace(/\\/g, '/') || '.',
      remote,
      github: githubSlug(remote),
      branch: git(repo.path, 'rev-parse', '--abbrev-ref', 'HEAD'),
      head: git(repo.path, 'rev-parse', 'HEAD'),
    };
  });
}

/**
 * Se cada mapa ou documento está versionado: `tracked` (no índice do git), `ignored` (barrado por um
 * .gitignore), `untracked` (fora do índice, sem ser ignorado) ou null (fora de repositório git, ou o
 * git não respondeu). Um mapa que não está no git só existe nesta máquina: quem clona não recebe.
 * O git roda DENTRO da pasta de cada item, com o nome do arquivo: comparar com `--show-toplevel`
 * quebra quando a mesma pasta tem duas grafias (link simbólico no macOS, nome curto no Windows).
 * Um `git ls-files` e um `git check-ignore` por pasta, não um por arquivo.
 */
export function gitStateOf(root, paths) {
  const estado = new Map(paths.map((p) => [p, null]));
  const porPasta = new Map();
  for (const p of paths) {
    const abs = resolve(root, p);
    const pasta = dirname(abs);
    if (!porPasta.has(pasta)) porPasta.set(pasta, new Map());
    porPasta.get(pasta).set(basename(abs), p);
  }
  for (const [pasta, nomes] of porPasta) {
    // Nome com [ ] ou * é nome, não padrão.
    const rodar = (args, input) => safe(() => spawnSync('git', ['--literal-pathspecs', ...args], {
      cwd: pasta, input, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    }), null);
    const ls = rodar(['ls-files', '-z', '--', ...nomes.keys()]);
    // Pasta inexistente ou fora de repositório git: o estado fica desconhecido.
    if (!ls || ls.status !== 0) continue;
    const versionados = new Set(ls.stdout.split('\0').filter(Boolean));
    const fora = [...nomes.keys()].filter((n) => !versionados.has(n));
    // check-ignore sai com 0 se algum é ignorado e 1 se nenhum; outro código é erro: estado desconhecido.
    const ign = fora.length ? rodar(['check-ignore', '-z', '--stdin'], `${fora.join('\0')}\0`) : { status: 1, stdout: '' };
    const ignorados = new Set(ign?.status === 0 ? ign.stdout.split('\0').filter(Boolean) : []);
    for (const [n, p] of nomes) {
      if (versionados.has(n)) estado.set(p, 'tracked');
      else if (ign?.status === 0 || ign?.status === 1) estado.set(p, ignorados.has(n) ? 'ignored' : 'untracked');
    }
  }
  return estado;
}

/** Id do modelo com mais respostas na sessão; só o formato de um id passa (nada de texto livre). */
function modeloPrincipal(modelos) {
  const [id] = Object.entries(modelos || {}).sort((a, b) => b[1] - a[1])[0] || [];
  return id && /^[\w.:/@[\]-]{1,100}$/.test(id) ? id : null;
}

/**
 * Só os números de cada sessão; o transcript em si nunca é copiado. As sessões do Claude Code e
 * as do Codex desta pasta entram juntas, as `limite` mais recentes entre as duas.
 */
function sessoes(root, limite, env) {
  if (limite <= 0) return [];
  const todas = [...transcriptsRecentes(root, null, limite), ...transcriptsCodexRecentes(root, limite, env)]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limite);
  return todas.map(({ sid, caminho }) => {
    const m = safe(() => metricasDaSessao(caminho), null);
    if (!m) return null;
    const num = (v) => (Number.isFinite(v) ? v : null);
    return {
      id: sanitizeModelText(sid, 80),
      host: m.host,
      messages: num(m.msgs),
      peakContextTokens: num(m.contexto),
      contextWindow: num(m.janela),
      prefixRewrites: num(m.reescritas),
      cacheWriteTokens: num(m.gravado),
      messagesUntilFirstEdit: num(m.msgsAteEdit),
      hours: num(m.horas) == null ? null : Math.round(m.horas * 100) / 100,
      startedAt: m.inicio ? new Date(m.inicio).toISOString() : null,
      endedAt: m.fim ? new Date(m.fim).toISOString() : null,
      // Totais da sessão por categoria de cobrança, e o modelo mais usado: o bastante para estimar
      // custo com a tabela de preço de quem consome. Contagens e um id de modelo, nunca texto.
      tokens: m.tokens ? {
        input: num(m.tokens.input), output: num(m.tokens.output),
        cacheRead: num(m.tokens.cacheRead), cacheWrite: num(m.tokens.cacheWrite),
      } : null,
      model: modeloPrincipal(m.modelos),
    };
  }).filter(Boolean);
}

export function buildSnapshot(root, { days = 30, sessions = 20, env = process.env } = {}) {
  const inventario = [];
  const report = buildReport(root, days, false, {
    onKnowledgeStatus: (kind, path, status) => inventario.push({ kind, path, status }),
  });
  const noGit = gitStateOf(root, inventario.map((i) => i.path));
  for (const i of inventario) Object.assign(i, { path: sanitizeModelText(i.path, 300), git: noGit.get(i.path) });
  const { metrics, knowledge, documentation, reviewQueue } = report;
  return {
    schema: SNAPSHOT_SCHEMA,
    generatedAt: report.generatedAt,
    machineId: machineId(env),
    host: runtimeHost(),
    windowDays: days,
    repositories: repositorios(root),
    knowledge: {
      score: knowledge.score,
      maps: knowledge.maps,
      documents: knowledge.documents,
      mapTrend: knowledge.mapTrend,
      items: inventario.sort((a, b) => `${a.kind}:${a.path}`.localeCompare(`${b.kind}:${b.path}`)),
    },
    documentation: {
      status: documentation.status,
      enabled: documentation.enabled,
      language: documentation.language,
      root: documentation.root,
      documentCount: documentation.documentCount,
    },
    reviewQueue: { status: reviewQueue.status, pending: reviewQueue.pending },
    usage: {
      eventsInWindow: metrics.eventsInWindow,
      byTool: metrics.byTool,
      durations: metrics.durations,
      pretool: metrics.pretool,
      symbolLookups: metrics.symbolLookups,
      storageStatus: metrics.storageStatus,
    },
    sessions: sessoes(root, sessions, env),
  };
}

function inteiro(args, nome, padrao, min, max) {
  const valor = args.find((a) => a.startsWith(`${nome}=`));
  if (!valor) return padrao;
  const n = Number(valor.slice(nome.length + 1));
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${nome} must be an integer from ${min} to ${max}`);
  return n;
}

function main() {
  const args = process.argv.slice(2);
  const desconhecidos = args.filter((a) => !/^--(root|days|sessions)=/.test(a) && a !== '--json');
  if (desconhecidos.length) throw new Error(`unknown option(s): ${desconhecidos.join(', ')}`);
  const snapshot = buildSnapshot(resolveRoot(), {
    days: inteiro(args, '--days', 30, 1, 365),
    sessions: inteiro(args, '--sessions', 20, 0, 200),
  });
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`context-tools snapshot: ${sanitizeModelText(error?.message || error, 300)}`);
    process.exitCode = 1;
  }
}
