import { test, expect } from 'claude-code/testing'

import { evaluateAlerts, formatStatus, needsRedraw, readLimits, readShowStatus } from './glance'

// 架空データのみ。
const NONE = { costUsd: null, ratePercent: null }
const five = (percentUsed: number) => ({ kind: 'five_hour', percentUsed })

test('formatStatus: コストと使用率を 1 行にする', () => {
  expect(formatStatus({ costUsd: 1.234, rateLimits: [five(72), { kind: 'seven_day', percentUsed: 8.5 }] })).toBe(
    '実コスト $1.23 · 5h 72% · 7d 8.5%',
  )
})

test('formatStatus: rateLimits が空ならコストだけ、どちらも無ければ undefined', () => {
  expect(formatStatus({ costUsd: 0.5, rateLimits: [] })).toBe('実コスト $0.50')
  expect(formatStatus({ rateLimits: [] })).toBeUndefined()
})

test('formatStatus: 有限でない値は出さない', () => {
  expect(formatStatus({ costUsd: Number.NaN, rateLimits: [five(Number.POSITIVE_INFINITY)] })).toBeUndefined()
})

test('needsRedraw: cost か rateLimits を含む測定だけ true', () => {
  expect(needsRedraw(['context'])).toBe(false)
  expect(needsRedraw(['context', 'cost'])).toBe(true)
  expect(needsRedraw(['rateLimits'])).toBe(true)
})

test('readLimits: 正の有限な数だけ有効、0・負・数以外・未設定は無効', () => {
  expect(readLimits({ costLimitUsd: 5, rateLimitPercent: 80 })).toEqual({ costUsd: 5, ratePercent: 80 })
  expect(readLimits({ costLimitUsd: 0, rateLimitPercent: -1 })).toEqual(NONE)
  expect(readLimits({ costLimitUsd: '5', rateLimitPercent: Number.NaN })).toEqual(NONE)
  expect(readLimits({})).toEqual(NONE)
})

test('readShowStatus: 既定は表示、false のときだけ消す', () => {
  expect(readShowStatus({})).toBe(true)
  expect(readShowStatus({ showStatus: false })).toBe(false)
})

test('evaluateAlerts: 上限が無効なら何も知らせない', () => {
  const result = evaluateAlerts({ costUsd: 999, rateLimits: [five(100)] }, NONE, new Set())
  expect(result.alerts).toEqual([])
  expect(result.notified.size).toBe(0)
})

test('evaluateAlerts: 超えた時に 1 度だけ知らせ、超過が続く間は再通知しない', () => {
  const limits = { costUsd: 5, ratePercent: null }
  const first = evaluateAlerts({ costUsd: 5.2, rateLimits: [] }, limits, new Set())
  expect(first.alerts).toHaveLength(1)
  const again = evaluateAlerts({ costUsd: 6, rateLimits: [] }, limits, first.notified)
  expect(again.alerts).toEqual([])
})

test('evaluateAlerts: 上限未満では知らせず、使用率は枠ごとに独立', () => {
  const limits = { costUsd: null, ratePercent: 80 }
  const result = evaluateAlerts({ rateLimits: [five(79.9), { kind: 'seven_day', percentUsed: 81 }] }, limits, new Set())
  expect(result.alerts).toHaveLength(1)
  expect(result.alerts[0]).toContain('7d')
  expect([...result.notified]).toEqual(['rate:seven_day'])
})

test('evaluateAlerts: 枠がリセットされて下回った後、再び超えたら知らせる', () => {
  const limits = { costUsd: null, ratePercent: 80 }
  const hit = evaluateAlerts({ rateLimits: [five(85)] }, limits, new Set())
  const reset = evaluateAlerts({ rateLimits: [five(3)] }, limits, hit.notified)
  expect(reset.notified.size).toBe(0)
  expect(evaluateAlerts({ rateLimits: [five(90)] }, limits, reset.notified).alerts).toHaveLength(1)
})

test('evaluateAlerts: rateLimits が空なら使用率の通知はない', () => {
  expect(evaluateAlerts({ costUsd: 1, rateLimits: [] }, { costUsd: null, ratePercent: 50 }, new Set()).alerts).toEqual([])
})

test('evaluateAlerts: コストが一時的に取れない測定でも、知らせ済みの印を保つ', () => {
  const limits = { costUsd: 5, ratePercent: null }
  const hit = evaluateAlerts({ costUsd: 6, rateLimits: [] }, limits, new Set())
  const missing = evaluateAlerts({ rateLimits: [five(10)] }, limits, hit.notified)
  expect(evaluateAlerts({ costUsd: 6.5, rateLimits: [] }, limits, missing.notified).alerts).toEqual([])
})
