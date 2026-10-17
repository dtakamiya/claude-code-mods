import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { MAX_TURNS } from './archive'
import { buildPaneRows } from './pane-model'
import { buildReportLines } from './report'
import { EMPTY_REVIEW, appendTurn, mainTurnCount, stampTurn } from './state'
import { agoText, turnLabelText, turnRefText } from './turnref'

// 架空データのみ。
const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 'internal-id-xyz',
  agentId: null,
  model: 'claude-opus-5-5',
  effort: 'high',
  tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  costUsd: 2,
  toolCount: 5,
  editCount: 2,
  durationMs: 1_000,
  reason: 'answer',
  ...overrides,
})

const MIN = 60_000

test('メインは「#番号（経過）」、時刻が無ければ「N ターン前」で示す', () => {
  const record = turn({ mainSeq: 37, completedAtMs: 1_000_000 })

  expect(turnRefText(record, 8, 1_000_000 + 12 * MIN)).toBe('#37（12 分前）')
  expect(turnRefText(record, 8)).toBe('#37（8 ターン前）')
  expect(turnRefText(record, 0)).toBe('#37（最新）')
})

test('サブエージェントは親のメインのターンに結びつけて示す', () => {
  expect(turnRefText(turn({ agentId: 'agent-1', mainSeq: 37 }), 3, 5)).toBe('#37 の中のサブエージェント')
})

test('古い記録（通し番号なし）でも壊れず、従来どおり turnId で示す', () => {
  const old = turn()

  expect(turnRefText(old, 4, 123)).toBe('ターン internal-id-xyz')
  expect(turnLabelText(old, 4, 'メイン')).toBe('internal-id-xyz · メイン')
  const lines = buildReportLines({ ...EMPTY_REVIEW, turns: [old] }, 1_000)
  expect(lines.join('\n')).toContain('ターン internal-id-xyz（メイン）')
  expect(() => buildPaneRows({ ...EMPTY_REVIEW, turns: [old] }, {}, 1_000)).not.toThrow()
})

test('経過時間は分・時間・日で丸め、時計の巻き戻りは「たった今」', () => {
  expect(agoText(30_000)).toBe('たった今')
  expect(agoText(-5 * MIN)).toBe('たった今')
  expect(agoText(59 * MIN)).toBe('59 分前')
  expect(agoText(3 * 60 * MIN)).toBe('3 時間前')
  expect(agoText(50 * 60 * MIN)).toBe('2 日前')
})

test('記録に通し番号と時刻を足し、サブエージェントは進行中の親の番号を持つ', () => {
  const sub = stampTurn(EMPTY_REVIEW, turn({ agentId: 'a' }), 10)
  const afterSub = appendTurn(EMPTY_REVIEW, sub)
  const main = stampTurn(afterSub, turn(), 20)

  expect(sub).toMatchObject({ mainSeq: 1, completedAtMs: 10 })
  expect(main).toMatchObject({ mainSeq: 1, completedAtMs: 20 })
  expect(mainTurnCount(afterSub)).toBe(0)
  expect(stampTurn(appendTurn(afterSub, main), turn(), Number.NaN)).toEqual(turn({ mainSeq: 2 }))
})

test('上限を超えて畳んだ後も、通し番号がずれない', () => {
  const total = MAX_TURNS + 25
  const review = Array.from({ length: total }).reduce<typeof EMPTY_REVIEW>(
    (state, _, index) => appendTurn(state, stampTurn(state, turn({ turnId: `t${index}` }), index)),
    EMPTY_REVIEW,
  )

  expect(review.archived?.turns).toBe(25)
  expect(review.turns[0]?.mainSeq).toBe(26)
  expect(review.turns[review.turns.length - 1]?.mainSeq).toBe(total)
  expect(mainTurnCount(review)).toBe(total)
})

test('高コストターンの表示に内部の turnId は出ず、記録にプロンプト本文の項目も増えない', () => {
  const record = stampTurn(EMPTY_REVIEW, turn(), 1_000)
  const review = appendTurn(EMPTY_REVIEW, record)

  const report = buildReportLines(review, 1_000 + 12 * MIN).join('\n')
  const paneLabels = buildPaneRows(review, {}, 1_000 + 12 * MIN).flatMap(row => (row.kind === 'turn' ? [row.label] : []))

  expect(report).toContain('#1（12 分前）')
  expect(report).not.toContain('internal-id-xyz')
  expect(paneLabels).toEqual(['#1（12 分前）'])
  expect(Object.keys(record).sort()).toEqual(Object.keys(turn()).concat('mainSeq', 'completedAtMs').sort())
})
