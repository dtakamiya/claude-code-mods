import { test, expect } from 'claude-code/testing'
import type { SessionUsage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { analyze, render, type Snapshot } from './analyze'
import { buildSnapshot, type BreakdownSource } from './pane-snapshot'

// 架空データのみ。
const breakdown = {
  percentage: 62,
  totalTokens: 124_000,
  maxTokens: 200_000,
  categories: [
    { name: 'メッセージ', tokens: 58_000, kind: 'used', color: 'x', isDeferred: false },
    { name: '空き', tokens: 76_000, kind: 'free', color: 'x', isDeferred: false },
  ],
  mcpTools: [],
  memoryFiles: [],
  agents: [],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 160_000,
} as unknown as BreakdownSource

const usage = { context: { breakdown } } as unknown as SessionUsage
const currentText = (s: Snapshot) => render(s, analyze(s))

const runCtx = ($: Engine, args = '') =>
  $.command.run({ command: 'ctx', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

const PANE_PROPS = { title: 'Context', isFocused: false, bodyColumns: 60, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} }

test('/ctx（引数なし）は現行の render と同一のテキストを返す', async ($, on) => {
  on('session.usage', () => ({ value: usage }))
  const ran = await runCtx($)
  expect(ran.text).toBe(currentText(buildSnapshot(breakdown)))
})

test('/ctx pane: ペインが置かれなければ現行テキストを返す（フォールバック A）', async ($, on) => {
  on('session.usage', () => ({ value: usage }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }))
  const ran = await runCtx($, 'pane')
  expect(ran.text).toBe(currentText(buildSnapshot(breakdown)))
})

test('/ctx pane: ペインが置かれたら返答は1行', async ($, on) => {
  on('session.usage', () => ({ value: usage }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ran = await runCtx($, ' pane ')
  expect((ran.text ?? '').split('\n')).toHaveLength(1)
})

test('/ctx pane 後に Pane が内訳の行を描く（terminal / desktop）', async ($, on) => {
  on('session.usage', () => ({ value: usage }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await runCtx($, 'pane')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-doctor', surface, component: 'Pane', requestId: 'context-doctor', props: PANE_PROPS } as never)
    expect(await ui.find({ type: 'Text', text: /62%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('内訳が無い間の Pane は「まだ内訳がありません」を出す', async ($) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-doctor', surface, component: 'Pane', requestId: 'context-doctor', props: PANE_PROPS } as never)
    expect(await ui.find({ type: 'Text', text: /まだ内訳がありません/ })).toBeDefined()
    await ui.unmount()
  }
})
