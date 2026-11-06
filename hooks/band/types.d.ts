// Contrato do `$.state` da faixa: o que o `turn.complete` grava e o `ui.render` lê.
export type Band = { text: string; warn: string | null }

declare module 'claude-code' {
  interface PluginState {
    'context-tools': { band: Band | null; lastUsd: number | null }
  }
}
