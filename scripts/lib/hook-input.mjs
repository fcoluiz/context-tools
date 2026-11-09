// Entrada única dos hooks. `readFileSync(0)` espera o fim do stdin, e no Windows o host às vezes
// escreve o evento e não fecha o pipe: o hook ficava parado até o timeout do host (60 s num
// PreToolUse sem `timeout`), segurando a ferramenta do usuário. O evento é um objeto JSON só,
// então basta ele estar completo para seguir; o prazo cobre o pipe que nunca recebe nada.
//
// Alguns shells também prefixam BOM, e `JSON.parse` recusa o evento inteiro por um caractere.

const BOM = /^﻿/;
export const HOOK_INPUT_TIMEOUT_MS = 2000;

/** Texto do evento, sem BOM. Vazio no terminal (TTY), sem entrada ou se o prazo vencer. */
export function readHookInput({ stream = process.stdin, timeoutMs = HOOK_INPUT_TIMEOUT_MS } = {}) {
  if (stream.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let text = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off('data', onData);
      // Pipe aberto mantém o processo vivo depois do hook: solta-o.
      try { stream.destroy(); } catch { /* já fechado */ }
      resolve(text.replace(BOM, ''));
    };
    const onData = (chunk) => {
      text += chunk;
      try { JSON.parse(text.replace(BOM, '')); finish(); } catch { /* evento ainda incompleto */ }
    };
    // Timer ref'd de propósito: com o pipe preso, um timer `unref` nunca dispararia.
    const timer = setTimeout(finish, timeoutMs);
    stream.setEncoding?.('utf8');
    stream.on('data', onData);
    stream.once('end', finish);
    stream.once('error', finish);
  });
}

/** Evento do hook como objeto; `{}` quando não há entrada ou ela não é JSON. */
export async function readHookEvent(opts) {
  try { return JSON.parse((await readHookInput(opts)) || '{}') || {}; } catch { return {}; }
}

/**
 * Stop do Claude que já é a continuação causada por um hook Stop (`stop_hook_active`).
 *
 * No Claude Code, `additionalContext` num Stop devolve o turno ao modelo. Se o hook disser algo de
 * novo nessa volta, ele reabre o turno, e o modelo responde, e o Stop dispara outra vez. A
 * condição de um aviso (mapa faltando, sessão cara) continua de pé depois da resposta, então só a
 * deduplicação segurava o laço, e duas cópias instaladas no mesmo projeto apagavam o hash uma da
 * outra: o Claude Code cortou o turno após 9 bloqueios seguidos. Na continuação, todo hook Stop
 * do Claude fica calado: o aviso já foi dado na primeira volta.
 *
 * O Codex tem regra própria para a continuação (o adaptador permite uma); lá isto é sempre falso.
 */
export function isClaudeStopContinuation(event, host) {
  return host !== 'codex' && event?.stop_hook_active === true;
}

/** Lê o evento e diz se este Stop do Claude é continuação. Não lê o stdin no Codex. */
export async function readClaudeStopContinuation(host, opts) {
  if (host === 'codex') return false;
  return isClaudeStopContinuation(await readHookEvent(opts), host);
}
