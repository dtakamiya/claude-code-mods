import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { COMPACT_MIN_SIDE_TURNS, GROWTH_HINT_PROMPT_RATIO, GROWTH_HINT_RATIO, GROWTH_MIN_TURNS, GROWTH_WINDOW_TURNS, growthView } from './growth'

// 架空データのみ。
const turn = (costUsd: number | null, overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 't',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  costUsd,
  toolCount: 1,
  editCount: 0,
  reason: 'answer',
  ...overrides,
})
const run = (count: number, costUsd: number, promptTokens?: number, overrides: Partial<TurnRecord> = {}): TurnRecord[] =>
  Array.from({ length: count }, () => turn(costUsd, { firstStepPromptTokens: promptTokens, ...overrides }))

test('最初と直近の平均を並べ、プロンプト長を添える', () => {
  // Arrange
  const records = [...run(GROWTH_WINDOW_TURNS, 0.04, 18_000), ...run(5, 0.1, 80_000), ...run(GROWTH_WINDOW_TURNS, 0.19, 142_000)]

  // Act
  const view = growthView(records)

  // Assert
  expect(view?.trend).toBe('最初の 10 ターン $0.0400 → 直近 10 ターン $0.1900（プロンプト 18k → 142k tokens）')
  expect(view?.compact).toBeNull()
})

test('ターンが窓 2 つ分に満たなければ出さない', () => {
  expect(growthView(run(GROWTH_MIN_TURNS - 1, 0.1, 1_000))).toBeNull()
  expect(growthView([])).toBeNull()
})

test('サブエージェントと単価不明のターンは数えない', () => {
  // Arrange: メイン 19 件 + サブ・単価不明が混ざっても、メインの単価ありが 20 件に満たなければ出さない。
  const records = [...run(GROWTH_MIN_TURNS - 1, 0.1), turn(0.1, { agentId: 'sub' }), turn(null)]

  // Act & Assert
  expect(growthView(records)).toBeNull()
})

test('プロンプト長が取れていなければ、費用だけを出す', () => {
  // Act
  const view = growthView(run(GROWTH_MIN_TURNS, 0.1))

  // Assert
  expect(view?.trend).toBe('最初の 10 ターン $0.1000 → 直近 10 ターン $0.1000')
})

test('最新の compact の前後を比べる。compact 直後のターン自体は入れない', () => {
  // Arrange: 費用が上がり、compact 後に戻る。compact 直後は再構築で高い。
  const records = [...run(15, 0.2, 100_000), turn(0.9, { afterCompact: true, firstStepPromptTokens: 30_000 }), ...run(5, 0.06, 30_000)]

  // Act
  const view = growthView(records)

  // Assert
  expect(view?.compact).toBe('/compact の前 10 ターン $0.2000 → 後 5 ターン $0.0600（プロンプト 100k → 30k tokens）')
})

test('compact の前後どちらかのターンが少なければ、比較を出さない', () => {
  // Arrange
  const fewAfter = [...run(20, 0.2), turn(0.9, { afterCompact: true }), ...run(COMPACT_MIN_SIDE_TURNS - 1, 0.06)]
  const fewBefore = [...run(COMPACT_MIN_SIDE_TURNS - 1, 0.2), turn(0.9, { afterCompact: true }), ...run(20, 0.06)]

  // Act & Assert
  expect(growthView(fewAfter)?.compact).toBeNull()
  expect(growthView(fewBefore)?.compact).toBeNull()
})

test('畳み込み済みのターンがあれば注記に件数を出す', () => {
  // Act
  const view = growthView(run(GROWTH_MIN_TURNS, 0.1), 150)

  // Assert
  expect(view?.note).toContain('150 ターンは含みません')
  expect(growthView(run(GROWTH_MIN_TURNS, 0.1))?.note).not.toContain('畳み込み')
})

test('直近の平均が最初の倍率以上なら /compact・/clear の候補を添える。表示のみで自動実行はしない', () => {
  // Arrange: 0.04 → 0.19（4.75 倍）
  const view = growthView([...run(GROWTH_WINDOW_TURNS, 0.04, 18_000), ...run(GROWTH_WINDOW_TURNS, 0.19, 142_000)])

  // Assert
  expect(view?.hint).toContain('/compact')
  expect(view?.hint).toContain('/clear')
  expect(view?.hint).toContain('自動では実行しません')
})

test('倍率に届かない・最初が 0 円なら候補は出さない', () => {
  expect(growthView([...run(GROWTH_WINDOW_TURNS, 0.1, 10_000), ...run(GROWTH_WINDOW_TURNS, 0.1 * GROWTH_HINT_RATIO - 0.001, 90_000)])?.hint).toBeNull()
  expect(growthView([...run(GROWTH_WINDOW_TURNS, 0, 10_000), ...run(GROWTH_WINDOW_TURNS, 0.5, 90_000)])?.hint).toBeNull()
})

test('直近の窓の中で compact 済みなら、候補は出さない', () => {
  // Arrange: 費用は 5 倍以上だが、直近 10 ターンの中で compact している。
  const records = [...run(15, 0.04, 10_000), ...run(5, 0.3, 90_000), turn(0.9, { afterCompact: true, firstStepPromptTokens: 30_000 }), ...run(4, 0.3, 90_000)]

  // Assert
  expect(growthView(records)?.hint).toBeNull()
})

test('費用がちょうど倍率の境界でも出す（浮動小数の誤差で外れない）', () => {
  expect(growthView([...run(GROWTH_WINDOW_TURNS, 0.1, 10_000), ...run(GROWTH_WINDOW_TURNS, 0.3, 90_000)])?.hint).not.toBeNull()
})

test('プロンプト長が伸びていない・取れないとき（モデルや effort の変更など）は候補を出さない', () => {
  // 費用は 4.75 倍だがプロンプト長は同じ。
  expect(growthView([...run(GROWTH_WINDOW_TURNS, 0.04, 50_000), ...run(GROWTH_WINDOW_TURNS, 0.19, 50_000 * (GROWTH_HINT_PROMPT_RATIO - 0.1))])?.hint).toBeNull()
  expect(growthView([...run(GROWTH_WINDOW_TURNS, 0.04), ...run(GROWTH_WINDOW_TURNS, 0.19)])?.hint).toBeNull()
})

test('畳み込み済みのターンがあるとき、「最初」は会話の始まりではないので候補を出さない', () => {
  const records = [...run(GROWTH_WINDOW_TURNS, 0.04, 18_000), ...run(GROWTH_WINDOW_TURNS, 0.19, 142_000)]
  expect(growthView(records, 150)?.hint).toBeNull()
})
