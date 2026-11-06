import { expect, test } from 'claude-code/testing'

const BAND = { plugin: 'context-tools', component: 'AbovePrompt', props: { hasSurvey: false } } as const

test('the band draws what the last turn recorded, on every surface', async ($, on) => {
  on('state.get', (_, e) => ({
    value: e.key === 'band'
      ? { value: { text: '$1.20 · 3 turn(s) · ctx 156k ~1.2×', warn: '✂️ split' }, version: 1 }
      : { value: null, version: 1 },
  }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /ctx 156k/ }))?.text).toBe('$1.20 · 3 turn(s) · ctx 156k ~1.2×')
    expect((await ui.find({ type: 'Text', text: /split/ }))?.text).toBe('✂️ split')
    await ui.unmount()
  }
})

test('before any turn the band leaves the row to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
