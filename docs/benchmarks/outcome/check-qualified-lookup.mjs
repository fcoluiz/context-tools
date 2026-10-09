// Conferência do caso `fix-qualified-lookup`: roda na cópia que o agente editou e verifica, num
// projeto Pascal montado aqui, que a busca pelo nome qualificado acha a definição. Sai 0 se acha.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ct-check-'));
try {
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'UPedido.pas'), [
    'unit UPedido;', 'interface', 'type', '  TPedido = class', '    procedure Confirmar;', '  end;',
    'implementation', 'procedure TPedido.Confirmar;', 'begin', 'end;', 'end.', '',
  ].join('\n'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'symbols.mjs'), 'TPedido.Confirmar', `--root=${dir}`], {
    encoding: 'utf8', env: { ...process.env, CONTEXT_TOOLS_LANG: 'en', CONTEXT_TOOLS_STATE_DIR: join(dir, '.state') },
  });
  const ok = /TPedido\.Confirmar/.test(r.stdout) && !/no DEFINITION/.test(r.stdout);
  process.stdout.write(r.stdout);
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
