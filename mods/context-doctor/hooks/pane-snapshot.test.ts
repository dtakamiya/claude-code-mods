import { test, expect } from 'claude-code/testing'

import type { Snapshot } from './analyze'
import { buildPaneView, buildSnapshot, dropUndefined, type BreakdownSource } from './pane-snapshot'

// 架空データのみ。
const source = {
  percentage: 10,
  totalTokens: 20_000,
  maxTokens: 200_000,
  categories: [{ name: 'メッセージ', tokens: 20_000, kind: 'used', color: 'x', isDeferred: false }],
  mcpTools: [],
  memoryFiles: [],
  agents: [],
  isAutoCompactEnabled: false,
} as unknown as BreakdownSource

test('buildSnapshot: 必要な項目だけを写し、余分な項目は持たない', () => {
  const snap = buildSnapshot({ ...source, autoCompactThreshold: 160_000, extra: 1 } as BreakdownSource)
  expect(snap.percentage).toBe(10)
  expect(snap.autoCompactThreshold).toBe(160_000)
  expect(snap.categories).toBe(source.categories)
  expect('extra' in snap).toBe(false)
})

test('buildSnapshot: 無い任意項目は undefined のまま', () => {
  const snap = buildSnapshot(source)
  expect(snap.skills).toBeUndefined()
  expect(snap.slashCommands).toBeUndefined()
  expect(snap.autoCompactThreshold).toBeUndefined()
})

test('dropUndefined: ネストした undefined キーを落とし、入力は変えない', () => {
  const input = { a: 1, b: undefined, c: { d: undefined, e: 2 }, f: [{ g: undefined, h: 3 }] }
  const out = dropUndefined(input)
  expect(out).toEqual({ a: 1, c: { e: 2 }, f: [{ h: 3 }] })
  expect('b' in out).toBe(false)
  expect('b' in input).toBe(true)
})

test('dropUndefined: null と 0 と空文字は残す', () => {
  expect(dropUndefined({ a: null, b: 0, c: '' })).toEqual({ a: null, b: 0, c: '' })
})

test('buildPaneView: undefined キーを含まない JSON 安全な値になる', () => {
  const view = buildPaneView(buildSnapshot(source), 1000)
  const snap = view.snapshot as Snapshot
  expect(view.v).toBe(1)
  expect(view.status).toBe('ok')
  expect(view.measuredAtMs).toBe(1000)
  expect('skills' in snap).toBe(false)
  expect(JSON.parse(JSON.stringify(view))).toEqual(view)
})
