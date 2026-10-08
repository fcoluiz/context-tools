#!/usr/bin/env node
// 🕰️ Por que este código é assim? — a pergunta que ler mais código NÃO responde.
//
// As outras ferramentas respondem sobre o ESTADO do código: onde X está (`symbols`), o que
// tem em volta (`outline`), o que muda junto (`coupling`), o que apodreceu (`audit-docs`).
// Nenhuma responde sobre as DECISÕES que produziram esse estado — e essa é a única pergunta
// em que ler o arquivo inteiro não ajuda, porque a resposta não está lá. Está no histórico.
//
// É onde um agente erra com mais confiança: remove um guard que existe por um motivo,
// "simplifica" o que já foi simplificado e quebrou, troca um limiar que foi medido. Mesma
// classe de falha que o resto do plugin evita — confiantemente errado — no eixo que faltava.
//
// Uso:
//   why.mjs <símbolo>              → o que moldou as linhas daquele símbolo
//   why.mjs <arquivo> <linha>      → idem, para um trecho específico
//   why.mjs <símbolo> --n=5        → mais commits (padrão 3)
//
// Custo medido: ~1,1 s por símbolo (`git log -L` percorre o histórico daquele intervalo).
// Por isso é SOB DEMANDA e nunca virou hook: caro demais para rodar sozinho.
//
// Se o histórico não tiver o que dizer, ele DIZ isso — nunca devolve vazio com cara de
// resposta. E se o git falhar, distingue "não achei" de "não consegui olhar".

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRoot, findRepos, safe, loadConfig, isMain, relPath } from './lib/roots.mjs';
import { buildIndex } from './symbols.mjs';
import { makeT, detectLang } from './lib/i18n.mjs';
import { recordMetric } from './lib/telemetry.mjs';

const GIT_TIMEOUT_MS = 30000;
const MAX_CORPO = 600;      // teto do corpo de cada mensagem
const CONTEXTO_LINHAS = 30; // quantas linhas do símbolo alimentam o `git log -L`

const falhas = [];
function git(repo, args) {
  try {
    return execFileSync('git', args, {
      cwd: repo, encoding: 'utf8', timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    // "Não achei" só pode ser afirmado se a busca aconteceu. Distinguir importa: histórico
    // raso (`clone --depth 1`) é o caso mais comum e o remédio é outro.
    falhas.push(e && e.code === 'ETIMEDOUT' ? 'timeout' : (e?.code || 'erro do git'));
    return '';
  }
}

/**
 * Commits que tocaram AS LINHAS daquele intervalo — não o arquivo inteiro.
 *
 * `git log -L` segue o trecho através de renomeações e reindentações, que é justamente o que
 * `git log <arquivo>` não faz: num arquivo de 14 mil linhas, o histórico do arquivo é ruído
 * quase puro, e o histórico do trecho é a resposta.
 */
function historicoDoTrecho(repoPath, arquivo, inicio, fim, n) {
  const intervalo = `${inicio},${Math.max(inicio, fim)}:${arquivo}`;
  const bruto = git(repoPath, ['log', '-L', intervalo, '--format=%x00%h%x1f%ad%x1f%an%x1f%s%x1f%b', '--date=short', `-n${n}`]);
  const commits = [];
  for (const bloco of bruto.split('\0').slice(1)) {
    const [hash, data, autor, assunto, corpo = ''] = bloco.split('\x1f');
    if (!hash) continue;
    // O corpo vem colado no diff (`git log -L` sempre imprime o patch); corta no primeiro
    // marcador de diff, que é onde a prosa acaba e o ruído começa.
    const prosa = corpo.split(/^(?:diff --git|@@|---|\+\+\+)/m)[0].trim();
    commits.push({ hash, data, autor, assunto: (assunto || '').trim(), corpo: prosa.slice(0, MAX_CORPO) });
  }
  return commits;
}

function main() {
  const args = process.argv.slice(2);
  const nArg = args.find((a) => a.startsWith('--n='));
  const n = Math.min(10, Math.max(1, parseInt(nArg?.slice(4) ?? '3', 10) || 3));
  const livres = args.filter((a) => !a.startsWith('--'));
  const root = resolveRoot(args);
  const cfg = loadConfig(root);
  const t = makeT(detectLang(cfg));

  if (!livres.length) { console.log(t('why.usage')); return; }

  const repos = findRepos(root, { requireGit: true });
  if (!repos.length) { console.log(t('why.semGit', { root })); return; }

  // Dois modos: <arquivo> <linha>, ou <símbolo> (resolvido pelo índice).
  const alvos = [];
  const linhaExplicita = livres.length >= 2 && /^\d+$/.test(livres[1]);
  if (linhaExplicita) {
    const rel = String(livres[0]).replace(/\\/g, '/');
    const ini = parseInt(livres[1], 10);
    for (const r of repos) {
      if (existsSync(join(r.path, rel))) alvos.push({ repo: r, arquivo: rel, inicio: ini, fim: ini + CONTEXTO_LINHAS, rotulo: `${rel}:${ini}` });
    }
    if (!alvos.length) { console.log(t('why.arquivoNaoAchado', { f: rel })); return; }
  } else {
    const alvo = livres[0];
    const idx = buildIndex(root, cfg);
    let re; try { re = new RegExp(alvo, 'i'); } catch { console.log(t('sym.badPattern', { q: alvo })); return; }
    const achados = [];
    for (const [nome, locs] of idx.defs) {
      if (!re.test(nome)) continue;
      for (const l of locs) achados.push({ nome, ...l });
    }
    if (!achados.length) { console.log(t('why.semSimbolo', { q: alvo })); return; }
    const exatos = achados.filter((a) => a.nome.toLowerCase() === alvo.toLowerCase());
    for (const a of (exatos.length ? exatos : achados).slice(0, 3)) {
      // O `file` do índice é relativo à RAIZ (pode incluir o nome do repo num workspace):
      // reduz ao caminho dentro do repo, que é o que o git entende.
      const rel = a.file.replace(/\\/g, '/');
      const repo = repos.find((r) => existsSync(join(r.path, rel)))
        || repos.find((r) => existsSync(join(r.path, rel.split('/').slice(1).join('/'))));
      if (!repo) continue;
      const dentro = existsSync(join(repo.path, rel)) ? rel : rel.split('/').slice(1).join('/');
      alvos.push({
        repo, arquivo: dentro, inicio: a.line,
        fim: Math.min(a.end || a.line, a.line + CONTEXTO_LINHAS),
        rotulo: `${a.kind} — ${dentro}:${a.line}`,
      });
    }
    if (!alvos.length) { console.log(t('why.semSimbolo', { q: alvo })); return; }
  }

  const saida = [];
  let algumCommit = false;
  for (const alvo of alvos) {
    const commits = historicoDoTrecho(alvo.repo.path, alvo.arquivo, alvo.inicio, alvo.fim, n);
    saida.push(t('why.alvo', { alvo: alvo.rotulo }));
    if (!commits.length) { saida.push(t('why.semHistorico')); continue; }
    algumCommit = true;
    for (const c of commits) {
      saida.push(`  ${c.hash}  ${c.data}  ${c.autor}`);
      saida.push(`    ${c.assunto}`);
      for (const l of c.corpo.split('\n').filter((x) => x.trim()).slice(0, 8)) saida.push(`      ${l.trim()}`);
    }
    saida.push('');
  }

  // Falha do git não pode virar "não há o que dizer": são coisas diferentes, e o remédio
  // de uma não serve para a outra (repositório raso ⇒ `git fetch --unshallow`).
  if (!algumCommit && falhas.length) { console.log(t('why.gitFalhou', { causas: [...new Set(falhas)].join('; ') })); return; }
  console.log(saida.join('\n').trimEnd());
  if (falhas.length) console.log(t('why.parcial', { causas: [...new Set(falhas)].join('; ') }));
}

if (isMain(import.meta.url)) {
  const started = Date.now();
  const root = resolveRoot(process.argv.slice(2));
  try { main(); } catch (e) { console.log(`why: ${e?.message || e}`); }
  finally {
    recordMetric(root, 'why', {
      explicitLine: process.argv.slice(2).some((x) => /^\d+$/.test(x)),
      durationMs: Date.now() - started,
    });
  }
}

export { historicoDoTrecho };
