import type { Register } from 'claude-code'

import { render, summarize } from './recap'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'recap',
      description: 'ツール別の呼び出し回数とエラー件数を一覧にする',
    })
    return next(e)
  })

  on('command.run', { command: 'recap' }, async $ => {
    const messages = await $.session.messages()
    return { text: render(summarize(messages)) }
  })
}
