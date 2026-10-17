import { test, expect } from 'claude-code/testing'

import type { ArchivedTurns, TurnRecord } from '../types'
import { MAX_TURNS, EMPTY_ARCHIVE } from './archive'
import { breakdownHint, breakdownItems, breakdownNote, breakdownView, costBreakdown } from './breakdown'
import { buildPaneRows } from './pane-model'
import { buildReportLines } from './report'
import { EMPTY_REVIEW, appendTurn } from './state'
import { estimateFacts } from './summary'


/** 浮動小数の合計の誤差を許す比較。 */
const expectNear = (actual: number | null | undefined, expected: number): void => {
  expect(Math.abs((actual ?? Number.NaN) - expected) < 1e-9).toBe(true)
}

// 架空データのみ。
const turn = (index: number, parts: TurnRecord['costParts'], overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: `t${index}`,
  agentId: null,
  model: 'claude-opus-5-5',
  effort: 'high',
  tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  costUsd: parts == null ? null : parts.input + parts.output + parts.cacheRead + parts.cacheWrite,
  costParts: parts,
  toolCount: 1,
  editCount: 0,
  durationMs: 1000,
  reason: 'answer',
  ...overrides,
})

const WRITE_HEAVY = { input: 0.05, output: 0.25, cacheRead: 0.12, cacheWrite: 0.58 }

test('内訳の割合は大きい順に並び、合計は推定の下限と一致する', () => {
  // Arrange
  const records = [turn(1, WRITE_HEAVY), turn(2, WRITE_HEAVY)]

  // Act
  const breakdown = costBreakdown(records)

  // Assert
  expect(breakdown).not.toBeNull()
  expect(breakdownItems(breakdown!)).toBe('書込 58% · 出力 25% · 読込 12% · 入力 5%')
  expectNear(breakdown!.totalUsd, estimateFacts(records).lowUsd)
  expect(breakdown!.excludedTurns).toBe(0)
})

test('単価不明・内訳のないターンは除き、その数を注記に出す。合計は内訳のあるターンの推定と一致する', () => {
  // Arrange: 単価不明 1 件、古い記録（内訳なしだが単価あり）1 件
  const records = [turn(1, WRITE_HEAVY), turn(2, null), turn(3, undefined, { costUsd: 0.5 })]

  // Act
  const breakdown = costBreakdown(records)

  // Assert
  expect(breakdown?.excludedTurns).toBe(2)
  expectNear(breakdown?.totalUsd, 1)
  expect(breakdownNote(breakdown!)).toContain('2 ターンを除く')
  expect(breakdownNote(breakdown!)).toContain('5 分単価')
})

test('畳んだ記録を含めても、内訳の合計は畳む前と同じになる', () => {
  // Arrange
  const count = MAX_TURNS + 20
  const all = Array.from({ length: count }, (_, index) => turn(index, index % 9 === 0 ? null : WRITE_HEAVY))
  const folded = all.reduce(appendTurn, EMPTY_REVIEW)

  // Act
  const before = costBreakdown(all)
  const after = costBreakdown(folded.turns, folded.archived)

  // Assert
  expect(folded.archived?.turns).toBe(20)
  expectNear(after?.totalUsd, before?.totalUsd ?? Number.NaN)
  expectNear(after?.parts.cacheWrite, before?.parts.cacheWrite ?? Number.NaN)
  expect(after?.excludedTurns).toBe(before?.excludedTurns)
})

test('内訳を持たない古い畳み集計は、単価のあるターンを内訳から除く', () => {
  // Arrange: 0.23.0 より前の状態（costParts なし）
  const { costParts: _parts, partsMissingTurns: _missing, ...legacy } = EMPTY_ARCHIVE
  const archived: ArchivedTurns = { ...legacy, turns: 10, unpricedTurns: 2, pricedUsd: 1 }

  // Act
  const breakdown = costBreakdown([turn(1, WRITE_HEAVY)], archived)

  // Assert
  expect(breakdown?.excludedTurns).toBe(10)
})

test('内訳が出せないとき（記録なし・全部単価不明）は null', () => {
  expect(costBreakdown([])).toBeNull()
  expect(breakdownView([turn(1, null)])).toBeNull()
})

test('手がかりは書込または出力が半分以上のときだけ出す', () => {
  const hintOf = (parts: NonNullable<TurnRecord['costParts']>): string | null => breakdownHint(costBreakdown([turn(1, parts)])!)

  expect(hintOf(WRITE_HEAVY)).toContain('書込が大きい')
  expect(hintOf({ input: 0.05, output: 0.6, cacheRead: 0.1, cacheWrite: 0.25 })).toContain('出力が大きい')
  expect(hintOf({ input: 0.05, output: 0.2, cacheRead: 0.65, cacheWrite: 0.1 })).toBeNull()
})

test('ペインとテキストレポートの両方に内訳が出る', () => {
  // Arrange
  const review = [turn(1, WRITE_HEAVY)].reduce(appendTurn, EMPTY_REVIEW)

  // Act
  const rows = buildPaneRows(review)
  const lines = buildReportLines(review)

  // Assert
  expect(rows.some(row => row.kind === 'kv' && row.label === '内訳' && row.value.startsWith('書込 58%'))).toBe(true)
  expect(lines.some(line => line.startsWith('内訳: 書込 58%'))).toBe(true)
})
