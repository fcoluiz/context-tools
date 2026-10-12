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
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { resolveRoot, findRepos, isMain, safe, sanitizeModelText, runtimeHost } from './lib/roots.mjs';
import { buildReport } from './health.mjs';
import { metricasDaSessao, transcriptsRecentes } from './lib/sessao.mjs';

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

/** Id do modelo com mais respostas na sessão; só o formato de um id passa (nada de texto livre). */
function modeloPrincipal(modelos) {
  const [id] = Object.entries(modelos || {}).sort((a, b) => b[1] - a[1])[0] || [];
  return id && /^[\w.:/@[\]-]{1,100}$/.test(id) ? id : null;
}

/** Só os números de cada sessão; o transcript em si nunca é copiado. */
function sessoes(root, limite) {
  if (limite <= 0) return [];
  return transcriptsRecentes(root, null, limite).map(({ sid, caminho }) => {
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
    onKnowledgeStatus: (kind, path, status) => inventario.push({ kind, path: sanitizeModelText(path, 300), status }),
  });
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
    sessions: sessoes(root, sessions),
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
