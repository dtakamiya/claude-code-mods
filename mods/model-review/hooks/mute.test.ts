import { test, expect } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import { RECENT_CONCERN_MAIN_TURNS, type Concern, type ConcernKind } from './analyze'
import { NO_CONCERNS_TEXT } from './labels'
import { mutedLineText, readMutedConcerns, splitMuted } from './mute'
import { buildPaneRows } from './pane-model'
import { buildReportLines } from './report'

// 架空データのみ。
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

const review = (turns: readonly TurnRecord[]): ReviewState => ({ turns, sessionCostUsd: { baseline: null, current: null } })

const kinds = (set: ReadonlySet<ConcernKind>): ConcernKind[] => [...set].sort()

test('mutedConcerns は英名と短い名前を、カンマ・読点・空白区切りで読み、大文字小文字と前後の空白を無視する', () => {
  // Act / Assert
  expect(kinds(readMutedConcerns({ mutedConcerns: 'overspec,delegation' }))).toEqual(['delegation', 'overspec'])
  expect(kinds(readMutedConcerns({ mutedConcerns: ' OverSpec ，委譲、 切替 ' }))).toEqual(['delegation', 'overspec', 'switch'])
  expect(kinds(readMutedConcerns({ mutedConcerns: 'サブ underspec' }))).toEqual(['subagent', 'underspec'])
})

test('全角英字・半角カナで書いた名前も同じ種類として読む（NFKC）', () => {
  // Act / Assert
  expect(kinds(readMutedConcerns({ mutedConcerns: 'ｏｖｅｒｓｐｅｃ,ｻﾌﾞ' }))).toEqual(['overspec', 'subagent'])
})

test('mutedConcerns の知らない名前・空・文字列以外は無視する', () => {
  // Act / Assert
  expect(kinds(readMutedConcerns({ mutedConcerns: 'overspec,typo,過剰です' }))).toEqual(['overspec'])
  expect(readMutedConcerns({ mutedConcerns: '' }).size).toBe(0)
  expect(readMutedConcerns({ mutedConcerns: ' , 、' }).size).toBe(0)
  expect(readMutedConcerns({}).size).toBe(0)
  expect(readMutedConcerns({ mutedConcerns: ['overspec'] }).size).toBe(0)
  expect(readMutedConcerns({ mutedConcerns: 1 }).size).toBe(0)
  expect(readMutedConcerns({ mutedConcerns: null }).size).toBe(0)
})

test('止めた種類とそれ以外に分け、止めている 1 行は画面の順で、該当があれば件数を添える', () => {
  // Arrange
  const overspec: Concern = { kind: 'overspec', count: 3, examples: [], amountUsd: null }
  const delegation: Concern = { kind: 'delegation', count: 1, examples: [], amountUsd: null }
  const muted: ReadonlySet<ConcernKind> = new Set(['switch', 'overspec'])

  // Act
  const { shown, hidden } = splitMuted([overspec, delegation], muted)

  // Assert
  expect(shown).toEqual([delegation])
  expect(hidden).toEqual([overspec])
  expect(mutedLineText(muted, hidden)).toBe('止めている指摘（設定 mutedConcerns）: 過剰 3 件 / 切替')
  expect(mutedLineText(new Set(), [])).toBeNull()
})

test('止めている種類が窓より前にだけ該当したものなら「（過去）」と添え、母数のある件数は指摘の節と同じ表記にする', () => {
  // Arrange
  const past: Concern = { kind: 'overspec', count: 3, outOf: 40, examples: [], amountUsd: null, lastTurnsAgo: RECENT_CONCERN_MAIN_TURNS }

  // Act / Assert
  expect(mutedLineText(new Set(['overspec']), [past])).toBe('止めている指摘（設定 mutedConcerns）: 過剰 3 / 40 件（過去）')
})

test('止めた種類は結論行の件数に入らず、指摘の節には「止めている指摘」の 1 行だけが残る（ペインとテキストで同じ）', () => {
  // Arrange: 過剰 3 件だけが出る記録。
  const state = review([lightOpus('o1'), lightOpus('o2'), lightOpus('o3')])
  const muted: ReadonlySet<ConcernKind> = new Set(['overspec'])

  // Act
  const lines = buildReportLines(state, undefined, muted)
  const rows = buildPaneRows(state, {}, undefined, undefined, muted)

  // Assert: 結論は ✓、指摘の節は「指摘なし」と止めている 1 行。過剰の行・バッジ・次の一手は出ない。
  expect(lines[0]).toBe('✓ 結論: 目立った指摘なし')
  expect(lines).toContain(`  ${NO_CONCERNS_TEXT}`)
  expect(lines).toContain('  止めている指摘（設定 mutedConcerns）: 過剰 3 / 3 件')
  expect(lines.some(line => line.startsWith('  【過剰】'))).toBe(false)
  expect(rows[0]).toMatchObject({ kind: 'conclusion', text: lines[0], tone: 'success' })
  expect(rows).toContainEqual({ kind: 'note', text: '止めている指摘（設定 mutedConcerns）: 過剰 3 / 3 件' })
  expect(rows.some(row => row.kind === 'badge' && row.label === '過剰')).toBe(false)
  expect(rows.some(row => row.kind === 'next')).toBe(false)
})

test('止めていない種類はそのまま出し、止めている種類に該当がなくても 1 行は残す', () => {
  // Arrange
  const state = review([lightOpus('o1'), lightOpus('o2'), lightOpus('o3')])
  const muted: ReadonlySet<ConcernKind> = new Set(['delegation'])

  // Act
  const lines = buildReportLines(state, undefined, muted)

  // Assert
  expect(lines[0]).toBe('▲ 結論: 見直し候補 3 件（過剰 3）')
  expect(lines.some(line => line.startsWith('  【過剰】'))).toBe(true)
  expect(lines).toContain('  止めている指摘（設定 mutedConcerns）: 委譲')
})

test('何も止めていなければ「止めている指摘」の行は出ない', () => {
  // Arrange
  const state = review([lightOpus('o1'), lightOpus('o2'), lightOpus('o3')])

  // Act
  const text = buildReportLines(state).join('\n')
  const rows = buildPaneRows(state)

  // Assert
  expect(text).not.toContain('止めている指摘')
  expect(rows.some(row => row.kind === 'note' && row.text.includes('止めている指摘'))).toBe(false)
})
