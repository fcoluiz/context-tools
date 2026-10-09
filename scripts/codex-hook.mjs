#!/usr/bin/env node
// Adaptador de entrada/saída para hooks do Codex.
//
// O núcleo dos hooks continua sendo compartilhado, mas o Codex entrega session_id/cwd/
// transcript_path via stdin e usa systemMessage quando o script chamado realmente produz um
// aviso. Este processo normaliza esses detalhes sem alterar o contrato dos hooks Claude existentes.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordMetric } from './lib/telemetry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const script = process.argv[2];
const args = process.argv.slice(3);
const permitidos = new Set([
  'context-maps.mjs',
  'context-docs.mjs',
  'coupling.mjs',
  'handoff.mjs',
  'pre-tool.mjs',
  'session-write-journal.mjs',
  'codex-md-hint.mjs',
]);

if (!permitidos.has(script)) {
  process.stderr.write('codex-hook: script de hook não permitido\n');
  process.exit(1);
}

const entrada = (() => {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
})();
let evento = {};
try { evento = entrada.trim() ? JSON.parse(entrada) : {}; } catch { evento = {}; }

const cwd = typeof evento.cwd === 'string' && evento.cwd ? resolve(evento.cwd) : process.cwd();
const tracksAutoReview = script === 'context-docs.mjs'
  && args.includes('--stop-report')
  && evento.hook_event_name === 'Stop';
const env = {
  ...process.env,
  CONTEXT_TOOLS_HOST: 'codex',
  // O cwd entregue pelo Codex é a raiz da sessão. Sem esta variável, um projeto sem `.git`
  // pode subir para um workspace-pai que contenha outro repositório e gravar estado/mapas no
  // lugar errado. O Claude já fornece CLAUDE_PROJECT_DIR; o adaptador Codex precisa fazer o
  // mesmo explicitamente.
  CONTEXT_TOOLS_PROJECT_DIR: cwd,
  ...(evento.session_id ? { CONTEXT_TOOLS_SESSION_ID: String(evento.session_id) } : {}),
  ...(evento.turn_id ? { CONTEXT_TOOLS_TURN_ID: String(evento.turn_id) } : {}),
  ...(evento.transcript_path ? { CONTEXT_TOOLS_TRANSCRIPT_PATH: String(evento.transcript_path) } : {}),
};
Object.assign(process.env, env);

async function writeCaptureHint() {
  try {
    const { loadConfig } = await import('./lib/roots.mjs');
    const { readCaptureSuggestion } = await import('./lib/session-reads.mjs');
    const hint = await readCaptureSuggestion(cwd, loadConfig(cwd), {
      sessionId: evento.session_id,
      transcriptPath: typeof evento.transcript_path === 'string' ? evento.transcript_path : null,
    });
    if (hint) process.stdout.write(JSON.stringify({ systemMessage: hint }));
  } catch {
    // M4: a sugestão é opcional e nunca pode afetar o Stop.
  }
}

async function main() {
  // Track explicit file edits around the tool call. This is Codex-only, local, and silent;
  // Stop later uses the recorded paths instead of claiming every shared-workspace diff.
  if (script === 'session-write-journal.mjs') {
    try {
      process.chdir(cwd);
      const { recordSessionWriteEvent } = await import('./lib/session-write-journal.mjs');
      const result = recordSessionWriteEvent(cwd, evento, args[0]);
      if (!['ignored-tool','already-recorded','unchanged'].includes(result.status)) recordMetric(cwd, 'write-attribution', { outcome: result.status });
    } catch {
      // M4: attribution bookkeeping never blocks a Codex tool or session.
    }
    return 0;
  }

  // PreToolUse é o hook de maior frequência. Importar sua função diretamente evita um segundo
  // cold-start de Node em cada chamada Codex; os demais scripts continuam no caminho genérico
  // abaixo porque ainda precisam do contrato CLI/args e da adaptação de Stop.
  if (script === 'pre-tool.mjs') {
    try {
      process.chdir(cwd);
      if (typeof evento.tool_input?.command === 'string' && evento.tool_input.command.includes('--context-tools-edit=')) {
        const { recordSessionWriteEvent } = await import('./lib/session-write-journal.mjs');
        recordSessionWriteEvent(cwd, evento, '--pre-tool-use');
      }
      const { executarPreTool } = await import('./pre-tool.mjs');
      const saida = await executarPreTool(evento);
      if (saida) process.stdout.write(saida);
    } catch {
      // M4: falha no pre-hook nunca pode derrubar ou bloquear a ferramenta Codex.
    }
    return 0;
  }

  // PostToolUse de todo Bash: o mesmo motivo do PreToolUse para não abrir um segundo Node.
  // `executarGrepContext` sai na hora quando o comando não é rg/grep.
  if (script === 'grep-context.mjs') {
    try {
      process.chdir(cwd);
      const { executarGrepContext } = await import('./grep-context.mjs');
      const saida = await executarGrepContext(evento);
      if (saida) process.stdout.write(saida);
    } catch {
      // M4: contexto a mais nunca pode derrubar a ferramenta Codex.
    }
    return 0;
  }

  if (tracksAutoReview) {
    try {
      process.chdir(cwd);
      const { executeContextReview, codexReviewOutput } = await import('./lib/review-engine.mjs');
      const result = executeContextReview(cwd, { sessionId: evento.session_id, turnId: evento.turn_id, continuation: evento.stop_hook_active === true });
      recordMetric(cwd, 'auto-review', {
        outcome: result.claimed?.length ? 'prompted' : result.continuation && result.prompt ? 'continuation-limit'
          : result.status === 'incomplete' ? 'verification-incomplete' : result.completed ? 'review-resolved' : result.findings.length ? 'deduplicated' : 'no-findings',
        hookPromptCharacters: result.prompt?.length || 0,
        hookPromptTokensEstimate: Math.ceil((result.prompt?.length || 0)/4),
        findingCount: result.findings.length, resolvedClaims: result.completed || 0, metadataSynchronized: result.synchronized || 0,
        sourceReads: result.cache.reads, sourceBytes: result.cache.bytes, sourceCacheHits: result.cache.hits,
        verificationIssues: result.issues.length, durationMs: result.durationMs,
      });
      const output = codexReviewOutput(result);
      if (output) process.stdout.write(output);
      // Sessão que só leu código não chega à revisão acima (ela parte das edições). Sem revisão
      // pendente neste turno, a sugestão de registro pode falar — nunca as duas juntas.
      else await writeCaptureHint();
    } catch (error) {
      recordMetric(cwd, 'auto-review', { outcome: 'hook-error', errorKind: error.code || 'review-engine-error' });
    }
    return 0;
  }

  // UserPromptSubmit is called for every user message. Keep the exact-file preflight in this
  // process instead of starting a second Node child, and emit nothing for ordinary or fresh
  // prompts. The imported checker never stores the prompt or calls a model.
  if (script === 'context-docs.mjs' && args.includes('--prompt-audit')) {
    try {
      process.chdir(cwd);
      const { contextMapsPromptAudit } = await import('./context-maps.mjs');
      const context = contextMapsPromptAudit(cwd, typeof evento.prompt === 'string' ? evento.prompt : '');
      if (context) process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
      }));
    } catch {
      // M4: an offline preflight must never block or disrupt the prompt.
    }
    return 0;
  }

  const child = spawnSync(process.execPath, [join(HERE, script), ...args], {
    cwd,
    env,
    input: entrada,
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGTERM',
  });

  if (child.stderr) process.stderr.write(child.stderr);

  let saida = child.stdout || '';
  if (saida.trim() && (evento.hook_event_name === 'Stop' || evento.hook_event_name === 'SessionStart')) {
    try {
      const json = JSON.parse(saida);
      const texto = json?.hookSpecificOutput?.additionalContext;
      const notice = json?.hookSpecificOutput?._contextToolsNotice;
      if (evento.hook_event_name === 'SessionStart' && typeof notice === 'string' && notice) {
        delete json.hookSpecificOutput._contextToolsNotice;
        json.systemMessage = notice;
        saida = JSON.stringify(json);
      } else if (evento.hook_event_name === 'Stop' && typeof texto === 'string' && texto) {
        saida = JSON.stringify({ systemMessage: texto });
      }
    } catch { /* Preserve the original hook output on unexpected formats. */ }
  }
  if (saida) process.stdout.write(saida);
  return child.status ?? 1;
}

try { process.exitCode = await main(); } catch { process.exitCode = 0; }
