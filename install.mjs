#!/usr/bin/env node
// Instalação standalone (sem plugin): copia os scripts para <projeto>/.claude/scripts/ e
// registra os hooks em <projeto>/.claude/settings.json.
//
// Preferir o plugin quando possível (`claude --plugin-dir`), porque ele resolve caminho sozinho
// via ${CLAUDE_PLUGIN_ROOT} e atualiza junto. Este instalador existe para quem não usa plugin
// ou quer os scripts versionados dentro do próprio projeto.
//
// Uso:
//   node install.mjs <projeto>          → instala scripts + hooks
//   node install.mjs <projeto> --no-hooks
//   node install.mjs <projeto> --dry-run
//   node install.mjs <projeto> --target=auto|claude|codex|both
//
// Idempotente: não duplica hook já presente e nunca sobrescreve configuração alheia.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

// Compatibilidade: sem --target, o instalador continua sendo Claude como sempre foi.
// O modo explícito permite instalar uma ou as duas integrações sem duplicar a lógica de cópia.
const targetFlag = args.find((a) => a.startsWith('--target='));
let targetMode = targetFlag ? targetFlag.slice('--target='.length) : null;
if (targetMode === 'auto') {
  targetMode = process.env.CODEX_HOME && !process.env.CLAUDE_PLUGIN_ROOT ? 'codex' : 'both';
}
if (targetMode && !['claude', 'codex', 'both'].includes(targetMode)) {
  console.error(`target inválido: ${targetMode} (use claude, codex, both ou auto)`);
  process.exit(1);
}
if (targetMode && targetMode !== 'claude') {
  const baseArgs = args.filter((a) => !a.startsWith('--target='));
  const jobs = [];
  if (targetMode === 'both') jobs.push([process.execPath, fileURLToPath(import.meta.url), ...baseArgs]);
  jobs.push([process.execPath, join(HERE, 'install-codex.mjs'), ...baseArgs]);
  for (const [cmd, ...rest] of jobs) {
    const r = spawnSync(cmd, rest, { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  process.exit(0);
}
const dry = args.includes('--dry-run');
const noHooks = args.includes('--no-hooks');
const target = resolve(args.find((a) => !a.startsWith('--')) || process.cwd());

const say = (s) => console.log(s);
const act = (s) => say(`  ${dry ? '[dry] ' : ''}${s}`);

if (!existsSync(target)) { say(`❌ projeto não encontrado: ${target}`); process.exit(1); }

say(`\n📦 context-tools → ${target}${dry ? '  (simulação)' : ''}\n`);

// ---- 1. scripts ----
const dstScripts = join(target, '.claude', 'scripts');
const dstLib = join(dstScripts, 'lib');
if (!dry) { mkdirSync(dstLib, { recursive: true }); }

let copied = 0;
for (const f of readdirSync(join(HERE, 'scripts'))) {
  if (!f.endsWith('.mjs')) continue;
  if (f === 'codex-hook.mjs' || f === 'codex-md-hint.mjs' || f === 'benchmark-pretool.mjs' || f === 'benchmark-prompt-audit.mjs') continue;
  act(`scripts/${f}`);
  if (!dry) copyFileSync(join(HERE, 'scripts', f), join(dstScripts, f));
  copied++;
}
for (const f of readdirSync(join(HERE, 'scripts', 'lib'))) {
  act(`scripts/lib/${f}`);
  if (!dry) copyFileSync(join(HERE, 'scripts', 'lib', f), join(dstLib, f));
  copied++;
}
say(`  → ${copied} arquivo(s)\n`);

// ---- 1b. .claude/.gitignore ----
// Os scripts gravam estado em .claude/ (cache de símbolos, travas anti-loop, baseline de
// sessão). Sem isto, quem instala vê arquivos não rastreados aparecerem no `git status` —
// e pode acabar commitando um cache de índice. Um .gitignore DENTRO de .claude/ resolve
// sem tocar no .gitignore da raiz, que é do usuário.
//
// A lista vem do `.claude/.gitignore` DESTE repositório — fonte única, não uma cópia. Era
// escrita à mão aqui e derivou: ficou faltando `.pre-tool-state.json`, `.handoff-aviso.json` e
// `handoff-*.md`, todos criados por features posteriores. Quem instalava via `install.mjs` via
// esses arquivos aparecerem no `git status` e podia commitar um handoff gerado sem perceber.
// (A entrada daqui também estava com o nome errado — `.pre-tool-state` não casa
// `.pre-tool-state.json` no gitignore, então nem neste repo ela funcionava.)
//
// Quando instalado via `npx --package github:...` (não um checkout local), o npm empacota o
// projeto usando as regras do `.gitignore` raiz (não há `.npmignore` nem `files` no
// package.json) — e o npm SEMPRE exclui arquivos chamados `.gitignore` do pacote, por padrão,
// independente do que o `.gitignore` diz. `.claude/.gitignore` some do pacote, e a leitura
// abaixo quebrava o instalador inteiro. O fallback replica o mesmo conteúdo; o teste
// `tests/hooks-e2e.test.mjs` compara os dois e falha se um dia divergirem.
const STATE_FILES_FALLBACK = [
  '.stop-report-state', '.coupling-state', '.coupling-sessions.json',
  '.context-maps-session-baseline.json', '.symbols-cache.json', '.context-tools-snapshot.json',
  '.pre-tool-state.json', '.context-tools-metrics.json', '.auto-review-candidates.json', '.documentation-cache.json', '.source-fingerprints.json',
  '.documentation-stop-state.json', '.handoff-aviso.json', '.mtime-probe*', 'handoff-*.md',
  '.context-maps-session-notice.json', '.documentation-session-notice.json', '.codex-auto-review-state.json',
  '.session-write-journal/', '.hook-emissions/', '.verify-state.json', '.pre-tool-answers.json', '.document-updates/', '.session-reads.json', '*.tmp', '*.lock', '.claude-md-hint-done', 'context-tools-install.json',
];
let STATE_FILES;
try {
  STATE_FILES = readFileSync(join(HERE, '.claude', '.gitignore'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
} catch {
  STATE_FILES = STATE_FILES_FALLBACK;
}
const ignorePath = join(target, '.claude', '.gitignore');
const jaIgnorado = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
const faltando = STATE_FILES.filter((f) => !jaIgnorado.includes(f));
if (faltando.length) {
  act(`.claude/.gitignore (+${faltando.length} entrada(s) de estado)`);
  if (!dry) {
    const conteudo = jaIgnorado
      ? `${jaIgnorado.replace(/\n*$/, '')}\n${faltando.join('\n')}\n`
      : `# estado gerado pelos context-tools — não versionar\n${faltando.join('\n')}\n`;
    mkdirSync(dirname(ignorePath), { recursive: true });
    writeFileSync(ignorePath, conteudo, 'utf8');
  }
} else {
  act('.claude/.gitignore já cobre o estado — mantido');
}
say('');

// ---- 2. hooks ----
if (noHooks) {
  say('  hooks: pulado (--no-hooks)\n');
} else {
  const settingsPath = join(target, '.claude', 'settings.json');
  const settings = existsSync(settingsPath)
    ? (() => { try { return JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {
        say(`  ⚠️  ${settingsPath} não é JSON válido — hooks NÃO registrados. Corrija e rode de novo.`);
        return null;
      } })()
    : {};

  if (settings) {
    // A lista de hooks vem de `hooks/hooks.json` — FONTE ÚNICA, não uma cópia. Aqui só se troca
    // a variável de caminho: o plugin resolve `${CLAUDE_PLUGIN_ROOT}` sozinho, e a instalação
    // standalone precisa apontar para a cópia em `<projeto>/.claude/scripts/`.
    //
    // Era uma lista duplicada à mão até 2026-08-04, e ela DERIVOU: o manifesto do plugin ficou
    // sem `handoff.mjs --stop-report` (acrescentado só aqui em be8935b) e sem o `PreToolUse`
    // inteiro (0387af8 nunca tocou o manifesto). Quem instalasse como PLUGIN — o caminho que o
    // próprio README recomenda — ficava sem o aviso de sessão cara, sem handoff gerado e sem o
    // único ponto PUSH do plugin, tudo em silêncio, porque hook ausente não reclama.
    //
    // `matcher` filtra POR FERRAMENTA. Só o PreToolUse usa: sem ele o hook rodaria em toda
    // chamada (Edit, Bash, Read…) para no fim calar em quase todas — desperdício que a
    // própria medição desaconselha. `''` continua sendo "qualquer" nos outros eventos.
    const manifesto = JSON.parse(readFileSync(join(HERE, 'hooks', 'hooks.json'), 'utf8'));
    // Uma entrada por GRUPO, não por evento: o PreToolUse tem dois (Grep e Bash), e indexar por
    // evento fazia o segundo grupo sobrescrever o primeiro em silêncio. `if` (filtro do Claude
    // Code por conteúdo da chamada) é copiado junto — sem ele o hook de Bash rodaria em TODO
    // comando, não só em `grep`/`rg`.
    const wanted = [];
    for (const [event, grupos] of Object.entries(manifesto.hooks)) {
      for (const g of grupos) {
        wanted.push([event, {
          matcher: g.matcher ?? '',
          handlers: g.hooks.map((h) => ({
            command: h.command.replace('${CLAUDE_PLUGIN_ROOT}/scripts/', '$CLAUDE_PROJECT_DIR/.claude/scripts/'),
            ...(h.if ? { if: h.if } : {}),
          })),
        }]);
      }
    }
    // O `settings.json` é do USUÁRIO e pode ter qualquer forma — inclusive uma que este
    // instalador não previu (escrita à mão, versão futura do Claude Code, outra ferramenta).
    // Antes, um `hooks.SessionStart` que não fosse array derrubava o instalador com stack
    // trace. Não corrompia o arquivo (a gravação vem depois), mas quebrar na cara de quem
    // instala é péssimo, e uma linha a mais no caminho errado poderia gravar lixo.
    // Regra: forma inesperada => avisa e PULA aquele evento, nunca sobrescreve o que é do
    // usuário e nunca interrompe a instalação dos scripts, que é a parte essencial.
    if (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks)) {
      if (settings.hooks !== undefined) {
        say('  ⚠️  settings.json tem "hooks" num formato inesperado — hooks NÃO registrados, nada foi alterado.');
        say('     Corrija ou remova a chave "hooks" e rode de novo; os scripts já foram instalados.\n');
        settings.hooks = null;   // sinaliza para não gravar
      } else {
        settings.hooks = {};
      }
    }
    let added = 0;
    for (const [event, { matcher, handlers }] of settings.hooks === null ? [] : wanted) {
      if (!Array.isArray(settings.hooks[event])) {
        if (settings.hooks[event] !== undefined) {
          say(`  ⚠️  hooks.${event} não é lista — pulado, seu settings.json não foi tocado.`);
          continue;
        }
        settings.hooks[event] = [];
      }
      let group = settings.hooks[event].find((g) => g && typeof g === 'object' && g.matcher === matcher);
      if (!group) { group = { matcher, hooks: [] }; settings.hooks[event].push(group); }
      if (!Array.isArray(group.hooks)) group.hooks = [];
      for (const { command, if: condition } of handlers) {
        const script = command.split('/').pop().split('"')[0];
        const already = group.hooks.some((h) => (h.command || '').includes(script) && (h.if || null) === (condition || null));
        if (already) { act(`hook ${event} já presente — mantido`); continue; }
        act(`hook ${event}: ${command.replace('$CLAUDE_PROJECT_DIR/.claude/scripts/', '')}${condition ? ` (${condition})` : ''}`);
        group.hooks.push({ type: 'command', ...(condition ? { if: condition } : {}), command });
        added++;
      }
    }
    if (!dry && added && settings.hooks !== null) {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    }
    say(`  → ${added} hook(s) adicionado(s)\n`);
  }
}

// ---- 2b. marcador de instalação ----
// Espelha `.codex/context-tools-install.json` (install-codex.mjs): registra nome, versão e data
// para que `setup-claude.mjs status`/`doctor` consigam identificar bootstraps desatualizados.
if (!dry) {
  const packageJson = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
  const markerPath = join(target, '.claude', 'context-tools-install.json');
  writeFileSync(markerPath, `${JSON.stringify({
    name: 'context-tools',
    version: packageJson.version,
    installedAt: new Date().toISOString(),
    source: HERE,
  }, null, 2)}\n`, 'utf8');
  act('.claude/context-tools-install.json');
}

// ---- 3. verificação ----
say('Verificação:');
say(`  node .claude/scripts/symbols.mjs --stats`);
say(`  node .claude/scripts/coupling.mjs`);
say(`  node .claude/scripts/audit-docs.mjs`);
say(`  node .claude/scripts/context-pack.mjs <symbol-or-file> --budget=2000`);
say(`  node .claude/scripts/providers.mjs --json`);
say(`  node .claude/scripts/metrics.mjs`);
say(`  node .claude/scripts/health.mjs --audit`);
say('');
say('Nada mais a configurar: as pastas de código e os repositórios são detectados.');
say('Para fugir da convenção, crie .claude/context-tools.json (ver README).\n');
