import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordSessionWriteEvent } from '../scripts/lib/session-write-journal.mjs';
import { contextMapsPromptAudit, contextMapsStopReport, recordSessionBaseline, sessionBaselineDiagnostics, sessionChangedFiles } from '../scripts/context-maps.mjs';
import { mapasRelevantes } from '../scripts/handoff.mjs';
import { shouldStartAutoReview } from '../scripts/lib/auto-review-state.mjs';
import { compareReviewedSources, fingerprintSourcesInRoot, fingerprintSourcesInRoots } from '../scripts/lib/source-fingerprints.mjs';
import { documentationStopReport, initializeDocumentation } from '../scripts/lib/documentation.mjs';

function withSession(root, fn) {
  const previous = {
    mapsRoot: process.env.CONTEXT_MAPS_ROOT,
    projectDir: process.env.CONTEXT_TOOLS_PROJECT_DIR,
    sessionId: process.env.CONTEXT_TOOLS_SESSION_ID,
    host: process.env.CONTEXT_TOOLS_HOST,
  };
  process.env.CONTEXT_MAPS_ROOT = root;
  process.env.CONTEXT_TOOLS_PROJECT_DIR = root;
  process.env.CONTEXT_TOOLS_SESSION_ID = `test-${Date.now()}-${Math.random()}`;
  process.env.CONTEXT_TOOLS_HOST = 'codex';
  try { return fn(process.env.CONTEXT_TOOLS_SESSION_ID); }
  finally {
    for (const [key, value] of Object.entries({
      CONTEXT_MAPS_ROOT: previous.mapsRoot,
      CONTEXT_TOOLS_PROJECT_DIR: previous.projectDir,
      CONTEXT_TOOLS_SESSION_ID: previous.sessionId,
      CONTEXT_TOOLS_HOST: previous.host,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function trackedWrite(root, path, text) {
  const event = { session_id: process.env.CONTEXT_TOOLS_SESSION_ID, tool_use_id: String(Math.random()), tool_name: 'Write', tool_input: { file_path: path }, tool_response: { success: true } };
  recordSessionWriteEvent(root, event, '--pre-tool-use');
  text === null ? rmSync(path) : writeFileSync(path, text);
  recordSessionWriteEvent(root, event, '--post-tool-use');
}

test('mapa sem Git compara conteúdo, não mtime, e aceita digest revisado', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-map-hash-'));
  const source = join(root, 'src', 'area.js');
  const map = join(root, '.claude', 'context', 'area.md');
  const mtime = new Date('2020-01-01T00:00:00Z');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.claude', 'context'), { recursive: true });
    writeFileSync(source, 'export function before() {}\n');
    utimesSync(source, mtime, mtime);
    writeFileSync(map, '---\narea: "area"\ncovers:\n  - "src/area.js"\nverified_at: 2021-01-01\n---\n');
    assert.equal(contextMapsStopReport(root), '', 'baseline legado limpo não pede revisão');

    writeFileSync(source, 'export function after() {}\n');
    utimesSync(source, mtime, mtime);
    const changed = contextMapsStopReport(root);
    assert.match(changed, /src\/area\.js/);
    assert.match(changed, /source_digest: sha256:[a-f0-9]{64}/);

    const digest = fingerprintSourcesInRoot(root, ['src/area.js']).digest;
    writeFileSync(map, `---\narea: "area"\ncovers:\n  - "src/area.js"\nverified_at: 2021-01-01\nsource_digest: ${digest}\n---\n`);
    assert.equal(contextMapsStopReport(root), '', 'digest revisado aceita conteúdo atual sem tocar nas datas');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Stop automático limita mapas aos arquivos alterados depois do baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-session-map-scope-'));
  const a = join(root, 'src', 'a.js');
  const b = join(root, 'src', 'b.js');
  const maps = join(root, '.claude', 'context');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(maps, { recursive: true });
    writeFileSync(a, 'export const a = 1;\n');
    writeFileSync(b, 'export const b = 1;\n');
    const aDigest = fingerprintSourcesInRoot(root, ['src/a.js']).digest;
    const bDigest = fingerprintSourcesInRoot(root, ['src/b.js']).digest;
    writeFileSync(join(maps, 'area-a.md'), `---\narea: area-a\ncovers:\n  - "src/a.js"\nverified_at: 2021-01-01\nsource_digest: ${aDigest}\n---\n`);
    writeFileSync(join(maps, 'area-b.md'), `---\narea: area-b\ncovers:\n  - "src/b.js"\nverified_at: 2021-01-01\nsource_digest: ${bDigest}\n---\n`);
    writeFileSync(b, 'export const b = 2;\n'); // alteração anterior ao início da sessão
    const before = new Date(Date.now() - 5000);
    utimesSync(b, before, before);

    withSession(root, () => {
      recordSessionBaseline(root);
      recordSessionWriteEvent(root, { session_id: process.env.CONTEXT_TOOLS_SESSION_ID }, '--session-start');
      trackedWrite(root, a, 'export const a = 2;\n');
      const after = new Date(Date.now() + 1000);
      utimesSync(a, after, after);
      const report = contextMapsStopReport(root, { sessionOnly: true });
      assert.match(report, /area-a/);
      assert.doesNotMatch(report, /area-b/);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Stop limita as fontes dentro do mapa aos arquivos que mudaram nesta sessão', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-session-source-scope-'));
  const a = join(root, 'src', 'a.js');
  const b = join(root, 'src', 'b.js');
  const map = join(root, '.claude', 'context', 'area.md');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.claude', 'context'), { recursive: true });
    writeFileSync(a, 'export const a = 1;\n');
    writeFileSync(b, 'export const b = 1;\n');
    const digest = fingerprintSourcesInRoot(root, ['src/a.js', 'src/b.js']).digest;
    writeFileSync(map, `---\narea: area\ncovers:\n  - "src/a.js"\n  - "src/b.js"\nverified_at: 2021-01-01\nsource_digest: ${digest}\n---\n`);
    writeFileSync(b, 'export const b = 2; // pre-existing\n');
    const before = new Date(Date.now() - 10_000);
    utimesSync(b, before, before);

    withSession(root, () => {
      recordSessionBaseline(root);
      recordSessionWriteEvent(root, { session_id: process.env.CONTEXT_TOOLS_SESSION_ID }, '--session-start');
      trackedWrite(root, a, 'export const a = 2; // this session\n');
      const after = new Date(Date.now() + 2_000);
      utimesSync(a, after, after);
      const report = contextMapsStopReport(root, { sessionOnly: true });
      assert.match(report, /src\/a\.js/);
      assert.doesNotMatch(report, /src\/b\.js/, 'a stale sibling from before the session is excluded');
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Stop automático cala quando baseline Git é antigo ou incompleto', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-incomplete-baseline-'));
  const state = join(root, '.codex', 'context-tools', '.context-maps-session-baseline.json');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.codex', 'context-tools'), { recursive: true });
    withSession(root, (session) => {
      const entry = { head: 'abc123', at: Date.now(), sujos: {} };
      writeFileSync(state, JSON.stringify({ [session]: { [root]: entry } }));
      assert.equal(sessionChangedFiles(root), null, 'baseline de versão antiga não comprova sujeira inicial completa');
      writeFileSync(state, JSON.stringify({ [session]: { [root]: { ...entry, sujosCompleto: false } } }));
      assert.equal(sessionChangedFiles(root), null, 'snapshot truncado não deve atribuir mudanças antigas à sessão');
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('baseline sem Git distingue exclusões herdadas de exclusões feitas na sessão', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-nogit-deletions-'));
  const before = join(root, 'src', 'before.js');
  const during = join(root, 'src', 'during.js');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(before, 'export const old = true;\n');
    writeFileSync(during, 'export const current = true;\n');
    rmSync(before);
    withSession(root, () => {
      recordSessionBaseline(root);
      recordSessionWriteEvent(root, { session_id: process.env.CONTEXT_TOOLS_SESSION_ID }, '--session-start');
      trackedWrite(root, during, null);
      const changed = sessionChangedFiles(root);
      assert.ok(changed.includes('src/during.js'));
      assert.ok(!changed.includes('src/before.js'));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preflight do prompt é offline e só sinaliza mapa stale ou arquivo sem cobertura citado', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-prompt-audit-'));
  const source = join(root, 'src', 'area.js');
  const map = join(root, '.claude', 'context', 'area.md');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.claude', 'context'), { recursive: true });
    writeFileSync(source, 'export const before = true;\n');
    const digest = fingerprintSourcesInRoot(root, ['src/area.js']).digest;
    writeFileSync(map, `---\narea: area\ncovers:\n  - "src/area.js"\nverified_at: 2021-01-01\nsource_digest: ${digest}\n---\n`);
    withSession(root, () => {
      assert.equal(contextMapsPromptAudit(root, 'Review the implementation carefully.'), '');
      assert.equal(contextMapsPromptAudit(root, 'Review src/area.js.'), '');
      assert.equal(contextMapsPromptAudit(root, 'Review area.js.'), '');
      writeFileSync(source, 'export const after = true;\n');
      const after = new Date(Date.now() + 1000);
      utimesSync(source, after, after);
      assert.match(contextMapsPromptAudit(root, 'Review `src/area.js`.'), /area/);
      assert.match(contextMapsPromptAudit(root, 'Review area.js.'), /area/);

      const untracked = join(root, 'src', 'unmapped.ts');
      writeFileSync(untracked, 'export const x = 1;\n');
      const missing = contextMapsPromptAudit(root, 'Inspect `src/unmapped.ts`.');
      assert.match(missing, /context map|mapa de contexto/i);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preflight de arquivo mapeado ignora irmão stale não citado', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-prompt-file-scope-'));
  const a = join(root, 'src', 'a.js');
  const b = join(root, 'src', 'b.js');
  const map = join(root, '.claude', 'context', 'area.md');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.claude', 'context'), { recursive: true });
    writeFileSync(a, 'export const a = 1;\n');
    writeFileSync(b, 'export const b = 1;\n');
    const reviewedAt = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(a, reviewedAt, reviewedAt);
    const digest = fingerprintSourcesInRoot(root, ['src/a.js', 'src/b.js']).digest;
    writeFileSync(map, `---\narea: area\ncovers:\n  - "src/a.js"\n  - "src/b.js"\nverified_at: 2021-01-01\nsource_digest: ${digest}\n---\n`);
    withSession(root, () => {
      writeFileSync(b, 'export const b = 2;\n');
      assert.equal(contextMapsPromptAudit(root, 'Review `src/a.js`.'), '', 'the first lookup does not blame an unchanged file for a stale sibling');
      assert.match(contextMapsPromptAudit(root, 'Review `src/b.js`.'), /area/);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Stop de documentação ignora referências stale que já estavam alteradas antes da sessão', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-session-doc-scope-'));
  const a = join(root, 'src', 'a.js');
  const b = join(root, 'src', 'b.js');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(a, 'export const a = 1;\n');
    writeFileSync(b, 'export const b = 1;\n');
    initializeDocumentation(root, { lang: 'en' });
    const docs = join(root, 'ai-context', 'features');
    const digest = (path, id) => fingerprintSourcesInRoots([{ root, path, id }]).digest;
    writeFileSync(join(docs, 'area-a.md'), `# Area A\n\n- Source: src/a.js\n- Last reviewed: 2021-01-01\n- source_digest: ${digest(a, './src/a.js')}\n`);
    writeFileSync(join(docs, 'area-b.md'), `# Area B\n\n- Source: src/b.js\n- Last reviewed: 2021-01-01\n- source_digest: ${digest(b, './src/b.js')}\n`);
    writeFileSync(b, 'export const b = 2;\n');
    const before = new Date(Date.now() - 5000);
    utimesSync(b, before, before);

    withSession(root, () => {
      recordSessionBaseline(root);
      recordSessionWriteEvent(root, { session_id: process.env.CONTEXT_TOOLS_SESSION_ID }, '--session-start');
      documentationStopReport(root, { lang: 'en' }, { dedupe: false, sessionOnly: true });
      trackedWrite(root, a, 'export const a = 2;\n');
      const after = new Date(Date.now() + 1000);
      utimesSync(a, after, after);
      const report = documentationStopReport(root, { lang: 'en' }, { dedupe: false, sessionOnly: true });
      assert.match(report, /area-a\.md/);
      assert.doesNotMatch(report, /area-b\.md/);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Stop de documentação limita as referências do mesmo documento aos arquivos desta sessão', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-doc-source-scope-'));
  const a = join(root, 'src', 'a.js');
  const b = join(root, 'src', 'b.js');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(a, 'export const a = 1;\n');
    writeFileSync(b, 'export const b = 1;\n');
    initializeDocumentation(root, { lang: 'en' });
    const doc = join(root, 'ai-context', 'features', 'shared-area.md');
    const digest = fingerprintSourcesInRoots([
      { root, path: a, id: './src/a.js' },
      { root, path: b, id: './src/b.js' },
    ]).digest;
    writeFileSync(doc, `# Shared area\n\n- Source: src/a.js, src/b.js\n- Last reviewed: 2021-01-01\n- source_digest: ${digest}\n`);
    writeFileSync(b, 'export const b = 2; // pre-existing\n');
    const before = new Date(Date.now() - 10_000);
    utimesSync(b, before, before);

    withSession(root, () => {
      recordSessionBaseline(root);
      recordSessionWriteEvent(root, { session_id: process.env.CONTEXT_TOOLS_SESSION_ID }, '--session-start');
      documentationStopReport(root, { lang: 'en' }, { dedupe: false, sessionOnly: true });
      trackedWrite(root, a, 'export const a = 2; // this session\n');
      const after = new Date(Date.now() + 2_000);
      utimesSync(a, after, after);
      const report = documentationStopReport(root, { lang: 'en' }, { dedupe: false, sessionOnly: true });
      assert.match(report, /src\/a\.js/);
      assert.doesNotMatch(report, /src\/b\.js/, 'stale sibling references are not attached to the session review');
      assert.match(report, /source_fingerprints:/);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('metadados por fonte distinguem hashes revisados de fontes ainda pendentes', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-source-fingerprints-compare-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.js'), 'a');
    writeFileSync(join(root, 'src', 'b.js'), 'b');
    const current = fingerprintSourcesInRoot(root, ['src/a.js', 'src/b.js']);
    const partial = compareReviewedSources(current, { 'src/a.js': current.sources['src/a.js'] });
    assert.equal(partial.complete, false);
    assert.deepEqual(partial.changed, ['src/b.js']);
    const complete = compareReviewedSources(current, { 'src/a.js': current.sources['src/a.js'], 'src/b.js': current.sources['src/b.js'] });
    assert.equal(complete.complete, true);
    assert.deepEqual(complete.changed, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('relatórios só pedem sincronizar source_digest quando todos os hashes por fonte já batem', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-digest-sync-'));
  const source = join(root, 'src', 'area.js');
  const map = join(root, '.claude', 'context', 'area.md');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.claude', 'context'), { recursive: true });
    writeFileSync(source, 'export const current = true;\n');
    const fingerprint = fingerprintSourcesInRoot(root, ['src/area.js']);
    writeFileSync(map, `---\narea: area\ncovers:\n  - "src/area.js"\nverified_at: 2021-01-01\nsource_digest: sha256:${'0'.repeat(64)}\nsource_fingerprints: ${JSON.stringify(fingerprint.sources)}\n---\n`);
    assert.match(contextMapsStopReport(root), /sync source_digest|sincronize source_digest/i);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const docRoot = mkdtempSync(join(tmpdir(), 'context-tools-doc-digest-sync-'));
  const docSource = join(docRoot, 'src', 'area.js');
  try {
    mkdirSync(join(docRoot, 'src'), { recursive: true });
    writeFileSync(docSource, 'export const current = true;\n');
    initializeDocumentation(docRoot, { lang: 'en' });
    const docFingerprint = fingerprintSourcesInRoots([{ root: docRoot, path: docSource, id: './src/area.js' }]);
    writeFileSync(join(docRoot, 'ai-context', 'features', 'area.md'), `# Area\n\n- Source: src/area.js\n- Last reviewed: 2021-01-01\n- source_digest: sha256:${'0'.repeat(64)}\n- source_fingerprints: ${JSON.stringify(docFingerprint.sources)}\n`);
    const report = documentationStopReport(docRoot, { lang: 'en' }, { dedupe: false });
    assert.match(report, /synchronize aggregate metadata only/);
    assert.doesNotMatch(report, /changed:.*src\/area\.js/);
  } finally { rmSync(docRoot, { recursive: true, force: true }); }
});

test('relatório de saúde pode identificar baseline de sessão incompleto', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-baseline-diagnostics-'));
  const state = join(root, '.codex', 'context-tools', '.context-maps-session-baseline.json');
  try {
    mkdirSync(join(root, '.codex', 'context-tools'), { recursive: true });
    withSession(root, (sid) => {
      writeFileSync(state, JSON.stringify({ [sid]: { [root]: { head: 'abc123', at: Date.now(), sujos: {}, sujosCompleto: false, sujosContagem: 501 } } }));
      assert.deepEqual(sessionBaselineDiagnostics(root), [{ repo: root, kind: 'dirty-limit', count: 501, limit: 30000 }]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source_digest é igual em raízes diferentes quando caminhos relativos e bytes são iguais', () => {
  const a = mkdtempSync(join(tmpdir(), 'context-tools-digest-a-'));
  const b = mkdtempSync(join(tmpdir(), 'context-tools-digest-b-'));
  try {
    for (const root of [a, b]) {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'same.js'), 'export const same = true;\n');
    }
    assert.equal(
      fingerprintSourcesInRoot(a, ['src/same.js']).digest,
      fingerprintSourcesInRoot(b, ['src/same.js']).digest,
    );
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('handoff respeita source_digest em vez de marcar mapa revisado como defasado pelo commit antigo', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-handoff-digest-'));
  const source = join(root, 'src', 'area.js');
  const map = join(root, '.claude', 'context', 'area.md');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.claude', 'context'), { recursive: true });
    writeFileSync(source, 'export const value = 1;\n');
    let digest = fingerprintSourcesInRoot(root, ['src/area.js']).digest;
    writeFileSync(map, `---\narea: area\ncovers:\n  - "src/area.js"\nverified_at: deadbee\nsource_digest: ${digest}\n---\n`);
    assert.deepEqual(mapasRelevantes(root, ['src/area.js']), [{ nome: 'area', defasado: false }]);

    writeFileSync(source, 'export const value = 2;\n');
    assert.deepEqual(mapasRelevantes(root, ['src/area.js']), [{ nome: 'area', defasado: true }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('handoff respeita fingerprint do arquivo alterado mesmo quando um irmão do mapa mudou', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-handoff-file-fingerprint-'));
  const a = join(root, 'src', 'a.js');
  const b = join(root, 'src', 'b.js');
  const map = join(root, '.claude', 'context', 'area.md');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.claude', 'context'), { recursive: true });
    writeFileSync(a, 'export const a = 1;\n');
    writeFileSync(b, 'export const b = 1;\n');
    const current = fingerprintSourcesInRoot(root, ['src/a.js', 'src/b.js']);
    writeFileSync(map, `---\narea: area\ncovers:\n  - "src/a.js"\n  - "src/b.js"\nverified_at: deadbee\nsource_digest: ${current.digest}\nsource_fingerprints: ${JSON.stringify(current.sources)}\n---\n`);
    writeFileSync(b, 'export const b = 2;\n');
    assert.deepEqual(mapasRelevantes(root, ['src/a.js']), [{ nome: 'area', defasado: false }]);
    assert.deepEqual(mapasRelevantes(root, ['src/b.js']), [{ nome: 'area', defasado: true }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex mantém o pedido de revisão pendente entre sessões', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-tools-review-pending-'));
  try {
    const start = Date.now();
    assert.equal(shouldStartAutoReview(root, 'pending A', start), true);
    assert.equal(shouldStartAutoReview(root, 'pending A', start + 1000), false);
    assert.equal(shouldStartAutoReview(root, 'pending B', start + 2000), true);
    assert.equal(shouldStartAutoReview(root, 'pending A', start + 25 * 60 * 60 * 1000), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
