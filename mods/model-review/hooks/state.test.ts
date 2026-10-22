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

test('累計が基準点以上でも直前の値より小さくなったら、巻き戻りとして基準点を取り直す', () => {
  // Arrange: 基準点 0 で始まり、もう 1 ターン進んで累計 30 になった後、再開で 0 に戻った（基準点との比較だけでは見逃す）
  const before = withCurrent(appendTurn(withCostSample(appendTurn(EMPTY_REVIEW, record), 0), record), 30)

  // Act
  const after = withCurrent(before, 0)
  const resumed = withCurrent(after, 2)

  // Assert
  expect(after.sessionCostUsd).toEqual({ baseline: 0, current: 0, baselineTurns: 2 })
  expect(resumed.sessionCostUsd).toEqual({ baseline: 0, current: 2, baselineTurns: 2 })
})

test('累計が増えている・変わらないあいだは、基準点を取り直さない', () => {
  // Arrange
  const started = withCostSample(appendTurn(EMPTY_REVIEW, record), 1)

  // Act
  const same = withCurrent(withCurrent(started, 3), 3)

  // Assert
  expect(same.sessionCostUsd).toEqual({ baseline: 1, current: 3, baselineTurns: 1 })
})

test('基準点を取り直したら、畳んだ集計の「基準点より後」のぶんも消す（取り直した基準点より前になるため）', () => {
  // Arrange: 畳んだ集計に基準点より後のぶんが積まれている
  const sinceBaseline = { lowUsd: 10, highUsd: 12, cacheWrite: 5_000 }
  const archived = { turns: 100, subagents: 0, advisorCalls: 0, groups: [], pricedUsd: 10, unpricedTurns: 0, highUsd: 12, sinceBaseline }
  const before = { ...withCurrent(withCostSample(appendTurn(EMPTY_REVIEW, record), 0), 110), archived }

  // Act
  const after = withCurrent(before, 2)

  // Assert: 基準点より後のぶんだけ消え、件数・合計（全体の集計）は残る
  expect(after.archived?.sinceBaseline).toEqual({ lowUsd: 0, highUsd: 0, cacheWrite: 0 })
  expect(after.archived?.turns).toBe(100)
  expect(after.archived?.pricedUsd).toBe(10)
  expect(before.archived.sinceBaseline).toEqual(sinceBaseline)
})

test('累計が変わらない測定では同じ状態を返す（atom の書込みと再描画を起こさない）', () => {
  // Arrange
  const sampled = withCostSample(appendTurn(EMPTY_REVIEW, record), 1)

  // Act
  const same = withCurrent(sampled, 1)

  // Assert
  expect(same).toBe(sampled)
})
