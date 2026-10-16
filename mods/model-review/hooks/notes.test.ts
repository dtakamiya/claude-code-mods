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
