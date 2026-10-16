import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { EMPTY_REVIEW, appendTurn, withBaseline, withCostSample, withCurrent } from './state'

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

test('起動時に基準点が取れなかったときは、後に取れたコストを基準点にし、現在値も更新する', () => {
  // Arrange: 起動時は累計コストが取れず、基準点も現在値も null のまま。
  const unset = withBaseline(EMPTY_REVIEW, null)

  // Act
  const sampled = withCostSample(unset, 4.2)

  // Assert
  expect(sampled.sessionCostUsd).toEqual({ baseline: 4.2, current: 4.2 })
  expect(unset.sessionCostUsd).toEqual({ baseline: null, current: null })
})

test('基準点が設定済みなら、後のコストの取得は基準点を変えず、現在値だけ更新する', () => {
  // Arrange
  const started = withBaseline(EMPTY_REVIEW, 1.5)

  // Act
  const sampled = withCostSample(started, 2.5)

  // Assert
  expect(sampled.sessionCostUsd).toEqual({ baseline: 1.5, current: 2.5 })
})
