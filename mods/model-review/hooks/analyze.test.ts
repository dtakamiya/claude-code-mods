import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import {
  LIGHT_MAX_OUTPUT_TOKENS,
  LIGHT_MAX_TOOL_CALLS,
  estimateTotal,
  findConcerns,
  groupByModelEffort,
  modelRank,
  RANK_HAIKU,
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
