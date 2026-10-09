import type { Register } from 'claude-code'

import { analyze, render } from './analyze'
import { buildSnapshot } from './pane-snapshot'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ctx',
      description: 'コンテキストの内訳を分析し、課題と改善案を出す',
    })
    return next(e)
  })

  on('command.run', { command: 'ctx' }, async $ => {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    if (!b) return { text: 'まだ内訳がありません（最初の応答後に再実行してください）。' }
    const snap = buildSnapshot(b)
    return { text: render(snap, analyze(snap)) }
  })
}
