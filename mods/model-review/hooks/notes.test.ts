import { test, expect } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import { buildNotes } from './notes'
import { PRICE_TABLE_FETCHED_AT, PRICE_TABLE_STALE_DAYS } from './pricing'

// 架空データのみ。
const turn: TurnRecord = {
  turnId: 't1',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.1,
  toolCount: 1,
  editCount: 0,
  durationMs: 1_000,
  reason: 'answer',
}
const review: ReviewState = { turns: [turn], sessionCostUsd: { baseline: null, current: null } }

const MS_PER_DAY = 86_400_000
const fetchedMs = Date.parse(PRICE_TABLE_FETCHED_AT)
const ageNotes = (nowMs: number | undefined): string[] =>
  buildNotes(review, nowMs).filter(text => text.includes('単価表の取得から'))

test('単価表の取得から基準日数を超えたら、経過日数と取得日つきで注記する', () => {
  // Arrange: 基準の翌日。
  const nowMs = fetchedMs + (PRICE_TABLE_STALE_DAYS + 1) * MS_PER_DAY

  // Act
  const notes = ageNotes(nowMs)

  // Assert
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain(`${PRICE_TABLE_STALE_DAYS + 1} 日`)
  expect(notes[0]).toContain(PRICE_TABLE_FETCHED_AT)
})

test('単価表の取得から基準日数ちょうどまでは注記しない', () => {
  expect(ageNotes(fetchedMs + PRICE_TABLE_STALE_DAYS * MS_PER_DAY)).toEqual([])
  expect(ageNotes(fetchedMs)).toEqual([])
})

test('現在時刻が渡されないときは経過日数の注記を出さない', () => {
  expect(ageNotes(undefined)).toEqual([])
})

test('記録がなければ、経過日数の注記も含めて空', () => {
  const empty: ReviewState = { turns: [], sessionCostUsd: { baseline: null, current: null } }
  expect(buildNotes(empty, fetchedMs + 365 * MS_PER_DAY)).toEqual([])
})

const SONNET_MODEL = 'claude-sonnet-5-5'
const OPUS_MODEL = 'claude-opus-5-5'
const SWITCH_NOTE_MARK = '切替の推定'
/** total ターンのうち、index が switchAt 未満は Sonnet、以降は Opus の記録。index 0 始まり。 */
const recordsSwitchingAt = (total: number, switchAt: number): TurnRecord[] =>
  Array.from({ length: total }, (_, index) => ({
    ...turn,
    turnId: `t${index}`,
    model: index < switchAt ? SONNET_MODEL : OPUS_MODEL,
  }))
const switchNotesOf = (turns: TurnRecord[]): string[] =>
  buildNotes({ turns, sessionCostUsd: { baseline: null, current: null } }).filter(text => text.includes(SWITCH_NOTE_MARK))

test('切替が直近 10 ターンの中にあれば、切替の注記を出す', () => {
  // Arrange: 15 ターン中、index 5 から Opus。直近 10 ターン（index 5〜14）に切替がある。
  // Act
  const notes = switchNotesOf(recordsSwitchingAt(15, 5))

  // Assert
  expect(notes).toHaveLength(1)
})

test('直近 10 ターンより前の切替だけなら、切替の注記は出さない', () => {
  // Arrange: 16 ターン中、index 5 で切替。直近 10 ターン（index 6〜15）に切替はない。
  // Act
  const notes = switchNotesOf(recordsSwitchingAt(16, 5))

  // Assert
  expect(notes).toEqual([])
})

test('直近ターンでの切替は、切替の注記を出す', () => {
  // Act
  const notes = switchNotesOf(recordsSwitchingAt(20, 19))

  // Assert
  expect(notes).toHaveLength(1)
})

const TTL_MARK = '実コストが'
const ttlNotesOf = (sessionCostUsd: ReviewState['sessionCostUsd'], turns: TurnRecord[]): string[] =>
  buildNotes({ turns, sessionCostUsd }).filter(text => text.includes(TTL_MARK))
/** 基準点より前に積んだ、上限推定だけが大きいターン（実コストには入らない）。 */
const preBaselineTurn: TurnRecord = {
  ...turn,
  turnId: 'pre',
  costUsd: 1,
  costUpperUsd: 10,
  tokens: { ...turn.tokens, cacheWrite: 100_000 },
}
/** 基準点より後のターン。実コストに入り、上限推定も小さい。 */
const postBaselineTurn: TurnRecord = {
  ...turn,
  turnId: 'post',
  costUsd: 0.1,
  costUpperUsd: 0.1,
  tokens: { ...turn.tokens, cacheWrite: 60_000 },
}

test('基準点が遅れたとき、基準点より前のターンは上限推定に入れず、後のターンだけで判定する', () => {
  // Arrange: 基準点は 3 ターン目（index 3）の時点。実コスト 0.5 は後の 2 ターンの上限 0.2 を大きく超える。
  const turns = [preBaselineTurn, preBaselineTurn, preBaselineTurn, postBaselineTurn, postBaselineTurn]

  // Act
  const notes = ttlNotesOf({ baseline: 5, current: 5.5, baselineTurns: 3 }, turns)

  // Assert
  expect(notes).toHaveLength(1)
})

test('基準点が未取得なら、キャッシュ書込が多くても実コストの注記は出さない', () => {
  // Act
  const notes = ttlNotesOf({ baseline: null, current: 5.5 }, [postBaselineTurn, postBaselineTurn])

  // Assert
  expect(notes).toEqual([])
})

test('基準点ターン数を持たない旧い状態は、最初のターンから基準点とみなす', () => {
  // Arrange: 実コスト 0.5 は全ターンの上限 0.2 を超える。
  const turns = [postBaselineTurn, postBaselineTurn]

  // Act
  const notes = ttlNotesOf({ baseline: 5, current: 5.5 }, turns)

  // Assert
  expect(notes).toHaveLength(1)
})

test('単価不明のモデル名は、3 割未満でも注記に出す（件数は畳んだぶんも含む）', () => {
  // Arrange
  const many = Array.from({ length: 9 }, (_, index) => ({ ...turn, turnId: `t${index}` }))
  const state: ReviewState = {
    turns: [{ ...turn, turnId: 'u', model: 'recent-mystery', costUsd: null }, ...many],
    sessionCostUsd: { baseline: null, current: null },
    archived: {
      turns: 100,
      subagents: 0,
      advisorCalls: 0,
      groups: [
        { model: 'old-mystery', effort: null, turns: 1, unpricedTurns: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null },
      ],
      pricedUsd: 0,
      unpricedTurns: 1,
      highUsd: 0,
      sinceBaseline: { lowUsd: 0, highUsd: 0, cacheWrite: 0 },
    },
  }

  // Act
  const text = buildNotes(state).find(note => note.includes('単価不明')) ?? ''

  // Assert
  expect(text).toContain('recent-mystery')
  expect(text).toContain('old-mystery')
  expect(text).toContain('2 ターン')
  expect(text).not.toContain('単価表が古い可能性')
})
