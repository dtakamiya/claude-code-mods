import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { CACHE_REBUILD_STREAK, NO_CACHE_MIN_PROMPT_TOKENS, NO_CACHE_STREAK, cacheHitRate, longestRebuildStreak, noCacheStreak, ttlUnderestimateSuspected } from './cache'

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

test('/compact 直後のターンは書込多めに数えず、連続も切る', () => {
  // Arrange: 書込が読込を上回るターンが 3 回続くが、真ん中は compact 直後
  const records = [turn(0, 10), turn(0, 10, { afterCompact: true }), turn(0, 10)]

  // Act
  const streak = longestRebuildStreak(records)

  // Assert
  expect(streak).toBe(1)
})

const bare = (input: number, overrides: Partial<TurnRecord> = {}): TurnRecord => turn(0, 0, { tokens: { input, output: 1, cacheRead: 0, cacheWrite: 0 }, ...overrides })
const BIG = NO_CACHE_MIN_PROMPT_TOKENS

test('キャッシュ未使用の連続は、最新のメインから数え、読込・書込がともに 0 で入力が下限以上のターンだけを数える', () => {
  // Arrange
  const records = [turn(500, 0), bare(BIG), bare(BIG), bare(BIG + 5)]

  // Act
  const result = noCacheStreak(records)

  // Assert
  expect(result).toEqual({ streak: 3, promptTokens: BIG * 3 + 5 })
  expect(NO_CACHE_STREAK).toBe(3)
})

test('キャッシュ未使用: 入力が下限未満・書込か読込が 1 でもある・最新が使用済みのターンで連続が切れる', () => {
  expect(noCacheStreak([bare(BIG), bare(BIG), bare(BIG - 1)]).streak).toBe(0)
  expect(noCacheStreak([bare(BIG), bare(BIG), bare(BIG), turn(0, 1, { tokens: { input: BIG, output: 1, cacheRead: 0, cacheWrite: 1 } })]).streak).toBe(0)
  expect(noCacheStreak([bare(BIG), bare(BIG), bare(BIG), turn(100, 0)]).streak).toBe(0)
  expect(noCacheStreak([bare(BIG), turn(100, 0), bare(BIG)]).streak).toBe(1)
})

test('キャッシュ未使用: 複数ステップのターンは 1 ステップ目の入力で見る（ツール 4 回・合計 12,000・1 ステップ目 3,000 の 3 連続では出ない）', () => {
  // Arrange: 合計は 12,000 で下限を超えるが、1 ステップ目の入力は 3,000。
  const multiStep = () => bare(12_000, { toolCount: 4, firstStepPromptTokens: 3_000 })

  // Act / Assert
  expect(noCacheStreak([multiStep(), multiStep(), multiStep()]).streak).toBe(0)
  // 1 ステップ目が下限以上なら数え、合計もその値で足す。
  expect(noCacheStreak([bare(40_000, { firstStepPromptTokens: BIG }), bare(40_000, { firstStepPromptTokens: BIG })])).toEqual({ streak: 2, promptTokens: BIG * 2 })
  // firstStepPromptTokens の無い古い記録は合計で代用する。
  expect(noCacheStreak([bare(BIG), bare(BIG)]).streak).toBe(2)
})

test('キャッシュ未使用: サブエージェントは数えず連続も切らない。/compact 直後のターンは数えず連続を切る', () => {
  expect(noCacheStreak([bare(BIG), bare(BIG), bare(BIG, { agentId: 'a1' }), bare(BIG)]).streak).toBe(3)
  expect(noCacheStreak([bare(BIG), bare(BIG, { afterCompact: true }), bare(BIG), bare(BIG)]).streak).toBe(2)
})
