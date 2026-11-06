import { expect, test } from 'claude-code/testing'

// Só `hasSurvey` importa para a faixa; o resto das props do AbovePrompt fica com o kit.
const BAND = { plugin: 'context-tools', component: 'AbovePrompt', props: { hasSurvey: false } as never } as const
const OUT = { text: '$1.20 · 3 turn(s) · ctx 156k ~1.2×', warn: '✂️ split' }

test('before any turn the band leaves the row to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('after a turn the band draws what status.mjs --band answered, on every surface', async ($, on) => {
  const runs: string[][] = []
  on('session.usage', () => ({ value: { startedAt: 0, context: { used: 156000, limit: 200000 }, rateLimits: [], cost: { usd: 1.2 } } }) as never)
  on('session.turns', () => ({ value: 3 }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: `${JSON.stringify(OUT)}\n`, stderr: '' } } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  // A faixa se atualiza depois do turno, sem segurá-lo: dá a vez até o refresh terminar.
  for (let i = 0; i < 2000 && runs.length === 0; i++) await Promise.resolve()
  for (let i = 0; i < 200; i++) await Promise.resolve()
  expect(runs[0]).toContain('--band')
  expect(runs[0]).toContain('--usd=1.2')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /ctx 156k/ }))?.text).toBe(OUT.text)
    expect((await ui.find({ type: 'Text', text: /split/ }))?.text).toBe(OUT.warn)
    await ui.unmount()
  }
})
