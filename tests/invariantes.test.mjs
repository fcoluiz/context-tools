// Invariantes que atravessam arquivos: coisas que só quebram quando DOIS arquivos discordam,
// e por isso nenhum teste de unidade pega. Cada teste aqui existe porque a divergência
// correspondente já aconteceu, ou porque nada no repositório a impediria de acontecer.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LANGS } from '../scripts/lib/i18n.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...parts) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));

// A versão vive em QUATRO arquivos. Já divergiu de verdade em 2026-08-04 (plugin.json 1.2.0 x
// package.json 1.1.0), e o teste que nasceu daquele bug cobre só um dos quatro pares.
// Divergência aqui não derruba nada na hora: faz o usuário reportar bug de uma versão que não é
// a que está rodando, e faz o marketplace servir uma tag que não corresponde à fonte.
test('a versão é a mesma nos quatro arquivos que a declaram', () => {
  const pkg = readJson('package.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json precisa de uma versão semântica');

  assert.equal(
    readJson('.claude-plugin', 'plugin.json').version, pkg.version,
    '.claude-plugin/plugin.json divergiu do package.json',
  );
  assert.equal(
    readJson('.codex-plugin', 'plugin.json').version, pkg.version,
    '.codex-plugin/plugin.json divergiu do package.json',
  );

  const entry = readJson('.agents', 'plugins', 'marketplace.json')
    .plugins.find((plugin) => plugin.name === 'context-tools');
  assert.ok(entry, 'o catálogo precisa expor context-tools');
  assert.equal(
    entry.source.ref, `v${pkg.version}`,
    '.agents/plugins/marketplace.json aponta para uma tag que não é a versão da fonte',
  );
});

// O fallback do `makeT` esconde chave faltando: cai no catálogo `en` e a mensagem sai no idioma
// errado, sem erro nenhum. Sem este teste, adicionar chave só em `en` passa verde e vira
// mensagem em inglês no meio de uma sessão em português.
test('todos os catálogos de idioma têm exatamente as mesmas chaves', () => {
  const fonte = readFileSync(join(ROOT, 'scripts', 'lib', 'i18n.mjs'), 'utf8');
  const chavesPorIdioma = new Map();

  for (const lang of LANGS) {
    const inicio = fonte.indexOf(`\n  ${lang}: {`);
    assert.notEqual(inicio, -1, `catálogo ${lang} não foi encontrado no formato esperado`);
    const seguintes = LANGS
      .map((outro) => fonte.indexOf(`\n  ${outro}: {`))
      .filter((posicao) => posicao > inicio);
    const fim = seguintes.length ? Math.min(...seguintes) : fonte.length;
    const chaves = [...fonte.slice(inicio, fim).matchAll(/^\s+'([\w.]+)':/gm)].map((m) => m[1]);
    assert.ok(chaves.length > 0, `catálogo ${lang} ficou vazio — o parser deste teste envelheceu`);
    chavesPorIdioma.set(lang, chaves);
  }

  for (const [lang, chaves] of chavesPorIdioma) {
    const duplicadas = chaves.filter((chave, i) => chaves.indexOf(chave) !== i);
    assert.deepEqual(duplicadas, [], `catálogo ${lang} tem chave duplicada (a última vence, em silêncio)`);
  }

  const [base, ...outros] = [...chavesPorIdioma.keys()];
  for (const lang of outros) {
    const faltando = chavesPorIdioma.get(base).filter((k) => !chavesPorIdioma.get(lang).includes(k));
    const sobrando = chavesPorIdioma.get(lang).filter((k) => !chavesPorIdioma.get(base).includes(k));
    assert.deepEqual(faltando, [], `chaves ausentes em ${lang}`);
    assert.deepEqual(sobrando, [], `chaves em ${lang} que não existem em ${base}`);
  }
});

// Os três manifestos de hooks descrevem o MESMO conjunto de ferramentas em três grafias de
// caminho. Já dessincronizaram uma vez (e94f455, "align Codex plugin and standalone hooks").
test('os três manifestos de hooks cobrem o mesmo conjunto de scripts', () => {
  const scriptsDe = (manifesto) => {
    const hooks = readJson(...manifesto).hooks;
    const mapa = {};
    for (const [evento, grupos] of Object.entries(hooks)) {
      mapa[evento] = [...new Set(grupos
        .flatMap((grupo) => grupo.hooks.map((hook) => hook.command))
        // codex-hook.mjs é o invólucro, não a ferramenta: o script real é o argumento seguinte.
        .map((comando) => (comando.match(/([\w-]+\.mjs)(?!.*[\w-]+\.mjs)/) || [])[1])
        .filter(Boolean))].sort();
    }
    return mapa;
  };

  const claude = scriptsDe(['hooks', 'hooks.json']);
  const codexPlugin = scriptsDe(['hooks', 'codex-hooks.json']);
  const codexLocal = scriptsDe(['.codex', 'hooks.json']);

  assert.deepEqual(
    Object.keys(codexPlugin).sort(), Object.keys(codexLocal).sort(),
    'plugin Codex e instalação standalone precisam cobrir os mesmos eventos',
  );
  for (const evento of Object.keys(codexPlugin)) {
    assert.deepEqual(
      codexPlugin[evento], codexLocal[evento],
      `o evento ${evento} difere entre o plugin Codex e a instalação standalone`,
    );
  }

  // Claude e Codex NÃO têm o mesmo desenho de eventos, de propósito: o Codex registra autoria
  // (session-write-journal em Pre/PostToolUse), audita o prompt (UserPromptSubmit) e consolida a
  // revisão de mapas no context-docs do Stop. O que precisa valer é o contrário de uma lacuna:
  // toda ferramenta que o Claude roda em hook tem contrapartida no Codex. O hint de
  // CLAUDE.md/AGENTS.md é a exceção legítima — cada host escreve no arquivo do próprio agente.
  const ferramentas = (mapa) => new Set(Object.values(mapa).flat().filter((s) => !/md-hint\.mjs$/.test(s)));
  const noCodex = ferramentas(codexPlugin);
  const faltando = [...ferramentas(claude)].filter((script) => !noCodex.has(script));
  assert.deepEqual(faltando, [], 'ferramentas que o Claude roda em hook sem contrapartida no Codex');
});

// A divergência de matcher é INTENCIONAL e invisível no JSON (que não aceita comentário):
// o Codex não expõe uma tool Grep, então o gatilho equivalente lá é Bash. Este teste é onde
// essa decisão fica escrita — se alguém "corrigir" um dos dois para igualar o outro, quebra aqui.
test('PreToolUse dispara em Grep no Claude e em Bash no Codex, de propósito', () => {
  // O matcher do Codex é uma alternância ("apply_patch|Edit|Write|Bash"): o grupo que roda o
  // pre-tool.mjs precisa incluir Bash e não Grep; o do Claude precisa ser exatamente Grep.
  const matcherDoPreTool = (...manifesto) => readJson(...manifesto).hooks.PreToolUse
    .find((grupo) => grupo.hooks.some((hook) => /pre-tool\.mjs/.test(hook.command)))?.matcher || '';
  assert.deepEqual(matcherDoPreTool('hooks', 'hooks.json').split('|'), ['Grep']);
  for (const manifesto of [['hooks', 'codex-hooks.json'], ['.codex', 'hooks.json']]) {
    const alternativas = matcherDoPreTool(...manifesto).split('|');
    assert.ok(alternativas.includes('Bash'), `${manifesto.join('/')}: pre-tool precisa disparar em Bash`);
    assert.ok(!alternativas.includes('Grep'), `${manifesto.join('/')}: o Codex não expõe uma tool Grep`);
  }
});
