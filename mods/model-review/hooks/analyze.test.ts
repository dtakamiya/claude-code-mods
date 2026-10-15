import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import {
  LIGHT_MAX_OUTPUT_TOKENS,
  LIGHT_MAX_TOOL_CALLS,
  estimateTotal,
  findConcerns,
  groupByModelEffort,
  modelRank,
  topCostTurns,
  MIN_OVERSPEC_SAVINGS_USD,
  UNDERSPEC_ERROR_STREAK,
  RANK_HAIKU,
  estimateRange,
  RANK_OPUS,
  RANK_SONNET,
} from './analyze'

// 架空データのみ。既定値は「重い」側に寄らない軽い 1 ターン。
const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 'turn-x',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.01,
  toolCount: 0,
  editCount: 0,
  durationMs: 1_000,
  reason: 'answer',
  ...overrides,
})

test('モデル × effort ごとにターン数・トークン・コストを足し合わせる', () => {
  // Arrange
  const records = [
    turn({ turnId: 'a', costUsd: 0.5, tokens: { input: 10, output: 1, cacheRead: 2, cacheWrite: 3 } }),
    turn({ turnId: 'b', costUsd: 0.25, tokens: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 } }),
    turn({ turnId: 'c', model: 'claude-haiku-5-5', effort: 'low', costUsd: 0.1 }),
  ]

  // Act
  const groups = groupByModelEffort(records)

  // Assert
  expect(groups).toHaveLength(2)
  expect(groups[0]).toMatchObject({
    model: 'claude-sonnet-5-5',
    effort: 'high',
    turns: 2,
    unpricedTurns: 0,
    tokens: { input: 30, output: 3, cacheRead: 2, cacheWrite: 3 },
  })
  expect(groups[0]?.costUsd?.toFixed(9)).toBe('0.750000000')
})

test('単価不明のターンがあるグループはコストを null にし、件数だけ数える', () => {
  // Arrange
  const records = [turn({ costUsd: 0.5 }), turn({ costUsd: null })]

  // Act
  const [group] = groupByModelEffort(records)

  // Assert
  expect(group).toMatchObject({ turns: 2, unpricedTurns: 1, costUsd: null })
})

test('推定合計は単価不明のターンを除き、その件数を別に返す', () => {
  // Arrange
  const records = [turn({ costUsd: 0.5 }), turn({ costUsd: null }), turn({ costUsd: 0.25 })]

  // Act
  const total = estimateTotal(records)

  // Assert
  expect(total).toEqual({ costUsd: 0.75, unpricedTurns: 1 })
})

test('モデル名から階層を判定し、未知のモデルは階層なしにする', () => {
  // Act / Assert
  expect(modelRank('claude-haiku-5-5')).toBe(RANK_HAIKU)
  expect(modelRank('us.anthropic.claude-sonnet-4-6')).toBe(RANK_SONNET)
  expect(modelRank('claude-fable-5-1')).toBe(RANK_OPUS)
  expect(modelRank('claude-unlisted-9')).toBe(-1)
})

test('軽作業を上位モデルで実行したターンを過剰の可能性として指摘する', () => {
  // Arrange: ツール 2 回・出力 100 tokens・編集なし。
  const records = [turn({ turnId: 'light-1', model: 'claude-opus-5-5', effort: 'medium', toolCount: 2 })]

  // Act
  const [concern] = findConcerns(records)

  // Assert
  expect(concern).toMatchObject({ kind: 'overspec', count: 1 })
  expect(concern?.examples[0]).toContain('light-1')
  expect(concern?.examples[0]).toContain('claude-opus-5-5')
})

test('軽作業でも effort が xhigh なら、モデルが Haiku でも過剰の可能性として指摘する', () => {
  // Arrange
  const records = [turn({ model: 'claude-haiku-5-5', effort: 'xhigh', toolCount: 0 })]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.map(concern => concern.kind)).toEqual(['overspec'])
})

test('編集を伴うか出力が大きいターンは軽作業とみなさず、過剰として指摘しない', () => {
  // Arrange
  const records = [
    turn({ model: 'claude-opus-5-5', toolCount: 1, editCount: 1 }),
    turn({ model: 'claude-opus-5-5', toolCount: 0, tokens: { input: 1, output: LIGHT_MAX_OUTPUT_TOKENS + 1, cacheRead: 0, cacheWrite: 0 } }),
    turn({ model: 'claude-opus-5-5', toolCount: LIGHT_MAX_TOOL_CALLS + 1 }),
  ]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'overspec')).toBeUndefined()
})

test('Haiku を低 effort で使い、ツールが多いターンを不足の可能性として指摘する', () => {
  // Arrange
  const records = [turn({ turnId: 'heavy-1', model: 'claude-haiku-5-5', effort: 'low', toolCount: 12 })]

  // Act
  const underspec = findConcerns(records).find(concern => concern.kind === 'underspec')

  // Assert
  expect(underspec).toMatchObject({ count: 1 })
  expect(underspec?.examples[0]).toContain('heavy-1')
})

test('Haiku を低 effort で使ったエラー終了のターンも不足の可能性として指摘する', () => {
  // Arrange
  const records = [turn({ model: 'claude-haiku-5-5', effort: 'low', reason: 'error' })]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.map(concern => concern.kind)).toEqual(['underspec'])
})

test('メインループが非 Haiku でツールを多く呼び、Haiku の委譲がなければ指揮者モデル運用を確認する', () => {
  // Arrange: メインのツール合計 10 回（閾値ちょうど）、Haiku のサブエージェントなし。
  const records = [
    turn({ turnId: 'm1', toolCount: 6, editCount: 2 }),
    turn({ turnId: 'm2', toolCount: 4 }),
  ]

  // Act
  const delegation = findConcerns(records).find(concern => concern.kind === 'delegation')

  // Assert
  expect(delegation).toMatchObject({ count: 1 })
  expect(delegation?.examples[0]).toContain('10 回')
})

test('Haiku のサブエージェントがあれば、メインのツールが多くても委譲の指摘はしない', () => {
  // Arrange
  const records = [
    turn({ turnId: 'm1', toolCount: 20 }),
    turn({ turnId: 's1', agentId: 'agent-1', model: 'claude-haiku-5-5', effort: 'medium', toolCount: 3 }),
  ]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'delegation')).toBeUndefined()
})

test('記録がないときは集計も指摘も空になる', () => {
  // Act / Assert
  expect(groupByModelEffort([])).toEqual([])
  expect(findConcerns([])).toEqual([])
  expect(estimateTotal([])).toEqual({ costUsd: 0, unpricedTurns: 0 })
})

test('Haiku 換算の差額が小さい軽作業は、モデル起因の過剰として指摘しない', () => {
  // Arrange: 差額 0.0005 は下限未満。
  const records = [turn({ model: 'claude-sonnet-5-5', effort: 'medium', toolCount: 1, costUsd: 0.02, haikuCostUsd: 0.0195 })]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'overspec')).toBeUndefined()
})

test('過剰の指摘は差額の大きい順に並び、合計の差額と例の文面に Haiku 換算の差額が入る', () => {
  // Arrange
  const records = [
    turn({ turnId: 'small', model: 'claude-sonnet-5-5', effort: 'medium', costUsd: 0.05, haikuCostUsd: 0.01 }),
    turn({ turnId: 'big', model: 'claude-opus-5-5', effort: 'medium', costUsd: 0.5, haikuCostUsd: 0.02 }),
  ]

  // Act
  const overspec = findConcerns(records).find(concern => concern.kind === 'overspec')

  // Assert: 差額 0.48 と 0.04。
  expect(overspec?.examples[0]).toContain('big')
  expect(overspec?.examples[0]).toContain('Haiku なら約 $0.4800 減')
  expect(overspec?.examples[0]).not.toContain('Sonnet なら')
  expect(overspec?.examples[1]).toContain('small')
  expect(overspec?.amountUsd?.toFixed(4)).toBe('0.5200')
})

test('Haiku の高 effort は Haiku 換算の差額が 0 でも、effort 起因の過剰として残る', () => {
  // Arrange
  const records = [turn({ model: 'claude-haiku-5-5', effort: 'max', toolCount: 0, costUsd: 0.01, haikuCostUsd: 0.01 })]

  // Act
  const overspec = findConcerns(records).find(concern => concern.kind === 'overspec')

  // Assert
  expect(overspec).toMatchObject({ count: 1, amountUsd: null })
})

test('Haiku 換算の差額が下限未満の Sonnet でも、effort が xhigh なら過剰として残る', () => {
  // Arrange
  const records = [turn({ model: 'claude-sonnet-5-5', effort: 'xhigh', toolCount: 0, costUsd: 0.001, haikuCostUsd: 0.0009 })]

  // Act
  const overspec = findConcerns(records).find(concern => concern.kind === 'overspec')

  // Assert
  expect(overspec?.count).toBe(1)
  expect(MIN_OVERSPEC_SAVINGS_USD).toBeGreaterThan(0.001 - 0.0009)
})

test('Haiku 換算がない古い記録（0.3.0）は、差額を判定せず従来どおり過剰として指摘する', () => {
  // Arrange: haikuCostUsd を持たない。
  const records = [turn({ model: 'claude-opus-5-5', effort: 'medium', toolCount: 0 })]

  // Act
  const overspec = findConcerns(records).find(concern => concern.kind === 'overspec')

  // Assert
  expect(overspec).toMatchObject({ count: 1, amountUsd: null })
})

test('Sonnet の low effort でエラー・中断が連続したターンを、不足の可能性として指摘する', () => {
  // Arrange: 連続 2 回目から数える。間に成功が入ると連続は切れる。
  const failed = (turnId: string, reason: TurnRecord['reason']) =>
    turn({ turnId, model: 'claude-sonnet-5-5', effort: 'low', toolCount: 0, reason })
  const records = [failed('e1', 'error'), failed('ok', 'answer'), failed('e2', 'error'), failed('e3', 'aborted')]

  // Act
  const underspec = findConcerns(records).find(concern => concern.kind === 'underspec')

  // Assert
  expect(UNDERSPEC_ERROR_STREAK).toBe(2)
  expect(underspec?.count).toBe(1)
  expect(underspec?.examples[0]).toContain('e3')
})

test('Sonnet の low effort でも、エラーが 1 回だけなら不足として指摘しない', () => {
  // Arrange
  const records = [turn({ model: 'claude-sonnet-5-5', effort: 'low', toolCount: 0, reason: 'error' })]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'underspec')).toBeUndefined()
})

test('高コストターンはコストの降順で上位だけを返し、単価不明のターンは除く', () => {
  // Arrange
  const records = [
    turn({ turnId: 'a', costUsd: 0.1 }),
    turn({ turnId: 'b', costUsd: null }),
    turn({ turnId: 'c', costUsd: 2 }),
    turn({ turnId: 'd', costUsd: 1 }),
    turn({ turnId: 'e', costUsd: 0.5 }),
  ]

  // Act
  const top = topCostTurns(records, 3)

  // Assert
  expect(top.map(record => record.turnId)).toEqual(['c', 'd', 'e'])
  expect(records[0]?.turnId).toBe('a')
})

test('メインループのモデル切替は、再構築コストの推定つきで切替の指摘になる', () => {
  // Arrange
  const records = [
    turn({ turnId: 't1', model: 'claude-sonnet-5-5', toolCount: 5 }),
    turn({ turnId: 't2', model: 'claude-opus-5-5', toolCount: 5, firstStepCacheWrite: 100_000 }),
  ]

  // Act
  const concern = findConcerns(records).find(candidate => candidate.kind === 'switch')

  // Assert
  expect(concern?.count).toBe(1)
  expect(concern?.amountUsd?.toFixed(4)).toBe('0.4800')
})

test('Opus の軽作業には Sonnet 換算の差額も出し、Sonnet・古い記録には出さない', () => {
  // Arrange
  const opus = turn({ turnId: 'o', model: 'claude-opus-5-5', effort: 'medium', costUsd: 0.5, haikuCostUsd: 0.02, sonnetCostUsd: 0.25 })
  const sonnet = turn({ turnId: 's', model: 'claude-sonnet-5-5', effort: 'medium', costUsd: 0.5, haikuCostUsd: 0.02, sonnetCostUsd: 0.5 })
  const legacy = turn({ turnId: 'l', model: 'claude-opus-5-5', effort: 'medium', costUsd: 0.5, haikuCostUsd: 0.02 })

  // Act
  const lines = [opus, sonnet, legacy].map(record => findConcerns([record]).find(c => c.kind === 'overspec')?.examples[0])

  // Assert
  expect(lines[0]).toContain('Sonnet なら約 $0.2500 減 · Haiku なら約 $0.4800 減（上限）')
  expect(lines[1]).not.toContain('Sonnet なら')
  expect(lines[2]).not.toContain('Sonnet なら')
})

test('推定の幅は、上限のある記録は上限で、古い記録・単価不明は下限のまま・除外で足す', () => {
  // Arrange
  const records = [
    turn({ turnId: 'a', costUsd: 1, costUpperUsd: 1.6 }),
    turn({ turnId: 'b', costUsd: 2 }),
    turn({ turnId: 'c', costUsd: null, costUpperUsd: null }),
  ]

  // Act
  const range = estimateRange(records)

  // Assert
  expect(range).toEqual({ lowUsd: 3, highUsd: 3.6 })
})
