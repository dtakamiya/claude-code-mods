import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { CACHE_REBUILD_STREAK, cacheHitRate, longestRebuildStreak, ttlUnderestimateSuspected } from './cache'

// 架空データのみ。
const turn = (cacheRead: number, cacheWrite: number, overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 'turn-x',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  tokens: { input: 0, output: 0, cacheRead, cacheWrite },
  costUsd: 0.01,
  toolCount: 0,
  editCount: 0,
  durationMs: 1_000,
  reason: 'answer',
  ...overrides,
})

test('ヒット率は、キャッシュ読込を入力・読込・書込の合計で割る', () => {
  // Arrange
  const tokens = { input: 100, output: 999, cacheRead: 800, cacheWrite: 100 }

  // Act
  const rate = cacheHitRate(tokens)

  // Assert
  expect(rate).toBe(0.8)
})

test('入力・読込・書込がすべて 0 のときヒット率は null', () => {
  expect(cacheHitRate({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull()
})

test('書込が読込を上回るターンの最長の連続回数を数える（サブエージェントは除く）', () => {
  // Arrange
  const records = [
    turn(10, 100),
    turn(10, 100),
    turn(500, 10),
    turn(10, 100, { agentId: 'a1' }),
    turn(10, 100),
    turn(10, 100),
    turn(10, 100),
  ]

  // Act
  const streak = longestRebuildStreak(records)

  // Assert
  expect(streak).toBe(3)
  expect(CACHE_REBUILD_STREAK).toBe(3)
})

test('実コストが推定を 20% 超えて上回り、書込が十分あるときだけ TTL 単価差を疑う', () => {
  expect(ttlUnderestimateSuspected({ actualUsd: 1.3, estimateUsd: 1, cacheWriteTokens: 100_000 })).toBe(true)
  expect(ttlUnderestimateSuspected({ actualUsd: 1.1, estimateUsd: 1, cacheWriteTokens: 100_000 })).toBe(false)
  expect(ttlUnderestimateSuspected({ actualUsd: 1.3, estimateUsd: 1, cacheWriteTokens: 1_000 })).toBe(false)
  expect(ttlUnderestimateSuspected({ actualUsd: 0.5, estimateUsd: 1, cacheWriteTokens: 100_000 })).toBe(false)
  expect(ttlUnderestimateSuspected({ actualUsd: 1, estimateUsd: 0, cacheWriteTokens: 100_000 })).toBe(false)
})

test('書込と読込が同じターンは再構築と数えず、連続を切る', () => {
  // Arrange: 書込 > 読込, 書込 = 読込, 書込 > 読込 の順。
  const turn = (cacheRead: number, cacheWrite: number, turnId: string): TurnRecord => ({
    turnId,
    agentId: null,
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    tokens: { input: 1, output: 1, cacheRead, cacheWrite },
    costUsd: 0.01,
    toolCount: 0,
    editCount: 0,
    durationMs: 1,
    reason: 'answer',
  })
  const records = [turn(10, 20, 'a'), turn(20, 20, 'b'), turn(10, 20, 'c')]

  // Assert
  expect(longestRebuildStreak(records)).toBe(1)
})
