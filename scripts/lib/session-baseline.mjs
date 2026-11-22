// Baseline de sessão do context-maps: índice leve compartilhado + retrato pesado por sessão.
//
// O índice (`.context-maps-session-baseline.json`) guarda, por [sessão][repo], só HEAD, instantes
// e contagens. Os retratos (`sujos` no repo Git, `files` no repo sem Git) vão para
// `.context-maps-session-baseline/<sessão>.json`. Antes os retratos ficavam no índice: num
// workspace com várias pastas grandes e muitas sessões em 24 h, o arquivo chegava a centenas de
// MB, era regravado inteiro a cada SessionStart e relido a cada consulta do Stop (minutos de CPU
// e gigabytes de memória somando os hooks). Agora cada sessão grava e lê só o próprio retrato.
//
// Entrada antiga com retrato embutido continua válida na leitura; a próxima gravação a migra.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safe, statePath } from './roots.mjs';

const HEAVY = ['sujos', 'files'];
const cache = new Map(); // caminho → { stamp, value }: um parse por processo enquanto o arquivo não muda

export function baselineIndexFile(root) {
  return statePath(root, '.context-maps-session-baseline.json');
}

function snapshotDir(root) {
  return statePath(root, '.context-maps-session-baseline');
}

function snapshotFile(root, sid) {
  return join(snapshotDir(root), `${String(sid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200)}.json`);
}

function stampOf(file) {
  const st = safe(() => statSync(file), null);
  return st ? `${st.mtimeMs}:${st.size}` : null;
}

function readJson(file) {
  const stamp = stampOf(file);
  if (!stamp) return {};
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = safe(() => JSON.parse(readFileSync(file, 'utf8')), {});
  const ok = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  cache.set(file, { stamp, value: ok });
  return ok;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  cache.set(file, { stamp: stampOf(file), value });
}

/** Índice leve: { [sid]: { [repo]: entrada } }. Não modifique o objeto devolvido sem gravar. */
export function loadBaselineIndex(root) {
  return readJson(baselineIndexFile(root));
}

/** Entrada completa de (sessão, repo), com o retrato pesado juntado; null se não houver. */
export function loadBaselineEntry(root, sid, repoPath) {
  if (!sid) return null;
  const entry = loadBaselineIndex(root)[sid]?.[repoPath];
  if (!entry || typeof entry !== 'object') return null;
  if (!entry.snapshot) return entry;
  const heavy = readJson(snapshotFile(root, sid))[repoPath];
  return heavy && typeof heavy === 'object' ? { ...entry, ...heavy } : entry;
}

/**
 * Grava o índice (já podado pelo chamador). Retrato embutido em qualquer entrada sai do índice e
 * vai para o arquivo da sessão; retrato de sessão que saiu do índice é apagado.
 */
export function saveBaselineIndex(root, store) {
  const index = {};
  for (const [sid, repos] of Object.entries(store)) {
    let moved = null;
    index[sid] = {};
    for (const [repoPath, entry] of Object.entries(repos || {})) {
      if (!entry || typeof entry !== 'object' || !HEAVY.some((k) => k in entry)) {
        index[sid][repoPath] = entry;
        continue;
      }
      const light = { ...entry, snapshot: true };
      const heavy = {};
      for (const k of HEAVY) if (k in entry) { heavy[k] = entry[k]; delete light[k]; }
      (moved ||= {})[repoPath] = heavy;
      index[sid][repoPath] = light;
    }
    if (moved) {
      const file = snapshotFile(root, sid);
      writeJson(file, { ...readJson(file), ...moved });
    }
  }
  const dir = snapshotDir(root);
  if (existsSync(dir)) {
    const keep = new Set(Object.keys(index).map((sid) => snapshotFile(root, sid)));
    for (const name of safe(() => readdirSync(dir), [])) {
      const file = join(dir, name);
      if (name.endsWith('.json') && !keep.has(file)) safe(() => { unlinkSync(file); cache.delete(file); }, null);
    }
  }
  writeJson(baselineIndexFile(root), index);
}
