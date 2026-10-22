import { test, expect } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import { RECENT_CONCERN_MAIN_TURNS, findConcerns, isRecentConcern, mainTurnsAfter, type Concern } from './analyze'
import { conclusionOf } from './conclusion'
import { PAST_CONCERNS_HEADING } from './labels'
import { NEXT_STEP_PREFIX } from './nextstep'
import { buildPaneRows } from './pane-model'
import { buildReportLines } from './report'
import { concernDetailText } from './summary'

// 架空データのみ。既定はメインの Sonnet で、軽作業にも重い作業にもならない 1 ターン。
// 編集を含む実装中心のターンにして、窓の中で委譲の指摘が出ないようにする。
const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 'turn-x',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.25,
  toolCount: 5,
  editCount: 2,
  durationMs: 1_000,
  reason: 'answer',
  ...overrides,
})

/** Opus の軽作業（Sonnet 換算の差額あり）。3 件で過剰になる。 */
const lightOpus = (turnId: string): TurnRecord =>
  turn({ turnId, model: 'claude-opus-5-5', effort: 'medium', toolCount: 0, editCount: 0, costUsd: 0.5, sonnetCostUsd: 0.25 })

const sonnetWork = (count: number): TurnRecord[] =>
  Array.from({ length: count }, (_, index) => turn({ turnId: `s${index}` }))

const review = (turns: readonly TurnRecord[]): ReviewState => ({ turns, sessionCostUsd: { baseline: null, current: null } })

const kindsOf = (concerns: readonly Concern[]): string[] => concerns.map(concern => concern.kind)

test('mainTurnsAfter は、そのターンより後に完了したメインのターンだけを数える', () => {
  // Arrange
  const target = turn({ turnId: 'target' })
  const records = [turn({ turnId: 'before' }), target, turn({ turnId: 'sub', agentId: 'a1' }), turn({ turnId: 'm1' }), turn({ turnId: 'm2' })]

  // Act / Assert
  expect(mainTurnsAfter(records, target)).toBe(2)
  expect(mainTurnsAfter(records, records[4]!)).toBe(0)
})

test('サブエージェントのターンは、その後で最初に完了したメインのターン（親）の中とみなし、それを数えない', () => {
  // Arrange: 最新のメインのターン m2 の中で動いたサブエージェント sub2 と、1 つ前の m1 の中の sub1。
  const sub1 = turn({ turnId: 'sub1', agentId: 'a1' })
  const sub2 = turn({ turnId: 'sub2', agentId: 'a2' })
  const records = [sub1, turn({ turnId: 'm1' }), sub2, turn({ turnId: 'm2' })]

  // Act / Assert
  expect(mainTurnsAfter(records, sub2)).toBe(0)
  expect(mainTurnsAfter(records, sub1)).toBe(1)
  expect(mainTurnsAfter([sub2], sub2)).toBe(0)
})

test('序盤に過剰 → Sonnet に切替 → 窓のぶん軽作業なし で、結論は ✓ になり、過剰と切替は過去の指摘として残る', () => {
  // Arrange: 切替は最初の Sonnet のターン。その後にメインが窓の数だけ続けば、切替も窓より前になる。
  const records = [lightOpus('o1'), lightOpus('o2'), lightOpus('o3'), ...sonnetWork(RECENT_CONCERN_MAIN_TURNS + 1)]

  // Act
  const concerns = findConcerns(records)
  const conclusion = conclusionOf(concerns, [])

  // Assert
  expect(kindsOf(concerns)).toEqual(['overspec', 'switch'])
  expect(concerns.find(concern => concern.kind === 'overspec')?.lastTurnsAgo).toBe(RECENT_CONCERN_MAIN_TURNS + 1)
  expect(concerns.find(concern => concern.kind === 'switch')?.lastTurnsAgo).toBe(RECENT_CONCERN_MAIN_TURNS)
  expect(concerns.some(isRecentConcern)).toBe(false)
  expect(conclusion).toEqual({ text: '✓ 問題なし · 結論: 目立った指摘なし（過去の指摘 2 種）', tone: 'success' })
})

test('窓の中に該当がまだあれば ▲ のまま', () => {
  // Arrange: 最後の過剰の後のメインのターンが窓より 1 少ない。
  const records = [lightOpus('o1'), lightOpus('o2'), lightOpus('o3'), ...sonnetWork(RECENT_CONCERN_MAIN_TURNS - 1)]

  // Act
  const concerns = findConcerns(records)
  const overspec = concerns.find(concern => concern.kind === 'overspec')

  // Assert
  expect(overspec?.lastTurnsAgo).toBe(RECENT_CONCERN_MAIN_TURNS - 1)
  expect(overspec !== undefined && isRecentConcern(overspec)).toBe(true)
  expect(conclusionOf(concerns, []).text).toBe('▲ 要確認 · 結論: 見直し候補 4 件（過剰 3 / 切替 1）')
})

test('最新のターンで該当すれば「最後は最新のターン」、それより前なら「N ターン前」を説明に添える', () => {
  // Arrange
  const latest = findConcerns([lightOpus('o1'), lightOpus('o2'), lightOpus('o3')])
  const earlier = findConcerns([lightOpus('o1'), lightOpus('o2'), lightOpus('o3'), turn({ model: 'claude-opus-5-5', effort: 'medium' })])

  // Act
  const latestText = concernDetailText(latest[0]!)
  const earlierText = concernDetailText(earlier[0]!)

  // Assert
  expect(latestText).toContain('最後は最新のターン')
  expect(earlierText).toContain('最後は 1 ターン前')
})

test('直近と過去の指摘が混ざるとき、結論は直近の種類だけで件数と色を決め、過去は種類数を添える', () => {
  // Arrange: 過去の不足（error 色）と直近の委譲（suggestion 色）。
  const recent: Concern = { kind: 'delegation', count: 1, examples: [], amountUsd: null }
  const past: Concern = { kind: 'underspec', count: 2, examples: [], amountUsd: null, lastTurnsAgo: RECENT_CONCERN_MAIN_TURNS }

  // Act
  const conclusion = conclusionOf([past, recent], [{ kind: 'switch', text: '切替の推定' }])

  // Assert
  expect(conclusion).toEqual({ text: '△ 参考 · 結論: 見直し候補 1 件（委譲 1） · 過去の指摘 1 種 · 注意 1 件', tone: 'suggestion' })
})

test('委譲は直近の窓だけで判定するので、何ターン前かを付けず常に直近として扱う', () => {
  // Arrange
  const delegation: Concern = { kind: 'delegation', count: 1, examples: [], amountUsd: null }

  // Act / Assert
  expect(isRecentConcern(delegation)).toBe(true)
  expect(concernDetailText(delegation)).not.toContain('最後は')
})

test('過去の指摘は、テキストでもペインでも小見出しの下に別に並び、「次の一手」を付けない', () => {
  // Arrange
  const state = review([lightOpus('o1'), lightOpus('o2'), lightOpus('o3'), ...sonnetWork(RECENT_CONCERN_MAIN_TURNS + 1)])

  // Act
  const lines = buildReportLines(state)
  const rows = buildPaneRows(state)

  // Assert: テキストは「指摘なし」の後に過去の小見出しと【過剰】。次の一手の行はない。
  const pastIndex = lines.indexOf(`  ${PAST_CONCERNS_HEADING}`)
  expect(pastIndex).toBeGreaterThan(0)
  expect(lines[pastIndex - 1]).toBe('  指摘なし')
  expect(lines.slice(pastIndex).some(line => line.startsWith('  【過剰】'))).toBe(true)
  expect(lines.some(line => line.includes(`→ ${NEXT_STEP_PREFIX}`))).toBe(false)

  // Assert: ペインは OK 行を出さず、見出しの直後に小見出し（注記）→ 色なしのバッジ。次の一手の行はない。
  const pastRow = rows.findIndex(row => row.kind === 'note' && row.text === PAST_CONCERNS_HEADING)
  expect(rows[pastRow - 1]).not.toMatchObject({ kind: 'ok' })
  expect(rows.slice(pastRow).find(row => row.kind === 'badge')).toMatchObject({ label: '過剰', tone: 'plain' })
  expect(rows.some(row => row.kind === 'next')).toBe(false)

  // Assert: 結論行はペインとテキストで同じ。
  const [first] = rows
  expect(first?.kind === 'conclusion' ? first.text : undefined).toBe(lines[0])
})

test('直近の指摘しかないときは、過去の小見出しを出さない', () => {
  // Arrange
  const state = review([lightOpus('o1'), lightOpus('o2'), lightOpus('o3')])

  // Act
  const lines = buildReportLines(state)
  const rows = buildPaneRows(state)

  // Assert
  expect(lines).not.toContain(`  ${PAST_CONCERNS_HEADING}`)
  expect(rows.some(row => row.kind === 'note' && row.text === PAST_CONCERNS_HEADING)).toBe(false)
  expect(rows.find(row => row.kind === 'badge')).toMatchObject({ label: '過剰', tone: 'warning' })
})
