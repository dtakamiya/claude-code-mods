import { test, expect } from 'claude-code/testing'

import { analyze, type Snapshot } from './analyze'
import { buildPaneRows } from './pane-model'
import { PaneBody } from './pane-view'
import type { PaneView as PaneViewState } from '../types'

// 架空データのみ。
const snapshot: Snapshot = {
  percentage: 75,
  totalTokens: 150_000,
  maxTokens: 200_000,
  categories: [
    { name: 'メッセージ', tokens: 74_600, kind: 'used' },
    { name: 'メモリファイル', tokens: 21_400, kind: 'used' },
    { name: 'MCP ツール', tokens: 20_500, kind: 'used' },
    { name: '空き', tokens: 17_000, kind: 'free' },
    { name: '圧縮バッファ', tokens: 33_000, kind: 'buffer' },
  ],
  mcpTools: [{ serverName: 'github', tokens: 12_000, isLoaded: true }, { serverName: 'jira', tokens: 8_500, isLoaded: true }],
  memoryFiles: [{ path: '/x/CLAUDE.md', type: 'Project', tokens: 21_400 }],
  agents: [],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 167_000,
}
const findings = analyze(snapshot)
const okView: PaneViewState = { v: 1, status: 'ok', snapshot, measuredAtMs: new Date(2026, 0, 1, 14, 5).getTime() }
const emptyView: PaneViewState = { v: 1, status: 'empty' }

const SURFACES = ['terminal', 'desktop'] as const
const PANE_PROPS = (bodyColumns: number) => ({ title: 'Context', isFocused: false, bodyColumns, placement: 'inline' }) as never

for (const surface of SURFACES) {
  test(`${surface}: 広めの幅で使用率・段階ラベル・バー・所見・内訳・脚注が出る`, async ($, on) => {
    // Arrange / Act
    on('ui.render', { component: 'Pane' }, ($$, e) =>
      PaneBody({ ui: $$.ui.resolve(e), rows: buildPaneRows({ view: okView, findings: okView.snapshot ? findings : [], bodyColumns: e.props.bodyColumns }) }),
    )
    const ui = await $.ui.mount({ plugin: 'context-doctor', surface, component: 'Pane', props: PANE_PROPS(72) })
    // Assert
    expect(await ui.find({ type: 'Text', text: '75% 使用  150,000 / 200,000 トークン（推定）' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '[注意]' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '圧縮点まで 17,000' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '┃' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '所見（今すぐ効く順）' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '内訳（窓に占める割合・降順）' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /圧縮バッファ.*33,000.*17%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /測定 14:05/ })).toBeDefined()
  })

  test(`${surface}: 狭幅では凡例と窓外を出さず、短縮した所見を出す`, async ($, on) => {
    // Arrange / Act
    on('ui.render', { component: 'Pane' }, ($$, e) =>
      PaneBody({ ui: $$.ui.resolve(e), rows: buildPaneRows({ view: okView, findings: okView.snapshot ? findings : [], bodyColumns: e.props.bodyColumns }) }),
    )
    const ui = await $.ui.mount({ plugin: 'context-doctor', surface, component: 'Pane', props: PANE_PROPS(32) })
    // Assert
    expect(await ui.find({ type: 'Text', text: '75%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /メモリ 21,400 \(11%\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /使用  ▒余裕/ })).toBeUndefined()
  })

  test(`${surface}: 内訳がまだ無いときは案内文を出す`, async ($, on) => {
    // Arrange / Act
    on('ui.render', { component: 'Pane' }, ($$, e) =>
      PaneBody({ ui: $$.ui.resolve(e), rows: buildPaneRows({ view: emptyView, findings: emptyView.snapshot ? findings : [], bodyColumns: e.props.bodyColumns }) }),
    )
    const ui = await $.ui.mount({ plugin: 'context-doctor', surface, component: 'Pane', props: PANE_PROPS(72) })
    // Assert
    expect(await ui.find({ type: 'Text', text: 'まだ内訳がありません' })).toBeDefined()
  })
}
