import { test, expect } from 'claude-code/testing'

import type { Finding, Snapshot } from './analyze'
import { buildPaneRows } from './pane-model'
import { PaneBody } from './pane-view'
import type { PaneView as PaneViewState } from '../types'

// 架空データのみ。
const snapshot: Snapshot = {
  percentage: 62,
  totalTokens: 124_000,
  maxTokens: 200_000,
  categories: [
    { name: 'メッセージ', tokens: 58_000, kind: 'used' },
    { name: 'メモリ', tokens: 21_000, kind: 'used' },
    { name: 'MCP', tokens: 15_000, kind: 'used' },
    { name: '空き', tokens: 76_000, kind: 'free' },
    { name: 'バッファ', tokens: 33_000, kind: 'buffer' },
  ],
  mcpTools: [],
  memoryFiles: [],
  agents: [],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 160_000,
}
const findings: Finding[] = [
  { level: 'mid', observation: 'MCP が 15,000 トークン', hypothesis: '未使用なら空けられる', suggestion: '/mcp で確認' },
]
const okView: PaneViewState = { v: 1, status: 'ok', snapshot, measuredAtMs: new Date(2026, 0, 1, 14, 5).getTime() }
const emptyView: PaneViewState = { v: 1, status: 'empty' }

const SURFACES = ['terminal', 'desktop'] as const
const PANE_PROPS = (bodyColumns: number) =>
  ({ title: 'Context', isFocused: false, bodyColumns, placement: 'inline' }) as never

for (const surface of SURFACES) {
  test(`${surface}: 通常幅で使用率・バー・内訳・所見・測定時刻が出る`, async ($, on) => {
    // Arrange
    on('ui.render', { component: 'Pane' }, ($$, e) =>
      PaneBody({ ui: $$.ui.resolve(e), rows: buildPaneRows({ view: okView, findings, bodyColumns: e.props.bodyColumns }), bodyColumns: e.props.bodyColumns }),
    )
    // Act
    const ui = await $.ui.mount({ plugin: 'context-doctor', surface, component: 'Pane', props: PANE_PROPS(80) })
    // Assert
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '内訳（使用上位）' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'メッセージ 58,000' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '[注意] 観察: MCP が 15,000 トークン' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '測定 14:05' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '█' })).toBeDefined()
  })

  test(`${surface}: 狭い幅ではコンパクト表示になり棒グラフを出さない`, async ($, on) => {
    // Arrange
    on('ui.render', { component: 'Pane' }, ($$, e) =>
      PaneBody({ ui: $$.ui.resolve(e), rows: buildPaneRows({ view: okView, findings, bodyColumns: e.props.bodyColumns }), bodyColumns: e.props.bodyColumns }),
    )
    // Act
    const ui = await $.ui.mount({ plugin: 'context-doctor', surface, component: 'Pane', props: PANE_PROPS(30) })
    // Assert
    expect(await ui.find({ type: 'Text', text: 'ctx 62%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '上位: メッセージ 58,000' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '░' })).toBeUndefined()
  })

  test(`${surface}: 内訳がまだ無いときは案内文を出す`, async ($, on) => {
    // Arrange
    on('ui.render', { component: 'Pane' }, ($$, e) =>
      PaneBody({ ui: $$.ui.resolve(e), rows: buildPaneRows({ view: emptyView, findings: [], bodyColumns: e.props.bodyColumns }), bodyColumns: e.props.bodyColumns }),
    )
    // Act
    const ui = await $.ui.mount({ plugin: 'context-doctor', surface, component: 'Pane', props: PANE_PROPS(80) })
    // Assert
    expect(await ui.find({ type: 'Text', text: 'まだ内訳がありません' })).toBeDefined()
  })
}
