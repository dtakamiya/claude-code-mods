import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { describeOption, estimateSwitchOptions } from './whatif'

// 架空データのみ。
const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 't1',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  tokens: { input: 100_000, output: 10_000, cacheRead: 400_000, cacheWrite: 100_000 },
  costUsd: 0.59,
  toolCount: 1,
  editCount: 0,
  durationMs: 1_000,
  reason: 'answer',
  firstStepCacheWrite: 100_000,
  firstStepPromptTokens: 600_000,
  ...overrides,
})

test('いまのモデルを除いた候補ごとに、再構築コスト・1 ターンの差・回収ターン数を出す', () => {
  // Arrange: Sonnet 5.5 の 1 ターンは $0.59。Opus 5.5 は $1.18（+$0.59）、Haiku 5.5 はプロンプト 60 万 tokens の高い単価段で $0.1575。
  const records = [turn()]

  // Act
  const options = estimateSwitchOptions(records)
  const haiku = options.find(option => option.model === 'claude-haiku-5-5')
  const opus = options.find(option => option.model === 'claude-opus-5-5')

  // Assert
  expect(options.map(option => option.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
  expect(haiku?.rebuildUsd?.toFixed(6)).toBe('0.057500')
  expect(haiku?.perTurnDeltaUsd?.toFixed(6)).toBe('-0.432500')
  expect(haiku?.breakEvenTurns).toBe(1)
  expect(opus?.rebuildUsd?.toFixed(6)).toBe('0.480000')
  expect(opus?.perTurnDeltaUsd?.toFixed(6)).toBe('0.590000')
  expect(opus?.breakEvenTurns).toBeNull()
})

test('基準は直近のメインのターン。サブエージェントや単価不明・プロンプト長不明のターンは基準にしない', () => {
  // Arrange: 最後のメインが Opus。その後ろにサブエージェントがある。
  const records = [
    turn({ turnId: 'a', model: 'claude-sonnet-5-5' }),
    turn({ turnId: 'b', model: 'claude-opus-5-5', costUsd: 1.18 }),
    turn({ turnId: 'sub', agentId: 'agent-1', model: 'claude-haiku-5-5' }),
    turn({ turnId: 'c', costUsd: null }),
    turn({ turnId: 'd', firstStepPromptTokens: undefined }),
  ]

  // Act
  const options = estimateSwitchOptions(records)

  // Assert
  expect(options.map(option => option.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
})

test('基準にできるターンがない、またはモデルの単価が不明なときは空を返す', () => {
  expect(estimateSwitchOptions([])).toEqual([])
  expect(estimateSwitchOptions([turn({ model: 'mystery-model' })])).toEqual([])
})

test('firstStepCacheWrite のない旧記録は基準にせず、直近の新しい記録で見積もる（再構築を 0 円とみなさない）', () => {
  // Arrange: 直近は旧記録（Opus・再構築の記録なし）。その前に新しい記録（Sonnet）がある。
  const records = [
    turn({ turnId: 'new', model: 'claude-sonnet-5-5' }),
    turn({ turnId: 'old', model: 'claude-opus-5-5', costUsd: 1.18, firstStepCacheWrite: undefined }),
  ]

  // Act
  const options = estimateSwitchOptions(records)
  const haiku = options.find(option => option.model === 'claude-haiku-5-5')

  // Assert: 基準は Sonnet の記録なので、候補は Haiku と Opus。Haiku の再構築は 0.0575。
  expect(options.map(option => option.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
  expect(haiku?.rebuildUsd?.toFixed(6)).toBe('0.057500')
})

test('firstStepCacheWrite のない旧記録しかなければ、再構築が不明なので空を返す', () => {
  expect(estimateSwitchOptions([turn({ firstStepCacheWrite: undefined })])).toEqual([])
})

test('文面はモデル名・再構築・差額の符号・回収ターン数を含む', () => {
  // Arrange
  const [haiku] = estimateSwitchOptions([turn()])

  // Act
  const text = haiku ? describeOption(haiku) : ''

  // Assert
  expect(text).toBe('haiku-5-5 へ: 再構築 +$0.0575 · 1 ターンあたり -$0.4325 · 約 1 ターンで回収')
})
