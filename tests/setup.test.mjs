import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveTargets, TARGETS } from '../scripts/lib/setup-targets.mjs';

function localPath(rel) {
  return fileURLToPath(new URL(rel, import.meta.url));
}

test('resolveTargets expande "both" e recusa agente desconhecido', () => {
  assert.deepEqual(resolveTargets('both').map((a) => a.id), ['codex', 'claude']);
  assert.deepEqual(resolveTargets(['claude']).map((a) => a.id), ['claude']);
  assert.deepEqual(resolveTargets(['claude', 'codex', 'claude']).map((a) => a.id), ['claude', 'codex']);
  // A mensagem sai no idioma resolvido pelo i18n; o que importa aqui é que ela nomeia o agente
  // recusado e as opções válidas, não a língua em que isso é dito.
  assert.throws(() => resolveTargets(['bogus']), /bogus/);
  assert.throws(() => resolveTargets(['bogus']), /claude, codex/);
});

test('setup.mjs --dry-run com --target=claude só simula o Claude', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-unified-'));
  const SETUP = localPath('../setup.mjs');
  try {
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz, '--target=claude'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `falhou: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\[Claude\]/);
    assert.doesNotMatch(r.stdout, /\[Codex\]/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('setup.mjs --dry-run com --target=both simula os dois agentes', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-unified-both-'));
  const SETUP = localPath('../setup.mjs');
  try {
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz, '--target=both'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `falhou: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\[Codex\]/);
    assert.match(r.stdout, /\[Claude\]/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('setup.mjs --dry-run detecta sozinho quando só .claude existe', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-detect-claude-'));
  const SETUP = localPath('../setup.mjs');
  try {
    mkdirSync(join(raiz, '.claude'), { recursive: true });
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz], { encoding: 'utf8', input: '' });
    assert.equal(r.status, 0, `falhou: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\[Claude\]/);
    assert.doesNotMatch(r.stdout, /\[Codex\]/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('setup.mjs --dry-run detecta sozinho quando só .codex/AGENTS.md existe', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-detect-codex-'));
  const SETUP = localPath('../setup.mjs');
  try {
    writeFileSync(join(raiz, 'AGENTS.md'), '# agents\n');
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz], { encoding: 'utf8', input: '' });
    assert.equal(r.status, 0, `falhou: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\[Codex\]/);
    assert.doesNotMatch(r.stdout, /\[Claude\]/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('setup.mjs --dry-run sem detecção e sem TTY cai para "both"', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-detect-none-'));
  const SETUP = localPath('../setup.mjs');
  try {
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz], { encoding: 'utf8', input: '' });
    assert.equal(r.status, 0, `falhou: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\[Codex\]/);
    assert.match(r.stdout, /\[Claude\]/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('setup.mjs recusa --target inválido de forma explícita', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-bad-target-'));
  const SETUP = localPath('../setup.mjs');
  try {
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz, '--target=bogus'], {
      encoding: 'utf8',
      env: { ...process.env, CONTEXT_TOOLS_LANG: 'en' },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /invalid agent: bogus/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// O setup era o único lugar do projeto com português fixo no código, ignorando o i18n que todas
// as outras ferramentas já usavam. Estes dois testes são o que impede a regressão: a mesma
// execução, só mudando CONTEXT_TOOLS_LANG, tem que sair nos dois idiomas.
test('as mensagens do setup seguem CONTEXT_TOOLS_LANG, com inglês como padrão', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-lang-'));
  const SETUP = localPath('../setup.mjs');
  const rodar = (lang) => spawnSync(
    process.execPath,
    [SETUP, '--dry-run', '--project', raiz, '--target=claude'],
    { encoding: 'utf8', env: { ...process.env, CONTEXT_TOOLS_LANG: lang } },
  );
  try {
    const en = rodar('en');
    assert.equal(en.status, 0, `falhou: ${en.stdout}${en.stderr}`);
    assert.match(en.stdout, /Project detected automatically/);
    assert.doesNotMatch(en.stdout, /Projeto detectado/);

    const pt = rodar('pt');
    assert.equal(pt.status, 0, `falhou: ${pt.stdout}${pt.stderr}`);
    assert.match(pt.stdout, /Projeto detectado automaticamente/);
    assert.doesNotMatch(pt.stdout, /Project detected/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('o "lang" gravado no projeto também escolhe o idioma do próprio setup', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'context-tools-setup-lang-config-'));
  const SETUP = localPath('../setup.mjs');
  try {
    mkdirSync(join(raiz, '.claude'), { recursive: true });
    writeFileSync(join(raiz, '.claude', 'context-tools.json'), '{"lang":"pt"}\n', 'utf8');
    // CONTEXT_TOOLS_LANG ausente de propósito: quem responde aqui é o context-tools.json.
    const env = { ...process.env };
    delete env.CONTEXT_TOOLS_LANG;
    const r = spawnSync(process.execPath, [SETUP, '--dry-run', '--project', raiz, '--target=claude'], { encoding: 'utf8', env });
    assert.equal(r.status, 0, `falhou: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Projeto detectado automaticamente/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('adapters Codex e Claude compartilham repositório mas usam CLI e marketplace distintos', () => {
  assert.equal(TARGETS.codex.bin, 'codex');
  assert.equal(TARGETS.claude.bin, 'claude');
  assert.equal(TARGETS.codex.repository, TARGETS.claude.repository);
  assert.notEqual(TARGETS.codex.marketplaceName, TARGETS.claude.marketplaceName);
});

test('context-tools (comando curto): global e sem perguntas por padrão; o resto passa como está', async () => {
  const { defaultArgs } = await import('../context-tools.mjs');
  assert.deepEqual(defaultArgs([]), ['--global', '--yes']);
  assert.deepEqual(defaultArgs(['--mcp']), ['--mcp', '--global', '--yes']);
  assert.deepEqual(defaultArgs(['update', '--target=claude']), ['update', '--target=claude', '--global', '--yes']);
  assert.deepEqual(defaultArgs(['--project', 'app']), ['--project', 'app', '--yes'], 'por projeto: sem --global');
  assert.deepEqual(defaultArgs(['--guided']), ['--guided'], 'guiado continua perguntando');
  assert.deepEqual(defaultArgs(['status']), ['status'], 'status não vira instalação');
});

// O comando curto é "para todos": sem --target vai para os dois agentes, tenha a máquina a CLI de
// um, dos dois ou de nenhum — a CLI que faltar é instalada pelo próprio setup.
test('global sem --target instala Claude e Codex, mesmo sem nenhuma CLI no PATH', () => {
  const r = spawnSync(process.execPath, [localPath('../context-tools.mjs'), '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, CONTEXT_TOOLS_LANG: 'en', PATH: '', Path: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[Codex\] Simulation: nothing was changed/, r.stdout);
  assert.match(r.stdout, /\[Claude\] Simulation: nothing was changed/, r.stdout);
});

// No Linux/macOS o bin do npm é um symlink: `argv[1]` chega com o caminho do link e
// `import.meta.url` com o real. A comparação direta fazia o instalador sair sem fazer nada.
test('instalador roda quando chamado por um symlink, como o bin do npm', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-bin-link-'));
  try {
    for (const [link, alvo] of [['context-tools', '../context-tools.mjs'], ['setup-all', '../setup.mjs']]) {
      const caminho = join(dir, `${link}.mjs`);
      try { symlinkSync(localPath(alvo), caminho); } catch { t.skip('sem permissão para criar symlink'); return; }
      const r = spawnSync(process.execPath, [caminho, '--global', '--yes', '--dry-run', '--target=claude'], { encoding: 'utf8', env: { ...process.env, CONTEXT_TOOLS_LANG: 'en' } });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /\[Claude\] Simulation: nothing was changed/, `${link}: ${r.stdout}${r.stderr}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
