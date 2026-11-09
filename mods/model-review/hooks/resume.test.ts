import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { cellWidth } from './format'
import { MS_PER_HOUR, MS_PER_MINUTE, PROMPT_DROP_RATIO, findResumes, idleGapMs, resumeNoteText } from './resume'

// 架空データのみ。主な値: 直前ターンの入力 100,000 tokens、再開したターンは全文を書き直して書込 90,000・読込 500。
const BASE_MS = 1_000_000_000_000
const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 'turn-x',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  tokens: { input: 50, output: 300, cacheRead: 500, cacheWrite: 90_000 },
  costUsd: 0.4,
  toolCount: 0,
  editCount: 0,
  durationMs: 10_000,
  reason: 'answer',
  firstStepCacheWrite: 90_000,
  firstStepCacheRead: 500,
  firstStepPromptTokens: 90_550,
  mainSeq: 2,
  completedAtMs: BASE_MS,
  ...overrides,
})
const previous = (overrides: Partial<TurnRecord> = {}): TurnRecord =>
  turn({
    turnId: 'turn-prev',
    mainSeq: 1,
    completedAtMs: BASE_MS - 10 * MS_PER_MINUTE,
    tokens: { input: 50, output: 300, cacheRead: 99_000, cacheWrite: 1_000 },
    firstStepCacheWrite: 1_000,
    firstStepCacheRead: 99_000,
    firstStepPromptTokens: 100_050,
    ...overrides,
  })
/** 直前ターンの完了から gapMs あいて始まった、再開ターン（durationMs 10 秒）。 */
const resumedAfter = (gapMs: number, overrides: Partial<TurnRecord> = {}): TurnRecord =>
  turn({ completedAtMs: previous().completedAtMs! + gapMs + 10_000, ...overrides })

test('間隔は、当ターンの完了 − 所要時間 − 直前ターンの完了で出す', () => {
  expect(idleGapMs(previous(), resumedAfter(8 * MS_PER_MINUTE))).toBe(8 * MS_PER_MINUTE)
})

test('時刻か所要時間が欠けていれば間隔は不明（null）で、過大に見積もらない', () => {
  const withoutCompleted = turn()
  const { completedAtMs: _omit, ...rest } = withoutCompleted
  expect(idleGapMs(previous(), rest)).toBeNull()
  expect(idleGapMs(previous(), resumedAfter(MS_PER_HOUR, { durationMs: undefined }))).toBeNull()
  const { completedAtMs: _omitPrev, ...prevRest } = previous()
  expect(idleGapMs(prevRest, resumedAfter(MS_PER_HOUR))).toBeNull()
})

test('partial（reload を跨いだ）ターンと、通し番号が連続しない（間が畳まれた）ターンは間隔不明', () => {
  expect(idleGapMs(previous(), resumedAfter(MS_PER_HOUR, { partial: true }))).toBeNull()
  expect(idleGapMs(previous({ partial: true }), resumedAfter(MS_PER_HOUR))).toBeNull()
  expect(idleGapMs(previous(), resumedAfter(MS_PER_HOUR, { mainSeq: 5 }))).toBeNull()
})

test('時計の巻き戻りなどで負になった間隔は 0 とする', () => {
  expect(idleGapMs(previous(), turn({ completedAtMs: previous().completedAtMs! - 5_000 }))).toBe(0)
})

test('境界: 5 分未満は出ず、ちょうど 5 分から「5 分 TTL なら切れる」間隔として出る', () => {
  const justUnder = findResumes([previous(), resumedAfter(5 * MS_PER_MINUTE - 1_000)])
  const exactly = findResumes([previous(), resumedAfter(5 * MS_PER_MINUTE)])
  const over = findResumes([previous(), resumedAfter(5 * MS_PER_MINUTE + 1_000)])
  expect(justUnder.count).toBe(0)
  expect(exactly.latest?.ttlOver).toBe('5m')
  expect(over.latest?.ttlOver).toBe('5m')
})

test('境界: 1 時間未満は 5 分 TTL のみ、ちょうど 1 時間から 1 時間 TTL でも切れる間隔', () => {
  const under = findResumes([previous(), resumedAfter(MS_PER_HOUR - 1_000)])
  const exactly = findResumes([previous(), resumedAfter(MS_PER_HOUR)])
  const over = findResumes([previous(), resumedAfter(MS_PER_HOUR + 1_000)])
  expect(under.latest?.ttlOver).toBe('5m')
  expect(exactly.latest?.ttlOver).toBe('1h')
  expect(over.latest?.ttlOver).toBe('1h')
})

test('再構築の根拠（書込が大きく読込が小さい）が無ければ、長く放置していても出さない', () => {
  const warm = resumedAfter(2 * MS_PER_HOUR, { firstStepCacheWrite: 1_000, firstStepCacheRead: 89_000, firstStepPromptTokens: 90_050 })
  const smallWrite = resumedAfter(2 * MS_PER_HOUR, { firstStepCacheWrite: 100, firstStepCacheRead: 10, firstStepPromptTokens: 100_000 })
  expect(findResumes([previous(), warm]).count).toBe(0)
  expect(findResumes([previous(), smallWrite]).count).toBe(0)
})

test('書込・読込の記録が無い古いターンは根拠が無いので出さない', () => {
  const { firstStepCacheRead: _omit, ...noRead } = resumedAfter(2 * MS_PER_HOUR)
  expect(findResumes([previous(), noRead]).count).toBe(0)
})

test('/compact 直後（afterCompact）のターンは出さない', () => {
  expect(findResumes([previous(), resumedAfter(2 * MS_PER_HOUR, { afterCompact: true })]).count).toBe(0)
})

test('架空シナリオ: idle compaction で入力が急減したターンを、再書込（放置後の再構築）と呼ばない', () => {
  // 直前 100,000 tokens の会話が、放置中の要約で 12,000 tokens になり、キャッシュ切れで全文書込になった（afterCompact は立たない前提）。
  const compacted = resumedAfter(55 * MS_PER_MINUTE, { firstStepCacheWrite: 12_000, firstStepCacheRead: 0, firstStepPromptTokens: 12_000 })
  expect(findResumes([previous(), compacted]).count).toBe(0)
})

test('入力の減り方の境界: 直前の PROMPT_DROP_RATIO 以下は圧縮とみなして除き、わずかに上なら出す', () => {
  const prevPrompt = previous().firstStepPromptTokens!
  const atRatio = Math.floor(prevPrompt * PROMPT_DROP_RATIO)
  const mk = (prompt: number) =>
    resumedAfter(2 * MS_PER_HOUR, { firstStepCacheWrite: prompt, firstStepCacheRead: 0, firstStepPromptTokens: prompt })
  expect(findResumes([previous(), mk(atRatio)]).count).toBe(0)
  expect(findResumes([previous(), mk(atRatio + 1_000)]).count).toBe(1)
})

test('直前ターンの入力長が分からなければ、圧縮でないと言えないので出さない', () => {
  const { firstStepPromptTokens: _omit, ...prevRest } = previous()
  expect(findResumes([prevRest, resumedAfter(2 * MS_PER_HOUR)]).count).toBe(0)
})

test('サブエージェントのターンは、直前ターンにも対象にも数えない', () => {
  const sub = turn({ turnId: 'sub', agentId: 'a1', mainSeq: 2, completedAtMs: BASE_MS - 60_000 })
  const resumed = resumedAfter(2 * MS_PER_HOUR, { mainSeq: 2 })
  expect(findResumes([previous(), sub, resumed]).count).toBe(1)
})

test('件数は全体、latest は最も新しい 1 件。既存の「連続再構築」とは別の文面で、放置後の「可能性」と弱く言う', () => {
  const p1 = previous()
  const r1 = resumedAfter(8 * MS_PER_MINUTE)
  const p2 = turn({ ...previous(), turnId: 'p2', mainSeq: 3, completedAtMs: r1.completedAtMs! + 5_000 })
  const r2 = turn({ ...resumedAfter(2 * MS_PER_HOUR), turnId: 'r2', mainSeq: 4, completedAtMs: p2.completedAtMs! + 2 * MS_PER_HOUR + 10_000 })
  const summary = findResumes([p1, r1, p2, r2])

  const text = resumeNoteText(summary, r2.completedAtMs! + 3 * MS_PER_MINUTE)

  expect(summary.count).toBe(2)
  expect(text).toContain('2 件')
  expect(text).toContain('#4（3 分前）')
  expect(text).toContain('放置後の可能性')
  expect(text).toContain('1 時間どちらの TTL でも')
  expect(text).not.toContain('連続')
})

test('5 分以上 1 時間未満の再開は「TTL が 5 分なら」と条件を付け、TTL は断定しない', () => {
  const summary = findResumes([previous(), resumedAfter(8 * MS_PER_MINUTE)])

  const text = resumeNoteText(summary)

  expect(text).toContain('約 8 分')
  expect(text).toContain('TTL が 5 分なら')
  expect(text).toContain('放置後の可能性')
  expect(text).not.toContain('1 時間どちら')
})

test('該当が無ければ文面は null', () => {
  expect(resumeNoteText(findResumes([previous(), resumedAfter(MS_PER_MINUTE)]))).toBeNull()
  expect(resumeNoteText(findResumes([]))).toBeNull()
})

test('注記は 1 文 2 本に収まる長さ（全角換算で 80 桁 2 行ほど）で、断定のヘッジは末尾の 1 回だけ', () => {
  const text = resumeNoteText(findResumes([previous(), resumedAfter(8 * MS_PER_MINUTE)])) ?? ''

  expect(cellWidth(text)).toBeLessThanOrEqual(170)
  expect(text.match(/断定/g)).toHaveLength(1)
})

test('同じターンがモデルの切替でもあるときは、金額を重ねず切替側に任せる（件数は数える）', () => {
  // Arrange: 直前は sonnet、再開したターンは opus（モデルが替わった）。
  const summary = findResumes([previous(), resumedAfter(8 * MS_PER_MINUTE, { model: 'claude-opus-5-5' })])

  // Act
  const text = resumeNoteText(summary) ?? ''

  // Assert
  expect(summary.count).toBe(1)
  expect(summary.latest?.overlapsSwitch).toBe(true)
  expect(text).toContain('切替と重なるため金額は切替側')
  expect(text).not.toContain('$')
})

test('切替でないターンは金額（再構築の推定）を出す', () => {
  const summary = findResumes([previous(), resumedAfter(8 * MS_PER_MINUTE)])

  expect(summary.latest?.overlapsSwitch).toBe(false)
  expect(resumeNoteText(summary)).toContain('再構築の推定 $')
})
