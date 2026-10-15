import { expect, test } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import { BAR_WIDTH, buildPaneRows } from './pane-model'

// 架空データのみ。
const turn = (overrides: Partial<TurnRecord>): TurnRecord => ({
  turnId: 't1',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  tokens: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 },
  costUsd: 3,
  toolCount: 1,
  editCount: 0,
  durationMs: 1_000,
  reason: 'answer',
  ...overrides,
})
const review = (turns: TurnRecord[], cost = { baseline: null, current: null } as ReviewState['sessionCostUsd']): ReviewState => ({
  turns,
  sessionCostUsd: cost,
})

test('記録がなければ案内の 1 行だけを返す', () => {
  // Act
  const rows = buildPaneRows(review([]))

  // Assert
  expect(rows).toHaveLength(1)
  expect(rows[0]?.kind).toBe('message')
})

test('先頭はターン数・サブエージェント数・推定コストのタイトル行', () => {
  // Arrange
  const turns = [turn({}), turn({ turnId: 't2', agentId: 'a1', model: 'claude-haiku-5-5', costUsd: 1 })]

  // Act
  const [title] = buildPaneRows(review(turns))

  // Assert
  expect(title).toEqual({ kind: 'title', turns: 2, subagents: 1, costText: '$4.0000' })
})

test('コスト比のバーは合計に対する割合で埋まる', () => {
  // Arrange
  const turns = [turn({ costUsd: 3 }), turn({ turnId: 't2', model: 'claude-haiku-5-5', effort: 'low', costUsd: 1 })]

  // Act
  const groups = buildPaneRows(review(turns)).filter(row => row.kind === 'group')

  // Assert
  const filledByTier = Object.fromEntries(groups.map(row => (row.kind === 'group' ? [row.tier, row.filled] : [])))
  expect(filledByTier).toEqual({ sonnet: Math.round((3 / 4) * BAR_WIDTH), haiku: Math.round((1 / 4) * BAR_WIDTH) })
})

test('単価不明のグループはバーが空で、コストは「単価不明」', () => {
  // Act
  const groups = buildPaneRows(review([turn({ model: 'mystery', costUsd: null })])).filter(row => row.kind === 'group')

  // Assert
  expect(groups[0]).toMatchObject({ tier: 'other', filled: 0, costText: '単価不明' })
})

test('実コストと推定の差を符号付きで出す', () => {
  // Act
  const rows = buildPaneRows(review([turn({ costUsd: 3 })], { baseline: 10, current: 14 }))

  // Assert
  expect(rows).toContainEqual({
    kind: 'kv',
    label: 'コスト',
    value: '推定 $3.0000 / 実 $4.0000（読み込み後）/ 差 +$1.0000',
    tone: 'plain',
  })
})

test('グループごとにコスト割合を出し、1% 未満はバーを埋めない', () => {
  // Arrange
  const turns = [turn({ costUsd: 99.9 }), turn({ turnId: 't2', model: 'claude-haiku-5-5', effort: 'low', costUsd: 0.1 })]

  // Act
  const groups = buildPaneRows(review(turns)).filter(row => row.kind === 'group')

  // Assert
  const byTier = Object.fromEntries(groups.map(row => (row.kind === 'group' ? [row.tier, row] : [])))
  expect(byTier.sonnet).toMatchObject({ percentText: '100%' })
  expect(byTier.haiku).toMatchObject({ percentText: '<1%', filled: 0 })
})

test('妥当性セクションは内訳より上にあり、見出しに指摘件数が出る', () => {
  // Act
  const rows = buildPaneRows(review([turn({ model: 'claude-opus-5-5', effort: 'max' })]))

  // Assert
  const headings = rows.flatMap(row => (row.kind === 'heading' ? [row.text] : []))
  expect(headings[0]).toMatch(/^妥当性（参考）· 指摘 \d+ 件$/)
  expect(headings[1]).toContain('モデル × effort')
})

test('指摘がなければ OK 行、軽作業に重い設定ならバッジを出す', () => {
  // Arrange
  const heavyForLight = turn({ model: 'claude-opus-5-5', effort: 'max' })

  // Act
  const clean = buildPaneRows(review([turn({ toolCount: 5 })]))
  const flagged = buildPaneRows(review([heavyForLight]))

  // Assert
  expect(clean).toContainEqual({ kind: 'ok', text: '指摘なし' })
  expect(flagged.some(row => row.kind === 'badge' && row.label === '過剰')).toBe(true)
})
