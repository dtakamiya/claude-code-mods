import type { Register } from 'claude-code'

import { render, summarize } from './recap'

// 組み込みの `/recap` は Claude Code が使うため登録できない。旧名は残さない。
// 名前は validate の静的走査が読めるようリテラルで置く。
// 失敗時の文言は固定。例外の中身（セッション由来の文字列を含みうる）は出さない。
const FAILED_TEXT = 'ツール利用の振り返りを作れませんでした（セッションの読み取りに失敗）。'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tool-recap',
      description: 'ツール別の呼び出し回数とエラー件数を一覧にする',
    })
    return next(e)
  })

  on('command.run', { command: 'tool-recap' }, async $ => {
    const messages = await $.session.messages()
    return { text: render(summarize(messages)) }
  }).catch($ => {
    $.ui.log('session-recap: 集計に失敗したため固定文言を返した', { to: 'debug' })
    return { text: FAILED_TEXT }
  })
}
