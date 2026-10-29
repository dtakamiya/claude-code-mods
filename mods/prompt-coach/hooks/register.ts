import type { PromptSubmitInput, Register } from 'claude-code'

import { INITIAL_STATE, handleCoachCommand, judgeSubmission, type CoachState, type PromptSignal } from './analyze'

// 失敗時の文言は固定。例外の中身（入力由来の文字列を含みうる）は出さない。
const FAILED_JUDGE_LOG = 'prompt-coach: 判定に失敗したため指南を省略した'
const FAILED_COMMAND_TEXT = '/coach の処理に失敗しました（状態は変えていない）。'

// 本文・起源は判定にだけ使い、入力 e は無改変で次へ渡す。
const toSignal = (e: PromptSubmitInput): PromptSignal => ({
  text: e.text,
  originKind: e.origin.kind,
  isMeta: e.isMeta === true,
  isCommand: e.command !== undefined,
})

export const register: Register = on => {
  // メモリのみ。ファイルには保存しない。
  let state: CoachState = INITIAL_STATE

  on('session.start', async ($, e, next) => {
    state = INITIAL_STATE
    await $.command.register({
      name: 'coach',
      description: '送信直後の指南を停止・再開する（このセッション内）',
      argumentHint: 'on | off',
    })
    return next(e)
  })

  // 送信を止めない（失敗時も素通し）。判定の失敗は上の try で固定文言だけ残す。
  on('prompt.submit', async ($, e, next) => {
    try {
      const judgement = judgeSubmission(state, toSignal(e))
      state = judgement.state
      if (judgement.notice !== null) $.ui.status(judgement.notice)
    } catch {
      $.ui.log(FAILED_JUDGE_LOG, { to: 'debug' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // サブエージェントのターン終了では消さない（主会話の表示を消さないため）。
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) $.ui.status(undefined)
    return next(e)
  })

  on('command.run', { command: 'coach' }, async ($, e) => {
    const handled = handleCoachCommand(state, e.args)
    state = handled.state
    return { text: handled.text }
  }).catch($ => {
    $.ui.log('prompt-coach: /coach の処理に失敗した', { to: 'debug' })
    return { text: FAILED_COMMAND_TEXT }
  })
}
