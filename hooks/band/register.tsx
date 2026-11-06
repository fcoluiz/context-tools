// 📟 Faixa acima do prompt: custo da sessão, custo do último turno, turnos, contexto (com o
// multiplicador de custo por mensagem que ele implica) e se os testes valem para o que foi editado.
//
// O cálculo é do `scripts/status.mjs --band` (o mesmo do `ct status` do Codex): aqui só entram o
// custo em dólar e os turnos, que só o Claude Code sabe. Roda uma vez por turno, ao fim dele, sem
// segurar o turno; a falha de qualquer parte cala a faixa, nunca a sessão.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band } from './types'

const band = atom({ plugin: 'context-tools', key: 'band' } as const, null)
const lastUsd = atom({ plugin: 'context-tools', key: 'lastUsd' } as const, null)

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($).catch(() => {})
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, band)
    if (e.props.hasSurvey || b === null || !b.text) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>{b.text}</Text>
        {b.warn ? <Text color="yellow">{b.warn}</Text> : null}
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
  const prev = await read($, lastUsd)
  const argv = ['node', `${$.plugin.root}/scripts/status.mjs`, '--band', `--root=${root}`, `--session=${sid}`, `--turns=${turns}`]
  if (typeof usd === 'number') {
    argv.push(`--usd=${usd}`)
    if (typeof prev === 'number' && usd >= prev) argv.push(`--last-usd=${usd - prev}`)
    await update($, lastUsd, () => usd)
  }
  const r = await $.process.run(argv, { cwd: root, timeoutMs: 8000 })
  if (r.exitCode !== 0) return
  const next: Band = JSON.parse(r.stdout.trim())
  await update($, band, () => next)
}
