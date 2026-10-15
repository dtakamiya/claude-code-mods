import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { findSwitches } from './switches'

// 架空データのみ。
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

test('メインループでモデルが変わった次のターンを切替として数え、最初の応答の書込から再構築コストを推定する', () => {
  // Arrange: Opus 5.5 は書込 $5 / 読込 $0.2（MTok）。100,000 tokens で差は $0.48。
  const records = [
    turn({ turnId: 't1', model: 'claude-sonnet-5-5' }),
    turn({ turnId: 't2', model: 'claude-opus-5-5', firstStepCacheWrite: 100_000 }),
  ]

  // Act
  const summary = findSwitches(records)

  // Assert
  expect(summary.count).toBe(1)
  expect(summary.costUsd?.toFixed(4)).toBe('0.4800')
  expect(summary.examples[0]).toContain('t2')
  expect(summary.examples[0]).toContain('claude-sonnet-5-5 → claude-opus-5-5')
})

test('同じモデルで effort が変わっても、キャッシュが維持されるモデル（Sonnet 5.5）は切替に数えない', () => {
  // Arrange
  const records = [turn({ effort: 'high' }), turn({ turnId: 't2', effort: 'low' })]

  // Act
  const summary = findSwitches(records)

  // Assert
  expect(summary.count).toBe(0)
})

test('キャッシュが維持されないモデルでの effort 変更は切替に数える', () => {
  // Arrange
  const records = [
    turn({ model: 'claude-opus-4-8', effort: 'high' }),
    turn({ turnId: 't2', model: 'claude-opus-4-8', effort: 'low', firstStepCacheWrite: 10_000 }),
  ]

  // Act
  const summary = findSwitches(records)

  // Assert
  expect(summary.count).toBe(1)
  expect(summary.examples[0]).toContain('effort high → low')
})

test('Bedrock・Vertex の表記では、維持対象のモデルでも effort 変更を切替に数える', () => {
  // Arrange
  const records = [
    turn({ model: 'us.anthropic.claude-sonnet-5-5-v1:0', effort: 'high' }),
    turn({ turnId: 't2', model: 'us.anthropic.claude-sonnet-5-5-v1:0', effort: 'low' }),
  ]

  // Act
  const summary = findSwitches(records)

  // Assert
  expect(summary.count).toBe(1)
})

test('サブエージェントのターンは切替の判定に含めず、モデル不明のターンも飛ばす', () => {
  // Arrange
  const records = [
    turn({ turnId: 'main-1' }),
    turn({ turnId: 'sub-1', agentId: 'a1', model: 'claude-haiku-5-5' }),
    turn({ turnId: 'main-2', model: 'unknown' }),
    turn({ turnId: 'main-3' }),
  ]

  // Act
  const summary = findSwitches(records)

  // Assert
  expect(summary.count).toBe(0)
})

test('0.3.0 の記録（firstStepCacheWrite なし）でも切替は数え、コストは 0 とする', () => {
  // Arrange
  const records = [turn({ model: 'claude-sonnet-5-5' }), turn({ turnId: 't2', model: 'claude-opus-5-5' })]

  // Act
  const summary = findSwitches(records)

  // Assert
  expect(summary.count).toBe(1)
  expect(summary.costUsd).toBe(0)
})

test('単価不明のモデルへの切替は、数えるがコストは null にする', () => {
  // Arrange
  const records = [turn({}), turn({ turnId: 't2', model: 'claude-unlisted-9', firstStepCacheWrite: 1_000 })]

  // Act
  const summary = findSwitches(records)

  // Assert
  expect(summary).toMatchObject({ count: 1, costUsd: null })
})
