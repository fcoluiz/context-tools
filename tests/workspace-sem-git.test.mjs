// Projeto sem `.git` próprio, com `extraRepos` apontando para pastas irmãs, dentro de uma pasta
// que agrupa outros projetos (alguns com `.git`). Cobre a raiz resolvida pelo shell do agente e
// a verificação de fontes do ack fora da raiz do projeto.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { acknowledgeDocument } from '../scripts/ack.mjs';
import { fingerprintSourcesInRoot } from '../scripts/lib/source-fingerprints.mjs';
import { safeEditTarget } from '../scripts/lib/session-write-journal.mjs';

const roots = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'lib', 'roots.mjs')).href;

function workspace(fn) {
  const ws = mkdtempSync(join(tmpdir(), 'ct-ws-'));
  try {
    const app = join(ws, 'app');
    for (const dir of ['app/src', 'app/.claude/context', 'app/.codex', 'app/ai-context', 'shared', 'other', 'unrelated']) mkdirSync(join(ws, dir), { recursive: true });
    writeFileSync(join(app, 'src', 'a.js'), 'export function a() {}\n');
    writeFileSync(join(ws, 'shared', 'u.js'), 'export function u() {}\n');
    writeFileSync(join(ws, 'unrelated', 'x.js'), 'export function x() {}\n');
    writeFileSync(join(ws, 'other', 'o.js'), 'export function o() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: join(ws, 'other') });
    const config = JSON.stringify({ extraRepos: ['../shared'] });
    writeFileSync(join(app, '.claude', 'context-tools.json'), config);
    writeFileSync(join(app, '.codex', 'context-tools.json'), config);
    return fn(app, ws);
  } finally { rmSync(ws, { recursive: true, force: true }); }
}

function rootFrom(cwd) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CONTEXT_TOOLS_PROJECT_DIR;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { resolveRoot } from ${JSON.stringify(roots)}; process.stdout.write(resolveRoot([]));`], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function map(app, covers) {
  const path = join(app, '.claude', 'context', 'flow.md');
  writeFileSync(path, `---\narea: flow\ncovers:\n${covers.map((c) => `  - "${c}"\n`).join('')}verified_at: 2020-01-01\n---\n# Flow\nText.\n`);
  return path;
}

test('shell sem CLAUDE_PROJECT_DIR: pasta com context-tools.json é a raiz, não a pasta que agrupa projetos', () => workspace((app) => {
  assert.equal(rootFrom(app), app);
}));

test('mapa com fonte em extraRepos é verificado e confirmado pelo ack', () => workspace((app) => {
  const path = map(app, ['src/a.js', '../shared/u.js']);
  assert.deepEqual(fingerprintSourcesInRoot(app, ['src/a.js', '../shared/u.js']).markers, []);
  const result = acknowledgeDocument(app, '.claude/context/flow.md');
  assert.deepEqual(result.acknowledged.sort(), ['../shared/u.js', 'src/a.js']);
  assert.match(readFileSync(path, 'utf8'), /source_digest:/);
}));

test('pasta irmã não declarada em extraRepos continua fora', () => workspace((app) => {
  assert.deepEqual(fingerprintSourcesInRoot(app, ['../unrelated/x.js']).markers, ['outside:../unrelated/x.js']);
  map(app, ['../unrelated/x.js']);
  assert.throws(() => acknowledgeDocument(app, '.claude/context/flow.md'), /source outside allowed roots/);
}));

test('pasta do projeto ligada (junction/symlink) a um extraRepos vale como fonte', () => workspace((app, ws) => {
  mkdirSync(join(app, 'lib'));
  symlinkSync(join(ws, 'shared'), join(app, 'lib', 'shared'), 'junction');
  symlinkSync(join(ws, 'unrelated'), join(app, 'lib', 'unrelated'), 'junction');
  assert.ok(safeEditTarget(app, 'lib/shared/u.js'));
  assert.equal(safeEditTarget(app, 'lib/unrelated/x.js'), null);
  assert.deepEqual(fingerprintSourcesInRoot(app, ['lib/shared/u.js']).markers, []);
  writeFileSync(join(app, 'ai-context', 'doc.md'), '# Doc\n\nUses `lib/shared/u.js`.\n');
  assert.deepEqual(acknowledgeDocument(app, 'ai-context/doc.md').acknowledged, ['./lib/shared/u.js']);
}));
