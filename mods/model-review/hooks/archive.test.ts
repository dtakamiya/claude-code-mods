import { test, expect } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import { groupByModelEffort } from './analyze'
import { MAX_TURNS, archiveNote, mergeGroups } from './archive'
import { buildNotes } from './notes'
import { buildPaneRows } from './pane-model'
import { buildReportLines } from './report'
import { EMPTY_REVIEW, appendTurn, withBaseline } from './state'
import { advisorCallText, estimateFacts, subagentCount } from './summary'

// 架空データのみ。
const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const
const EFFORTS = ['low', 'high', null] as const

const turnAt = (index: number): TurnRecord => ({
  turnId: `turn-${index}`,
  agentId: index % 7 === 0 ? `agent-${index}` : null,
  model: MODELS[index % MODELS.length]!,
  effort: EFFORTS[index % EFFORTS.length]!,
  tokens: { input: 10 + (index % 5), output: 5, cacheRead: 100, cacheWrite: index % 3 },
  costUsd: index % 11 === 0 ? null : 0.01,
  costUpperUsd: index % 11 === 0 ? null : 0.015,
  toolCount: index % 4,
  editCount: 0,
  durationMs: 1000,
  reason: 'answer',
  advisorCalls: index % 13 === 0 ? 1 : 0,
})

const micro = (usd: number): number => Math.round(usd * 1e6)

const build = (count: number): { readonly all: readonly TurnRecord[]; readonly review: ReviewState } => {
  const all = Array.from({ length: count }, (_, index) => turnAt(index))
  return { all, review: all.reduce(appendTurn, EMPTY_REVIEW) }
}

test('上限までは畳まず、超えた分だけ古い順に集計へ移す', () => {
  // Act
  const atLimit = build(MAX_TURNS).review
  const over = build(MAX_TURNS + 3).review

  // Assert
  expect(atLimit.archived).toBeUndefined()
  expect(over.turns).toHaveLength(MAX_TURNS)
  expect(over.turns[0]?.turnId).toBe('turn-3')
  expect(over.archived?.turns).toBe(3)
})

test('畳み込み前後で、モデル別・合計・サブエージェント数・advisor が一致する', () => {
  // Arrange
  const { all, review } = build(MAX_TURNS * 3 + 17)

  // Act
  const folded = mergeGroups(review.archived, groupByModelEffort(review.turns))
  const expected = groupByModelEffort(all)

  // Assert
  expect(folded.map(group => ({ ...group, costUsd: group.costUsd === null ? null : Math.round(group.costUsd * 1e6) }))).toEqual(
    expected.map(group => ({ ...group, costUsd: group.costUsd === null ? null : Math.round(group.costUsd * 1e6) })),
  )
  const foldedFacts = estimateFacts(review.turns, review.archived)
  const fullFacts = estimateFacts(all)
  expect(foldedFacts.unpricedTurns).toBe(fullFacts.unpricedTurns)
  expect(micro(foldedFacts.costUsd)).toBe(micro(fullFacts.costUsd))
  expect(micro(foldedFacts.highUsd)).toBe(micro(fullFacts.highUsd))
  expect(subagentCount(review.turns, review.archived)).toBe(subagentCount(all))
  expect(advisorCallText(review.turns, review.archived)).toBe(advisorCallText(all))
  expect((review.archived?.turns ?? 0) + review.turns.length).toBe(all.length)
})

test('基準点のターン数は外した分だけ前へずれ、基準点より前のターンは畳み込みの実コスト側に入らない', () => {
  // Arrange: 10 ターン後に基準点を取り、その後 MAX_TURNS 超まで続ける
  const head = Array.from({ length: 10 }, (_, index) => turnAt(index)).reduce(appendTurn, EMPTY_REVIEW)
  const based = withBaseline(head, 1)
  const review = Array.from({ length: MAX_TURNS + 20 }, (_, index) => turnAt(100 + index)).reduce(appendTurn, based)

  // Assert: 畳んだ 30 件のうち、基準点より後の 20 件だけが sinceBaseline に入る
  expect(review.archived?.turns).toBe(30)
  expect(review.sessionCostUsd.baselineTurns).toBe(0)
  const afterBaseline = Array.from({ length: 20 }, (_, index) => turnAt(100 + index))
  expect(review.archived?.sinceBaseline.cacheWrite).toBe(afterBaseline.reduce((sum, r) => sum + r.tokens.cacheWrite, 0))
})

test('畳んだことはペインとレポートに注記し、件数は畳んだぶんも含める', () => {
  // Arrange
  const { review } = build(MAX_TURNS + 40)

  // Act
  const rows = buildPaneRows(review)
  const lines = buildReportLines(review)

  // Assert
  const note = archiveNote(review.archived)
  expect(note).toContain('40')
  expect(rows).toContainEqual({ kind: 'note', text: note })
  expect(lines).toContain(note)
  expect(rows.find(row => row.kind === 'title')).toMatchObject({ turns: MAX_TURNS + 40 })
  expect(lines[2]).toContain(`${MAX_TURNS + 40} ターン`)
  expect(archiveNote(undefined)).toBeNull()
})

test('単価不明の割合は、畳んだぶんを含めて判定する', () => {
  // Arrange: 畳まれる古い側がすべて単価不明、直近は単価あり
  const unpriced = (index: number): TurnRecord => ({ ...turnAt(index), costUsd: null, costUpperUsd: null })
  const priced = (index: number): TurnRecord => ({ ...turnAt(index), costUsd: 0.01, costUpperUsd: 0.01 })
  const old = Array.from({ length: 400 }, (_, index) => unpriced(index))
  const recent = Array.from({ length: MAX_TURNS }, (_, index) => priced(1000 + index))
  const review = [...old, ...recent].reduce(appendTurn, EMPTY_REVIEW)

  // Act
  const notes = buildNotes(review)

  // Assert: 400 / 900 = 44% なので、直近だけ見ると出ない注記が出る
  expect(notes.some(text => text.includes('単価不明のターンが 400 / 900 件'))).toBe(true)
})

test('5,000 ターンでも保持は上限まで、ペインの組み立ては目標時間内に収まる', () => {
  // Arrange
  const started = performance.now()
  const review = Array.from({ length: 5_000 }, (_, index) => turnAt(index)).reduce(appendTurn, EMPTY_REVIEW)
  const appended = performance.now()

  // Act
  const rows = buildPaneRows(review)
  const built = performance.now()

  // Assert（目標は余裕を持たせた値。CI の揺れで落ちないこと優先）
  expect(review.turns).toHaveLength(MAX_TURNS)
  expect(rows.length).toBeGreaterThan(0)
  expect(appended - started).toBeLessThan(3_000)
  expect(built - appended).toBeLessThan(500)
})

test('モデルが混ざるターンは、モデル別の集計と畳み込みの両方でモデルごとに分かれる（#83）', () => {
  // Arrange
  const mixed: TurnRecord = {
    ...turnAt(1),
    agentId: null,
    model: 'claude-haiku-5-5',
    effort: 'high',
    tokens: { input: 300, output: 30, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.3,
    byModel: [
      { model: 'claude-opus-5-5', tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.2, steps: 1 },
      { model: 'claude-haiku-5-5', tokens: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.1, steps: 1 },
    ],
  }
  const filler = Array.from({ length: MAX_TURNS }, (_, index) => ({ ...turnAt(index + 1000), agentId: null, model: 'claude-sonnet-5-5', effort: null }))
  const all = [mixed, ...filler]

  // Act
  const direct = groupByModelEffort([mixed])
  const review = all.reduce(appendTurn, EMPTY_REVIEW)
  const folded = mergeGroups(review.archived, groupByModelEffort(review.turns))

  // Assert
  expect(direct.map(group => [group.model, group.tokens.input, group.costUsd])).toEqual([
    ['claude-haiku-5-5', 200, 0.1],
    ['claude-opus-5-5', 100, 0.2],
  ])
  const opus = folded.find(group => group.model === 'claude-opus-5-5' && group.effort === 'high')
  expect(opus?.tokens.input).toBe(100)
  expect(opus?.costUsd).toBe(0.2)
})

test('byModel のない記録は、これまでどおり最後のモデルにまとめる', () => {
  // Arrange
  const old = { ...turnAt(1), model: 'claude-opus-5-5', effort: 'high' }

  // Act
  const groups = groupByModelEffort([old])

  // Assert
  expect(groups.map(group => [group.model, group.turns])).toEqual([['claude-opus-5-5', 1]])
})

test('食い違った応答があるターンは注記に 1 行出し、なければ出さない（#83）', () => {
  // Arrange
  const plain = { ...EMPTY_REVIEW, turns: [turnAt(1)] }
  const diverged = { ...EMPTY_REVIEW, turns: [{ ...turnAt(1), divergedSteps: 2 }] }

  // Act / Assert
  expect(buildNotes(plain).some(note => note.includes('食い違った'))).toBe(false)
  expect(buildNotes(diverged).filter(note => note.includes('食い違った')).length).toBe(1)
})
