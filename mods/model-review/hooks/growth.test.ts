import { test, expect } from 'claude-code/testing'

import type { ArchivedTurns, ReviewState, TurnRecord } from '../types'
import { COMPACT_MIN_SIDE_TURNS, GROWTH_MIN_TURNS, GROWTH_WINDOW_TURNS, growthView } from './growth'
import { buildPaneRows } from './pane-model'
import { buildReportLines } from './report'

// 架空データのみ。
const turn = (index: number, costUsd: number | null, promptTokens: number | undefined, overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: `t${index}`,
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  costUsd,
  toolCount: 1,
  editCount: 0,
  durationMs: 1000,
  reason: 'answer',
  firstStepPromptTokens: promptTokens,
  ...overrides,
})

/** 先頭 10 ターンは $0.04・18k、末尾は $0.19・142k の、伸びていく会話。最初に全文書込の高いターンが 1 つ付く（推移には入らない）。 */
const growing = (count: number): TurnRecord[] => [
  turn(-1, 0.5, 5_000),
  ...Array.from({ length: count }, (_, index) =>
    index < GROWTH_WINDOW_TURNS ? turn(index, 0.04, 18_000) : index >= count - GROWTH_WINDOW_TURNS ? turn(index, 0.19, 142_000) : turn(index, 0.1, 60_000),
  ),
]

test('最初の区間と直近の区間の 1 ターンあたりの費用とプロンプト長を並べる', () => {
  // Act
  const view = growthView(growing(GROWTH_MIN_TURNS + 5))

  // Assert
  expect(view?.trend).toBe('1 ターンあたり $0.0400 → $0.1900（プロンプト 18k → 142k tokens）')
  expect(view?.compact).toBeNull()
  expect(view?.note).toBeNull()
})

test('中断したターン・プロンプト長 0 のターンは平均に入れない', () => {
  // Arrange
  const records = [
    ...growing(GROWTH_MIN_TURNS).map((record, index) => (index === 7 ? { ...record, firstStepPromptTokens: 0 } : record)),
    turn(99, 0.001, 1_000, { reason: 'aborted' }),
  ]

  // Act / Assert
  expect(growthView(records)?.trend).toBe('1 ターンあたり $0.0400 → $0.1900（プロンプト 18k → 142k tokens）')
})

test('ターン数が足りないときは出さない', () => {
  expect(growthView(growing(GROWTH_MIN_TURNS - 1))).toBeNull()
  expect(growthView([])).toBeNull()
})

test('サブエージェントのターンは数えず、単価不明のターンはコストの平均から除く', () => {
  // Arrange
  const records = [
    ...growing(GROWTH_MIN_TURNS),
    turn(100, 9, 9_000_000, { agentId: 'sub-1' }),
    turn(101, null, 142_000),
  ]

  // Act
  const view = growthView(records)

  // Assert
  expect(view?.trend).toBe('1 ターンあたり $0.0400 → $0.1900（プロンプト 18k → 142k tokens）')
})

test('プロンプト長が取れないときは費用だけを出す', () => {
  // Arrange
  const records = growing(GROWTH_MIN_TURNS).map(record => ({ ...record, firstStepPromptTokens: undefined }))

  // Act / Assert
  expect(growthView(records)?.trend).toBe('1 ターンあたり $0.0400 → $0.1900')
})

test('compact の後だけで推移を見て、前後を別の行に並べる。直後のターンは比べない', () => {
  // Arrange
  const before = Array.from({ length: 12 }, (_, index) => turn(index, 0.2, 150_000))
  const compactTurn = turn(12, 0.9, 20_000, { afterCompact: true })
  const after = Array.from({ length: 5 }, (_, index) => turn(13 + index, 0.06, 20_000))

  // Act
  const view = growthView([...before, compactTurn, ...after])

  // Assert
  expect(view?.trend).toBeNull()
  expect(view?.compact).toBe('1 ターンあたり compact の前 $0.2000 → 後 $0.0600（プロンプト 150k → 20k tokens）（compact の直後のターンは除く）')
})

test('compact の前後どちらかが少なすぎるときは前後の比較を出さない', () => {
  // Arrange
  const records = [...growing(GROWTH_MIN_TURNS), turn(50, 0.9, 20_000, { afterCompact: true }), ...Array.from({ length: COMPACT_MIN_SIDE_TURNS - 1 }, (_, i) => turn(51 + i, 0.05, 20_000))]

  // Act
  const view = growthView(records)

  // Assert
  expect(view).toBeNull()
})

test('畳み込み済みのターンがあれば、推移に入らないことを注記する', () => {
  // Arrange
  const archived = { turns: 40 } as ArchivedTurns

  // Act
  const view = growthView(growing(GROWTH_MIN_TURNS), archived)

  // Assert
  expect(view?.note).toContain('40 ターンは推移に入っていません')
})

test('ペインとテキストレポートの両方に推移が出て、指摘（▲）にはならない', () => {
  // Arrange
  const review: ReviewState = { turns: growing(GROWTH_MIN_TURNS), sessionCostUsd: { baseline: null, current: null } }

  // Act
  const text = buildReportLines(review).join('\n')
  const rows = buildPaneRows(review, {}, 0, 80)

  // Assert
  expect(text).toContain('推移: 1 ターンあたり $0.0400 → $0.1900')
  expect(rows.some(row => row.kind === 'kv' && row.label === '推移')).toBe(true)
  expect(text).toContain('目立った指摘なし')
})
