import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { analyze, render } from './analyze'
import { EMPTY_PANE_VIEW } from './pane-atom'
import { buildPaneRows } from './pane-model'
import { buildPaneView, buildSnapshot } from './pane-snapshot'
import { PaneBody } from './pane-view'

const PANE_ID = 'context-doctor'
const PANE_ARG = 'pane'
const NO_BREAKDOWN_TEXT = 'まだ内訳がありません（最初の応答後に再実行してください）。'
const PANE_OPENED_TEXT = 'Context ペインを開きました。'

// validate の静的走査が読めるよう、参照はこのファイルに置く（リテラルの plugin / key）。
const paneView = atom({ plugin: 'context-doctor', key: 'view' } as const, EMPTY_PANE_VIEW)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ctx',
      description: 'コンテキストの内訳を分析し、課題と改善案を出す',
      argumentHint: PANE_ARG,
    })
    return next(e)
  })

  on('command.run', { command: 'ctx' }, async ($, e) => {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    if (!b) return { text: NO_BREAKDOWN_TEXT }
    const snap = buildSnapshot(b)
    if (e.args.trim() !== PANE_ARG) return { text: render(snap, analyze(snap)) }

    const view = buildPaneView(snap, Date.now())
    await update($, paneView, () => view)
    const opened = await $.ui.open({ id: PANE_ID, title: 'Context' })
    return { text: opened.isPlaced ? PANE_OPENED_TEXT : render(snap, analyze(snap)) }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const panes = await $.ui.panes()
      if (panes.some(pane => pane.id === PANE_ID && pane.isPlaced)) {
        const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
        if (b) {
          const view = buildPaneView(buildSnapshot(b), Date.now())
          await update($, paneView, () => view)
        }
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const view = await read($, paneView)
    const { bodyColumns } = e.props
    const findings = view.snapshot ? analyze(view.snapshot) : []
    const rows = buildPaneRows({ view, findings, bodyColumns })
    return <PaneBody ui={$.ui.resolve(e)} rows={rows} bodyColumns={bodyColumns} />
  })
}
