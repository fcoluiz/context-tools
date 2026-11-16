// Confere vários bugs de uma vez, para os casos de "sessão longa" (vários pedidos num prompt só).
//   node check-all.mjs <script de bugs> <id> [<id>…]
// Roda `node <script> check <id>` para cada um, na pasta atual (a cópia do agente), e só passa se
// todos passarem. Diz qual falhou: um caso que corrige 2 de 3 bugs não pode parecer um zero.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const [script, ...ids] = process.argv.slice(2);
if (!script || !ids.length) { console.error('usage: check-all.mjs <bugs script> <id> [<id>…]'); process.exit(2); }
let failed = 0;
for (const id of ids) {
  const r = spawnSync(process.execPath, [resolve(script), 'check', id], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}${ok ? '' : `: ${String(r.stderr || r.stdout).trim().split('\n')[0]}`}`);
}
process.exit(failed ? 1 : 0);
