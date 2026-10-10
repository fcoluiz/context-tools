// O que o benchmark de resultado mostrou e foi corrigido (docs/benchmarks/outcome-pilot-2026-10-09.pt-BR.md):
//   - o Grep devolve linhas soltas, sem o método que as contém → grep-context.mjs (PostToolUse);
//   - os agentes gastavam turnos descobrindo como rodar os testes → verify.mjs --session-start;
//   - num repositório novo, o SessionStart mandava ler um índice vazio;
//   - o pacote de evidências misturava testes e nomes parecidos no meio das definições;
//   - o harness não registrava o que o agente consultou.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { localPath } from './paths.mjs';
import { linhasPorArquivo } from '../scripts/grep-context.mjs';
import { sessionTestLine, testDetails } from '../scripts/verify.mjs';
import { documentationSessionContext } from '../scripts/lib/documentation.mjs';
import { buildContextPack } from '../scripts/context-pack.mjs';
import { parseStream, claudeArgs, anonimizar } from '../scripts/benchmark-outcome.mjs';
import { makeT } from '../scripts/lib/i18n.mjs';

const S = (nome) => localPath(`../scripts/${nome}`);
const t = makeT('en');

function projeto(arquivos) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-achados-'));
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), conteudo);
  }
  return dir;
}

function hook(script, dir, evento, args = []) {
  const r = spawnSync(process.execPath, [S(script), ...args], {
    cwd: dir, input: typeof evento === 'string' ? evento : JSON.stringify(evento), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CONTEXT_TOOLS_HOOK_DEDUPE: '0', CONTEXT_TOOLS_LANG: 'en' },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}

const LEITOR = [
  'namespace Lib',
  '{',
  '    public class Leitor',
  '    {',
  '        private int? _max;',
  '',
  '        public Leitor()',
  '        {',
  '            _max = 64;',
  '        }',
  '',
  '        private void Empilhar(int valor)',
  '        {',
  '            if (_max != null && valor > _max)',
  '            {',
  '                throw new System.Exception("profundo");',
  '            }',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

test('grep-context: cada linha do Grep ganha o símbolo que a contém, com o intervalo', () => {
  const dir = projeto({ 'src/Leitor.cs': LEITOR });
  try {
    // Grep num arquivo só: a saída não repete o caminho.
    const unico = hook('grep-context.mjs', dir, {
      tool_name: 'Grep', cwd: dir, tool_input: { pattern: '_max', path: 'src/Leitor.cs' },
      tool_response: { mode: 'content', content: '5:        private int? _max;\n9:            _max = 64;\n14:            if (_max != null && valor > _max)\n16:                throw' },
    });
    assert.match(unico, /src\/Leitor\.cs: /);
    assert.match(unico, /9 Leitor\.Leitor\(\) \(7-10\)/, 'o construtor, não o método seguinte');
    assert.match(unico, /14-16 Leitor\.Empilhar\(\) \(12-18\)/, 'linhas seguidas do mesmo símbolo viram um intervalo');
    assert.match(unico, /5 class Leitor \(3-19\)/, 'campo fica na classe');

    // rg pelo Bash, com caminho Windows (o `C:` não pode virar separador) e um arquivo sem parser.
    const abs = join(dir, 'src', 'Leitor.cs');
    const bash = hook('grep-context.mjs', dir, {
      tool_name: 'Bash', cwd: dir, tool_input: { command: 'rg -n _max src' },
      tool_response: { stdout: `${abs}:14:            if (_max\nREADME.txt:3: _max` },
    });
    assert.match(bash, /14 Leitor\.Empilhar\(\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grep-context: sobrecargas com o mesmo nome não se fundem num intervalo só', () => {
  const dir = projeto({
    'src/Dist.cs': [
      'public class Dist', '{',
      '    public int Lev(string a, string b)', '    {', '        if (a == null) throw new System.Exception("nulo");', '        return 0;', '    }',
      '    public int Lev(string a, string b, int max)', '    {', '        if (a == null) throw new System.Exception("nulo");', '        return 0;', '    }',
      '}', '',
    ].join('\n'),
  });
  try {
    const saida = hook('grep-context.mjs', dir, {
      tool_name: 'Grep', cwd: dir, tool_input: { pattern: 'nulo', path: 'src/Dist.cs' },
      tool_response: { content: '5: x\n10: x' },
    });
    assert.match(saida, /5 Dist\.Lev\(\) \(3-7\) `public int Lev\(string a, string b\)`; 10 Dist\.Lev\(\) \(8-12\) `public int Lev\(string a, string b, int max\)`/,
      'cada sobrecarga com o próprio intervalo e a própria assinatura');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grep-context: corte nunca é silencioso, e teste fica para o fim', () => {
  // Rodada 2 do benchmark: a lista parava em 8 arquivos sem avisar, e o agente tratou como completa
  // uma resposta sem os chamadores dos arquivos cortados.
  const arquivos = {};
  for (let i = 1; i <= 24; i++) arquivos[`src/M${String(i).padStart(2, '0')}.cs`] = `public class M${i}\n{\n    public void Chama()\n    {\n        Alvo();\n    }\n}\n`;
  arquivos['Lib.Tests/MTests.cs'] = 'public class MTests\n{\n    public void Testa()\n    {\n        Alvo();\n    }\n}\n';
  const dir = projeto(arquivos);
  try {
    // O teste aparece PRIMEIRO na saída do Grep; mesmo assim vai para o fim.
    const content = ['Lib.Tests/MTests.cs:5:        Alvo();', ...Object.keys(arquivos).filter((f) => f.startsWith('src/')).map((f) => `${f}:5:        Alvo();`)].join('\n');
    const saida = hook('grep-context.mjs', dir, { tool_name: 'Grep', cwd: dir, tool_input: { pattern: 'Alvo' }, tool_response: { mode: 'content', content } });
    assert.match(saida, /src\/M01\.cs: 5 M1\.Chama\(\) \(3-6\)/);
    assert.match(saida, /⚠️ 5 more file\(s\) with matches NOT annotated above \(limit reached\) — this list is not complete: .*Lib\.Tests\/MTests\.cs/,
      '25 arquivos, 20 anotados: os 5 restantes são nomeados, e o teste está entre eles');
    assert.ok(saida.length <= 2000, `orçamento: ${saida.length}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grep-context: cala sem número de linha, fora do projeto, em outro comando e com entrada lixo', () => {
  const dir = projeto({ 'src/Leitor.cs': LEITOR });
  const fora = projeto({ 'Outro.cs': LEITOR });
  try {
    assert.equal(hook('grep-context.mjs', dir, { tool_name: 'Grep', cwd: dir, tool_input: { pattern: '_max' }, tool_response: { mode: 'files_with_matches', filenames: ['src/Leitor.cs'] } }), '');
    assert.equal(hook('grep-context.mjs', dir, { tool_name: 'Bash', cwd: dir, tool_input: { command: 'ls -la' }, tool_response: { stdout: 'src/Leitor.cs:14: x' } }), '');
    assert.equal(hook('grep-context.mjs', dir, { tool_name: 'Grep', cwd: dir, tool_input: { pattern: '_max' }, tool_response: { content: `${join(fora, 'Outro.cs')}:14: x` } }), '', 'arquivo de fora do projeto não é lido');
    assert.equal(hook('grep-context.mjs', dir, 'não é json'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fora, { recursive: true, force: true });
  }
  // Linhas de contexto (`-`) contam; o limite de arquivos vale.
  const pares = linhasPorArquivo('a.js:3-x\na.js:4:y\nb.js:1:z\n');
  assert.deepEqual([...pares.entries()], [['a.js', [3, 4]], ['b.js', [1]]]);
});

test('verify --session-start: o comando de teste e como rodar um arquivo só, ou silêncio', () => {
  const nodeTest = projeto({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  const runner = projeto({
    'package.json': JSON.stringify({ scripts: { test: 'node tests/run.mjs' } }),
    'tests/a.test.mjs': "import test from 'node:test';\n",
  });
  const vitest = projeto({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) });
  const py = projeto({ 'pytest.ini': '[pytest]\n' });
  const nada = projeto({ 'LEIA.md': '# nada\n' });
  try {
    assert.equal(sessionTestLine(nodeTest, {}, t), '🧪 Tests in this project: `npm test` (runs `node --test`); one file: `node --test <file>`.');
    assert.deepEqual(testDetails(runner, 'npm test'), { script: 'node tests/run.mjs', single: 'node --test <file>' }, 'runner próprio com node:test');
    assert.equal(testDetails(vitest, 'npm test').single, 'npx vitest run <file>');
    assert.match(sessionTestLine(py, {}, t), /`pytest`; one file: `pytest <file>::<test>`/);
    assert.equal(sessionTestLine(nada, {}, t), '', 'sem comando detectável, nada de chute');
    assert.equal(sessionTestLine(nodeTest, { verify: { enabled: false } }, t), '', 'verify desligado cala também aqui');
    assert.match(hook('verify.mjs', nodeTest, {}, ['--session-start']), /npm test/);
  } finally {
    for (const d of [nodeTest, runner, vitest, py, nada]) rmSync(d, { recursive: true, force: true });
  }
});

test('SessionStart da documentação: índice sem documentos não manda ler antes de explorar', () => {
  const dir = projeto({ 'src/a.js': 'export const a = 1;\n' });
  try {
    const primeira = documentationSessionContext(dir, {});
    assert.match(primeira, /has no documents yet; nothing to read before exploring/);
    assert.doesNotMatch(primeira, /Read the index before broad exploration/);
    assert.match(primeira, /Created: ai-context\/00-index\.md/, 'o que foi escrito no projeto continua dito');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('context-pack: produção antes de teste, exato antes de parcial', () => {
  const dir = projeto({
    'Lib.Tests/LeitorTests.cs': 'namespace T\n{\n    public class LeitorTests\n    {\n        public void MaxDepth()\n        {\n        }\n    }\n}\n',
    'Lib/Config.cs': 'namespace Lib\n{\n    public class Config\n    {\n        public const int DefaultMaxDepth = 64;\n    }\n}\n',
    'Lib/Leitor.cs': 'namespace Lib\n{\n    public class Leitor\n    {\n        public int? MaxDepth { get; set; }\n    }\n}\n',
  });
  try {
    const defs = buildContextPack(dir, 'MaxDepth', { budget: 800, history: false }).items
      .filter((i) => i.kind === 'definition').map((i) => `${i.confidence} ${i.file}`);
    assert.deepEqual(defs, ['exact Lib/Leitor.cs', 'partial Lib/Config.cs', 'exact Lib.Tests/LeitorTests.cs']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('benchmark: stream-json dá o resultado e a lista de ferramentas consultadas', () => {
  const linhas = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'MaxDepth', path: 'Src' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'Src/JsonReader.cs' } }, { type: 'text', text: 'x' }] } },
    { type: 'result', result: 'resposta', num_turns: 3, total_cost_usd: 0.1 },
  ].map((l) => JSON.stringify(l)).join('\n');
  const { json, tools } = parseStream(`${linhas}\nlixo\n`);
  assert.equal(json.result, 'resposta');
  assert.deepEqual(tools, ['Grep: MaxDepth', 'Read: Src/JsonReader.cs']);
  assert.deepEqual(parseStream('').tools, []);
  // results.json é publicável: cópia temporária e pasta do usuário somem em toda grafia.
  const dir = 'C:\\Users\\fulano\\AppData\\Local\\Temp\\ct-outcome-x-AbC';
  const home = 'C:\\Users\\fulano';
  assert.equal(
    anonimizar(`Read: ${dir}\\src\\a.cs | C:/Users/fulano/AppData/Local/Temp/ct-outcome-x-AbC/b.cs | /c/Users/fulano/tmp | "C:\\\\Users\\\\fulano\\\\x"`, dir, home),
    'Read: <copy>\\src\\a.cs | <copy>/b.cs | <home>/tmp | "<home>\\\\x"',
  );
  const args = claudeArgs('with');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--verbose'), 'stream-json no modo -p exige --verbose');
});
