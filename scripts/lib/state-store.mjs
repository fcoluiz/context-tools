// Short, project-local transactions shared by hooks. Atomic rename alone does not serialize
// read/modify/write; every writer must hold the same exclusive lock.
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function readState(path, initial) {
  try {
    if (statSync(path).size > 64 * 1024 * 1024) return { ok: false, reason: 'state-size-limit' };
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid-state' };
    return { ok: true, value };
  }
  catch (error) {
    if (error.code === 'ENOENT') return { ok: true, value: initial() };
    return { ok: false, reason: error instanceof SyntaxError ? 'invalid-state' : 'state-unavailable', code: error.code || null };
  }
}

export function transactState(path, initial, mutate, { waitMs = 200, staleMs = 60000, now = Date.now() } = {}) {
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  let fd;
  let temporary;
  const owns = () => {
    try { return readFileSync(lockPath, 'utf8').startsWith(`${token}\n`); } catch { return false; }
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const deadline = Date.now() + waitMs;
    while (fd === undefined) {
      try {
        fd = openSync(lockPath, 'wx');
        writeFileSync(fd, `${token}\n${process.pid}\n${now}\n`, 'utf8');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Quarantine stale locks and compare their token before reclaiming. Never unlink a
        // replacement lock created between our stat and rename.
        try {
          const contents = readFileSync(lockPath, 'utf8');
          const pid = Number(contents.split('\n')[1]);
          let alive = false;
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; }
          }
          if (!alive && Date.now() - statSync(lockPath).mtimeMs >= staleMs) {
            const quarantine = `${lockPath}.${token}.stale`;
            renameSync(lockPath, quarantine);
            if (readFileSync(quarantine, 'utf8') === contents) unlinkSync(quarantine);
            else {
              // link is exclusive: unlike rename it cannot overwrite a new owner's lock.
              // If the filesystem cannot restore it, retain the quarantine for diagnosis.
              try { linkSync(quarantine, lockPath); unlinkSync(quarantine); } catch { /* retain */ }
            }
          }
        } catch { /* retry an ordinary lock race */ }
        if (Date.now() >= deadline) return { ok: false, reason: 'state-lock-busy' };
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    const loaded = readState(path, initial);
    if (!loaded.ok) return loaded;
    const value = mutate(loaded.value);
    temporary = `${path}.${token}.tmp`;
    writeFileSync(temporary, JSON.stringify(loaded.value), { encoding: 'utf8', flag: 'wx' });
    if (!owns()) return { ok: false, reason: 'state-lock-lost' };
    renameSync(temporary, path);
    temporary = null;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, reason: 'state-unavailable', code: error.code || null, message: String(error.message).slice(0, 300) };
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* best effort */ } }
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (owns()) { try { unlinkSync(lockPath); } catch { /* best effort */ } }
  }
}
