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
  expect(sampled.sessionCostUsd).toEqual({ baseline: 4.2, current: 4.2, baselineTurns: 0 })
  expect(unset.sessionCostUsd).toEqual({ baseline: null, current: null })
})

test('基準点が遅れて取れたときは、取った時点のターン数を残し、それより前のターンを区別できるようにする', () => {
  // Arrange: 起動時は基準点が取れず、2 ターン完了した後に初めてコストが取れた。
  const twoTurns = appendTurn(appendTurn(withBaseline(EMPTY_REVIEW, null), record), record)

  // Act
  const sampled = withCostSample(twoTurns, 4.2)

  // Assert
  expect(sampled.sessionCostUsd).toEqual({ baseline: 4.2, current: 4.2, baselineTurns: 2 })
})

test('NaN や Infinity の基準点は null と同じく無視し、状態を変えない', () => {
  for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    // Act
    const result = withBaseline(EMPTY_REVIEW, broken)

    // Assert
    expect(result).toBe(EMPTY_REVIEW)
  }
})

test('壊れた基準点を無視した後に来た有限の値が、基準点になる（壊れた値で固定されない）', () => {
  // Arrange
  const afterBroken = withBaseline(EMPTY_REVIEW, Number.NaN)

  // Act
  const repaired = withBaseline(afterBroken, 3.0)

  // Assert
  expect(repaired.sessionCostUsd.baseline).toBe(3.0)
})

test('有限でないコストの取得は、基準点も現在値も変えない', () => {
  // Arrange
  const started = withBaseline(EMPTY_REVIEW, 1.5)

  // Act
  const sampledNaN = withCostSample(started, Number.NaN)
  const sampledInfinity = withCostSample(started, Number.POSITIVE_INFINITY)
  const currentNaN = withCurrent(started, Number.NaN)

  // Assert
  expect(sampledNaN).toBe(started)
  expect(sampledInfinity).toBe(started)
  expect(currentNaN).toBe(started)
})

test('有限でない値で基準点を取れなかった状態から、後の有限の値で基準点を取れる', () => {
  // Arrange: 起動時に NaN が来ても、基準点はまだ未設定のまま。
  const broken = withCostSample(EMPTY_REVIEW, Number.NaN)

  // Act
  const sampled = withCostSample(broken, 2.0)

  // Assert
  expect(sampled.sessionCostUsd).toEqual({ baseline: 2.0, current: 2.0, baselineTurns: 0 })
})

test('基準点が設定済みなら、後のコストの取得は基準点を変えず、現在値だけ更新する', () => {
  // Arrange
  const started = withBaseline(EMPTY_REVIEW, 1.5)

  // Act
  const sampled = withCostSample(started, 2.5)

  // Assert
  expect(sampled.sessionCostUsd).toEqual({ baseline: 1.5, current: 2.5, baselineTurns: 0 })
})

test('累計が基準点より小さくなったら、基準点を取り直して実コストを負にしない', () => {
  // Arrange: 再開などで累計が 5.0 から 1.0 に巻き戻った
  const before = withCostSample(appendTurn(EMPTY_REVIEW, record), 5)

  // Act
  const after = withCurrent(before, 1)

  // Assert
  expect(after.sessionCostUsd).toEqual({ baseline: 1, current: 1, baselineTurns: 1 })
})
