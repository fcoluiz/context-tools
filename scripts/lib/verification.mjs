// Laço de verificação: "editou código e não rodou teste depois".
//
// Tudo sai de fontes que já existem — o transcript da sessão (o que foi editado e quais
// comandos rodaram, em ordem) e os arquivos do projeto (quais testes existem, qual comando os
// roda). Nenhum hook novo por edição: medir o diário por Edit custaria ~2 partidas de Node a
// cada escrita, e o transcript já registra a mesma sequência de graça.
//
// Regras de silêncio, na ordem:
//   - projeto sem comando de teste detectável e sem arquivo de teste → nunca fala;
//   - nenhuma edição de código depois do último comando de teste → nunca fala;
//   - no máximo UM aviso por sessão (estado em `.verify-state.json`).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HISTORY_CODE_RE, safe, walk } from './roots.mjs';

const TEST_FILE_RE = /(?:\.(?:test|spec)\.[A-Za-z0-9]+$)|(?:_test\.(?:go|py)$)|(?:^test_[^/\\]+\.py$)|(?:Tests?\.(?:cs|java|kt|php)$)/;
const TEST_DIR_RE = /(?:^|[\\/])(?:tests?|__tests__|specs?)(?:[\\/])/i;
const MAX_TEST_FILES = 3000;
const MAX_TEST_BYTES = 512 * 1024;

/**
 * Comandos que rodam teste. Larga de propósito: errar para "rodou teste" só cala um aviso;
 * errar para o outro lado repetiria cobrança em quem já testou.
 */
const DEFAULT_TEST_COMMAND_RE = new RegExp([
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b`,
  String.raw`\bnode\s+(?:--[\w-]+\s+)*--test\b`,
  String.raw`\b(?:npx\s+)?(?:vitest|jest|mocha|ava|tap|playwright\s+test)\b`,
  String.raw`\b(?:python\d*\s+-m\s+)?pytest\b`,
  String.raw`\bpython\d*\s+-m\s+unittest\b`,
  String.raw`\bgo\s+test\b`,
  String.raw`\bcargo\s+(?:test|nextest)\b`,
  String.raw`\bdotnet\s+test\b`,
  String.raw`\b(?:mvn|mvnw|\.\/mvnw)\s+(?:\S+\s+)*test\b`,
  String.raw`\bgradlew?\s+(?:\S+\s+)*test\b`,
  String.raw`\b(?:phpunit|rspec|rake\s+test|mix\s+test|deno\s+test|make\s+test|ctest)\b`,
  String.raw`(?:^|[\s"'/\\])tests?[\\/][\w./\\-]*\.(?:m?js|cjs|ts|py)\b`,
].join('|'), 'i');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

export function isTestFile(path) {
  const name = basename(path);
  return TEST_FILE_RE.test(name) || TEST_DIR_RE.test(path);
}

/** Comando de teste do projeto, ou null quando não há como saber sem adivinhar. */
export function detectTestCommand(repoPath, cfg = {}) {
  const configured = cfg?.verify?.command;
  if (typeof configured === 'string' && configured.trim()) return configured.trim().slice(0, 200);
  const has = (file) => existsSync(join(repoPath, file));
  const pkg = safe(() => JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8')), null);
  const npmTest = pkg?.scripts?.test;
  if (typeof npmTest === 'string' && npmTest.trim() && !/no test specified/i.test(npmTest)) {
    if (has('pnpm-lock.yaml')) return 'pnpm test';
    if (has('yarn.lock')) return 'yarn test';
    if (has('bun.lockb') || has('bun.lock')) return 'bun test';
    return 'npm test';
  }
  if (has('pytest.ini') || has('conftest.py') || /\bpytest\b/.test(safe(() => readFileSync(join(repoPath, 'pyproject.toml'), 'utf8'), ''))) return 'pytest';
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('pom.xml')) return 'mvn test';
  if (has('build.gradle') || has('build.gradle.kts')) return has('gradlew') ? './gradlew test' : 'gradle test';
  // .NET: a solução ou o projeto na raiz é o que `dotnet test` descobre sozinho.
  if (safe(() => readdirSync(repoPath), []).some((name) => /.(?:sln|slnx|csproj)$/i.test(name))) return 'dotnet test';
  const composer = safe(() => JSON.parse(readFileSync(join(repoPath, 'composer.json'), 'utf8')), null);
  if (typeof composer?.scripts?.test === 'string' || Array.isArray(composer?.scripts?.test)) return 'composer test';
  if (has('phpunit.xml') || has('phpunit.xml.dist')) return 'vendor/bin/phpunit';
  return null;
}

export function listTestFiles(repoPath) {
  return walk(repoPath, HISTORY_CODE_RE)
    .filter((file) => isTestFile(relative(repoPath, file)))
    .slice(0, MAX_TEST_FILES);
}

function stemOf(path) {
  return basename(path, extname(path))
    .replace(/\.(?:test|spec)$/i, '')
    .replace(/_test$/i, '')
    .replace(/^test_/i, '')
    .replace(/Tests?$/, '');
}

/**
 * Testes relacionados a um arquivo: mesmo nome-base (convenção) ou que o importam pelo nome.
 * Sempre rotulados com o motivo — é pista, não prova de cobertura.
 */
export function relatedTests(repoPath, file, testFiles = listTestFiles(repoPath)) {
  const stem = stemOf(file);
  if (!stem || stem.length < 3) return [];
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importRe = new RegExp(`(?:from\\s+|require\\(\\s*|import\\s*\\(\\s*|import\\s+)['"][^'"]*\\b${escaped}(?:\\.[A-Za-z0-9]+)?['"]`);
  const target = resolve(repoPath, file);
  const out = [];
  for (const test of testFiles) {
    if (resolve(test) === target) continue;
    const rel = relative(repoPath, test).split(sep).join('/');
    if (stemOf(test).toLowerCase() === stem.toLowerCase()) { out.push({ file: rel, reason: 'name' }); continue; }
    const size = safe(() => statSync(test).size, Infinity);
    if (size > MAX_TEST_BYTES) continue;
    const text = safe(() => readFileSync(test, 'utf8'), '');
    if (text && importRe.test(text)) out.push({ file: rel, reason: 'import' });
  }
  return out.slice(0, 12);
}

function toolBlocks(line) {
  const o = safe(() => JSON.parse(line), null);
  if (!o || o.type !== 'assistant' || !Array.isArray(o.message?.content)) return { at: NaN, blocks: [] };
  return {
    at: Date.parse(o.timestamp),
    blocks: o.message.content.filter((c) => c && c.type === 'tool_use' && typeof c.name === 'string'),
  };
}

/**
 * Sequência mecânica do transcript Claude: edições e comandos de shell, em ordem, e todas as
 * chamadas com instante e caminhos tocados (para medir se a resposta do índice foi usada).
 * Formato inesperado vira lista vazia — nunca lança.
 */
export function sessionActivity(transcriptPath) {
  const raw = transcriptPath ? safe(() => readFileSync(transcriptPath, 'utf8'), '') : '';
  const edits = [];
  const commands = [];
  const calls = [];
  let seq = 0;
  for (const line of raw.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    const { at, blocks } = toolBlocks(line);
    for (const block of blocks) {
      seq++;
      const input = block.input || {};
      const paths = [input.file_path, input.notebook_path, input.path].filter((p) => typeof p === 'string' && p);
      if (Number.isFinite(at)) calls.push({ seq, at, paths });
      if (EDIT_TOOLS.has(block.name)) {
        if (paths[0]) edits.push({ seq, path: paths[0] });
      } else if (SHELL_TOOLS.has(block.name) && typeof input.command === 'string') {
        commands.push({ seq, command: input.command.slice(0, 4000) });
      }
    }
  }
  return { edits, commands, calls };
}

export function looksLikeTestRun(command, extra = []) {
  if (DEFAULT_TEST_COMMAND_RE.test(command)) return true;
  return extra.some((needle) => needle && command.includes(needle));
}

/**
 * Arquivos de código editados DEPOIS do último comando de teste. Vazio = nada a cobrar.
 * Caminhos fora da raiz e documentação/config ficam de fora.
 */
export function unverifiedEdits(root, activity, { extraPatterns = [] } = {}) {
  const needles = extraPatterns.filter((x) => typeof x === 'string' && x.trim());
  const lastTest = activity.commands.filter((c) => looksLikeTestRun(c.command, needles)).reduce((max, c) => Math.max(max, c.seq), 0);
  const files = new Set();
  for (const edit of activity.edits) {
    if (edit.seq <= lastTest) continue;
    const abs = isAbsolute(edit.path) ? edit.path : resolve(root, edit.path);
    const rel = relative(root, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    const norm = rel.split(sep).join('/');
    if (!HISTORY_CODE_RE.test(norm) || /^\.(?:claude|codex)\//.test(norm)) continue;
    files.add(norm);
  }
  return [...files].sort();
}
