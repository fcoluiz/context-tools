import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  auditDocumentation,
  buildDocumentationCatalog,
  createDocumentationDocument,
  documentationConfig,
  documentationSessionContext,
  documentationStopReport,
  initializeDocumentation,
} from '../scripts/lib/documentation.mjs';
import { buildContextPack } from '../scripts/context-pack.mjs';
import { fingerprintSourcesInRoots } from '../scripts/lib/source-fingerprints.mjs';

function tempProject() {
  return mkdtempSync(join(tmpdir(), 'context-tools-docs-'));
}

function config(root, value) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'context-tools.json'), value, 'utf8');
}

test('documentação inicializa projeto novo com estrutura inglesa padrão', () => {
  const root = tempProject();
  try {
    const result = initializeDocumentation(root, {});
    assert.equal(result.status, 'ready');
    assert.ok(result.created.includes('ai-context/00-index.md'));
    for (const dir of ['features', 'screens', 'decisions', 'integrations', 'database']) {
      assert.ok(existsSync(join(root, 'ai-context', dir)));
    }
    assert.match(readFileSync(join(root, 'ai-context', '00-index.md'), 'utf8'), /Standard structure/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('documentação respeita idioma configurado e aceita JSON com BOM', () => {
  const root = tempProject();
  try {
    config(root, '\uFEFF{"lang":"pt","documentation":{"enabled":true}}');
    const cfg = { lang: 'pt', documentation: { enabled: true } };
    const resolved = documentationConfig(root, cfg);
    assert.equal(resolved.language, 'pt');
    const result = initializeDocumentation(root, cfg);
    assert.ok(result.created.includes('ai-context/00-indice.md'));
    for (const dir of ['features', 'telas', 'decisoes', 'integracoes', 'banco']) {
      assert.ok(existsSync(join(root, 'ai-context', dir)));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('criação é idempotente e nunca sobrescreve documento existente', () => {
  const root = tempProject();
  try {
    initializeDocumentation(root, { lang: 'pt' });
    const first = createDocumentationDocument(root, 'feature', 'credito-cliente', { lang: 'pt' });
    assert.equal(first.status, 'created');
    const path = join(root, 'ai-context', 'features', 'credito-cliente.md');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, `${original}\nConteúdo confirmado pelo agente.\n`, 'utf8');
    const second = createDocumentationDocument(root, 'feature', 'credito-cliente', { lang: 'pt' });
    assert.equal(second.status, 'exists');
    assert.match(readFileSync(path, 'utf8'), /Conteúdo confirmado pelo agente/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('documentação desativada não cria estrutura nem catálogo', () => {
  const root = tempProject();
  try {
    const cfg = { documentation: { enabled: false } };
    const init = initializeDocumentation(root, cfg);
    assert.equal(init.status, 'disabled');
    assert.equal(existsSync(join(root, 'ai-context')), false);
    assert.equal(buildDocumentationCatalog(root, cfg).status, 'disabled');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('autoInit falso mantém a feature consultável, mas não cria estrutura no hook', () => {
  const root = tempProject();
  try {
    const context = documentationSessionContext(root, { documentation: { autoInit: false } });
    assert.match(context, /Operational documentation/);
    assert.equal(existsSync(join(root, 'ai-context')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('context-pack retorna documentação operacional antes de exploração textual', () => {
  const root = tempProject();
  try {
    initializeDocumentation(root, { lang: 'pt' });
    createDocumentationDocument(root, 'feature', 'credito-cliente', { lang: 'pt' });
    writeFileSync(join(root, 'credito.txt'), 'não é código indexado\n', 'utf8');
    const pack = buildContextPack(root, 'credito cliente', { budget: 1200 });
    assert.ok(pack.items.length > 0);
    assert.equal(pack.items[0].kind, 'documentation');
    assert.match(pack.items[0].file, /ai-context[\\/]features[\\/]credito-cliente\.md/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auditoria preserva A mapear como pendência, não como regra confirmada', () => {
  const root = tempProject();
  try {
    initializeDocumentation(root, { lang: 'pt' });
    createDocumentationDocument(root, 'feature', 'nova-area', { lang: 'pt' });
    const audit = auditDocumentation(root, { lang: 'pt' });
    assert.equal(audit.status, 'ready');
    assert.ok(audit.pending >= 1);
    assert.equal(audit.issues.some((issue) => /confirmed rule|regra confirmada/i.test(issue.message)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Stop associa referência por basename à fonte real e ignora cópias inexistentes nos extraRepos', () => {
  const workspace = tempProject();
  const root = join(workspace, 'AppServer');
  const connection = join(workspace, 'AppConnection');
  const desktop = join(workspace, 'AppDesktop');
  const shared = join(workspace, 'shared');
  try {
    initializeDocumentation(root, { lang: 'pt' });
    for (const repo of [connection, desktop, shared]) mkdirSync(repo, { recursive: true });
    const source = join(shared, 'modules', 'uPaymentApiClientAppServer.pas');
    mkdirSync(join(shared, 'modules'), { recursive: true });
    writeFileSync(source, 'unit uPaymentApiClientAppServer;\n', 'utf8');

    const document = join(root, 'ai-context', 'features', 'integracao-pagamento.md');
    writeFileSync(document, [
      '# Integração de pagamento',
      '',
      '- Última revisão: 2026-09-01.',
      '- Fonte: `./uPaymentApiClientAppServer.pas`.',
      '',
    ].join('\n'), 'utf8');

    const report = documentationStopReport(root, {
      lang: 'pt',
      extraRepos: ['../AppConnection', '../AppDesktop', '../shared'],
    });

    assert.match(report, /Operational documentation needs source review/);
    assert.match(report, /shared\/modules\/uPaymentApiClientAppServer\.pas/);
    assert.doesNotMatch(report, /AppServer\/uPaymentApiClientAppServer|AppConnection\/uPaymentApiClientAppServer|AppDesktop\/uPaymentApiClientAppServer/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Stop usa hash offline para ignorar mtime e detectar mudança de conteúdo em documentação', () => {
  const root = tempProject();
  const source = join(root, 'src', 'sample.mjs');
  const document = join(root, 'ai-context', 'features', 'sample.md');
  const mtime = new Date('2020-01-01T00:00:00Z');
  try {
    initializeDocumentation(root, { lang: 'pt' });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(source, 'export function original() {}\n');
    utimesSync(source, mtime, mtime);
    writeFileSync(document, '# Fluxo\n\n- Source: src/sample.mjs\n- Last reviewed: 2021-01-01\n');

    assert.equal(documentationStopReport(root, { lang: 'pt' }), '', 'a revisão legada limpa registra baseline sem aviso');

    writeFileSync(source, 'export function changed() {}\n');
    utimesSync(source, mtime, mtime);
    const report = documentationStopReport(root, { lang: 'pt' });
    assert.match(report, /Operational documentation needs source review/);
    assert.match(report, /source_digest: sha256:[a-f0-9]{64}/);

    const digest = fingerprintSourcesInRoots([{ root, path: source, id: './src/sample.mjs' }]).digest;
    writeFileSync(document, `# Fluxo\n\n- Source: src/sample.mjs\n- Last reviewed: 2021-01-01\n- source_digest: ${digest}\n`);
    assert.equal(documentationStopReport(root, { lang: 'pt' }), '', 'digest revisado valida offline mesmo com data antiga');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
