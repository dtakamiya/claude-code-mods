import { test, expect } from 'claude-code/testing'

import { PACE_MIN_SPAN_MS, formatDuration, paceLine, paceOf, recordRateSamples, shortPace, subscriptionView } from './pace'

// 架空データのみ。
const MIN = 60000
const NOW = Date.parse('2026-10-17T10:00:00Z')
const five = (percentUsed: number, resetsAt?: string) => ({ kind: 'five_hour', percentUsed, ...(resetsAt === undefined ? {} : { resetsAt }) })
const at = (minutesAgo: number, percentUsed: number) => ({ atMs: NOW - minutesAgo * MIN, percentUsed })

test('paceOf: 測定が 1 回だけならペースは出さず、リセットまでの時間だけ出す', () => {
  const pace = paceOf(five(72, '2026-10-17T11:10:00Z'), [at(0, 72)], NOW)
  expect(pace).toEqual({ minutesToLimit: null, minutesToReset: 70 })
})

test('paceOf: 直近の増え方から上限までの分を出す', () => {
  // 10 分で 60 → 72（毎分 1.2 ポイント）。残り 28 → 約 24 分。
  const pace = paceOf(five(72, '2026-10-17T11:10:00Z'), [at(10, 60), at(0, 72)], NOW)
  expect(pace).toEqual({ minutesToLimit: 24, minutesToReset: 70 })
})

test('paceOf: 最後の測定からの経過を差し引き、窓より古い測定だけなら出さない', () => {
  // 10 分で 60 → 72。最後の測定の 10 分後（いま）には、上限まで残り約 14 分。
  expect(paceOf(five(72), [at(20, 60), at(10, 72)], NOW).minutesToLimit).toBe(14)
  expect(paceOf(five(72), [at(60, 60), at(50, 72)], NOW).minutesToLimit).toBeNull()
})

test('paceOf: 間隔が短すぎる・増えていないときはペースを出さない', () => {
  expect(paceOf(five(72), [{ atMs: NOW - PACE_MIN_SPAN_MS + 1, percentUsed: 60 }, at(0, 72)], NOW).minutesToLimit).toBeNull()
  expect(paceOf(five(72), [at(10, 72), at(0, 72)], NOW).minutesToLimit).toBeNull()
})

test('paceOf: resetsAt が無い・過去・読めないときは minutesToReset を出さない', () => {
  expect(paceOf(five(72), [at(0, 72)], NOW).minutesToReset).toBeNull()
  expect(paceOf(five(72, '2026-10-17T09:00:00Z'), [at(0, 72)], NOW).minutesToReset).toBeNull()
  expect(paceOf(five(72, 'not a date'), [at(0, 72)], NOW).minutesToReset).toBeNull()
})

test('recordRateSamples: 使用率が下がったらリセットをまたいだとみなして数え直す', () => {
  const before = recordRateSamples({}, [five(90)], NOW - 10 * MIN)
  const after = recordRateSamples(before, [five(3)], NOW)
  expect(after.five_hour).toEqual([{ atMs: NOW, percentUsed: 3 }])
})

test('recordRateSamples: 丸めの揺れ（わずかな低下）ではリセットとみなさない', () => {
  const before = recordRateSamples({}, [five(72)], NOW - 10 * MIN)
  expect(recordRateSamples(before, [five(71.9)], NOW).five_hour).toHaveLength(2)
})

test('recordRateSamples: 窓より古い測定は捨て、有限でない値は記録しない', () => {
  const old = recordRateSamples({}, [five(10)], NOW - 40 * MIN)
  const next = recordRateSamples(old, [five(20), { kind: 'seven_day', percentUsed: Number.NaN }], NOW)
  expect(next.five_hour).toEqual([{ atMs: NOW, percentUsed: 20 }])
  expect(next.seven_day).toBeUndefined()
})

test('shortPace: リセットより先に上限へ届く見込みのときだけ出す', () => {
  expect(shortPace({ minutesToLimit: 40, minutesToReset: 70 })).toBe('↑40分')
  expect(shortPace({ minutesToLimit: 40, minutesToReset: null })).toBe('↑40分')
  expect(shortPace({ minutesToLimit: 90, minutesToReset: 70 })).toBeNull()
  expect(shortPace({ minutesToLimit: null, minutesToReset: 70 })).toBeNull()
})

test('formatDuration / paceLine: 目安と明記し、断定しない', () => {
  expect(formatDuration(40)).toBe('40 分')
  expect(formatDuration(70)).toBe('1 時間 10 分')
  expect(formatDuration(120)).toBe('2 時間')
  expect(paceLine(five(72), { minutesToLimit: 40, minutesToReset: 70 })).toBe(
    '5h 72% · このペースで約 40 分で上限（目安） · リセットまで 1 時間 10 分',
  )
  expect(paceLine(five(72), { minutesToLimit: null, minutesToReset: 70 })).toBe('5h 72% · リセットまで 1 時間 10 分')
})

test('subscriptionView: rateLimits が空（サブスク外）なら null で今の表示のまま', () => {
  expect(subscriptionView([], {}, NOW)).toBeNull()
  const view = subscriptionView([five(72, '2026-10-17T11:10:00Z')], { five_hour: [at(10, 60), at(0, 72)] }, NOW)
  expect(view?.apiNote).toContain('請求額ではありません')
  expect(view?.lines).toHaveLength(1)
  // ゲートウェイの上限枠だけ・有限でない値だけのときはサブスクとみなさない。
  expect(subscriptionView([{ kind: 'spend_limit', percentUsed: 50 }, five(Number.NaN)], {}, NOW)).toBeNull()
})
