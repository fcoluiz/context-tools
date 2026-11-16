#!/usr/bin/env node
// 🧩 Delegação a subagentes baratos (ver lib/delegation.mjs): escopo, estado e custo medido.
//
//   delegate.mjs scope --role=R --allow=<globs> [--ttl-minutes=N]   declara o escopo de escrita
//   delegate.mjs status [--json]                                    escopos vivos deste projeto
//   delegate.mjs clear [--role=R]                                   apaga escopo(s)
//   delegate.mjs report [--session=ID] [--host=claude|codex] [--json]
//                                    custo medido de cada subagente, e a estimativa sem delegar
//
// Hook do Claude: delegate.mjs --hook=pre-tool (evento no stdin). Roda em toda edição e em todo
// Bash, então o caminho comum (sessão principal, ou agente que não é `ct-*`) sai antes de importar
// qualquer coisa. O Codex chama a mesma trava de dentro do codex-hook.mjs.

const flag = (args, name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};

/** stdin inteiro, com teto de tempo: um hook nunca pode ficar preso esperando entrada. */
function readStdin(timeoutMs = 2000) {
  return new Promise((done) => {
    let data = '';
    const finish = () => { clearTimeout(timer); done(data); };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function hook() {
  // Nenhum import antes daqui: este caminho roda em todo Edit e todo Bash do Claude.
  const raw = await readStdin();
  // Sem `ct-` no evento, não há papel a travar: nem o JSON é lido.
  if (!/ct-(?:explorer|verifier|map-keeper|translator|executor)/i.test(raw)) return 0;
  let event = {};
  try { event = JSON.parse(raw) || {}; } catch { return 0; }
  const { delegationDenial } = await import('./lib/delegation.mjs');
  const reason = delegationDenial({ event, cwd: typeof event.cwd === 'string' && event.cwd ? event.cwd : process.env.CLAUDE_PROJECT_DIR });
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const hookKind = flag(args, 'hook');
  if (hookKind) {
    try { return await hook(); } catch { return 0; } // M4: a trava nunca derruba a ferramenta.
  }
  const { resolveRoot, loadConfig, runtimeHost } = await import('./lib/roots.mjs');
  const { detectLang } = await import('./lib/i18n.mjs');
  const lib = await import('./lib/delegation.mjs');
  const root = resolveRoot(args);
  const cfg = loadConfig(root);
  const pt = detectLang(cfg) === 'pt';
  const json = args.includes('--json');
  const [verb] = args.filter((a) => !a.startsWith('--'));

  if (verb === 'scope') {
    const r = lib.writeScope({ root, role: flag(args, 'role'), allow: flag(args, 'allow'), ttlMinutes: flag(args, 'ttl-minutes') });
    if (!r.ok) { process.stderr.write(`delegate: --role must be one of: ${lib.ROLE_NAMES.join(', ')}\n`); return 1; }
    console.log(json ? JSON.stringify(r.ticket, null, 2)
      : `🧩 ${r.ticket.role}: ${r.ticket.allow.join(', ') || (pt ? '(nada)' : '(nothing)')} — ${pt ? 'vale até' : 'valid until'} ${new Date(r.ticket.expiresAt).toLocaleTimeString()}`);
    return 0;
  }
  if (verb === 'status') {
    const scopes = lib.listScopes(root);
    if (json) console.log(JSON.stringify(scopes, null, 2));
    else if (!scopes.length) console.log(pt ? '🧩 nenhum escopo de escrita declarado neste projeto.' : '🧩 no write scope declared in this project.');
    else for (const s of scopes) console.log(`🧩 ${s.role}: ${s.allow.join(', ')} — ${pt ? 'até' : 'until'} ${new Date(s.expiresAt).toLocaleTimeString()}`);
    return 0;
  }
  if (verb === 'clear') {
    const n = lib.clearScope(root, flag(args, 'role') || null);
    console.log(pt ? `🧩 ${n} escopo(s) apagado(s).` : `🧩 ${n} scope(s) cleared.`);
    return 0;
  }
  if (verb === 'report') {
    const rep = await import('./lib/delegation-report.mjs');
    const host = flag(args, 'host') || runtimeHost();
    const session = typeof flag(args, 'session') === 'string' ? flag(args, 'session') : null;
    const report = host === 'codex'
      ? rep.codexReport(root, { session })
      : rep.claudeReport(root, { session, prices: cfg.delegation?.prices });
    console.log(json ? JSON.stringify(report, null, 2) : rep.formatReport(report, pt ? 'pt' : 'en'));
    return 0;
  }
  console.log(pt
    ? 'uso: delegate.mjs scope --role=R --allow=<globs> | status | clear [--role=R] | report [--session=ID] [--json]'
    : 'usage: delegate.mjs scope --role=R --allow=<globs> | status | clear [--role=R] | report [--session=ID] [--json]');
  return verb ? 1 : 0;
}

// O hook sai antes de carregar `roots.mjs` (medido: ~250 ms a mais por chamada no Windows).
if (process.argv.slice(2).some((a) => a.startsWith('--hook'))) {
  process.exitCode = await main();
} else {
  const { isMain } = await import('./lib/roots.mjs');
  if (isMain(import.meta.url)) process.exitCode = await main();
}
