import { test, expect } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import { HEADING, NO_CONCERNS_TEXT } from './labels'
import { buildPaneRows, type PaneRow } from './pane-model'
import { NO_TURNS_LINE, buildReportLines, formatInt, formatUsd } from './report'

// 架空データのみ。
const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 'turn-x',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.25,
  toolCount: 0,
  editCount: 0,
  durationMs: 1_000,
  reason: 'answer',
  ...overrides,
})

const withTurns = (turns: readonly TurnRecord[], baseline: number | null, current: number | null): ReviewState => ({
  turns,
  sessionCostUsd: { baseline, current },
})

test('記録がないときは案内の 1 行だけを返す', () => {
  // Arrange
  const empty = withTurns([], null, null)

  // Act
  const lines = buildReportLines(empty)

  // Assert
  expect(lines).toEqual([NO_TURNS_LINE])
})

test('実コストと推定の差を、同じ基準点から計算して表示する', () => {
  // Arrange: 推定 0.25 + 0.25 = 0.5、実コスト 0.75 - 0.25 = 0.5（基準点から）。
  const review = withTurns([turn({ turnId: 'a' }), turn({ turnId: 'b' })], 1.0, 1.75)

  // Act
  const text = buildReportLines(review).join('\n')

  // Assert
  expect(text).toContain('合計推定コスト: $0.5000')
  expect(text).toContain('セッション実コスト（読み込み後）: $0.7500')
  expect(text).toContain('差（実コスト − 推定）: $0.2500')
})

test('基準点がない環境では実コストを取得できないと表示する', () => {
  // Arrange
  const review = withTurns([turn()], null, null)

  // Act
  const text = buildReportLines(review).join('\n')

  // Assert
  expect(text).toContain('セッション実コスト: 取得できません')
})

test('単価不明のモデルは推定コストを「単価不明」と表示する', () => {
  // Arrange
  const review = withTurns([turn({ model: 'claude-unlisted-9', costUsd: null })], null, null)

  // Act
  const text = buildReportLines(review).join('\n')

  // Assert
  expect(text).toContain('claude-unlisted-9  effort high')
  expect(text).toContain('推定 単価不明')
  expect(text).toContain('単価不明 1 ターンを除く')
})

test('妥当性の指摘があれば、種類と件数を見出しに出す', () => {
  // Arrange: 軽作業を Opus で実行。
  const review = withTurns([turn({ turnId: 'light', model: 'claude-opus-5-5', effort: 'medium' })], null, null)

  // Act
  const text = buildReportLines(review).join('\n')

  // Assert
  expect(text).toContain('【過剰】 軽作業に重いモデル / effort · 1 件')
  expect(text).toContain('ターン light')
  expect(text).toContain('判定基準（参考）')
})

test('数値は桁区切りで表示する', () => {
  // Act / Assert
  expect(formatInt(1_234_567)).toBe('1,234,567')
  expect(formatInt(999)).toBe('999')
  expect(formatUsd(null)).toBe('単価不明')
  expect(formatUsd(0.5)).toBe('$0.5000')
})

test('コマンド出力にも、ヒット率・高コストターン・切替・注記が出る', () => {
  // Arrange
  const turns = [
    turn({ turnId: 'a', toolCount: 5, tokens: { input: 100, output: 5, cacheRead: 800, cacheWrite: 100 } }),
    turn({ turnId: 'b', toolCount: 5, model: 'claude-opus-5-5', costUsd: 2, firstStepCacheWrite: 100_000, advisorCalls: 1 }),
  ]

  // Act
  const text = buildReportLines(withTurns(turns, null, null)).join('\n')

  // Assert
  expect(text).toContain('ヒット 80%')
  expect(text).toContain('■ 高コストターン')
  expect(text).toContain('【切替】')
  expect(text).toContain('advisor 1 回')
  expect(text).toContain('fast mode')
})

test('見出しの順序と用語はペインと同じで、妥当性が最初に来る', () => {
  // Arrange: 指摘・ループ別・切替見積りが全部出る記録。
  const review = withTurns(
    [
      turn({ turnId: 't1', toolCount: 0, firstStepCacheWrite: 100_000, firstStepPromptTokens: 200_000 }),
      turn({ turnId: 's1', agentId: 'a1', model: 'claude-haiku-5-5' }),
    ],
    null,
    null,
  )

  // Act
  const text = buildReportLines(review).join('\n')
  const headingsOf = (rows: PaneRow[]) => rows.flatMap(row => (row.kind === 'heading' ? [row.text.split('· ')[0]?.trim() ?? ''] : []))
  const paneOrder = headingsOf(buildPaneRows(review))
  const reportOrder = paneOrder.map(heading => text.indexOf(`■ ${heading}`))

  // Assert: ペインの見出しがすべてテキストにあり、同じ順序で並ぶ。
  expect(paneOrder[0]).toBe(HEADING.concerns)
  expect(reportOrder.every(index => index >= 0)).toBe(true)
  expect(reportOrder).toEqual([...reportOrder].sort((a, b) => a - b))
})

test('指摘がないときは、ペインと同じ文言を出す', () => {
  // Arrange
  const text = buildReportLines(withTurns([turn({ toolCount: 5 })], null, null)).join('\n')

  // Assert
  expect(text).toContain(NO_CONCERNS_TEXT)
})
