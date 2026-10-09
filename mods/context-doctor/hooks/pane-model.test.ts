import { test, expect } from 'claude-code/testing'

import type { Finding, Snapshot } from './analyze'
import { NARROW_BODY_COLUMNS, buildPaneRows } from './pane-model'
import type { PaneView } from '../types'

// 架空データのみ。
const snapshot: Snapshot = {
  percentage: 62,
  totalTokens: 124_000,
  maxTokens: 200_000,
  categories: [
    { name: 'メッセージ', tokens: 58_000, kind: 'used' },
    { name: 'メモリ', tokens: 21_000, kind: 'used' },
    { name: 'MCP', tokens: 15_000, kind: 'used' },
    { name: 'ツール', tokens: 1_000, kind: 'used' },
    { name: '空き', tokens: 76_000, kind: 'free' },
    { name: 'バッファ', tokens: 33_000, kind: 'buffer' },
  ],
  mcpTools: [],
  memoryFiles: [],
  agents: [],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 160_000,
}
const measuredAtMs = new Date(2026, 0, 1, 14, 5).getTime()
const view: PaneView = { v: 1, status: 'ok', snapshot, measuredAtMs }
const findings: Finding[] = [
  { level: 'mid', observation: 'MCP が 15,000 トークン', hypothesis: '未使用なら空けられる', suggestion: '/mcp で確認' },
]
const texts = (rows: readonly { text: string }[]) => rows.map(r => r.text).join('\n')

test('通常幅: 使用率・バー・内訳上位3・所見・測定時刻が並ぶ', () => {
  // Arrange / Act
  const rows = buildPaneRows({ view, findings, bodyColumns: 80 })
  // Assert
  expect(rows[0]?.text).toContain('62%')
  expect(rows[0]?.text).toContain('124,000 / 200,000')
  expect(rows.find(r => r.kind === 'bar')?.ratio).toBe(0.62)
  expect(rows.find(r => r.kind === 'bar')?.text).toBe('圧縮点 160,000 まで 36,000')
  expect(rows.filter(r => r.kind === 'item').map(r => r.text)).toEqual(['メッセージ 58,000', 'メモリ 21,000', 'MCP 15,000'])
  expect(texts(rows)).toContain('空き 76,000 ／ 圧縮バッファ 33,000')
  expect(texts(rows)).toContain('[注意] 観察: MCP が 15,000 トークン')
  expect(texts(rows)).toContain('仮説: 未使用なら空けられる')
  expect(texts(rows)).toContain('→ /mcp で確認')
  expect(texts(rows)).toContain('測定 14:05')
})

test('通常幅: 所見が無いとき「所見なし。」を出す', () => {
  const rows = buildPaneRows({ view, findings: [], bodyColumns: 80 })
  expect(texts(rows)).toContain('所見なし。')
})

test('コンパクト: バー無し・1項目1行で所見は観察のみ', () => {
  const rows = buildPaneRows({ view, findings, bodyColumns: NARROW_BODY_COLUMNS - 1 })
  expect(rows.some(r => r.kind === 'bar')).toBe(false)
  expect(rows[0]?.text).toBe('ctx 62% 124,000/200,000')
  expect(texts(rows)).toContain('圧縮点まで 36,000')
  expect(texts(rows)).toContain('上位: メッセージ 58,000')
  expect(texts(rows)).not.toContain('仮説')
  expect(texts(rows)).toContain('測定 14:05 推定値')
})

test('bodyColumns がちょうど閾値のときは通常表示', () => {
  const rows = buildPaneRows({ view, findings, bodyColumns: NARROW_BODY_COLUMNS })
  expect(rows.some(r => r.kind === 'bar')).toBe(true)
})

test('empty: 内訳なしの1行だけを返す', () => {
  const rows = buildPaneRows({ view: { v: 1, status: 'empty' }, findings, bodyColumns: 80 })
  expect(rows).toEqual([{ kind: 'message', text: 'まだ内訳がありません（最初の応答後に開き直してください）' }])
})

test('v 不一致: empty と同じ扱い', () => {
  const stale = { ...view, v: 2 } as unknown as PaneView
  const rows = buildPaneRows({ view: stale, findings, bodyColumns: 80 })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.kind).toBe('message')
})

test('maxTokens=0: 比率は 0 で NaN を出さない', () => {
  const zero: PaneView = { ...view, snapshot: { ...snapshot, maxTokens: 0 } }
  const rows = buildPaneRows({ view: zero, findings: [], bodyColumns: 80 })
  expect(rows.find(r => r.kind === 'bar')?.ratio).toBe(0)
  expect(rows.filter(r => r.kind === 'item').every(r => r.ratio === 0)).toBe(true)
  expect(texts(rows)).not.toContain('NaN')
})

test('自動圧縮が無効なとき圧縮点の行を出さない', () => {
  const off: PaneView = { ...view, snapshot: { ...snapshot, isAutoCompactEnabled: false } }
  expect(buildPaneRows({ view: off, findings: [], bodyColumns: 80 }).find(r => r.kind === 'bar')?.text).toBe('')
})

test('圧縮点を超過しているとき超過量を出す', () => {
  const over: PaneView = { ...view, snapshot: { ...snapshot, totalTokens: 170_000 } }
  expect(texts(buildPaneRows({ view: over, findings: [], bodyColumns: 80 }))).toContain('圧縮点を 10,000 超過')
})

test('入力を変更しない', () => {
  const before = JSON.stringify({ view, findings })
  buildPaneRows({ view, findings, bodyColumns: 80 })
  expect(JSON.stringify({ view, findings })).toBe(before)
})
