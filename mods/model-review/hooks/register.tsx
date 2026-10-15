import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { PaneBody } from './pane'
import { EMPTY_REVIEW, appendTurn, withBaseline, withCurrent } from './state'
import { beginTurn, finishTurn, recordStep, recordTool, type Drafts } from './recorder'
import { buildPaneRows } from './pane-model'
import { buildReportLines } from './report'

const PANE_ID = 'model-review'
const PANE_TITLE = 'モデル振り返り'
const ADVISOR_TOOL_NAME = 'advisor'
const PANE_OPENED_TEXT = 'モデル振り返りペインを開きました。'

// validate の静的走査が読めるよう、参照はこのファイルに置く（リテラルの plugin / key）。
const reviewAtom = atom({ plugin: 'model-review', key: 'review' } as const, EMPTY_REVIEW)

export const register: Register = on => {
  // 進行中のターンの下書き（ループごと）。値は差し替えるだけで、中身は書き換えない。
  let drafts: Drafts = {}

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'model-review',
      description: 'セッションのモデル・effort・トークン・推定コストと、モデル選択の妥当性を表示する（読み取り専用）',
    })
    const usage = await $.session.usage()
    await update($, reviewAtom, state => withBaseline(state, usage.cost?.usd ?? null))
    return next(e)
  })

  on('command.run', { command: 'model-review' }, async $ => {
    const usd = (await $.session.usage()).cost?.usd
    if (usd !== undefined) await update($, reviewAtom, state => withCurrent(state, usd))
    const lines = buildReportLines(await read($, reviewAtom), Date.now())
    const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    return { text: opened.isPlaced ? PANE_OPENED_TEXT : lines.join('\n') }
  })

  on('session.measure', async ($, e, next) => {
    const costUsd = e.cost?.usd
    if (costUsd !== undefined) await update($, reviewAtom, state => withCurrent(state, costUsd))
    return next(e)
  })

  // 実行中のターンの途中経過は $.state に載らないので、変わるたびにペインを描き直させる（毎秒 10 回まで）。
  on('turn.start', async ($, e, next) => {
    drafts = beginTurn(drafts, e)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // モデルと effort は turn.start ではなく、応答ごとの turn.step にしか載らない。
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    drafts = recordStep(drafts, {
      turnId: e.turnId,
      agentId: e.agentId,
      model: e.model,
      effort: e.effort,
      usage: result.usage,
      advisorCalls: (result.serverToolUses ?? []).filter(use => use.name === ADVISOR_TOOL_NAME).length,
    })
    $.ui.invalidate('ui.render')
    return result
  })

  on('tool.call', async ($, e, next) => {
    drafts = recordTool(drafts, { agentId: e.agentId, tool: e.tool })
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const finished = finishTurn(drafts, {
      turnId: e.turnId,
      agentId: e.agentId,
      usage: e.usage,
      durationMs: e.durationMs,
      reason: e.reason,
    })
    drafts = finished.drafts
    await update($, reviewAtom, state => appendTurn(state, finished.record))
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const rows = buildPaneRows(await read($, reviewAtom), drafts, Date.now())
    return <PaneBody ui={$.ui.resolve(e)} rows={rows} />
  })
}
