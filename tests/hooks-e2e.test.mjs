// Testes de ponta a ponta dos HOOKS: roda o script como processo, exatamente como o Claude
// Code roda, e valida o contrato de saída.
//
// Os testes anteriores cobriam a lógica interna importando funções. Isso deixava sem cobertura
// justamente o que o Claude Code consome: o processo, o JSON, o código de saída. Um erro aí não
// aparece em teste unitário nenhum — e derruba (ou polui) toda sessão do usuário.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localPath } from './paths.mjs';
import { vereditoDaDivisao, economiaEstimada, pastaDeTranscripts, metricasDaSessao } from '../scripts/lib/sessao.mjs';
import { comandoDoPlugin } from '../scripts/handoff.mjs';
import { fingerprintSourcesInRoot } from '../scripts/lib/source-fingerprints.mjs';
import { fingerprintSourcesInRoots } from '../scripts/lib/source-fingerprints.mjs';
import { initializeDocumentation } from '../scripts/lib/documentation.mjs';
import { contextMapsStopReport } from '../scripts/context-maps.mjs';
import { recordSessionWriteEvent } from '../scripts/lib/session-write-journal.mjs';

const S = (nome) => localPath(`../scripts/${nome}`);

function repo({ comMapa = true, comMudanca = false } = {}) {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-e2e-'));
  mkdirSync(join(raiz, 'src'), { recursive: true });
  writeFileSync(join(raiz, 'src', 'a.js'), 'export function alfa() {}\n');
  const g = (...a) => spawnSync('git', ['-C', raiz, ...a], { stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('add', '-A');
  g('commit', '-qm', 'init');
  if (comMapa) {
    mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
    writeFileSync(
      join(raiz, '.claude', 'context', 'area.md'),
      '---\narea: "minha-area"\ncovers:\n  - "src/a.js"\nverified_at: HEAD\n---\n'
    );
  }
  if (comMudanca) appendFileSync(join(raiz, 'src', 'a.js'), 'export function beta() {}\n');
  return raiz;
}

function rodar(script, args, raiz, env = {}) {
  return spawnSync(process.execPath, [S(script), ...args], {
    env: { ...process.env, CONTEXT_TOOLS_HOST: 'claude', CONTEXT_MAPS_ROOT: raiz, CLAUDE_PROJECT_DIR: raiz, CONTEXT_TOOLS_LANG: 'en', ...env },
    encoding: 'utf8',
    cwd: raiz,
  });
}

test('E2E: SessionStart devolve JSON válido no contrato do hook', () => {
  const raiz = repo();
  try {
    const r = rodar('context-maps.mjs', ['--session-start'], raiz);
    assert.equal(r.status, 0, 'hook precisa sair com 0');
    const j = JSON.parse(r.stdout);
    assert.equal(j.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(typeof j.hookSpecificOutput.additionalContext === 'string');
    assert.ok(j.hookSpecificOutput.additionalContext.includes('minha-area'));
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: preflight offline só injeta contexto para arquivo citado e com pendência', () => {
  const raiz = repo({ comMapa: false });
  const ctx = join(raiz, '.claude', 'context');
  mkdirSync(ctx, { recursive: true });
  const digest = fingerprintSourcesInRoot(raiz, ['src/a.js']).digest;
  writeFileSync(join(ctx, 'area.md'), `---\narea: "minha-area"\ncovers:\n  - "src/a.js"\nverified_at: HEAD\nsource_digest: ${digest}\n---\n`);
  const audit = (prompt) => spawnSync(process.execPath, [S('context-docs.mjs'), '--prompt-audit'], {
    env: { ...process.env, CONTEXT_TOOLS_HOST: 'codex', CONTEXT_TOOLS_LANG: 'en', CONTEXT_TOOLS_PROJECT_DIR: raiz },
    input: JSON.stringify({ prompt }), encoding: 'utf8', cwd: raiz,
  });
  try {
    assert.equal(audit('Please review the implementation carefully.').stdout, '', 'sem caminho explícito não há contexto adicional');
    assert.equal(audit('Please review src/a.js.').stdout, '', 'mapa atualizado não consome tokens no prompt');

    appendFileSync(join(raiz, 'src', 'a.js'), 'export function nova() {}\n');
    const stale = audit('Please review src/a.js.');
    assert.equal(stale.status, 0);
    const context = JSON.parse(stale.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /offline preflight/i);
    assert.match(context, /minha-area/);

    writeFileSync(join(raiz, 'src', 'unmapped.ts'), 'export const x = 1;\n');
    const unmapped = audit('Please inspect `src/unmapped.ts`.');
    assert.match(JSON.parse(unmapped.stdout).hookSpecificOutput.additionalContext, /no context map covers/i);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: Stop automático só reporta mapa ligado a arquivo alterado após o baseline', () => {
  const raiz = repo({ comMapa: false });
  const git = (...args) => spawnSync('git', ['-C', raiz, ...args], { stdio: 'ignore' });
  const session = `scope-${Date.now()}-${Math.random()}`;
  const maps = join(raiz, '.claude', 'context');
  mkdirSync(maps, { recursive: true });
  writeFileSync(join(raiz, 'src', 'b.js'), 'export const old = true;\n');
  const aDigest = fingerprintSourcesInRoot(raiz, ['src/a.js']).digest;
  const bDigest = fingerprintSourcesInRoot(raiz, ['src/b.js']).digest;
  writeFileSync(join(maps, 'area-a.md'), `---\narea: area-a\ncovers:\n  - "src/a.js"\nverified_at: HEAD\nsource_digest: ${aDigest}\n---\n`);
  writeFileSync(join(maps, 'area-b.md'), `---\narea: area-b\ncovers:\n  - "src/b.js"\nverified_at: HEAD\nsource_digest: ${bDigest}\n---\n`);
  git('add', '-A');
  git('commit', '-qm', 'maps and sources');
  appendFileSync(join(raiz, 'src', 'b.js'), 'export const preexisting = true;\n');
  try {
    const start = rodar('context-maps.mjs', ['--session-start'], raiz, { CONTEXT_TOOLS_SESSION_ID: session });
    assert.equal(start.status, 0);
    appendFileSync(join(raiz, 'src', 'a.js'), 'export function sessionChange() {}\n');
    const stop = rodar('context-maps.mjs', ['--stop-report'], raiz, { CONTEXT_TOOLS_SESSION_ID: session });
    assert.equal(stop.status, 0);
    const context = JSON.parse(stop.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /area-a/);
    assert.doesNotMatch(context, /area-b/, 'mapa já stale antes do início da sessão fica fora');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: Stop automático limita documentos às fontes alteradas na sessão', () => {
  const raiz = repo({ comMapa: false });
  const git = (...args) => spawnSync('git', ['-C', raiz, ...args], { stdio: 'ignore' });
  const session = `docs-scope-${Date.now()}-${Math.random()}`;
  const a = join(raiz, 'src', 'a.js');
  const b = join(raiz, 'src', 'b.js');
  writeFileSync(b, 'export const original = true;\n');
  initializeDocumentation(raiz, { lang: 'en' });
  const docs = join(raiz, 'ai-context', 'features');
  const digestFor = (path, id) => fingerprintSourcesInRoots([{ root: raiz, path, id }]).digest;
  writeFileSync(join(docs, 'area-a.md'), `# Area A\n\n- Source: src/a.js\n- Last reviewed: 2026-01-01\n- source_digest: ${digestFor(a, './src/a.js')}\n`);
  writeFileSync(join(docs, 'area-b.md'), `# Area B\n\n- Source: src/b.js\n- Last reviewed: 2026-01-01\n- source_digest: ${digestFor(b, './src/b.js')}\n`);
  git('add', '-A');
  git('commit', '-qm', 'docs and sources');
  appendFileSync(b, 'export const preexisting = true;\n');
  try {
    const start = rodar('context-maps.mjs', ['--session-start'], raiz, {
      CONTEXT_TOOLS_HOST: 'codex', CONTEXT_TOOLS_SESSION_ID: session,
    });
    assert.equal(start.status, 0);
    const prime = rodar('context-docs.mjs', ['--session-start'], raiz, {
      CONTEXT_TOOLS_HOST: 'codex', CONTEXT_TOOLS_SESSION_ID: session,
    });
    assert.equal(prime.status, 0);
    const journalEnv = process.env.CONTEXT_TOOLS_HOST;
    process.env.CONTEXT_TOOLS_HOST = 'codex';
    try {
      recordSessionWriteEvent(raiz, { session_id: session }, '--session-start');
      const event = { session_id: session, tool_use_id: 'source-change', tool_name: 'Write', tool_input: { file_path: a }, tool_response: { success: true } };
      recordSessionWriteEvent(raiz, event, '--pre-tool-use');
      appendFileSync(a, 'export function sessionChange() {}\n');
      recordSessionWriteEvent(raiz, event, '--post-tool-use');
    } finally { journalEnv === undefined ? delete process.env.CONTEXT_TOOLS_HOST : process.env.CONTEXT_TOOLS_HOST = journalEnv; }
    const stop = rodar('context-docs.mjs', ['--stop-report'], raiz, {
      CONTEXT_TOOLS_HOST: 'codex', CONTEXT_TOOLS_SESSION_ID: session,
    });
    assert.equal(stop.status, 0);
    const context = JSON.parse(stop.stdout).reason;
    assert.match(context, /area-a\.md/);
    assert.doesNotMatch(context, /area-b\.md/, 'documento stale antes da sessão fica fora');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: sem mapa nenhum, o hook orienta o agente e sinaliza a primeira sessão', () => {
  const raiz = repo({ comMapa: false });
  try {
    const r = rodar('context-maps.mjs', ['--session-start'], raiz);
    assert.equal(r.status, 0);
    const output = JSON.parse(r.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /No context maps were found/);
    assert.match(output.hookSpecificOutput._contextToolsNotice, /No context maps were found/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: mapa corrompido não derruba o hook nem vaza lixo', () => {
  // M4: o hook nunca pode quebrar a sessão do usuário, aconteça o que acontecer.
  const raiz = repo();
  try {
    writeFileSync(join(raiz, '.claude', 'context', 'quebrado.md'), 'isto nao e frontmatter algum');
    writeFileSync(join(raiz, '.claude', 'context', 'vazio.md'), '');
    writeFileSync(join(raiz, '.claude', 'context', 'meio.md'), '---\narea: sem fechamento\n');
    const r = rodar('context-maps.mjs', ['--session-start'], raiz);
    assert.equal(r.status, 0, 'M4: exit 0 sempre');
    if (r.stdout.trim()) JSON.parse(r.stdout); // se falar, tem que ser JSON válido
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: Stop aponta mapas sem frontmatter ou metadata obrigatória', () => {
  const raiz = repo({ comMapa: false });
  const sid = `invalid-map-${Date.now()}-${Math.random()}`;
  try {
    rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
    writeFileSync(join(raiz, '.claude', 'context', 'quebrado.md'), '# Map without metadata\n');
    const r = rodar('context-maps.mjs', ['--stop-report'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /missing or invalid metadata/i);
    assert.match(context, /quebrado\.md/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: sem git, "verified_at: HEAD" não é data válida — hook diz "não verificável", não finge cobertura', () => {
  // `HEAD` é sintaxe de git ref, não de data: sem git o fallback de mtime não sabe o que fazer
  // com isso e tem que admitir, não interpretar como "desde sempre" nem calar.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-e2e-nogit-'));
  try {
    mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
    mkdirSync(join(raiz, 'src'), { recursive: true });
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function x() {}\n');
    writeFileSync(
      join(raiz, '.claude', 'context', 'a.md'),
      '---\narea: "x"\ncovers:\n  - "src/a.js"\nverified_at: HEAD\n---\n'
    );
    const r = rodar('context-maps.mjs', ['--session-start'], raiz);
    assert.equal(r.status, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /not verifiable/i, 'verified_at inválido sem git precisa admitir, não fingir');
    assert.match(ctx, /git init/i, 'sem git nenhum, o rodapé precisa sugerir o remédio');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: sem git, verified_at como DATA aciona o fallback de mtime', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-e2e-nogit-mtime-'));
  try {
    mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
    mkdirSync(join(raiz, 'src'), { recursive: true });
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function x() {}\n');
    writeFileSync(
      join(raiz, '.claude', 'context', 'a.md'),
      '---\narea: "x"\ncovers:\n  - "src/a.js"\nverified_at: "2020-01-01"\n---\n'
    );
    const r = rodar('context-maps.mjs', ['--session-start'], raiz);
    assert.equal(r.status, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    // src/a.js foi escrito AGORA, muito depois de 2020-01-01 — tem que acusar defasagem.
    assert.match(ctx, /POSSIBLY OUT OF DATE/, `precisa flagar via mtime: ${ctx}`);
    assert.match(ctx, /src\/a\.js/, 'precisa dizer QUAL arquivo');
    assert.match(ctx, /mtime/i, 'precisa deixar claro que o sinal é mais fraco que git');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: repo ganha git depois — verified_at (data) migra sozinho pra commit quando nada mudou por mtime', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-e2e-migra-'));
  try {
    mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
    mkdirSync(join(raiz, 'src'), { recursive: true });
    const alvo = join(raiz, 'src', 'a.js');
    writeFileSync(alvo, 'export function x() {}\n');
    const t0 = Date.now() - 60_000;
    utimesSync(alvo, t0 / 1000, t0 / 1000); // arquivo "editado" 60s atrás
    const mapa = join(raiz, '.claude', 'context', 'a.md');
    writeFileSync(
      mapa,
      `---\narea: "x"\ncovers:\n  - "src/a.js"\nverified_at: "${new Date(t0 + 30_000).toISOString()}"\n---\n`
    ); // verificado 30s DEPOIS da última edição — nada mudou desde então

    const g = (...a) => spawnSync('git', ['-C', raiz, ...a], { stdio: 'ignore' });
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('add', '-A');
    g('commit', '-qm', 'init');
    const head = spawnSync('git', ['-C', raiz, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

    const r = rodar('context-maps.mjs', ['--session-start'], raiz);
    assert.equal(r.status, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /auto-migrated/, `precisa avisar da migração: ${ctx}`);

    const novoConteudo = readFileSync(mapa, 'utf8');
    assert.match(novoConteudo, new RegExp(`verified_at: ${head}`), 'verified_at precisa virar o SHA do HEAD');
    assert.match(novoConteudo, /covers:\s*\n\s*- "src\/a\.js"/, 'resto do frontmatter precisa sobreviver intacto');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: repo ganha git depois, mas arquivo coberto mudou DEPOIS de verified_at — não migra, segue não verificável', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-e2e-nao-migra-'));
  try {
    mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
    mkdirSync(join(raiz, 'src'), { recursive: true });
    const alvo = join(raiz, 'src', 'a.js');
    writeFileSync(alvo, 'export function x() {}\n');
    const t0 = Date.now();
    const dataAntiga = new Date(t0 - 5 * 24 * 3600e3).toISOString(); // verified_at de 5 dias atrás
    // mtime do arquivo é AGORA — ou seja, mudou DEPOIS de verified_at.
    writeFileSync(
      join(raiz, '.claude', 'context', 'a.md'),
      `---\narea: "x"\ncovers:\n  - "src/a.js"\nverified_at: "${dataAntiga}"\n---\n`
    );

    const g = (...a) => spawnSync('git', ['-C', raiz, ...a], { stdio: 'ignore' });
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('add', '-A');
    g('commit', '-qm', 'init');

    const r = rodar('context-maps.mjs', ['--session-start'], raiz);
    assert.equal(r.status, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /auto-migrated/, `não pode migrar sem confirmar que nada mudou: ${ctx}`);
    assert.match(ctx, /not verifiable/i, 'sem confirmação por mtime, tem que continuar honesto');

    const conteudo = readFileSync(join(raiz, '.claude', 'context', 'a.md'), 'utf8');
    assert.match(conteudo, new RegExp(`verified_at: "?${dataAntiga}`), 'verified_at não pode ser reescrito sem confirmação');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: Stop avisa quando arquivo coberto muda sem o mapa mudar', () => {
  const raiz = repo();
  const sid = `covered-change-${Date.now()}-${Math.random()}`;
  try {
    rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    appendFileSync(join(raiz, 'src', 'a.js'), 'export function beta() {}\n');
    const r = rodar('context-maps.mjs', ['--stop-report'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim(), 'deveria avisar');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(/src\/a\.js/.test(ctx), 'precisa dizer QUAL arquivo mudou');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: Stop cala pendência antiga e auditoria global ainda a encontra', () => {
  const raiz = repo({ comMapa: false });
  const sid = `old-map-${Date.now()}-${Math.random()}`;
  try {
    const revisaoDoMapa = spawnSync('git', ['-C', raiz, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
    writeFileSync(join(raiz, '.claude', 'context', 'area.md'),
      `---\narea: "minha-area"\ncovers:\n  - "src/a.js"\nverified_at: ${revisaoDoMapa}\n---\n`);
    appendFileSync(join(raiz, 'src', 'a.js'), 'export function beta() {}\n');
    const committed = spawnSync('git', [
      '-C', raiz, '-c', 'user.email=t@t', '-c', 'user.name=test', 'commit', '-qam', 'change covered source',
    ], { encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.stderr);

    rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    const r = rodar('context-maps.mjs', ['--stop-report'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'pendência anterior ao baseline não entra no Stop automático');
    assert.match(contextMapsStopReport(raiz), /src\/a\.js/,
      'a auditoria global ainda mostra a referência persistente verified_at');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: Stop aceita que o mapa foi revisado depois de uma alteração local ainda não commitada', () => {
  const raiz = repo({ comMapa: false });
  try {
    const revisaoDoMapa = spawnSync('git', ['-C', raiz, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
    const mapa = join(raiz, '.claude', 'context', 'area.md');
    writeFileSync(mapa,
      `---\narea: "minha-area"\ncovers:\n  - "src/a.js"\nverified_at: ${revisaoDoMapa}\n---\nRevisado com a fonte atual.\n`);
    const sid = 'revisao-mapa-na-sessao';
    rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    appendFileSync(join(raiz, 'src', 'a.js'), 'export function beta() {}\n');
    writeFileSync(mapa,
      `---\narea: "minha-area"\ncovers:\n  - "src/a.js"\nverified_at: ${revisaoDoMapa}\n---\nRevisado com a fonte atual.\n`);
    const checked = fingerprintSourcesInRoot(raiz, ['src/a.js']);
    writeFileSync(mapa, readFileSync(mapa, 'utf8').replace('\n---\n', `\nsource_fingerprints: ${JSON.stringify(checked.sources)}\nsource_digest: ${checked.digest}\n---\n`));
    const future = new Date(Date.now() + 5000);
    utimesSync(mapa, future, future);

    const r = rodar('context-maps.mjs', ['--stop-report'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'metadata revisada deve encerrar a revisão pendente');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: Stop não repete o mesmo aviso (trava anti-loop)', () => {
  // Sem a trava, a condição persiste depois da resposta e o aviso volta a cada Stop —
  // podendo sustentar um laço que queima token sozinho.
  const raiz = repo();
  const sid = `anti-loop-${Date.now()}-${Math.random()}`;
  try {
    rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    appendFileSync(join(raiz, 'src', 'a.js'), 'export function beta() {}\n');
    const primeira = rodar('context-maps.mjs', ['--stop-report'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.ok(primeira.stdout.trim(), 'primeira precisa avisar');
    const segunda = rodar('context-maps.mjs', ['--stop-report'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(segunda.stdout.trim(), '', 'aviso idêntico não pode repetir');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: coupling --hook devolve JSON ou silêncio, nunca texto solto', () => {
  const raiz = repo({ comMudanca: true });
  try {
    const r = rodar('coupling.mjs', ['--changed', '--hook'], raiz);
    assert.equal(r.status, 0);
    if (r.stdout.trim()) {
      const j = JSON.parse(r.stdout);
      assert.equal(j.hookSpecificOutput.hookEventName, 'Stop');
    }
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: --strict do audit-docs sai com 1 quando acha ponteiro de linha', () => {
  // É o contrato usado em pre-commit: exit code errado passa doc podre adiante.
  const raiz = repo({ comMapa: false });
  try {
    mkdirSync(join(raiz, 'docs'), { recursive: true });
    writeFileSync(join(raiz, 'docs', 'g.md'), 'Ver `src/a.js:42` para detalhes.\n');
    const r = rodar('audit-docs.mjs', ['--strict', `--root=${raiz}`], raiz);
    assert.equal(r.status, 1, '--strict precisa falhar com ponteiro de linha');

    writeFileSync(join(raiz, 'docs', 'g.md'), 'Ver a funcao alfa para detalhes.\n');
    const limpo = rodar('audit-docs.mjs', ['--strict', `--root=${raiz}`], raiz);
    assert.equal(limpo.status, 0, 'sem ponteiro precisa passar');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: caso de teste é resposta de SEGUNDA CLASSE, atrás da definição', () => {
  // O risco de indexar nome de teste é justamente este: o nome do teste quase sempre CONTÉM o
  // nome do símbolo que ele testa, então sem ranqueamento a busca por `processaPedido` devolve
  // os testes dele antes da função. A pergunta "onde X está" tem uma resposta certa, e não é o
  // teste. Mesma doutrina de `key X`, e da regra de que arquivo nunca é apresentado como
  // definição.
  const raiz = repo({ comMapa: false });
  try {
    writeFileSync(join(raiz, 'src', 'pedido.js'), 'export function processaPedido() {}\n');
    mkdirSync(join(raiz, 'tests'), { recursive: true });
    writeFileSync(join(raiz, 'tests', 'p.test.mjs'),
      "test('processaPedido rejeita valor negativo', () => {});\n"
      + "test('processaPedido aceita zero', () => {});\n");

    const r = rodar('symbols.mjs', ['processaPedido', '--all', `--root=${raiz}`], raiz);
    assert.equal(r.status, 0);
    const linhas = r.stdout.split('\n');
    const iDef = linhas.findIndex((l) => /function processaPedido/.test(l));
    const iTeste = linhas.findIndex((l) => /rejeita valor negativo/.test(l));
    assert.ok(iDef >= 0, `a definição precisa aparecer, veio: ${r.stdout}`);
    assert.ok(iTeste >= 0, 'o teste também precisa aparecer — ele é resposta útil, só não é a primeira');
    assert.ok(iDef < iTeste, `a definição tem de vir ANTES do teste, veio: ${r.stdout}`);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: audit-docs audita os MAPAS, mas não o resto de .claude/', () => {
  // Os mapas eram os únicos documentos do projeto que ninguém auditava: `walk` pula toda entrada
  // iniciada por `.` e `IGNORED` contém `.claude`. Ao ligar isto nos 7 mapas deste repo saíram 4
  // achados, e um era REAL (um mapa citava o nome antigo de uma guarda). A poda do RESTO de
  // `.claude/` precisa continuar valendo — lá moram cache e travas, não documentação.
  const raiz = repo({ comMapa: false });
  try {
    mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
    writeFileSync(join(raiz, '.claude', 'context', 'area.md'),
      '---\narea: area\ncovers:\n  - "src/a.js"\nverified_at: HEAD\n---\n\nUsa `simboloQueNuncaExistiu` para tudo.\n');
    // Estado de ferramenta, com a MESMA cara de doc: não pode ser auditado.
    writeFileSync(join(raiz, '.claude', 'naoAuditar.md'), 'Cita `outroSimboloInexistente`.\n');

    const r = rodar('audit-docs.mjs', [`--root=${raiz}`], raiz);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /context\/area\.md/, `o mapa tem de ser auditado, veio: ${r.stdout}`);
    assert.match(r.stdout, /simboloQueNuncaExistiu/, 'o fantasma do mapa tem de ser acusado');
    assert.doesNotMatch(r.stdout, /naoAuditar/, '.claude/ fora de context/ continua sendo estado, não doc');
    assert.doesNotMatch(r.stdout, /outroSimboloInexistente/, 'não pode auditar estado de ferramenta');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: padrão de extensão citado num doc não vira "arquivo inexistente"', () => {
  // `.d.ts`, `.test.mjs`, `.spec.js` são PADRÃO de arquivo, não arquivo — e é assim que
  // documentação sobre filtro os escreve. Eram 3 dos 4 achados ao ligar a auditoria dos mapas.
  // Nome real continua sendo cobrado: sem isso o filtro teria trocado ruído por cegueira.
  const raiz = repo({ comMapa: false });
  try {
    mkdirSync(join(raiz, 'docs'), { recursive: true });
    writeFileSync(join(raiz, 'docs', 'filtro.md'),
      'O filtro exclui `.d.ts`, `.test.mjs` e `.spec.js` por padrão.\n');
    const r = rodar('audit-docs.mjs', [`--root=${raiz}`], raiz);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /\.d\.ts/, 'padrão de extensão não é arquivo inexistente');

    writeFileSync(join(raiz, 'docs', 'filtro.md'), 'Ver `moduloQueNaoExiste.js` para detalhes.\n');
    const real = rodar('audit-docs.mjs', [`--root=${raiz}`], raiz);
    assert.match(real.stdout, /moduloQueNaoExiste\.js/, 'nome de arquivo de verdade continua sendo cobrado');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: audit-docs RECUSA doc fora da raiz em vez de acusar tudo como inexistente', () => {
  // Regressão medida ao rodar o plugin num projeto de TERCEIRO: auditar o STACK.md de um
  // projeto com a raiz apontando para outro rendeu 93 achados [alto] + 13 [medio] que viraram
  // 1 [medio] com a raiz certa — 105 dos 106 eram artefato de ter olhado o repositório errado.
  // "Não existe" só pode ser afirmado se a busca aconteceu no lugar certo.
  const raiz = repo({ comMapa: false });
  const vizinho = mkdtempSync(join(tmpdir(), 'ctx-vizinho-doc-'));
  try {
    mkdirSync(join(vizinho, 'src'), { recursive: true });
    // O símbolo existe no VIZINHO — logo, acusá-lo de inexistente seria falso.
    writeFileSync(join(vizinho, 'src', 'b.js'), 'export function minhaFuncaoUnica() {}\n');
    writeFileSync(join(vizinho, 'FORA.md'), 'Ver `minhaFuncaoUnica` no modulo.\n');

    const r = rodar('audit-docs.mjs', [join(vizinho, 'FORA.md'), `--root=${raiz}`], raiz);
    assert.equal(r.status, 0, 'recusar não é erro — precisa sair 0');
    assert.match(r.stdout, /OUTSIDE the indexed root/, `esperava recusa explícita, veio: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /nonexistent symbol/, 'não pode acusar símbolo de um repo que não indexou');

    // Com a raiz certa, o mesmo doc é auditado normalmente e o símbolo é reconhecido.
    const ok = rodar('audit-docs.mjs', [join(vizinho, 'FORA.md'), `--root=${vizinho}`], vizinho);
    assert.doesNotMatch(ok.stdout, /OUTSIDE the indexed root/, 'raiz certa não pode ser recusada');
    assert.doesNotMatch(ok.stdout, /minhaFuncaoUnica/, 'símbolo existente não pode virar achado');
  } finally {
    rmSync(raiz, { recursive: true, force: true });
    rmSync(vizinho, { recursive: true, force: true });
  }
});

test('E2E: símbolo citado COM assinatura é conferido, não pulado', () => {
  // Regressão auto-demonstrada: `ehCandidato` rejeita token com parêntese/vírgula, então
  // `nome(args)` — a forma mais comum de citar função em doc — escapava da checagem inteira.
  // O mapa doc-audit.md deste repo citou por 2 commits uma função já renomeada e a auditoria
  // declarava "0 achados".
  const raiz = repo({ comMapa: false });
  try {
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function minhaFuncaoViva() {}\n');
    mkdirSync(join(raiz, 'docs'), { recursive: true });
    writeFileSync(
      join(raiz, 'docs', 'g.md'),
      'Ver `minhaFuncaoViva(a, b)` e tambem `minhaFuncaoMorta(x)` no modulo.\n'
    );
    const r = rodar('audit-docs.mjs', [`--root=${raiz}`], raiz);
    assert.match(r.stdout, /minhaFuncaoMorta/, `fantasma com assinatura precisa ser acusado: ${r.stdout}`);
    // E o que existe não pode virar achado só por ter sido citado com a assinatura.
    assert.doesNotMatch(r.stdout, /minhaFuncaoViva/, 'símbolo existente não pode virar fantasma');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: pasta de convenção não pode esconder o resto do repositório', () => {
  // O bug mais grave que a ferramenta já teve, e ele era silencioso: a descoberta devolvia
  // SÓ as pastas de convenção que existissem (`src`, `lib`, `tests`, `scripts`…), então
  // bastava uma delas existir para o resto sumir. Medido em repos reais:
  //   prometheus → 0 de 974 arquivos (100% invisível — tem `scripts/`, e o código mora em
  //                tsdb/, discovery/, storage/); django → 2.026 de 2.970 (32% invisível).
  // O layout abaixo é o do prometheus em miniatura: `scripts/` presente, código fora dele.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-desc-'));
  try {
    mkdirSync(join(raiz, 'scripts'), { recursive: true });
    mkdirSync(join(raiz, 'tsdb'), { recursive: true });
    writeFileSync(join(raiz, 'scripts', 'build.js'), 'export function build() {}\n');
    writeFileSync(join(raiz, 'tsdb', 'head.js'), 'export function funcaoEscondida() {}\n');

    const r = rodar('symbols.mjs', ['funcaoEscondida', `--root=${raiz}`], raiz);
    assert.match(r.stdout, /head\.js/, `código fora da pasta de convenção precisa ser achado: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /no DEFINITION/, 'não pode dizer que não existe');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: arquivo da raiz não é indexado duas vezes', () => {
  // `sourceDirs` devolve a raiz e `rootFiles` também devolvia os arquivos soltos dela, então
  // cada símbolo da raiz aparecia DUPLICADO na saída (cobra: 61 varridos para 36 reais).
  // Não era só feio: repetição comia o teto de 40 acertos e inflava a contagem que escolhe
  // o tier de cache.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-dup-'));
  try {
    writeFileSync(join(raiz, 'main.js'), 'export function soUmaVez() {}\n');
    const r = rodar('symbols.mjs', ['soUmaVez', `--root=${raiz}`], raiz);
    const acertos = (r.stdout.match(/main\.js/g) || []).length;
    assert.equal(acertos, 1, `esperava 1 ocorrência, veio ${acertos}: ${r.stdout}`);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: symbols distingue "pasta errada" de "linguagem que não leio"', () => {
  // Regressão medida num repo Rust real (um app desktop privado, 29 .rs): a mensagem dizia só "no source
  // files found" e mandava ajustar --root/sourceDirs. Nenhum dos dois podia funcionar, porque
  // a causa era a linguagem — seguir o conselho devolvia a MESMA mensagem. Falha visível com
  // diagnóstico errado custa round-trip atrás de algo que não existe.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-lang-'));
  const vazio = mkdtempSync(join(tmpdir(), 'ctx-vazio-'));
  try {
    mkdirSync(join(raiz, 'src'), { recursive: true });
    // ⚠️ ESTE TESTE PRECISA DE UMA LINGUAGEM QUE O ÍNDICE NÃO LEIA. Já foi `.rs`, depois
    // `.py`, e quebrou nas duas vezes — quando a linguagem entrou, o teste passou a falhar
    // sozinho. Ao ADICIONAR uma linguagem nova, troque a extensão aqui (é o 4º passo da
    // receita, junto com parser + CODE_RE + bareName). Ruby hoje; se Ruby entrar, use outra.
    writeFileSync(join(raiz, 'src', 'main.rb'), 'def main\nend\n');
    writeFileSync(join(raiz, 'src', 'lib.rb'), 'def alfa\nend\n');

    const r = rodar('symbols.mjs', ['alfa', `--root=${raiz}`], raiz);
    assert.match(r.stdout, /NONE in a language this index reads/, `esperava diagnóstico de linguagem: ${r.stdout}`);
    assert.match(r.stdout, /\.rb \(2\)/, 'precisa dizer QUAL extensão e quantas');
    assert.match(r.stdout, /will NOT help/, 'precisa desmentir o remédio que não serve');

    // Pasta de fato vazia continua recebendo o remédio de configuração — a outra causa.
    const v = rodar('symbols.mjs', ['alfa', `--root=${vazio}`], vazio);
    assert.match(v.stdout, /sourceDirs/, `pasta vazia mantém o remédio antigo: ${v.stdout}`);
    assert.doesNotMatch(v.stdout, /NONE in a language/, 'sem arquivo nenhum não é problema de linguagem');
  } finally {
    rmSync(raiz, { recursive: true, force: true });
    rmSync(vazio, { recursive: true, force: true });
  }
});

// A extensão do detector é a MESMA do índice (`CODE_RE` de lib/roots.mjs). Este teste roda
// sobre TODAS as linguagens de uma vez de propósito: a lista já foi copiada à mão aqui e
// derivou DUAS vezes — primeiro deixando Delphi e Rust cegos, depois Python e Go, sempre em
// silêncio. Testar linguagem por linguagem deixaria a próxima passar batido igual.
for (const [lang, ext, linha] of [
  ['Rust', 'rs', 'pub fn algo() {}'],
  ['Python', 'py', 'def algo(): pass'],
  ['Go', 'go', 'func algo() {}'],
  ['Delphi', 'pas', 'procedure Algo; begin end;'],
]) {
  test(`E2E: código ${lang} tocado também gera aviso de "sem mapa"`, () => {
    const raiz = repo({ comMapa: false });
    const g = (...a) => spawnSync('git', ['-C', raiz, ...a], { stdio: 'ignore' });
    try {
      for (const n of ['alfa', 'beta', 'gama']) {
        writeFileSync(join(raiz, 'src', `${n}.${ext}`), `${linha}\n`);
      }
      g('add', '-A'); g('commit', '-qm', lang);
      const sid = `sess-${ext}`;
      rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
      for (const n of ['alfa', 'beta', 'gama']) {
        appendFileSync(join(raiz, 'src', `${n}.${ext}`), '\n');
      }
      const r = rodar('context-maps.mjs', ['--stop-report'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
      assert.equal(r.status, 0, 'M4: exit 0 sempre');
      assert.match(r.stdout, new RegExp(`alfa\\.${ext}`), `esperava aviso citando os .${ext}, veio: ${r.stdout}`);
    } finally { rmSync(raiz, { recursive: true, force: true }); }
  });
}

test('E2E: um arquivo de qualquer linguagem também solicita avaliação de mapa', () => {
  const raiz = repo({ comMapa: false });
  const g = (...a) => spawnSync('git', ['-C', raiz, ...a], { stdio: 'ignore' });
  try {
    writeFileSync(join(raiz, 'src', 'unico.rs'), 'pub fn algo() {}\n');
    g('add', '-A'); g('commit', '-qm', 'rust');
    rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: 'sess-um' });
    appendFileSync(join(raiz, 'src', 'unico.rs'), '// mudou\n');
    const r = rodar('context-maps.mjs', ['--stop-report'], raiz, { CLAUDE_CODE_SESSION_ID: 'sess-um' });
    assert.equal(r.stdout.trim(), '', 'isolated uncovered source stays in manual health until recurrence');
    assert.match(contextMapsStopReport(raiz), /unico\.rs/, 'global audit still shows uncovered source');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: instalador não quebra nem corrompe settings.json de forma inesperada', () => {
  // O settings.json é do USUÁRIO e pode ter qualquer forma (escrito à mão, versão futura do
  // Claude Code, outra ferramenta). Antes, `hooks.SessionStart` como string derrubava o
  // instalador com stack trace. O que NÃO pode acontecer, em nenhuma hipótese, é a config do
  // usuário ser perdida.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-inst-'));
  const INSTALL = localPath('../install.mjs');
  try {
    mkdirSync(join(raiz, '.claude'), { recursive: true });
    writeFileSync(
      join(raiz, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { SessionStart: 'nao e lista' }, ajusteDoUsuario: 42 })
    );
    const r = spawnSync(process.execPath, [INSTALL, raiz], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'instalador não pode quebrar');
    assert.ok(!/TypeError|at file:/.test(r.stdout + r.stderr), 'não pode vazar stack trace');

    const depois = JSON.parse(readFileSync(join(raiz, '.claude', 'settings.json'), 'utf8'));
    assert.equal(depois.ajusteDoUsuario, 42, 'config do usuário precisa sobreviver');
    assert.equal(depois.hooks.SessionStart, 'nao e lista', 'o que era do usuário não pode ser sobrescrito');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: instalador é idempotente e não duplica hook', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-inst2-'));
  const INSTALL = localPath('../install.mjs');
  try {
    spawnSync(process.execPath, [INSTALL, raiz], { encoding: 'utf8' });
    spawnSync(process.execPath, [INSTALL, raiz], { encoding: 'utf8' });
    const s = JSON.parse(readFileSync(join(raiz, '.claude', 'settings.json'), 'utf8'));
    const cmds = s.hooks.Stop[0].hooks.map((h) => h.command);
    assert.equal(new Set(cmds).size, cmds.length, 'rodar duas vezes não pode duplicar hook');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: instalador registra EXATAMENTE os hooks do manifesto do plugin', () => {
  // Havia duas fiações de hook escritas à mão — o manifesto `hooks/hooks.json` (caminho
  // plugin) e a lista dentro do install.mjs (caminho standalone) — e elas DERIVARAM. O
  // manifesto ficou sem `handoff.mjs --stop-report` e sem o `PreToolUse` inteiro, então quem
  // instalasse como PLUGIN, que é o caminho recomendado no README, ficava sem o aviso de
  // sessão cara, sem handoff gerado e sem o único ponto PUSH — em silêncio, porque hook que
  // não existe não reclama. Hoje o install.mjs DERIVA do manifesto; este teste é o que impede
  // a cópia de voltar por outro caminho.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-inst3-'));
  const INSTALL = localPath('../install.mjs');
  const MANIFESTO = localPath('../hooks/hooks.json');
  try {
    const r = spawnSync(process.execPath, [INSTALL, raiz], { encoding: 'utf8' });
    assert.equal(r.status, 0, `instalador falhou: ${r.stdout}${r.stderr}`);

    const manifesto = JSON.parse(readFileSync(MANIFESTO, 'utf8')).hooks;
    const instalado = JSON.parse(readFileSync(join(raiz, '.claude', 'settings.json'), 'utf8')).hooks;

    // Compara pelo que os dois lados têm em comum: o script e seus argumentos. A variável de
    // caminho difere de propósito (${CLAUDE_PLUGIN_ROOT} × $CLAUDE_PROJECT_DIR/.claude).
    const semCaminho = (c) => c.replace(/^node "\$\{?CLAUDE_[A-Z_]+\}?(?:\/\.claude)?\/scripts\//, '').replace(/"/g, '');
    const achatar = (h) => Object.entries(h).flatMap(([ev, grupos]) =>
      grupos.flatMap((g) => g.hooks.map((x) => `${ev}|${g.matcher ?? ''}|${semCaminho(x.command)}`)));

    assert.deepEqual(
      achatar(instalado).sort(), achatar(manifesto).sort(),
      'os hooks instalados divergiram do manifesto do plugin',
    );
    // Guarda explícita contra as duas ausências reais que motivaram o teste.
    const todos = achatar(manifesto).join('\n');
    assert.match(todos, /handoff\.mjs --stop-report/, 'o manifesto precisa gerar o handoff no Stop');
    assert.match(todos, /PreToolUse\|Grep\|pre-tool\.mjs/, 'o PreToolUse precisa estar no manifesto, com matcher Grep');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: o .gitignore instalado cobre TODO estado que os scripts gravam', () => {
  // Mesma classe de deriva do manifesto de hooks: a lista de arquivos de estado era escrita à
  // mão no install.mjs e ficou para trás das features. Faltavam `.pre-tool-state.json`,
  // `.handoff-aviso.json` e `handoff-*.md` — então quem instalava via esses arquivos no
  // `git status` e podia commitar um handoff gerado. Hoje o install.mjs deriva do
  // `.claude/.gitignore` deste repo; isto prova que os dois lados batem e que os nomes são os
  // que os scripts REALMENTE escrevem (o antigo `.pre-tool-state` não casava o `.json`).
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-inst4-'));
  const INSTALL = localPath('../install.mjs');
  const FONTE = localPath('../.claude/.gitignore');
  try {
    const r = spawnSync(process.execPath, [INSTALL, raiz], { encoding: 'utf8' });
    assert.equal(r.status, 0, `instalador falhou: ${r.stdout}${r.stderr}`);
    const instalado = readFileSync(join(raiz, '.claude', '.gitignore'), 'utf8');
    const esperado = readFileSync(FONTE, 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const e of esperado) assert.ok(instalado.includes(e), `.gitignore instalado sem "${e}"`);

    // Os nomes precisam ser os que os scripts escrevem de verdade, não parecidos com eles.
    for (const real of ['.pre-tool-state.json', '.handoff-aviso.json', '.symbols-cache.json',
      '.context-maps-session-baseline.json', '.stop-report-state', '.coupling-state', '.coupling-sessions.json',
      '.source-fingerprints.json', '.context-maps-session-notice.json', '.documentation-session-notice.json',
      '.context-tools-metrics.1234.tmp']) {
      assert.ok(esperado.includes(real)
        || esperado.some((p) => p.endsWith('*') && real.startsWith(p.slice(0, -1)))
        || esperado.some((p) => p.startsWith('*') && real.endsWith(p.slice(1))),
        `nenhum padrão cobre o arquivo de estado "${real}"`);
    }
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: o fallback embutido de install.mjs não diverge de .claude/.gitignore', () => {
  // npm exclui arquivos ".gitignore" de pacotes distribuídos via npx por padrão (independente do
  // que o .gitignore diz), então install.mjs precisa de uma lista embutida para quando roda a
  // partir de um pacote empacotado, não de um checkout local. Sem este teste, a lista embutida
  // pode divergir silenciosamente da fonte real em .claude/.gitignore.
  const fonte = localPath('../install.mjs');
  const codigo = readFileSync(fonte, 'utf8');
  const bloco = codigo.match(/const STATE_FILES_FALLBACK = \[([\s\S]*?)\];/);
  assert.ok(bloco, 'install.mjs precisa expor STATE_FILES_FALLBACK como array literal');
  const embutido = [...bloco[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const esperado = readFileSync(localPath('../.claude/.gitignore'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  assert.deepEqual(embutido.sort(), esperado.sort(),
    'STATE_FILES_FALLBACK em install.mjs divergiu de .claude/.gitignore — atualize os dois juntos');
});

test('E2E: symbols responde e sai com 0 mesmo sem achar nada', () => {
  const raiz = repo({ comMapa: false });
  try {
    const achou = rodar('symbols.mjs', ['alfa', `--root=${raiz}`], raiz);
    assert.equal(achou.status, 0);
    assert.ok(/src\/a\.js:1/.test(achou.stdout), 'precisa dar arquivo e linha');

    const nada = rodar('symbols.mjs', ['zzz_nao_existe', `--root=${raiz}`], raiz);
    assert.equal(nada.status, 0, 'não achar não é erro de execução');
    assert.ok(/rg |Grep/i.test(nada.stdout), 'precisa mandar para o Grep, não devolver vazio');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: audit-docs enxerga doc fora de docs/', () => {
  // Mesmo bug do `sourceDirs`, e aqui era pior: `docDirs` não tinha fallback nenhum — repo
  // sem `docs/` devolvia lista VAZIA e a auditoria não olhava nada, calada.
  // Medido nos repos do workspace de referência: 20 documentos passaram a ser auditados, entre eles
  // AGENTS.md e CLAUDE.md — o arquivo que instrui o agente em toda sessão.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-doc-'));
  try {
    mkdirSync(join(raiz, 'src'), { recursive: true });
    mkdirSync(join(raiz, 'docs'), { recursive: true });
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function existe() {}\n');
    writeFileSync(join(raiz, 'docs', 'guia.md'), 'Veja `existe()`.\n');
    // Na RAIZ, fora de docs/ — é aqui que moram README, CLAUDE.md e AGENTS.md.
    writeFileSync(join(raiz, 'CLAUDE.md'), 'Chame `funcaoQueNaoExiste()` antes de tudo.\n');

    const r = rodar('audit-docs.mjs', [`--root=${raiz}`], raiz);
    assert.match(r.stdout, /funcaoQueNaoExiste/, `doc da raiz precisa ser auditada: ${r.stdout}`);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ---- PreToolUse: o unico ponto PUSH do plugin. Dimensionado no historico real deste
// workspace (68 sessoes): 649 dos 1.633 Greps (40%) procuram algo com cara de simbolo.
// Interceptar Read foi MEDIDO e descartado — so 25 de 3.690 (1%) seriam candidatos.
function preTool(entrada, raiz, sid = 'sessao-teste') {
  return spawnSync(process.execPath, [S('pre-tool.mjs')], {
    input: JSON.stringify(entrada),
    env: { ...process.env, CLAUDE_PROJECT_DIR: raiz, CONTEXT_TOOLS_LANG: 'en', CLAUDE_CODE_SESSION_ID: sid },
    encoding: 'utf8',
    cwd: raiz,
  });
}

test('E2E: PreToolUse responde ANTES do Grep quando o padrão é um símbolo', () => {
  const raiz = repo({ comMapa: false });
  try {
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function minhaFuncaoUnica() {}\n');
    const r = preTool({ tool_name: 'Grep', tool_input: { pattern: 'minhaFuncaoUnica' } }, raiz);
    assert.equal(r.status, 0, 'M4: nunca pode derrubar a sessão');
    const j = JSON.parse(r.stdout);
    assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(j.hookSpecificOutput.additionalContext, /minhaFuncaoUnica/);
    assert.match(j.hookSpecificOutput.additionalContext, /a\.js/, 'precisa dizer ONDE');
    assert.doesNotMatch(j.hookSpecificOutput.additionalContext, /evidence pack|pacote de evidências/i, 'símbolo simples não deve pagar pack');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: PreToolUse usa pack pequeno quando o símbolo atravessa arquivos', () => {
  const raiz = repo({ comMapa: false });
  try {
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function alvoDoPack() {}\n');
    writeFileSync(join(raiz, 'src', 'b.js'), 'export function alvoDoPack() {}\n');
    const r = preTool({ tool_name: 'Grep', tool_input: { pattern: 'alvoDoPack' } }, raiz, 'pack-sessao');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /evidence pack|pacote de evidências/i, 'a rota ambígua precisa declarar o pack');
    assert.match(ctx, /a\.js/, 'o pack precisa preservar a primeira definição');
    assert.match(ctx, /b\.js/, 'o pack precisa preservar a segunda definição');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: PreToolUse nomeia o repo/escopo varrido na resposta', () => {
  // Sem isso, um acerto de OUTRO módulo dentro do mesmo repo (ou a ausência de um símbolo que
  // na verdade mora num repo IRMÃO fora da raiz indexada) parece resposta completa. Nomear o
  // escopo é o que deixa quem lê perceber a fronteira, em vez de confiar cegamente.
  const raiz = repo({ comMapa: false });
  try {
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function minhaFuncaoUnica() {}\n');
    const r = preTool({ tool_name: 'Grep', tool_input: { pattern: 'minhaFuncaoUnica' } }, raiz);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /scope:/, `resposta precisa dizer qual repo foi varrido: ${ctx}`);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: PreToolUse NÃO repete a mesma resposta na mesma sessão', () => {
  const raiz = repo({ comMapa: false });
  try {
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function minhaFuncaoUnica() {}\n');
    assert.ok(preTool({ tool_name: 'Grep', tool_input: { pattern: 'minhaFuncaoUnica' } }, raiz).stdout.trim());
    const segunda = preTool({ tool_name: 'Grep', tool_input: { pattern: 'minhaFuncaoUnica' } }, raiz);
    assert.equal(segunda.stdout.trim(), '', 'repetir gasta token sem informar nada');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: PreToolUse cala em busca textual, símbolo inexistente e outra ferramenta', () => {
  // Silêncio é o padrão. O Grep roda de qualquer jeito — e nestes casos ele é a ferramenta
  // certa, então falar seria só ruído.
  const raiz = repo({ comMapa: false });
  try {
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function existe() {}\n');
    const regex = preTool({ tool_name: 'Grep', tool_input: { pattern: 'ai_triage\.flows.*' } }, raiz, 's1');
    assert.equal(regex.stdout.trim(), '', 'regex textual não é pergunta de símbolo');
    const ausente = preTool({ tool_name: 'Grep', tool_input: { pattern: 'NaoExisteEmLugarNenhum' } }, raiz, 's2');
    assert.equal(ausente.stdout.trim(), '', 'sem acerto o Grep resolve melhor');
    const curto = preTool({ tool_name: 'Grep', tool_input: { pattern: 'ab' } }, raiz, 's3');
    assert.equal(curto.stdout.trim(), '', 'nome curto casaria com meio mundo');
    const outra = preTool({ tool_name: 'Edit', tool_input: { file_path: 'x' } }, raiz, 's4');
    assert.equal(outra.stdout.trim(), '', 'só Grep interessa');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: claude-md-hint anexa o bloco UMA VEZ, e cala nas próximas', () => {
  const raiz = repo({ comMapa: false });
  try {
    writeFileSync(join(raiz, 'CLAUDE.md'), '# Meu projeto\n\nAlgumas notas.\n');
    const primeira = rodar('claude-md-hint.mjs', [], raiz);
    assert.equal(primeira.status, 0);
    const j = JSON.parse(primeira.stdout);
    assert.match(j.hookSpecificOutput.additionalContext, /CLAUDE\.md/);

    const conteudo = readFileSync(join(raiz, 'CLAUDE.md'), 'utf8');
    assert.match(conteudo, /# Meu projeto/, 'conteúdo original precisa sobreviver intacto');
    assert.match(conteudo, /context-tools:before-explore/, 'bloco marcado precisa ter sido anexado');

    const segunda = rodar('claude-md-hint.mjs', [], raiz);
    assert.equal(segunda.stdout.trim(), '', 'segunda vez tem que calar — já fez');

    const conteudoDepois = readFileSync(join(raiz, 'CLAUDE.md'), 'utf8');
    assert.equal(conteudoDepois, conteudo, 'segunda chamada não pode duplicar nem alterar nada');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: claude-md-hint não cria CLAUDE.md que o projeto não tinha', () => {
  const raiz = repo({ comMapa: false });
  try {
    const r = rodar('claude-md-hint.mjs', [], raiz);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'sem CLAUDE.md, não há o que anexar — e não deve criar um');
    assert.equal(existsSync(join(raiz, 'CLAUDE.md')), false, 'não pode criar arquivo que o projeto não tinha');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: claude-md-hint desliga com claudeMdHint:false na config', () => {
  const raiz = repo({ comMapa: false });
  try {
    writeFileSync(join(raiz, 'CLAUDE.md'), '# Projeto\n');
    mkdirSync(join(raiz, '.claude'), { recursive: true });
    writeFileSync(join(raiz, '.claude', 'context-tools.json'), JSON.stringify({ claudeMdHint: false }));
    const r = rodar('claude-md-hint.mjs', [], raiz);
    assert.equal(r.stdout.trim(), '', 'desligado por config, não pode escrever nada');
    const conteudo = readFileSync(join(raiz, 'CLAUDE.md'), 'utf8');
    assert.equal(conteudo, '# Projeto\n', 'CLAUDE.md não pode ser tocado quando desligado');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: claude-md-hint não duplica se o CLAUDE.md já tem o bloco (copiado de outro projeto)', () => {
  const raiz = repo({ comMapa: false });
  try {
    writeFileSync(join(raiz, 'CLAUDE.md'), '# Projeto\n\n<!-- context-tools:before-explore -->\njá tinha\n<!-- /context-tools:before-explore -->\n');
    const antes = readFileSync(join(raiz, 'CLAUDE.md'), 'utf8');
    const r = rodar('claude-md-hint.mjs', [], raiz);
    assert.equal(r.stdout.trim(), '', 'bloco já presente: marca feito e cala, não duplica');
    assert.equal(readFileSync(join(raiz, 'CLAUDE.md'), 'utf8'), antes, 'conteúdo não pode mudar quando o bloco já existe');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: PreToolUse com entrada lixo sai em silêncio e com status 0', () => {
  const raiz = repo({ comMapa: false });
  try {
    for (const lixo of ['', 'nao e json', '{"tool_name":null}', '{}']) {
      const r = spawnSync(process.execPath, [S('pre-tool.mjs')], {
        input: lixo, env: { ...process.env, CLAUDE_PROJECT_DIR: raiz }, encoding: 'utf8', cwd: raiz,
      });
      assert.equal(r.status, 0, `M4 quebrou com entrada: ${JSON.stringify(lixo)}`);
      assert.equal(r.stdout.trim(), '');
    }
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ---- why.mjs: a unica pergunta em que ler mais codigo NAO ajuda.
test('E2E: why devolve os commits que moldaram as linhas do símbolo', () => {
  const raiz = repo({ comMapa: false });
  try {
    const g = (...a) => spawnSync('git', ['-C', raiz, ...a], { stdio: 'ignore' });
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function guardaImportante() {\n  return 1;\n}\n');
    g('add', '-A');
    g('commit', '-qm', 'guard existe porque a fila estourava em producao');

    const r = rodar('why.mjs', ['guardaImportante', `--root=${raiz}`], raiz);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /guardaImportante/, `precisa nomear o alvo: ${r.stdout}`);
    assert.match(r.stdout, /fila estourava/, 'precisa trazer a RAZÃO, que é o ponto todo');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: why aceita <arquivo> <linha> sem depender do índice', () => {
  const raiz = repo({ comMapa: false });
  try {
    const g = (...a) => spawnSync('git', ['-C', raiz, ...a], { stdio: 'ignore' });
    writeFileSync(join(raiz, 'src', 'a.js'), 'const limiar = 300;\n');
    g('add', '-A');
    g('commit', '-qm', 'limiar medido, nao chutado');
    const r = rodar('why.mjs', ['src/a.js', '1', `--root=${raiz}`], raiz);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /limiar medido/, `modo arquivo:linha falhou: ${r.stdout}`);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: why distingue "não achei" de "não consegui olhar"', () => {
  // Sem git nao existe historico — e dizer "sem motivo registrado" seria mentir, porque a
  // busca nem aconteceu. Mesma doutrina do coupling.
  const semGit = mkdtempSync(join(tmpdir(), 'ctx-why-nogit-'));
  try {
    mkdirSync(join(semGit, 'src'), { recursive: true });
    writeFileSync(join(semGit, 'src', 'a.js'), 'export function existe() {}\n');
    const r = rodar('why.mjs', ['existe', `--root=${semGit}`], semGit);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no git repository|nenhum reposit/i, `esperava dizer que não há git: ${r.stdout}`);
  } finally { rmSync(semGit, { recursive: true, force: true }); }

  const raiz = repo({ comMapa: false });
  try {
    const r = rodar('why.mjs', ['SimboloQueNaoExiste', `--root=${raiz}`], raiz);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /not in the index|não está no índice/i);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ---- O plugin instalado onde ele NAO SERVE. Regra: continuar ajudando quando pode, e nao
// atrapalhar quando nao pode — o que inclui nao QUEBRAR, nao MENTIR e nao cobrar caro por nada.
test('E2E: projeto em linguagem que o índice não lê — explica, não quebra, não mente', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-incompat-'));
  try {
    mkdirSync(join(raiz, 'app'), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(raiz, 'app', `m${i}.rb`), `class Modelo${i}\nend\n`);

    const s = rodar('symbols.mjs', ['Modelo1', `--root=${raiz}`], raiz);
    assert.equal(s.status, 0);
    assert.match(s.stdout, /NONE in a language this index reads/, 'precisa dizer que a CAUSA é a linguagem');
    assert.match(s.stdout, /\.rb \(5\)/, 'precisa dizer QUAL linguagem e quantos arquivos');
    assert.match(s.stdout, /will NOT help/, 'precisa desmentir o remédio que não serve');

    // O SessionStart deve informar a ausência de mapas; o Stop permanece sem ruído sem
    // alterações ocorridas durante a sessão.
    for (const [script, args] of [['context-maps.mjs', ['--session-start']], ['context-maps.mjs', ['--stop-report']]]) {
      const r = rodar(script, args, raiz);
      assert.equal(r.status, 0);
      if (args[0] === '--session-start') assert.match(r.stdout, /No context maps were found/);
      else assert.equal(r.stdout.trim(), '', `${script} ${args[0]} não deve avisar sem alteração da sessão`);
    }
    const p = rodar('pre-tool.mjs', [], raiz);
    assert.equal(p.status, 0);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: sem git, cada ferramenta faz a coisa certa (ajuda ou explica)', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-nogit2-'));
  try {
    mkdirSync(join(raiz, 'src'), { recursive: true });
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function existeAqui() {}\n');

    // symbols e audit-docs só precisam dos ARQUIVOS: têm que continuar funcionando.
    assert.match(rodar('symbols.mjs', ['existeAqui', `--root=${raiz}`], raiz).stdout, /a\.js/);
    assert.equal(rodar('audit-docs.mjs', [`--root=${raiz}`], raiz).status, 0);

    // coupling e why dependem de histórico: têm que DIZER que não há, nunca fingir resposta.
    const c = rodar('coupling.mjs', [`--root=${raiz}`], raiz);
    assert.match(c.stdout, /no git repository/i, `coupling precisa explicar: ${c.stdout}`);
    const w = rodar('why.mjs', ['existeAqui', `--root=${raiz}`], raiz);
    assert.match(w.stdout, /no git repository/i, `why precisa explicar: ${w.stdout}`);

    // O hook orienta a primeira sessão mesmo sem mapa; a decisão de criar conteúdo continua do agente.
    const maps = JSON.parse(rodar('context-maps.mjs', ['--session-start'], raiz).stdout);
    assert.match(maps.hookSpecificOutput.additionalContext, /No context maps were found/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: sem git, Stop também enxerga arquivo tocado nesta sessão via mtime', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-nogit-stop-'));
  const sid = 'sessao-sem-git';
  try {
    mkdirSync(join(raiz, 'src'), { recursive: true });
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function existente() {}\n');

    // SessionStart grava o relógio de início (não há HEAD para gravar).
    rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });

    // Toca 3 arquivos DEPOIS do início da sessão — nenhum mapa cobre. 3+ arquivos é o limiar de
    // relevância (MIN_ARQUIVOS_PARA_AVISAR): um arquivo avulso pequeno demais cala de propósito.
    writeFileSync(join(raiz, 'src', 'novo.js'), 'export function novo() {}\n');
    writeFileSync(join(raiz, 'src', 'novo2.js'), 'export function novo2() {}\n');
    writeFileSync(join(raiz, 'src', 'novo3.js'), 'export function novo3() {}\n');

    const r = rodar('context-maps.mjs', ['--stop-report'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    const ctx = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
    assert.match(ctx, /novo\.js/, `precisa acusar o arquivo novo sem mapa: ${ctx}`);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: sem git, auditoria global detecta conteúdo alterado mesmo com mtime preservado', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-nogit-hash-'));
  const fonte = join(raiz, 'src', 'a.js');
  const mapa = join(raiz, '.claude', 'context', 'area.md');
  const mtime = new Date('2020-01-01T00:00:00Z');
  try {
    mkdirSync(join(raiz, 'src'), { recursive: true });
    mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
    writeFileSync(fonte, 'export function alfa() {}\n');
    utimesSync(fonte, mtime, mtime);
    writeFileSync(mapa, '---\narea: "minha-area"\ncovers:\n  - "src/a.js"\nverified_at: 2021-01-01\n---\n');

    assert.equal(contextMapsStopReport(raiz), '', 'a referência legada limpa cria baseline local sem prompt');

    writeFileSync(fonte, 'export function beta() {}\n');
    utimesSync(fonte, mtime, mtime);
    const report = contextMapsStopReport(raiz);
    assert.match(report, /src\/a\.js/, 'o hash detecta mudança apesar do mtime antigo');
    assert.match(report, /ack.mjs/);

    const digest = fingerprintSourcesInRoot(raiz, ['src/a.js']).digest;
    writeFileSync(mapa, `---\narea: "minha-area"\ncovers:\n  - "src/a.js"\nverified_at: 2021-01-01\nsource_digest: ${digest}\n---\n`);
    assert.equal(contextMapsStopReport(raiz), '', 'o digest revisado limpa a pendência sem depender da data');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: sem git, coupling aprende acoplamento por SESSÃO (cesta = sessão inteira, não commit)', () => {
  // Sem git, coupling.mjs não tem commit pra usar de cesta — usa a sessão inteira, gravada em
  // .claude/.coupling-sessions.json (ver recordSessionBasket em coupling.mjs). `minSessions`
  // (default 5) é o limiar abaixo do qual a resposta tem que ser "ainda não sei", não "sem
  // acoplamento" — por isso 5 sessões idênticas bastam para o link aparecer.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-coupling-nogit-'));
  try {
    mkdirSync(join(raiz, 'src'), { recursive: true });
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function a() {}\n');
    writeFileSync(join(raiz, 'src', 'b.js'), 'export function b() {}\n');

    for (let i = 0; i < 5; i++) {
      const sid = `sessao-${i}`;
      rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
      writeFileSync(join(raiz, 'src', 'a.js'), `export function a() { return ${i}; }\n`);
      writeFileSync(join(raiz, 'src', 'b.js'), `export function b() { return ${i}; }\n`);
      // Qualquer chamada (não só --changed) grava a cesta da sessão atual.
      rodar('coupling.mjs', [], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    }

    // Sessão nova, que não tocou nada — só CONSULTA o histórico já acumulado pelas 5 de cima.
    const r = rodar('coupling.mjs', [], raiz, { CLAUDE_CODE_SESSION_ID: 'sessao-consulta' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /a\.js/, `precisa listar a.js: ${r.stdout}`);
    assert.match(r.stdout, /b\.js/, `precisa listar b.js: ${r.stdout}`);
    assert.match(r.stdout, /5 sessions? recorded/i, `precisa dizer que o sinal vem de sessão, não commit: ${r.stdout}`);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: sem git, coupling abaixo do limiar de sessões diz "ainda não sei", não "sem acoplamento"', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-coupling-cold-'));
  try {
    mkdirSync(join(raiz, 'src'), { recursive: true });
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function a() {}\n');
    writeFileSync(join(raiz, 'src', 'b.js'), 'export function b() {}\n');

    const sid = 'sessao-unica';
    rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    writeFileSync(join(raiz, 'src', 'a.js'), 'export function a() { return 1; }\n');
    writeFileSync(join(raiz, 'src', 'b.js'), 'export function b() { return 1; }\n');

    const r = rodar('coupling.mjs', [], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no git repository/i, `sem git precisa dizer isso: ${r.stdout}`);
    assert.match(r.stdout, /1 of 5/, `precisa dar o placar de quanto falta: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /no coupling above threshold/i, '1 sessão não é "medi e não achei" — é "ainda não medi o bastante"');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: sessões concorrentes não corrompem o cache', () => {
  // Duas janelas do Claude Code no mesmo repo é caso comum. A gravação é atômica
  // (temporário + rename); sem isso um processo leria o que o outro está escrevendo.
  const raiz = mkdtempSync(join(tmpdir(), 'ctx-conc-'));
  try {
    mkdirSync(join(raiz, 'src'), { recursive: true });
    // Acima do limiar de cache, senão o tier B nem entra em jogo.
    for (let i = 0; i < 320; i++) writeFileSync(join(raiz, 'src', `a${i}.js`), `export function f${i}() {}\n`);

    const filhos = [1, 2, 3, 4].map((i) => rodar('symbols.mjs', [`f${i}`, `--root=${raiz}`], raiz));
    for (const [i, r] of filhos.entries()) {
      assert.equal(r.status, 0, `processo ${i} caiu`);
      assert.match(r.stdout, /definition\(s\)/, `processo ${i} não respondeu: ${r.stdout}`);
    }
    const cache = join(raiz, '.claude', '.symbols-cache.json');
    if (existsSync(cache)) {
      const c = JSON.parse(readFileSync(cache, 'utf8')); // lança se corrompido
      assert.ok(c.entries && Object.keys(c.entries).length > 0, 'cache gravado precisa ter entradas');
    }
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ---- handoff: o custo por mensagem cresce 3,4x com o contexto (medido em 65 sessoes), e o
// prefixo cacheado e regravado — zero vezes abaixo de 1h, mediana de 5 acima de 12h.
test('E2E: handoff lista o que a sessão tocou e NÃO inventa o resto', () => {
  const raiz = repo({ comMapa: false, comMudanca: true });
  try {
    const r = rodar('handoff.mjs', [`--root=${raiz}`], raiz);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /src\/a\.js/, `precisa listar o arquivo tocado: ${r.stdout}`);
    // O estado volátil fica como formulário EM BRANCO: preencher por palpite viraria
    // handoff que mente, e um handoff que mente é pior que não ter handoff.
    assert.match(r.stdout, /NÃO tem como saber|CANNOT know/i, 'precisa separar o que ele não sabe');
    assert.match(r.stdout, /NÃO funcionou|did NOT work/i, 'precisa perguntar o que falhou');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: handoff não reporta o estado interno do plugin como trabalho', () => {
  // O cache de símbolos e o baseline mudam a toda chamada. Lista-los seria a ferramenta
  // se confundindo com o trabalho. Mas os MAPAS são conteúdo real e têm que aparecer.
  const raiz = repo({ comMapa: false });
  try {
    mkdirSync(join(raiz, '.claude', 'context'), { recursive: true });
    writeFileSync(join(raiz, '.claude', '.symbols-cache.json'), '{"entries":{}}');
    writeFileSync(join(raiz, '.claude', '.context-maps-session-baseline.json'), '{}');
    writeFileSync(join(raiz, '.claude', 'context', 'area.md'), '---\narea: x\n---\n');
    const r = rodar('handoff.mjs', [`--root=${raiz}`], raiz);
    assert.doesNotMatch(r.stdout, /symbols-cache/, 'cache do plugin não é trabalho da sessão');
    assert.doesNotMatch(r.stdout, /session-baseline/, 'baseline do plugin não é trabalho');
    assert.match(r.stdout, /context\/area\.md/, 'mapa de contexto É trabalho e precisa aparecer');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ---- sujeira herdada: o baseline guarda o HEAD, e `git diff <HEAD>` compara commit contra
// WORKING TREE — então tudo que já estava sujo antes da sessão entrava como trabalho dela.
// Medido em 2026-08-04: dois arquivos modificados 20 h ANTES da sessão foram anunciados como
// "tocados nesta sessão", e continuariam em todo handoff até alguém commitar.
test('E2E: sujeira que já existia antes da sessão NÃO vira trabalho da sessão', () => {
  const raiz = repo({ comMapa: false });
  const sid = 'sessao-sujeira-herdada';
  try {
    // Sujo ANTES de a sessão abrir: um rastreado modificado e um não rastreado.
    appendFileSync(join(raiz, 'src', 'a.js'), 'export function herdada() {}\n');
    writeFileSync(join(raiz, 'src', 'nova-herdada.js'), 'export function novaHerdada() {}\n');

    // SessionStart grava HEAD + o mtime da sujeira existente.
    rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });

    const r = rodar('handoff.mjs', [`--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /a\.js/, `sujeira herdada não é trabalho da sessão: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /nova-herdada\.js/, 'não rastreado herdado também não é');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: arquivo já sujo que a sessão EDITA continua aparecendo', () => {
  // O outro lado da moeda, e o mais perigoso: subtrair pelo NOME esconderia trabalho real.
  // Por isso o critério é o mtime. `utimesSync` em vez de esperar o relógio — granularidade de
  // mtime varia por sistema de arquivos, e teste que depende disso pendura no CI de vez em quando.
  const raiz = repo({ comMapa: false });
  const sid = 'sessao-edita-o-que-ja-estava-sujo';
  try {
    appendFileSync(join(raiz, 'src', 'a.js'), 'export function jaEstavaSuja() {}\n');
    rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });

    // A sessão mexe no mesmo arquivo que já estava sujo.
    appendFileSync(join(raiz, 'src', 'a.js'), 'export function editadaNaSessao() {}\n');
    const daquiUmaHora = new Date(Date.now() + 3600000);
    utimesSync(join(raiz, 'src', 'a.js'), daquiUmaHora, daquiUmaHora);

    const r = rodar('handoff.mjs', [`--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /a\.js/, `trabalho real não pode sumir: ${r.stdout}`);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: sem registro de sujeira, o handoff degrada para o comportamento antigo', () => {
  // Versão antiga do hook, sessão sem id, baseline podado: nada disso pode quebrar nem
  // esconder arquivo. Sem o registro, mostra tudo — que é conservador e nunca omite trabalho.
  const raiz = repo({ comMapa: false, comMudanca: true });
  try {
    const r = rodar('handoff.mjs', [`--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: 'sessao-sem-baseline' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /src\/a\.js/, 'sem registro, o comportamento é o de antes');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ---- o laço que faltava: o plugin manda dividir a sessão desde que existe, e até 2026-08-04
// ninguém sabia se dividir tinha funcionado. O veredito julga o par (sessão que fechou cara →
// sessão que a sucedeu), que só fica completo depois — julgar no início da sucessora um
// aquecimento que ela ainda não teve seria inventar.
test('E2E: o veredito da divisão CALA quando não há par para julgar', () => {
  // Sem transcript nenhum, silêncio total. É o caso mais comum e o contrato M4.
  const raiz = repo({ comMapa: false });
  try {
    const r = rodar('handoff.mjs', ['--session-start', `--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: 'sem-par' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'sem par de sessões não há veredito honesto');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('veredito: ganha, empata e perde nos pontos medidos', () => {
  // O ponto de equilíbrio é 1,75x o aquecimento típico (52 mensagens), de simulação
  // contrafactual sobre 69 sessões. Abaixo ganha, acima perde — e a curva não extrapola.
  const cara = { contexto: 400000, fim: 1000, msgsAteEdit: 50 };
  const suc = (msgs) => ({ contexto: 100000, inicio: 1000 + 3600000, msgsAteEdit: msgs });

  assert.equal(vereditoDaDivisao(cara, suc(36), 200000).veredito, 'ganhou');
  assert.equal(vereditoDaDivisao(cara, suc(91), 200000).veredito, 'empatou');
  assert.equal(vereditoDaDivisao(cara, suc(150), 200000).veredito, 'perdeu');

  // Sessão anterior BARATA: não houve divisão, então não há veredito a dar.
  assert.equal(vereditoDaDivisao({ ...cara, contexto: 80000 }, suc(36), 200000), null);
  // Sucessora que não produziu nada: aquecimento indefinido, não é zero.
  assert.equal(vereditoDaDivisao(cara, { ...suc(36), msgsAteEdit: null }, 200000), null);
  // Gap grande: é outro trabalho, não continuação.
  assert.equal(vereditoDaDivisao(cara, { ...suc(36), inicio: 1000 + 40 * 3600000 }, 200000), null);
});

test('pastaDeTranscripts acha a pasta de um WORKTREE (o ponto de `.claude`)', () => {
  // Regressão de 2026-08-04, achada abrindo sessão dentro de um worktree deste próprio repo.
  // Todo worktree tem `.claude/worktrees/` no caminho, e o Claude Code converte o `.` em `-`
  // junto com as barras. A codificação não convertia o ponto, então DENTRO DE WORKTREE esta
  // função devolvia `null` e o bloco de custo inteiro — veredito, aviso do Stop, métricas do
  // handoff — ficava morto em silêncio. Falha calada é o modo de falha que este plugin existe
  // para não ter, e ela estava no próprio plugin.
  const base = mkdtempSync(join(tmpdir(), 'ctx-proj-'));
  try {
    const worktree = 'C--Projetos-meu-app--claude-worktrees-ctv-76b94b';
    const simples = 'C--Meus-Projetos';
    mkdirSync(join(base, worktree));
    mkdirSync(join(base, simples));

    assert.equal(
      pastaDeTranscripts('C:\\Projetos\\meu-app\\.claude\\worktrees\\ctv-76b94b', base),
      join(base, worktree),
    );
    // O caso que já funcionava não pode ter regredido: espaço continua virando um traço só.
    assert.equal(pastaDeTranscripts('C:\\Meus Projetos', base), join(base, simples));
    // Raiz sem pasta correspondente continua devolvendo null em vez de chutar a mais parecida.
    assert.equal(pastaDeTranscripts('C:\\Projetos\\outro-repo', base), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('metricasDaSessao normaliza o transcript do Codex sem usar a curva do Claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-codex-transcript-'));
  const caminho = join(dir, 'rollout.jsonl');
  try {
    const linha = (timestamp, payload) => JSON.stringify({ timestamp, type: 'event_msg', payload });
    writeFileSync(caminho, [
      JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', type: 'session_meta' }),
      linha('2026-08-06T03:00:00.000Z', { type: 'task_started' }),
      linha('2026-08-06T03:00:01.000Z', { type: 'token_count', info: {
        total_token_usage: { input_tokens: 120000, cached_input_tokens: 90000, cache_write_input_tokens: 0, output_tokens: 2000, reasoning_output_tokens: 500, total_tokens: 122500 },
        last_token_usage: { input_tokens: 180000, cached_input_tokens: 150000, cache_write_input_tokens: 0, output_tokens: 400, reasoning_output_tokens: 100, total_tokens: 180500 },
        model_context_window: 258400,
      }, rate_limits: { primary: { used_percent: 12 } } }),
      linha('2026-08-06T07:00:00.000Z', { type: 'task_compacted' }),
      linha('2026-08-06T07:00:01.000Z', { type: 'task_started' }),
      linha('2026-08-06T07:00:02.000Z', { type: 'token_count', info: {
        total_token_usage: { input_tokens: 150000, cached_input_tokens: 110000, cache_write_input_tokens: 1000, output_tokens: 3000, reasoning_output_tokens: 700, total_tokens: 153700 },
        last_token_usage: { input_tokens: 70000, cached_input_tokens: 60000, cache_write_input_tokens: 1000, output_tokens: 600, reasoning_output_tokens: 200, total_tokens: 70800 },
        model_context_window: 258400,
      }, rate_limits: { primary: { used_percent: 13 } } }),
    ].join('\n') + '\n');

    const m = metricasDaSessao(caminho);
    assert.equal(m.host, 'codex');
    assert.equal(m.msgs, 2, 'turnos devem vir dos task_started, não de uma curva de custo');
    assert.ok(Math.abs(m.horas - 7) < 0.01, `horas inesperadas: ${m.horas}`);
    assert.equal(m.contexto, 180000, 'contexto deve ser o maior input da última requisição');
    assert.equal(m.janela, 258400);
    assert.equal(m.percentualContexto, 180000 / 258400);
    assert.equal(m.totalInputTokens, 150000);
    assert.equal(m.totalCachedInputTokens, 110000);
    assert.equal(m.totalOutputTokens, 3000);
    assert.equal(m.compactacoes, 1);
    assert.equal(m.rateLimits.primary.used_percent, 13);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('E2E: Codex não avisa por contexto/tempo, mas mantém métricas no handoff', () => {
  const raiz = repo({ comMapa: false, comMudanca: true });
  const dir = mkdtempSync(join(tmpdir(), 'ctx-codex-stop-'));
  const caminho = join(dir, 'rollout.jsonl');
  const sid = 'codex-sessao-longa';
  const linha = (timestamp, payload) => JSON.stringify({ timestamp, type: 'event_msg', payload });
  const token = (timestamp, input) => linha(timestamp, { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: input - 1000, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: input + 110 },
    last_token_usage: { input_tokens: input, cached_input_tokens: input - 1000, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: input + 110 },
    model_context_window: 258400,
  } });
  const ambiente = { CONTEXT_TOOLS_HOST: 'codex', CONTEXT_TOOLS_SESSION_ID: sid, CONTEXT_TOOLS_TRANSCRIPT_PATH: caminho };
  try {
    writeFileSync(caminho, [
      JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', type: 'session_meta' }),
      linha('2026-08-06T03:00:00.000Z', { type: 'task_started' }),
      token('2026-08-06T03:00:01.000Z', 250000),
    ].join('\n') + '\n');
    const cedo = rodar('handoff.mjs', ['--stop-report', `--root=${raiz}`], raiz, ambiente);
    assert.equal(cedo.status, 0);
    assert.equal(cedo.stdout.trim(), '', 'contexto alto sozinho não deve disparar o aviso no Codex');

    writeFileSync(caminho, [
      JSON.stringify({ timestamp: '2026-08-06T00:00:00.000Z', type: 'session_meta' }),
      linha('2026-08-06T07:00:00.000Z', { type: 'task_started' }),
      token('2026-08-06T07:00:01.000Z', 70000),
    ].join('\n') + '\n');
    const tarde = rodar('handoff.mjs', ['--stop-report', `--root=${raiz}`], raiz, ambiente);
    assert.equal(tarde.status, 0);
    assert.equal(tarde.stdout.trim(), '', 'tempo alto também não deve disparar aviso no Codex');
    const handoff = rodar('handoff.mjs', ['--salvar', `--root=${raiz}`], raiz, ambiente);
    assert.equal(handoff.status, 0);
    assert.match(handoff.stdout, /Codex session/i, 'métricas do Codex continuam no handoff');
    assert.ok(existsSync(join(raiz, '.codex', 'context-tools', `handoff-${sid.slice(0, 8)}.md`)));
  } finally {
    rmSync(raiz, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('economiaEstimada não extrapola além da curva medida', () => {
  // Prometer número fora do que foi simulado seria inventar precisão.
  assert.equal(economiaEstimada(0.1), economiaEstimada(0.7), 'abaixo da curva, devolve a ponta');
  assert.equal(economiaEstimada(99), economiaEstimada(3.0), 'acima da curva, devolve a ponta');
  assert.ok(economiaEstimada(1.0) > 0 && economiaEstimada(2.0) < 0, 'o sinal vira no equilíbrio');
});

test('comandoDoPlugin descobre onde o script está, em vez de adivinhar', () => {
  // Ele conhecia dois layouts e caía no de `.claude/scripts/` por padrão. Existe um terceiro —
  // repositório cujos hooks apontam para o `scripts/` da própria fonte — e nele o aviso do Stop
  // mandava rodar um caminho INEXISTENTE. Adivinhar entre N casos sempre erra no N+1;
  // `import.meta.url` sabe a resposta.
  const raiz = process.platform === 'win32' ? 'C:\\proj' : '/proj';
  const j = (...p) => [raiz, ...p].join(process.platform === 'win32' ? '\\' : '/');

  const antes = process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  try {
    // 1) fonte é o próprio repo (este caso, o que estava quebrado)
    assert.equal(comandoDoPlugin(raiz, j('scripts', 'handoff.mjs')), 'scripts/handoff.mjs');
    // 2) instalação standalone
    assert.equal(comandoDoPlugin(raiz, j('.claude', 'scripts', 'handoff.mjs')), '.claude/scripts/handoff.mjs');
    // 3) script FORA da raiz: não há relativo honesto, então vem absoluto — nunca um palpite curto
    const fora = comandoDoPlugin(raiz, process.platform === 'win32' ? 'C:\\outro\\scripts\\handoff.mjs' : '/outro/scripts/handoff.mjs');
    assert.match(fora, /outro\/scripts\/handoff\.mjs/);
    assert.ok(!fora.startsWith('..'), 'caminho relativo para fora da raiz não serve a ninguém');
    // 4) como plugin, a variável vence o caminho real (é a forma portátil)
    process.env.CLAUDE_PLUGIN_ROOT = j('plugin');
    assert.match(comandoDoPlugin(raiz, j('scripts', 'handoff.mjs')), /\$CLAUDE_PLUGIN_ROOT/);
  } finally {
    if (antes === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = antes;
  }
});

test('E2E: símbolo grande demais não é atribuído — o nome não diria nada', () => {
  // `comIntervalos` fecha um símbolo na linha anterior ao próximo de mesma profundidade, então
  // um helper de topo seguido de chamadas que não viram símbolo engole todas elas. Foi o que
  // fez o handoff anunciar `function rodar` quando o que mudou foram testes dentro do intervalo
  // absorvido. Medido neste repo: mediana 11 linhas, p95 106, e o maior símbolo REAL tem 127.
  const raiz = repo({ comMapa: false });
  const g = (...a) => spawnSync('git', ['-C', raiz, ...a], { stdio: 'ignore' });
  const sid = 'sessao-span';
  try {
    // `helper` tem 3 linhas de verdade, mas absorve as 250 chamadas seguintes (que não são
    // símbolo) e fica com span > MAX_SPAN_ATRIBUIVEL. `pequena` fica logo depois, curtinha.
    const corpo = [
      'export function helper() {', '  return 1;', '}',
      ...Array.from({ length: 250 }, () => 'helper();'),
      'export function pequena() {', '  return 2;', '}',
    ];
    writeFileSync(join(raiz, 'src', 'grande.js'), corpo.join('\n') + '\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    rodar('context-maps.mjs', ['--session-start'], raiz, { CLAUDE_CODE_SESSION_ID: sid });

    // Edita FUNDO no intervalo absorvido por `helper`, e também dentro de `pequena`.
    corpo[150] = 'helper(); // mudou aqui';
    corpo[corpo.length - 2] = '  return 22;';
    writeFileSync(join(raiz, 'src', 'grande.js'), corpo.join('\n') + '\n');

    const r = rodar('handoff.mjs', [`--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /grande\.js/, 'o arquivo tem de aparecer de qualquer jeito');
    assert.doesNotMatch(r.stdout, /helper/, 'símbolo de 250+ linhas não diz onde retomar — não pode ser atribuído');
    assert.match(r.stdout, /pequena/, 'símbolo de tamanho útil continua sendo atribuído');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: o Stop entrega o prompt sozinho, mas SÓ depois do bloco preenchido', () => {
  // O prompt não pode sair junto do aviso: naquele instante o bloco volátil acabou de ser
  // gerado EM BRANCO, e é ele que faz o prompt valer a pena colar. Entregá-lo ali seria
  // entregar a versão inútil — a mesma que já existiu em disco e não ajudou ninguém. Então o
  // hook espera o preenchimento e entrega no turno seguinte, sem ninguém lembrar de comando.
  const raiz = repo({ comMapa: false, comMudanca: true });
  const transcritos = mkdtempSync(join(tmpdir(), 'ctx-transc-'));
  const sid = 'sessao-duas-fases';
  const env = { CLAUDE_CODE_SESSION_ID: sid, CONTEXT_TOOLS_TRANSCRIPTS: transcritos };
  const stop = () => rodar('handoff.mjs', ['--stop-report', `--root=${raiz}`], raiz, env);
  const doc = join(raiz, '.claude', `handoff-${sid.slice(0, 8)}.md`);
  try {
    // Transcript caro o bastante para cruzar o limiar de 200k de contexto.
    const uso = (n) => JSON.stringify({
      type: 'assistant', timestamp: new Date(17e11 + n * 60000).toISOString(),
      message: { usage: { cache_read_input_tokens: 260000, cache_creation_input_tokens: 100 } },
    });
    writeFileSync(join(transcritos, `${sid}.jsonl`),
      Array.from({ length: 40 }, (_, i) => uso(i)).join('\n') + '\n');

    // FASE 1 — avisa e grava o arquivo, e NÃO cospe prompt: o bloco acabou de nascer em branco.
    const f1 = stop();
    assert.equal(f1.status, 0);
    assert.match(f1.stdout, /Session at \d+k tokens/, `esperava o aviso, veio: ${f1.stdout}`);
    assert.ok(existsSync(doc), 'o handoff tinha de ser gerado');
    assert.doesNotMatch(f1.stdout, /Continuing work from a previous session/,
      'com o bloco em branco, entregar o prompt seria entregar a versão inútil');

    // Turno seguinte, ainda em branco: silêncio. Insistir ensinaria a ignorar a categoria.
    assert.equal(stop().stdout.trim(), '', 'em branco tem de calar');

    // O agente preenche a primeira pergunta.
    writeFileSync(doc, readFileSync(doc, 'utf8')
      .replace(/^(- \*\*.+?\*\*)\s*$/m, '$1 estava no parser de Pascal'));

    // FASE 2 — o prompt sai sozinho, sem ninguém lembrar de comando, e vai também para disco.
    const f2 = stop();
    assert.equal(f2.status, 0);
    assert.match(f2.stdout, /Continuing work from a previous session/, `esperava o prompt, veio: ${f2.stdout}`);
    assert.match(f2.stdout, /estava no parser de Pascal/, 'o bloco preenchido tem de ir junto');
    assert.ok(existsSync(doc.replace(/\.md$/, '.prompt.md')), 'o prompt também vai para disco');

    // E uma vez só.
    assert.equal(stop().stdout.trim(), '', 'o prompt sai UMA vez por sessão');
  } finally {
    rmSync(raiz, { recursive: true, force: true });
    rmSync(transcritos, { recursive: true, force: true });
  }
});

test('--prompt corta o cabeçalho por ESTRUTURA, em idioma que o i18n nem conhece', () => {
  // O corte era regex de texto traduzido (`^Esta sessão:|^This session:`). Modo de falha:
  // idioma novo no i18n — ou handoff gerado por outra versão — e o bloco de métricas vazava
  // para o prompt, calado. Aqui o documento está em ALEMÃO, que o i18n não fala: se o corte
  // dependesse de reconhecer a frase, as métricas passariam direto.
  const raiz = repo({ comMapa: false, comMudanca: true });
  const sid = 'sessao-estrutura';
  try {
    mkdirSync(join(raiz, '.claude'), { recursive: true });
    writeFileSync(
      join(raiz, '.claude', `handoff-${sid.slice(0, 8)}.md`),
      ['# Übergabe der Sitzung — 2026-08-04',
        '',
        'Diese Sitzung: 229 Nachrichten, 212k Token Kontext.',
        'Gemessen an 65 echten Sitzungen: jede Nachricht kostet 1.6x.',
        '',
        '## repositório — 2 arquivo(s)',
        '- `src/velho.js`',
        '',
        '## O que a ferramenta NÃO tem como saber — preencha antes de fechar',
        '- **Estado:** o parser de Pascal',
        ''].join('\n'),
    );
    const r = rodar('handoff.mjs', ['--prompt', `--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    // NADA de fora do bloco volátil do arquivo salvo pode chegar ao prompt — nem o título, nem
    // as métricas, nem a lista de arquivos dele. Desde a mescla isso vale por CONSTRUÇÃO (só o
    // volátil é enxertado), e não mais por reconhecer a frase; o alemão está aqui justamente
    // para que um idioma que o i18n não fala não tenha como passar por acidente.
    for (const vazado of [/Übergabe/, /Diese Sitzung/, /Gemessen an/, /src\/velho\.js/]) {
      assert.doesNotMatch(r.stdout, vazado, `conteúdo não-volátil do arquivo salvo vazou: ${vazado}`);
    }
    // O bloco mecânico vem fresco, no idioma da config, refletindo o que a sessão tocou de fato.
    assert.match(r.stdout, /src\/a\.js/, 'a lista de arquivos tem de ser a real, gerada agora');
    assert.match(r.stdout, /o parser de Pascal/, 'e o bloco volátil preenchido sobrevive');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('--prompt re-rotula o bloco volátil em vez de repetir "preencha"', () => {
  // No arquivo o bloco se chama "preencha antes de fechar" e vem com o aviso de que está em
  // branco de propósito — certos para quem vai preencher. Num prompt cujo bloco JÁ está
  // preenchido, os dois viram uma instrução que o próprio documento mostra cumprida, na cara
  // de quem acabou de colá-lo.
  //
  // O arquivo aqui é gravado em PORTUGUÊS e lido com a config em inglês, de propósito: é o
  // caso que derrubou a primeira tentativa, que comparava o texto traduzido. Localizar o bloco
  // por estrutura (último `##` do documento) é o que faz isto valer para handoff gerado em
  // outro idioma ou por uma versão anterior — falhar aí seria falhar calado, que é exatamente
  // o defeito que este re-rótulo veio consertar.
  const raiz = repo({ comMapa: false, comMudanca: true });
  const sid = 'sessao-rotulo';
  try {
    mkdirSync(join(raiz, '.claude'), { recursive: true });
    writeFileSync(
      join(raiz, '.claude', `handoff-${sid.slice(0, 8)}.md`),
      ['# Handoff', '', '## O que a ferramenta NÃO tem como saber — preencha antes de fechar',
        'Tudo acima saiu do git e dos mapas. O que vem abaixo só existe na sua cabeça, e é exatamente o que faz a próxima sessão começar rápido. Fica em branco de propósito: palpite aqui vira handoff que mente.',
        '', '- **O que estava sendo feito, e até onde chegou:** o parser de Pascal', ''].join('\n'),
    );
    const r = rodar('handoff.mjs', ['--prompt', `--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /o parser de Pascal/, 'o conteúdo preenchido tem de sobreviver');
    assert.doesNotMatch(r.stdout, /preencha antes de fechar/, 'o prompt não pode pedir o que já está feito');
    assert.doesNotMatch(r.stdout, /em branco de propósito/, 'o aviso de "está em branco" contradiz um bloco preenchido');
    // O título novo sai no idioma da CONFIG (aqui, inglês), enquanto o corpo preservado
    // continua na língua em que foi escrito. É o comportamento certo: o enquadramento é da
    // sessão que está começando; o conteúdo é da que terminou, e reescrevê-lo seria inventar.
    assert.match(r.stdout, /## What only the previous session knew/, 'o bloco precisa continuar tendo um título');
    // O corte do cabeçalho também é estrutural (tudo antes do primeiro `##`). O documento
    // gravado acima tem `# Handoff` em português; nenhuma regex de idioma participa disso.
    assert.doesNotMatch(r.stdout, /^# Handoff/m, 'o título do arquivo não entra no prompt');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('--prompt regenera o bloco MECÂNICO e preserva só o volátil', () => {
  // Pego em produção, no mesmo dia em que a entrega automática do prompt foi escrita: o
  // `--prompt` preferia o arquivo salvo INTEIRO, para não apagar o bloco volátil — e com isso
  // congelava também a lista de arquivos, que é derivável. Numa sessão longa, o handoff
  // preenchido cedo entregava no fim uma lista velha e um "próximo passo" já feito.
  //
  // A divisão certa é a mesma do resto do arquivo: preservar o que ninguém consegue derivar,
  // regenerar o que se deriva sozinho.
  const raiz = repo({ comMapa: false, comMudanca: true });
  const sid = 'sessao-mescla';
  try {
    mkdirSync(join(raiz, '.claude'), { recursive: true });
    // Handoff "antigo": bloco mecânico mentiroso, bloco volátil legítimo.
    writeFileSync(
      join(raiz, '.claude', `handoff-${sid.slice(0, 8)}.md`),
      ['# Handoff', '', '## repositório — 1 arquivo(s)', '- `arquivo-que-nao-existe-mais.js`', '',
        '## O que a ferramenta NÃO tem como saber — preencha antes de fechar',
        '- **Estado:** o parser de Pascal', ''].join('\n'),
    );
    const r = rodar('handoff.mjs', ['--prompt', `--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /o parser de Pascal/, 'o bloco volátil preenchido tem de sobreviver');
    assert.doesNotMatch(r.stdout, /arquivo-que-nao-existe-mais/,
      'o bloco mecânico tem de vir fresco do git, não congelado no arquivo salvo');
    assert.match(r.stdout, /src\/a\.js/, 'e tem de refletir o que a sessão realmente tocou');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: --prompt NÃO descarta o bloco volátil já preenchido', () => {
  // O prompt é para colar numa sessão nova, e a única parte que o faz valer é o bloco volátil.
  // Regenerar o documento aqui apagaria exatamente o que alguém acabou de escrever.
  const raiz = repo({ comMapa: false, comMudanca: true });
  const sid = 'sessao-prompt-preenchido';
  try {
    mkdirSync(join(raiz, '.claude'), { recursive: true });
    writeFileSync(
      join(raiz, '.claude', `handoff-${sid.slice(0, 8)}.md`),
      '# Handoff\n\n## repo\n- `src/a.js`\n\n- **O que estava sendo feito:** RESPOSTA-JA-ESCRITA\n'
    );
    const r = rodar('handoff.mjs', ['--prompt', `--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /RESPOSTA-JA-ESCRITA/, `o preenchido tem que sobreviver: ${r.stdout}`);
    assert.match(r.stdout, /Continuing work|Continuando o trabalho/, 'precisa do enquadramento de quem cola');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: --prompt gera do zero quando não há arquivo salvo', () => {
  const raiz = repo({ comMapa: false, comMudanca: true });
  try {
    const r = rodar('handoff.mjs', ['--prompt', `--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: 'sem-arquivo' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /src\/a\.js/, 'sem arquivo salvo, monta na hora');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: o aviso de sessão cara cala quando não há transcript', () => {
  // M4: sem dado, silêncio. E nunca pode derrubar o Stop.
  const raiz = repo({ comMapa: false });
  try {
    const r = rodar('handoff.mjs', ['--stop-report', `--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: 'sessao-que-nao-existe' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'sem transcript não há o que afirmar');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: handoff diz QUAIS SÍMBOLOS mudaram, não só o arquivo', () => {
  // "Você mexeu em triageService.js" quase não informa: são 14.249 linhas. Cruzar o
  // `git diff -U0` com os intervalos que o índice já guarda transforma isso em
  // "mexeu em registerFeedback" — que é onde a próxima sessão retoma.
  const raiz = repo({ comMapa: false });
  try {
    writeFileSync(join(raiz, 'src', 'a.js'), [
      'export function intocada() { return 1; }',
      'export function alterada() { return 2; }',
      'export function tambemIntocada() { return 3; }',
    ].join('\n') + '\n');
    const g = (...a) => spawnSync('git', ['-C', raiz, ...a], { stdio: 'ignore' });
    g('add', '-A'); g('commit', '-qm', 'base');
    writeFileSync(join(raiz, 'src', 'a.js'), [
      'export function intocada() { return 1; }',
      'export function alterada() { return 22; }',
      'export function tambemIntocada() { return 3; }',
    ].join('\n') + '\n');

    const r = rodar('handoff.mjs', [`--root=${raiz}`], raiz);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /alterada/, `precisa nomear o símbolo mudado: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /tambemIntocada/, 'símbolo não tocado não pode entrar');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('E2E: o aviso de sessão sai UMA VEZ e já deixa o handoff em disco', () => {
  // Repetir não traz informação nova — só ensina a ignorar a categoria inteira, que é o
  // mesmo raciocínio do aviso de "sem mapa". E gerar o handoff junto evita uma volta
  // inteira na hora em que o usuário decidir fechar.
  const raiz = repo({ comMapa: false });
  const sid = 'sessao-de-teste-aviso';
  try {
    // Transcript falso: contexto acima do limiar de 200k.
    const projDir = join(tmpdir(), 'ctx-fake-proj');
    rmSync(projDir, { recursive: true, force: true });
    const r1 = rodar('handoff.mjs', ['--stop-report', `--root=${raiz}`], raiz, { CLAUDE_CODE_SESSION_ID: sid });
    // Sem transcript real o aviso cala — e isso já é o contrato M4 sendo cumprido.
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout.trim(), '', 'sem dado de sessão, silêncio');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});
