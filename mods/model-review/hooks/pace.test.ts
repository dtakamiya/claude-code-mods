import { test, expect } from 'claude-code/testing'

import { formatStatus } from './glance'
import { PACE_MIN_SPAN_MS, PACE_WINDOW_MS, addRateSamples, formatSpan, paceHints, paceLine, ratePaces, rateView, type RateSamples } from './pace'
import { buildPaneRows } from './pane-model'
import { buildReportLines } from './report'
import { EMPTY_REVIEW } from './state'

// 架空データのみ。
const MIN = 60_000
const T0 = 1_700_000_000_000
const RESET = new Date(T0 + 70 * MIN).toISOString()
const five = (percentUsed: number, resetsAt: string = RESET) => ({ kind: 'five_hour', percentUsed, resetsAt })

test('formatSpan は分と時間で読みやすく丸める', () => {
  expect(formatSpan(10_000)).toBe('1 分未満')
  expect(formatSpan(40 * MIN)).toBe('40 分')
  expect(formatSpan(70 * MIN)).toBe('1 時間 10 分')
  expect(formatSpan(120 * MIN)).toBe('2 時間')
})

test('2 回以上の測定から増え方を求め、上限までとリセットまでを目安として示す', () => {
  // Arrange: 10 分で 60% → 72%（1 分 1.2%）。残り 28% は約 23 分。
  const samples = addRateSamples(addRateSamples({}, [five(60)], T0), [five(72)], T0 + 10 * MIN)

  // Act
  const [pace] = ratePaces(samples, T0 + 10 * MIN)

  // Assert
  expect(paceLine(pace!)).toBe('5h 72% · このペースだと約 23 分で上限（目安） · リセットまで 1 時間')
  expect(paceHints(samples, T0 + 10 * MIN).get('five_hour')).toBe('上限まで23分')
})

test('測定が 1 回だけ、または間隔が短すぎるときは、ペースを出さずリセットまでだけ示す', () => {
  // Arrange
  const once = addRateSamples({}, [five(72)], T0)
  const tooShort = addRateSamples(once, [five(73)], T0 + PACE_MIN_SPAN_MS - 1)

  // Act / Assert
  expect(paceLine(ratePaces(once, T0)[0]!)).toBe('5h 72% · リセットまで 1 時間 10 分')
  expect(paceLine(ratePaces(tooShort, T0 + PACE_MIN_SPAN_MS - 1)[0]!)).toContain('リセットまで')
  expect(paceLine(ratePaces(tooShort, T0 + PACE_MIN_SPAN_MS - 1)[0]!)).not.toContain('このペース')
  expect(paceHints(once, T0).size).toBe(0)
})

test('リセットをまたいだら（使用率が下がる・リセット時刻が替わる）それまでの測定を捨てる', () => {
  // Arrange
  const before = addRateSamples(addRateSamples({}, [five(60)], T0), [five(90)], T0 + 5 * MIN)

  // Act
  const droppedPercent = addRateSamples(before, [five(3)], T0 + 6 * MIN)
  const nextWindow = addRateSamples(before, [five(95, new Date(T0 + 400 * MIN).toISOString())], T0 + 6 * MIN)

  // Assert
  expect(droppedPercent.five_hour?.points).toHaveLength(1)
  expect(nextWindow.five_hour?.points).toHaveLength(1)
  expect(paceHints(droppedPercent, T0 + 6 * MIN).size).toBe(0)
})

test('resetsAt がないときはリセットまでを出さず、ペースだけを示す', () => {
  // Arrange
  const samples = addRateSamples(addRateSamples({}, [five(10, '')], T0), [five(20, '')], T0 + 10 * MIN)

  // Act
  const line = paceLine(ratePaces(samples, T0 + 10 * MIN)[0]!)

  // Assert
  expect(line).toBe('5h 20% · このペースだと約 1 時間 20 分で上限（目安）')
})

test('リセットまでに上限へ届かないペースなら、持つ見込みと示し、status の印は出さない', () => {
  // Arrange: 10 分で 1% → 残り 72% は 720 分。リセットは 70 分後。
  const samples = addRateSamples(addRateSamples({}, [five(27)], T0), [five(28)], T0 + 10 * MIN)

  // Act
  const line = paceLine(ratePaces(samples, T0 + 10 * MIN)[0]!)

  // Assert
  expect(line).toContain('リセットまでは持つ見込み（目安）')
  expect(paceHints(samples, T0 + 10 * MIN).size).toBe(0)
})

test('最後の測定が古いときは、いまのペースとは言わない', () => {
  // Arrange
  const samples = addRateSamples(addRateSamples({}, [five(60)], T0), [five(72)], T0 + 10 * MIN)

  // Act
  const stale = ratePaces(samples, T0 + 10 * MIN + PACE_WINDOW_MS + 1)[0]!

  // Assert
  expect(stale.etaMs).toBeNull()
})

test('有限でない使用率は無視し、今回の測定に無い枠は前の測定のまま残す', () => {
  // Arrange
  const first = addRateSamples({}, [five(10), { kind: 'seven_day', percentUsed: 5 }], T0)

  // Act
  const next = addRateSamples(first, [five(Number.NaN)], T0 + MIN)
  const partial = addRateSamples(first, [five(12)], T0 + MIN)

  // Assert
  expect(Object.keys(next).sort()).toEqual(['five_hour', 'seven_day'])
  expect(next.five_hour?.points).toHaveLength(1)
  expect(partial.seven_day?.points).toHaveLength(1)
  expect(partial.five_hour?.points).toHaveLength(2)
})

test('リセット時刻の数秒の揺れでは測定を捨てない', () => {
  // Arrange
  const jittered = new Date(Date.parse(RESET) + 3_000).toISOString()

  // Act
  const samples = addRateSamples(addRateSamples({}, [five(60)], T0), [five(62, jittered)], T0 + 5 * MIN)

  // Assert
  expect(samples.five_hour?.points).toHaveLength(2)
})

test('リセット時刻を過ぎた枠は、次の報告まで古い値を出さない', () => {
  // Arrange
  const samples = addRateSamples({}, [five(72)], T0)

  // Act / Assert
  expect(ratePaces(samples, T0 + 71 * MIN)).toEqual([])
  expect(rateView(samples, T0 + 71 * MIN)).toBeNull()
})

test('増えていない時間も含めてペースを出す（増えた直後の値だけで楽観しない）', () => {
  // Arrange: 5 分で 60% → 62%。その後 5 分増えなければ、10 分で 2% のペース。
  const samples = addRateSamples(addRateSamples({}, [five(60)], T0), [five(62)], T0 + 5 * MIN)

  // Act
  const atLast = ratePaces(samples, T0 + 5 * MIN)[0]!
  const later = ratePaces(samples, T0 + 10 * MIN)[0]!

  // Assert
  expect(later.etaMs!).toBeGreaterThan(atLast.etaMs!)
})

test('100% に達していれば、ペースの文ではなく「上限に達しています」と示し、印は出さない', () => {
  // Arrange
  const samples = addRateSamples(addRateSamples({}, [five(98)], T0), [five(100)], T0 + 10 * MIN)

  // Act
  const pace = ratePaces(samples, T0 + 10 * MIN)[0]!

  // Assert
  expect(paceLine(pace)).toBe('5h 100% · 上限に達しています · リセットまで 1 時間')
  expect(paceHints(samples, T0 + 10 * MIN).size).toBe(0)
})

test('知らない種類の枠名（空白を含む）でも、行の本文にラベルが混ざらない', () => {
  // Arrange
  const samples = addRateSamples({}, [{ kind: 'seven_day opus', percentUsed: 40, resetsAt: RESET }], T0)

  // Act
  const view = rateView(samples, T0)

  // Assert
  expect(view?.rows[0]).toEqual({ label: 'seven_day opus', text: '40% · リセットまで 1 時間 10 分' })
})

test('status 行には短い印だけを添え、印がなければ今までと同じ表示（サブスク外も同じ）', () => {
  // Arrange
  const rateLimits = [{ kind: 'five_hour', percentUsed: 72 }]

  // Act / Assert
  expect(formatStatus({ costUsd: 1.234, rateLimits }, new Map([['five_hour', '上限まで40分']]))).toBe('API換算 $1.23 · 5h 72%（上限まで40分）')
  expect(formatStatus({ costUsd: 1.234, rateLimits })).toBe('API換算 $1.23 · 5h 72%')
  expect(formatStatus({ costUsd: 1.234, rateLimits: [] }, new Map([['five_hour', '上限まで40分']]))).toBe('実コスト $1.23')
})

const review = {
  ...EMPTY_REVIEW,
  turns: [
    {
      turnId: 't1',
      agentId: null,
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.1,
      toolCount: 1,
      editCount: 0,
      durationMs: 1_000,
      reason: 'answer' as const,
    },
  ],
}

test('サブスク（使用率あり）では金額を「API 換算」と明示して請求額でないと添え、サブスク外は今のまま', () => {
  // Arrange
  const samples: RateSamples = addRateSamples({}, [five(72)], T0)
  const rate = rateView(samples, T0)

  // Act
  const withRate = buildReportLines(review, T0, new Set(), rate).join('\n')
  const without = buildReportLines(review, T0).join('\n')
  const rows = buildPaneRows(review, {}, T0, 80, new Set(), rate)
  const rowsWithout = buildPaneRows(review, {}, T0, 80)

  // Assert
  expect(withRate).toContain('合計推定コスト（API 換算・参考）')
  expect(withRate).toContain('使用率 5h: 72% · リセットまで 1 時間 10 分')
  expect(withRate).toContain('請求額ではありません')
  expect(without).toContain('合計推定コスト:')
  expect(without).not.toContain('API 換算')
  expect(without).not.toContain('使用率')
  expect(JSON.stringify(rows)).toContain('API 換算の推定')
  expect(JSON.stringify(rowsWithout)).not.toContain('API 換算')
  expect(rateView({}, T0)).toBeNull()
})

test('サブスクでは実額にも「API 換算」を添え、請求額に読めないようにする。サブスク外は今のまま', () => {
  // Arrange: 読み込み時 $0.25、現在 $0.75 の累計コスト
  const withCost = { ...review, sessionCostUsd: { baseline: 0.25, current: 0.75, baselineTurns: 0 } }
  const rate = rateView(addRateSamples({}, [five(72)], T0), T0)

  // Act
  const report = buildReportLines(withCost, T0, new Set(), rate).join('\n')
  const reportWithout = buildReportLines(withCost, T0).join('\n')
  const rows = JSON.stringify(buildPaneRows(withCost, {}, T0, 80, new Set(), rate))
  const rowsWithout = JSON.stringify(buildPaneRows(withCost, {}, T0, 80))

  // Assert
  expect(report).toContain('実（API 換算） $0.5000（読み込み後）')
  expect(report).toContain('セッション実コスト（API 換算・請求額ではない・読み込み後）: $0.5000')
  expect(rows).toContain('/ 実（API 換算） $0.5000（読み込み後）')
  expect(reportWithout).toContain('実 $0.5000（読み込み後）')
  expect(reportWithout).toContain('セッション実コスト（読み込み後）: $0.5000')
  expect(rowsWithout).toContain('/ 実 $0.5000（読み込み後）')
  expect(rowsWithout).not.toContain('API 換算')
})
