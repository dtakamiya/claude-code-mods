import { expect, test } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import type { Concern, ModelGroup } from './analyze'
import {
  actualCostUsd,
  advisorCallText,
  concernDetailText,
  describeSwitchOptions,
  estimateFacts,
  groupFacts,
  loopView,
  subagentCount,
  toolDetailText,
  turnOriginLabel,
} from './summary'

// 架空データのみ。
const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 't1',
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

const review = (turns: TurnRecord[], baseline: number | null, current: number | null): ReviewState => ({
  turns,
  sessionCostUsd: { baseline, current },
})

test('指摘の 1 行分は、種類の説明・件数・母数つきの金額を並べる', () => {
  // Arrange
  const concern: Concern = { kind: 'overspec', count: 3, examples: [], amountUsd: 0.75, outOf: 3 }

  // Act
  const text = concernDetailText(concern)

  // Assert
  expect(text).toBe('軽作業に重いモデル / effort · 3 / 3 件 · Sonnet 換算 $0.7500')
})

test('金額の語がない指摘の種類は、金額があっても金額を付けない', () => {
  // Arrange
  const concern: Concern = { kind: 'underspec', count: 2, examples: [], amountUsd: 1 }

  // Act
  const text = concernDetailText(concern)

  // Assert
  expect(text).not.toContain('$')
  expect(text.endsWith('· 2 件')).toBe(true)
})

test('effort のないグループは effort を「-」にし、分母が 0 ならヒット率を出さない', () => {
  // Arrange
  const group: ModelGroup = {
    model: 'claude-sonnet-5-5',
    effort: null,
    turns: 1,
    unpricedTurns: 1,
    tokens: { input: 0, output: 1_234, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
  }

  // Act
  const facts = groupFacts(group)

  // Assert: プロンプトのトークンが 0 なので分母がなく、ヒット率は出ない。
  expect(facts).toEqual({ effort: '-', hit: null, input: '0', output: '1,234', cacheRead: '0', cacheWrite: '0', costText: '単価不明' })
})

test('推定は全ターン単価不明かどうかと、単価不明の件数を返す', () => {
  // Arrange
  const partly = [turn({ model: 'mystery', costUsd: null }), turn({ turnId: 't2' })]

  // Act
  const facts = estimateFacts(partly)

  // Assert
  expect(facts.allUnpriced).toBe(false)
  expect(facts.unpricedTurns).toBe(1)
  expect(estimateFacts([turn({ costUsd: null })]).allUnpriced).toBe(true)
})

test('実コストは基準点と現在値の両方があるときだけ、読み込み後の差として返す', () => {
  // Act / Assert
  expect(actualCostUsd(review([], null, 5))).toBeNull()
  expect(actualCostUsd(review([], 10, 14))).toBe(4)
})

test('advisor の呼び出しがなければ文面を出さない', () => {
  // Act / Assert
  expect(advisorCallText([turn({})])).toBeNull()
  expect(advisorCallText([turn({ advisorCalls: 2 })])).toContain('2 回（費用が usage に載るかは未確認')
})

test('ループ別は、メインとサブエージェントの両方があるときだけ返す', () => {
  // Act / Assert
  expect(loopView([turn({})])).toBeNull()
  expect(loopView([turn({}), turn({ turnId: 's1', agentId: 'a1' })])?.rows.map(row => row.label)).toEqual(['メイン', 'サブエージェント'])
})

test('サブエージェントのヒット率がメインより大きく低いときだけ、注記を返す', () => {
  // Arrange: メインは読込 900 / 1,000 = 90%、サブエージェントは 0%。
  const mainCached = turn({ tokens: { input: 100, output: 5, cacheRead: 900, cacheWrite: 0 } })
  const subUncached = turn({ turnId: 's1', agentId: 'a1', tokens: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 } })
  const subCached = turn({ turnId: 's2', agentId: 'a2', tokens: { input: 100, output: 5, cacheRead: 900, cacheWrite: 0 } })

  // Act
  const low = loopView([mainCached, subUncached])
  const healthy = loopView([mainCached, subCached])

  // Assert
  expect(low?.subagentNote).toContain('サブエージェントは親のキャッシュを読まず')
  expect(healthy?.subagentNote).toBeNull()
})

test('切替の見積りは、基準にできるターンがなければ空配列', () => {
  // Act / Assert
  expect(describeSwitchOptions([turn({})])).toEqual([])
  expect(describeSwitchOptions([turn({ firstStepCacheWrite: 100_000, firstStepPromptTokens: 600_000 })]).length).toBeGreaterThan(0)
})

test('ターンの起点・ツールと所要時間・サブエージェント数の表記', () => {
  // Arrange
  const main = turn({})
  const sub = turn({ turnId: 's1', agentId: 'a1', toolCount: 3, durationMs: 125_000 })

  // Act / Assert
  expect(turnOriginLabel(main)).toBe('メイン')
  expect(turnOriginLabel(sub)).toBe('サブエージェント')
  expect(toolDetailText(sub)).toBe('ツール 3 回 · 2 分 5 秒')
  expect(subagentCount([main, sub])).toBe(1)
})
