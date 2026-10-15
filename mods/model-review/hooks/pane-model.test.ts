import { expect, test } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import { BAR_WIDTH, buildPaneRows, type PaneRow } from './pane-model'

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

const rowsOf = (turns: TurnRecord[], cost?: ReviewState['sessionCostUsd']): PaneRow[] => buildPaneRows(review(turns, cost))
const noteTexts = (rows: PaneRow[]): string[] => rows.flatMap(row => (row.kind === 'note' ? [row.text] : []))

test('グループ行のトークン表示の先頭にキャッシュヒット率を出す', () => {
  // Arrange: 読込 800 ÷（入力 100 + 読込 800 + 書込 100）= 80%。
  const rows = rowsOf([turn({ tokens: { input: 100, output: 5, cacheRead: 800, cacheWrite: 100 } })])

  // Act
  const group = rows.find(row => row.kind === 'group')

  // Assert
  expect(group?.kind === 'group' ? group.tokenText : '').toMatch(/^ヒット 80% · 入力 100/)
})

test('高コストターンを、コスト降順で上位 3 件まで見出しつきで出す', () => {
  // Arrange
  const turns = [
    turn({ turnId: 'a', costUsd: 1 }),
    turn({ turnId: 'b', costUsd: 4 }),
    turn({ turnId: 'c', costUsd: 3 }),
    turn({ turnId: 'd', costUsd: 2 }),
  ]

  // Act
  const rows = rowsOf(turns)

  // Assert
  const top = rows.filter(row => row.kind === 'turn')
  expect(top.map(row => (row.kind === 'turn' ? row.costText : ''))).toEqual(['$4.0000', '$3.0000', '$2.0000'])
  expect(rows).toContainEqual({ kind: 'heading', text: '高コストターン' })
})

test('モデル切替があれば切替バッジに推定コストと件数を出し、注記を足す', () => {
  // Arrange
  const turns = [
    turn({ turnId: 't1', toolCount: 5 }),
    turn({ turnId: 't2', model: 'claude-opus-5-5', toolCount: 5, firstStepCacheWrite: 100_000 }),
  ]

  // Act
  const rows = rowsOf(turns)

  // Assert
  const badge = rows.find(row => row.kind === 'badge' && row.label === '切替')
  expect(badge?.kind === 'badge' ? badge.text : '').toContain('1 件')
  expect(badge?.kind === 'badge' ? badge.text : '').toContain('推定 $0.4800')
  expect(noteTexts(rows).some(text => text.includes('切替の推定'))).toBe(true)
})

test('過剰のバッジには Haiku 換算の差額の上限を出す', () => {
  // Arrange
  const rows = rowsOf([turn({ model: 'claude-opus-5-5', effort: 'medium', toolCount: 0, costUsd: 0.5, haikuCostUsd: 0.02 })])

  // Act
  const badge = rows.find(row => row.kind === 'badge' && row.label === '過剰')

  // Assert
  expect(badge?.kind === 'badge' ? badge.text : '').toContain('最大 $0.4800')
})

test('書込が読込を上回るターンが 3 回続くと、キャッシュ再構築の注記を出す', () => {
  // Arrange
  const rebuilding = (turnId: string) => turn({ turnId, toolCount: 5, tokens: { input: 0, output: 10, cacheRead: 10, cacheWrite: 100 } })
  const rows = rowsOf([rebuilding('a'), rebuilding('b'), rebuilding('c')])

  // Act
  const notes = noteTexts(rows)

  // Assert
  expect(notes.some(text => text.includes('3 回連続'))).toBe(true)
})

test('実コストが推定を大きく上回り書込が多いとき、TTL 単価差の可能性を注記する', () => {
  // Arrange: 推定 $3、実 $4（+33%）、書込 100,000 tokens。
  const rows = rowsOf([turn({ toolCount: 5, costUsd: 3, tokens: { input: 0, output: 10, cacheRead: 0, cacheWrite: 100_000 } })], {
    baseline: 10,
    current: 14,
  })

  // Act
  const notes = noteTexts(rows)

  // Assert
  expect(notes.some(text => text.includes('1 時間 TTL'))).toBe(true)
})

test('単価不明のターンが 3 割以上なら、単価表が古い可能性を取得日つきで注記する', () => {
  // Arrange
  const rows = rowsOf([turn({ toolCount: 5, model: 'mystery', costUsd: null }), turn({ turnId: 't2', toolCount: 5 })])

  // Act
  const notes = noteTexts(rows)

  // Assert
  expect(notes.some(text => text.includes('単価表が古い可能性') && text.includes('2026-10-15'))).toBe(true)
})

test('advisor の呼び出しがあれば回数を出し、金額には含まれない旨を未確認と明記する', () => {
  // Arrange
  const rows = rowsOf([turn({ toolCount: 5, advisorCalls: 2 })])

  // Act
  const kv = rows.find(row => row.kind === 'kv' && row.label === 'advisor')

  // Assert
  expect(kv?.kind === 'kv' ? kv.value : '').toContain('2 回')
  expect(kv?.kind === 'kv' ? kv.value : '').toContain('未確認')
})

test('fast mode の割増が推定に含まれない旨を、常に注記する', () => {
  // Act
  const notes = noteTexts(rowsOf([turn({ toolCount: 5 })]))

  // Assert
  expect(notes.some(text => text.includes('fast mode'))).toBe(true)
})
