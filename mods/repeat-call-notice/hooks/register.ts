import type { Register } from 'claude-code'

import { findRepeats, formatNotice } from './analyze'

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    // サブエージェントのターンでは主会話を誤集計するので何もしない。
    if (e.agentId !== undefined) return next(e)
    try {
      const repeats = findRepeats(await $.session.messages())
      if (repeats.length > 0) $.ui.toast(formatNotice(repeats))
    } catch {
      // 固定文言のみ。例外の中身（入力由来の文字列を含みうる）は出さない。
      $.ui.log('repeat-call-notice: 判定に失敗したため通知を省略した', { to: 'debug' })
    }
    return next(e)
  })
}
