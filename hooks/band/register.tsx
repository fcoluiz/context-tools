// 📟 Faixa acima do prompt: custo da sessão, custo do último turno, turnos, contexto (com o
// multiplicador de custo por mensagem que ele implica) e se os testes valem para o que foi editado.
//
// O cálculo é do `scripts/status.mjs --band` (o mesmo do `ct status` do Codex): aqui só entram o
// custo em dólar e os turnos, que só o Claude Code sabe. Roda uma vez por turno, ao fim dele, sem
// segurar o turno; a falha de qualquer parte cala a faixa, nunca a sessão.
//
// Sem `$.state` de propósito: `$.state` exige um contrato declarado em `"types"` no plugin.json, e
// um Claude Code anterior a ~2.1.78 descarta TODOS os hooks do plugin quando vê esse campo. O valor
// fica neste módulo e `$.ui.invalidate` redesenha; um hot reload só esvazia a faixa até o próximo turno.
import type { EngineInterface, Register } from 'claude-code'

import type { Band } from './types'

let band: Band | null = null
let lastUsd: number | null = null

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($).catch(() => {})
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || band === null || !band.text) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>{band.text}</Text>
        {band.warn ? <Text color="yellow">{band.warn}</Text> : null}
      </Box>
    )
  })
}

async function refresh($: EngineInterface) {
  const [usage, turns, sid, root] = await Promise.all([
    $.session.usage(),
    $.session.turns(),
    $.session.id(),
    $.session.root(),
  ])
  const usd = usage.cost?.usd
  const argv = ['node', `${$.plugin.root}/scripts/status.mjs`, '--band', `--root=${root}`, `--session=${sid}`, `--turns=${turns}`]
  if (typeof usd === 'number') {
    argv.push(`--usd=${usd}`)
    if (typeof lastUsd === 'number' && usd >= lastUsd) argv.push(`--last-usd=${usd - lastUsd}`)
    lastUsd = usd
  }
  // Janelas de limite da conta (vazio fora de assinatura): o status.mjs prevê se acabam antes de renovar.
  if (usage.rateLimits?.length) argv.push(`--limits=${JSON.stringify(usage.rateLimits)}`)
  const r = await $.process.run(argv, { cwd: root, timeoutMs: 8000 })
  if (r.exitCode !== 0) return
  band = JSON.parse(r.stdout.trim()) as Band
  $.ui.invalidate('ui.render')
}
