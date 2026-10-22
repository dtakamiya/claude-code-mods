import { test, expect } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import { analyzeReview } from './analysis'
import { HEADING } from './labels'
import { buildPaneRows } from './pane-model'
import { buildReportLines } from './report'
import { buildSections } from './sections'

// 架空データのみ。
const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 'turn-x',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.25,
  toolCount: 0,
  editCount: 0,
  durationMs: 1_000,
  reason: 'answer',
  ...overrides,
})

/** 指摘・ループ別・切替見積り・高コストターンが全部出る記録。 */
const richReview = (): ReviewState => ({
  turns: [
    turn({ turnId: 't1', firstStepCacheWrite: 100_000, firstStepPromptTokens: 200_000, firstStepCacheRead: 100_000 }),
    turn({ turnId: 's1', agentId: 'a1', model: 'claude-haiku-5-5' }),
    ...['o1', 'o2', 'o3'].map(turnId => turn({ turnId, model: 'claude-opus-5-5', effort: 'medium', costUsd: 0.5, sonnetCostUsd: 0.25 })),
  ],
  sessionCostUsd: { baseline: 0, current: 2 },
})

const SECTION_HEADING = {
  concerns: HEADING.concerns,
  groups: HEADING.groups,
  topTurns: HEADING.topTurns,
  loops: HEADING.loops,
  whatIf: HEADING.whatIf,
  cost: HEADING.cost,
} as const

test('節は 1 か所（buildSections）で順序を決め、中身のない任意の節は入れない', () => {
  // Act
  const rich = buildSections(analyzeReview(richReview())).map(section => section.kind)
  const plain = buildSections(analyzeReview({ turns: [turn()], sessionCostUsd: { baseline: null, current: null } })).map(section => section.kind)

  // Assert
  expect(rich).toEqual(['concerns', 'groups', 'topTurns', 'loops', 'whatIf', 'cost'])
  expect(plain).toEqual(['concerns', 'groups', 'topTurns', 'cost'])
})

test('ペインとテキストは同じ節を同じ順序で出す（見出しの並びが buildSections と一致する）', () => {
  // Arrange
  const review = richReview()
  const kinds = buildSections(analyzeReview(review)).map(section => section.kind)

  // Act
  const text = buildReportLines(review).join('\n')
  const paneHeadings = buildPaneRows(review).flatMap(row => (row.kind === 'heading' ? [row.text] : []))
  const textPositions = kinds.map(kind => text.indexOf(`■ ${SECTION_HEADING[kind]}`))
  const panePositions = kinds.map(kind => paneHeadings.findIndex(heading => heading.startsWith(SECTION_HEADING[kind])))

  // Assert: どちらにも全部あり、順序が buildSections と同じ
  expect(textPositions.every(position => position >= 0)).toBe(true)
  expect(panePositions.every(position => position >= 0)).toBe(true)
  expect([...textPositions].sort((a, b) => a - b)).toEqual(textPositions)
  expect([...panePositions].sort((a, b) => a - b)).toEqual(panePositions)
})

test('同じ記録・同じ設定・同じ日なら集計を使い回し、記録・設定・日が変われば計算し直す', () => {
  // Arrange
  const review = richReview()
  const muted = new Set<'overspec'>()
  const DAY = 24 * 60 * 60 * 1000
  const noon = 20_000 * DAY + DAY / 2

  // Act
  const first = analyzeReview(review, noon, muted)
  const sameDay = analyzeReview(review, noon + 60_000, muted)
  const nextDay = analyzeReview(review, noon + DAY, muted)
  const otherMuted = analyzeReview(review, noon + DAY, new Set(['overspec'] as const))
  const otherReview = analyzeReview({ ...review }, noon + DAY, new Set(['overspec'] as const))

  // Assert
  expect(sameDay).toBe(first)
  expect(nextDay).not.toBe(first)
  expect(otherMuted).not.toBe(nextDay)
  expect(otherReview).not.toBe(otherMuted)
  expect(otherMuted.concerns.some(concern => concern.kind === 'overspec')).toBe(false)
})

test('結論・金額・差は、ペインとテキストで同じ集計から出る', () => {
  // Arrange
  const review = richReview()
  const analysis = analyzeReview(review)

  // Act
  const pane = buildPaneRows(review)
  const text = buildReportLines(review)

  // Assert
  const conclusion = pane[0]
  expect(conclusion?.kind === 'conclusion' ? conclusion.text : '').toBe(analysis.conclusion.text)
  expect(text[0]).toBe(analysis.conclusion.text)
  expect(analysis.diff).not.toBeNull()
})
