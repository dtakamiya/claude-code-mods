import type { Register } from 'claude-code'

import { formatBell, shouldNotify } from './analyze'

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    if (shouldNotify(e)) $.ui.toast(formatBell(e.durationMs))
    return next(e)
  })
}
