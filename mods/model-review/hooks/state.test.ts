import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { EMPTY_REVIEW, appendTurn, withBaseline, withCurrent } from './state'

// 架空データのみ。
const record: TurnRecord = {
  turnId: 'turn-1',
  agentId: null,
  model: 'claude-haiku-5-5',
  effort: 'low',
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.000001,
  toolCount: 0,
  editCount: 0,
  durationMs: 10,
  reason: 'answer',
}

test('基準点は最初に得た値だけを保持し、後から上書きしない', () => {
  // Arrange
  const first = withBaseline(EMPTY_REVIEW, 1.5)

  // Act
  const second = withBaseline(first, 9.9)

  // Assert
  expect(second.sessionCostUsd.baseline).toBe(1.5)
  expect(second).toBe(first)
})

test('基準点に null を渡しても、既存の値は変わらず、未設定のままにもしない', () => {
  // Act
  const unchanged = withBaseline(EMPTY_REVIEW, null)

  // Assert
  expect(unchanged.sessionCostUsd.baseline).toBeNull()
  expect(unchanged).toBe(EMPTY_REVIEW)
})

test('ターンの追記と現在のコストの更新は元の状態を書き換えない', () => {
  // Arrange
  const before = EMPTY_REVIEW

  // Act
  const after = withCurrent(appendTurn(before, record), 2.25)

  // Assert
  expect(after.turns).toEqual([record])
  expect(after.sessionCostUsd.current).toBe(2.25)
  expect(before.turns).toEqual([])
  expect(before.sessionCostUsd.current).toBeNull()
})
