// Releitura do mesmo trecho de um arquivo que não mudou, pelo shell (`cat`, `sed -n`, `head`,
// `nl -ba | sed -n`, `Get-Content`). No Claude Code a ferramenta Read já devolve "File unchanged
// since last read" sozinha; no Codex toda leitura passa pelo shell e nada avisa. Aqui só se avisa:
// a leitura roda de qualquer jeito, porque depois de uma compactação reler é o certo.
//
// O registro é por sessão, com mtime + tamanho do arquivo. O SessionStart da sessão zera o dela
// (compactação, retomada), e registros com mais de 6 h somem.
import { statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { safe, statePath } from './roots.mjs';

const ARQUIVO = '.reread-state.json';
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_POR_SESSAO = 400;

const caminho = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s"'|;&<>]+))`;
const pegar = (m, i) => m[i] ?? m[i + 1] ?? m[i + 2];

/**
 * O comando é uma leitura simples de UM arquivo? Devolve `{ file, range }` (range `all` ou
 * `A-B`), ou null. Conservador: pipe, redirecionamento, vários arquivos ou flag desconhecida = null.
 */
export function parseReadCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd || cmd.length > 400) return null;
  let m;
  // nl -ba arq | sed -n 'A,Bp'  (o único pipe aceito: só numera as linhas)
  if ((m = cmd.match(new RegExp(String.raw`^nl\s+-ba\s+${caminho}\s*\|\s*sed\s+-n\s+['"]?(\d+),(\d+)p['"]?$`)))) {
    return { file: pegar(m, 1), range: `${m[4]}-${m[5]}` };
  }
  if (/[|;&<>`$]/.test(cmd.replace(/'[^']*'|"[^"]*"/g, ''))) return null;
  if ((m = cmd.match(new RegExp(String.raw`^cat\s+${caminho}$`)))) return { file: pegar(m, 1), range: 'all' };
  if ((m = cmd.match(new RegExp(String.raw`^sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+${caminho}$`)))) {
    return { file: pegar(m, 3), range: `${m[1]}-${m[2] ?? m[1]}` };
  }
  if ((m = cmd.match(new RegExp(String.raw`^head\s+(?:-n\s*(\d+)|-(\d+))\s+${caminho}$`)))) {
    return { file: pegar(m, 3), range: `1-${m[1] ?? m[2]}` };
  }
  if ((m = cmd.match(new RegExp(String.raw`^head\s+${caminho}$`)))) return { file: pegar(m, 1), range: '1-10' };
  if ((m = cmd.match(new RegExp(String.raw`^(?:Get-Content|gc|type)\s+(?:-Raw\s+)?(?:-(?:Path|LiteralPath)\s+)?${caminho}(?:\s+-Raw)?(?:\s+-Encoding\s+\w+)?$`, 'i')))) {
    return { file: pegar(m, 1), range: 'all' };
  }
  if ((m = cmd.match(new RegExp(String.raw`^(?:Get-Content|gc)\s+(?:-(?:Path|LiteralPath)\s+)?${caminho}\s+-(?:TotalCount|Head|First)\s+(\d+)$`, 'i')))) {
    return { file: pegar(m, 1), range: `1-${m[4]}` };
  }
  return null;
}

/** O trecho `novo` já estava dentro do trecho `antigo`? */
function cobre(antigo, novo) {
  if (antigo === 'all') return true;
  if (novo === 'all') return false;
  const [a1, a2] = antigo.split('-').map(Number);
  const [n1, n2] = novo.split('-').map(Number);
  return a1 <= n1 && n2 <= a2;
}

function carregar(root) {
  const store = safe(() => JSON.parse(readFileSync(statePath(root, ARQUIVO), 'utf8')), null) || {};
  const agora = Date.now();
  for (const sid of Object.keys(store)) {
    const s = store[sid];
    if (!s || typeof s !== 'object' || agora - (s.at || 0) > TTL_MS) delete store[sid];
  }
  return store;
}

function salvar(root, store) {
  const arq = statePath(root, ARQUIVO);
  safe(() => { mkdirSync(dirname(arq), { recursive: true }); writeFileSync(arq, JSON.stringify(store)); }, null);
}

/**
 * Registra a leitura e diz se ela repete uma anterior desta sessão sem o arquivo ter mudado.
 * Devolve `{ file, range, minutes, times }` quando repete; senão null.
 */
export function checkReread(root, sid, cwd, read, now = Date.now()) {
  if (!root || !sid || !read) return null;
  const abs = isAbsolute(read.file) ? read.file : join(cwd || root, read.file);
  const st = safe(() => statSync(abs), null);
  if (!st || !st.isFile()) return null;
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('..')) return null;
  const store = carregar(root);
  const sessao = store[sid] && typeof store[sid].files === 'object' ? store[sid] : { files: {} };
  const anteriores = Array.isArray(sessao.files[rel]) ? sessao.files[rel] : [];
  const mesmos = anteriores.filter((r) => r.mtimeMs === st.mtimeMs && r.size === st.size);
  const previa = mesmos.find((r) => cobre(r.range, read.range));
  let resposta = null;
  if (previa) {
    previa.times = (previa.times || 1) + 1;
    resposta = { file: rel, range: read.range, minutes: Math.max(0, Math.round((now - previa.at) / 60000)), times: previa.times };
  } else {
    // Um arquivo que mudou invalida as leituras antigas dele.
    sessao.files[rel] = [...mesmos, { range: read.range, mtimeMs: st.mtimeMs, size: st.size, at: now, times: 1 }];
  }
  sessao.at = now;
  const nomes = Object.keys(sessao.files);
  if (nomes.length > MAX_POR_SESSAO) for (const n of nomes.slice(0, nomes.length - MAX_POR_SESSAO)) delete sessao.files[n];
  store[sid] = sessao;
  salvar(root, store);
  return resposta;
}

/** O SessionStart zera o registro da sessão: depois de compactar ou retomar, reler é legítimo. */
export function resetRereads(root, sid) {
  if (!root || !sid) return;
  const store = carregar(root);
  if (!store[sid]) return;
  delete store[sid];
  salvar(root, store);
}
