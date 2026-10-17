import { expect, test } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import { MAIN_DELEGATION_MIN_TOOL_CALLS } from './analyze'
import { ALERT_LABEL } from './conclusion'
import { cellWidth, formatUsdRange } from './format'
import { BAR_WIDTH, MIN_BAR_WIDTH, barWidthFor, buildPaneRows, type PaneRow } from './pane-model'
import { beginTurn, recordStep, recordTool } from './recorder'

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

test('記録がなければ、先頭に結論「まだ記録がありません」と案内の 1 行を返す', () => {
  // Act
  const rows = buildPaneRows(review([]))

  // Assert
  expect(rows.map(row => row.kind)).toEqual(['conclusion', 'message'])
  expect(rows[0]).toEqual({ kind: 'conclusion', text: '結論: まだ記録がありません', tone: 'plain' })
})

test('先頭はターン数・サブエージェント数・推定コストのタイトル行', () => {
  // Arrange
  const turns = [turn({}), turn({ turnId: 't2', agentId: 'a1', model: 'claude-haiku-5-5', costUsd: 1 })]

  // Act
  const title = buildPaneRows(review(turns)).find(row => row.kind === 'title')

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

type GroupRow = Extract<PaneRow, { kind: 'group' }>
const groupsAt = (columns: number | undefined): GroupRow[] =>
  buildPaneRows(
    review([turn({ costUsd: 3 }), turn({ turnId: 't2', model: 'claude-haiku-5-5', effort: 'low', costUsd: 1 })]),
    {},
    undefined,
    columns,
  ).filter((row): row is GroupRow => row.kind === 'group')

/** pane.tsx のバー行の幅: 字下げ 2 + 金額 + 2 + バー + 2 + 割合。 */
const barRowCells = (row: GroupRow): number =>
  2 + cellWidth(row.costText) + (row.barWidth === 0 ? 0 : 2 + row.barWidth) + 2 + row.percentText.length

for (const columns of [110, 80, 60]) {
  test(`${columns} 桁のペインでも、バー行は金額を削らず桁数に収まる`, () => {
    // Act
    const groups = groupsAt(columns)

    // Assert
    expect(groups).toHaveLength(2)
    for (const row of groups) {
      expect(barRowCells(row)).toBeLessThanOrEqual(columns)
      expect(row.filled).toBeLessThanOrEqual(row.barWidth)
      expect(row.costText).toMatch(/^\$/)
    }
  })
}

test('バー幅は桁数に応じて縮み、広ければ最大幅、狭すぎても最小幅を残す', () => {
  // Assert
  expect(barWidthFor(undefined, '$3.0000')).toBe(BAR_WIDTH)
  expect(barWidthFor(110, '$3.0000')).toBe(BAR_WIDTH)
  expect(barWidthFor(80, '$3.0000')).toBe(BAR_WIDTH)
  expect(barWidthFor(60, '$3.0000')).toBeLessThan(BAR_WIDTH)
  expect(barWidthFor(60, '$3.0000')).toBeGreaterThan(MIN_BAR_WIDTH)
  // 収まらないときはバーを出さない（0）。最小幅を無理に残して行を溢れさせない。
  expect(barWidthFor(20, '$3.0000')).toBe(0)
  expect(barWidthFor(24, '$3.0000')).toBe(MIN_BAR_WIDTH)
  // 実際の範囲表記（全角の〜）や「単価不明」は、桁数で数えるのでバーがさらに縮む。
  const range = formatUsdRange(10, 12)
  expect(cellWidth(range)).toBe(range.length + 1)
  expect(barWidthFor(32, range)).toBeLessThan(barWidthFor(32, '$3.0000'))
  expect(cellWidth('単価不明')).toBe(8)
})

test('幅が極端に狭い、または金額が全角（単価不明・範囲）でも、バー行は桁数に収まる', () => {
  // Arrange: 単価不明（全角 4 文字 = 8 桁）のグループと、範囲表記のグループ。
  const unpriced = turn({ costUsd: null, costUpperUsd: null, model: 'gateway-model' })
  const ranged = turn({ turnId: 't2', costUsd: 10, costUpperUsd: 12 })

  for (const columns of [60, 36, 24, 18]) {
    // Act
    const groups = buildPaneRows(review([unpriced, ranged]), {}, undefined, columns).filter((row): row is GroupRow => row.kind === 'group')

    // Assert
    expect(groups.length).toBeGreaterThan(0)
    // バーを出す行は必ず収まる。出さない行（barWidth 0）は金額と割合だけで、それ以上は縮められない。
    for (const row of groups) if (row.barWidth > 0) expect(barRowCells(row)).toBeLessThanOrEqual(columns)
  }
})

test('バー幅が変わっても、埋まるセルの割合は同じ（75% / 25%）', () => {
  // Act
  const narrow = groupsAt(40)
  const wide = groupsAt(120)

  // Assert
  for (const rows of [narrow, wide]) {
    const sonnet = rows.find(row => row.tier === 'sonnet')
    expect(sonnet?.filled).toBe(Math.round(0.75 * (sonnet?.barWidth ?? 0)))
  }
  expect(narrow[0]?.barWidth).toBeLessThan(wide[0]?.barWidth ?? 0)
  expect(groupsAt(60)[0]?.barWidth).toBeLessThan(groupsAt(80)[0]?.barWidth ?? 0)
})

test('色以外でも状態が分かる: 結論は記号（▲ / ✓）と文言、注意は「注意」の文言、割合は数字で出る', () => {
  // Act
  const rows = groupsAt(60)
  const [conclusion] = buildPaneRows(review([turn({ toolCount: 5 })]), {}, undefined, 60)

  // Assert
  expect(conclusion).toMatchObject({ kind: 'conclusion' })
  expect(conclusion?.kind === 'conclusion' ? conclusion.text : '').toMatch(/^✓ 結論:/)
  expect(Object.fromEntries(rows.map(row => [row.tier, row.percentText]))).toEqual({ sonnet: '75%', haiku: '25%' })
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

test('妥当性セクションは内訳より上にあり、見出しは件数を出さず「見直し候補の内訳」と書く', () => {
  // Act
  const heavy = (turnId: string) => turn({ turnId, model: 'claude-opus-5-5', effort: 'max' })
  const rows = buildPaneRows(review([heavy('a'), heavy('b'), heavy('c')]))

  // Assert
  const headings = rows.flatMap(row => (row.kind === 'heading' ? [row.text] : []))
  expect(headings[0]).toBe('妥当性（参考）· 見直し候補の内訳')
  expect(headings[1]).toContain('モデル × effort')
})

test('指摘がなければ OK 行、軽作業に重い設定ならバッジを出す', () => {
  // Arrange
  const heavyForLight = (turnId: string) => turn({ turnId, model: 'claude-opus-5-5', effort: 'max' })

  // Act
  const clean = buildPaneRows(review([turn({ toolCount: 5 })]))
  const flagged = buildPaneRows(review([heavyForLight('a'), heavyForLight('b'), heavyForLight('c')]))

  // Assert
  expect(clean).toContainEqual({ kind: 'ok', text: '指摘なし' })
  expect(flagged.some(row => row.kind === 'badge' && row.label === '過剰')).toBe(true)
})

const rowsOf = (turns: TurnRecord[], cost?: ReviewState['sessionCostUsd']): PaneRow[] => buildPaneRows(review(turns, cost))
const noteTexts = (rows: PaneRow[]): string[] =>
  rows.flatMap(row => (row.kind === 'note' || (row.kind === 'badge' && row.label === ALERT_LABEL) ? [row.text] : []))

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

test('過剰のバッジには Sonnet 換算の差額を出す', () => {
  // Arrange
  const light = (turnId: string) =>
    turn({ turnId, model: 'claude-opus-5-5', effort: 'medium', toolCount: 0, costUsd: 0.5, haikuCostUsd: 0.02, sonnetCostUsd: 0.25 })
  const rows = rowsOf([light('a'), light('b'), light('c')])

  // Act
  const badge = rows.find(row => row.kind === 'badge' && row.label === '過剰')

  // Assert
  expect(badge?.kind === 'badge' ? badge.text : '').toContain('Sonnet 換算 $0.7500')
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

test('実コストが 1 時間単価の上限内なら、TTL 単価差の注記は出さず、推定は幅で表示する', () => {
  // Arrange: 下限 $3、上限 $4.2。実 $4（上限内）、書込 100,000 tokens。
  const rows = rowsOf([turn({ toolCount: 5, costUsd: 3, costUpperUsd: 4.2, tokens: { input: 0, output: 10, cacheRead: 0, cacheWrite: 100_000 } })], {
    baseline: 10,
    current: 14,
  })

  // Act
  const notes = noteTexts(rows)
  const cost = rows.find(row => row.kind === 'kv' && row.label === 'コスト')

  // Assert
  expect(notes.some(text => text.includes('1 時間単価にした上限'))).toBe(false)
  expect(cost).toMatchObject({ value: expect.stringContaining('$3.0000〜$4.2000') })
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
  expect(notes.some(text => text.includes('1 時間単価にした上限'))).toBe(true)
})

test('単価不明のターンが 3 割以上なら、単価表が古い可能性を取得日つきで注記する', () => {
  // Arrange
  const rows = rowsOf([turn({ toolCount: 5, model: 'mystery', costUsd: null }), turn({ turnId: 't2', toolCount: 5 })])

  // Act
  const notes = noteTexts(rows)

  // Assert
  expect(notes.some(text => text.includes('単価表が古い可能性') && text.includes('2026-10-15'))).toBe(true)
})

test('advisor の呼び出しがあれば回数を出し、金額には含まれない旨を明記する', () => {
  // Arrange
  const rows = rowsOf([turn({ toolCount: 5, advisorCalls: 2 })])

  // Act
  const kv = rows.find(row => row.kind === 'kv' && row.label === 'advisor')

  // Assert
  expect(kv?.kind === 'kv' ? kv.value : '').toContain('2 回')
  expect(kv?.kind === 'kv' ? kv.value : '').toContain('含まれません')
})

test('fast mode の割増が推定に含まれない旨を、常に注記する', () => {
  // Act
  const notes = noteTexts(rowsOf([turn({ toolCount: 5 })]))

  // Assert
  expect(notes.some(text => text.includes('fast mode'))).toBe(true)
})

test('実行中のターンがあれば、完了前でも「実行中」の行にツール数と推定コストを出す', () => {
  // Arrange: 完了済みのターンはない。Sonnet 5.5 の 1 応答（入力 100 万 tokens = $2）とツール 2 回。
  const usage = { model: 'claude-sonnet-5-5', input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  let drafts = beginTurn({}, { turnId: 'live-1' })
  drafts = recordStep(drafts, { turnId: 'live-1', model: 'claude-sonnet-5-5', effort: 'high', usage })
  drafts = recordTool(drafts, { tool: 'Read' })
  drafts = recordTool(drafts, { tool: 'Edit' })

  // Act
  const rows = buildPaneRows(review([]), drafts)

  // Assert
  const live = rows.find(row => row.kind === 'kv' && row.label === '実行中')
  expect(live?.kind === 'kv' ? live.value : '').toContain('ツール 2 回')
  expect(live?.kind === 'kv' ? live.value : '').toContain('$2.0000')
  expect(rows.some(row => row.kind === 'message')).toBe(false)
})

test('実行中のターンがなく記録もなければ、結論と案内の 1 行だけを返す', () => {
  // Act
  const rows = buildPaneRows(review([]), beginTurn({}, { turnId: 'idle' }))

  // Assert
  expect(rows.map(row => row.kind)).toEqual(['conclusion', 'message'])
})

test('単価不明の割合がちょうど 3 割なら単価表の注記を出し、それ未満なら出さない', () => {
  // Arrange: 10 ターン中 3 件 / 2 件が単価不明。
  const turns = (unpriced: number) =>
    Array.from({ length: 10 }, (_, index) =>
      turn({ turnId: `t${index}`, toolCount: 5, ...(index < unpriced ? { model: 'mystery', costUsd: null } : {}) }),
    )

  // Act
  const atLimit = noteTexts(rowsOf(turns(3)))
  const below = noteTexts(rowsOf(turns(2)))

  // Assert
  expect(atLimit.some(text => text.includes('単価表が古い可能性'))).toBe(true)
  expect(below.some(text => text.includes('単価表が古い可能性'))).toBe(false)
})

test('切替の見積りは、基準にできるターンがあるときだけ見出しつきで出す', () => {
  // Arrange
  const withBase = rowsOf([turn({ firstStepCacheWrite: 100_000, firstStepPromptTokens: 600_000 })])
  const withoutBase = rowsOf([turn({})])

  // Act
  const headings = (rows: PaneRow[]) => rows.filter(row => row.kind === 'heading').map(row => (row as { text: string }).text)

  // Assert
  expect(headings(withBase)).toContain('いま切り替えたら（目安）')
  expect(headings(withoutBase)).not.toContain('いま切り替えたら（目安）')
})

test('ループ別の集計は、メインとサブエージェントの両方があるときだけ見出しつきで出す', () => {
  // Arrange
  const both = rowsOf([turn({}), turn({ turnId: 's1', agentId: 'a1' })])
  const mainOnly = rowsOf([turn({})])
  const headings = (rows: PaneRow[]) => rows.filter(row => row.kind === 'heading').map(row => (row as { text: string }).text)

  // Assert
  expect(headings(both)).toContain('ループ別（キャッシュ効率）')
  expect(headings(mainOnly)).not.toContain('ループ別（キャッシュ効率）')
})

test('タイトルの推定は、上限のあるターンがあれば幅で表示する', () => {
  // Arrange: 下限 $3、上限 $4.2。
  const title = buildPaneRows(review([turn({ costUsd: 3, costUpperUsd: 4.2 })])).find(row => row.kind === 'title')

  // Assert
  expect(title).toMatchObject({ kind: 'title', costText: '$3.0000〜$4.2000' })
})

test('状況に応じた警告は「注意」バッジにし、常に出す免責は dim の注記のまま残す', () => {
  // Arrange: 切替（モデル変更）で警告が出る記録。
  const rows = rowsOf([
    turn({ turnId: 't1' }),
    turn({ turnId: 't2', model: 'claude-opus-5-5', firstStepCacheWrite: 100_000, firstStepPromptTokens: 200_000 }),
  ])

  // Act
  const alerts = rows.filter(row => row.kind === 'badge' && row.label === ALERT_LABEL)
  const notes = rows.filter(row => row.kind === 'note')

  // Assert
  expect(alerts.length).toBeGreaterThan(0)
  expect(notes.some(row => row.kind === 'note' && row.text.includes('推定に含まれないもの'))).toBe(true)
  expect(notes.some(row => row.kind === 'note' && row.text.includes('切替の推定'))).toBe(false)
})

test('グループ行はトークンとキャッシュを別の行に分ける', () => {
  // Arrange
  const rows = rowsOf([turn({ tokens: { input: 100, output: 5, cacheRead: 800, cacheWrite: 100 } })])

  // Act
  const group = rows.find(row => row.kind === 'group')

  // Assert
  expect(group?.kind === 'group' ? group.cacheText : '').toBe('キャッシュ 読 800 / 書 100')
  expect(group?.kind === 'group' ? group.tokenText : '').not.toContain('キャッシュ')
})

// 過剰（軽作業に Opus）の指摘を 1 件ずつ作るターン。Sonnet 換算の差額は 0.25 ドル。
const lightOpus = (turnId: string): TurnRecord =>
  turn({ turnId, model: 'claude-opus-5-5', effort: 'medium', toolCount: 0, costUsd: 0.5, haikuCostUsd: 0.02, sonnetCostUsd: 0.25 })
const glossaryRows = (rows: PaneRow[]): string[] => noteTexts(rows).filter(text => text.startsWith('用語'))

test('先頭の結論は、見直し候補の件数を種類別に出し、指摘ありの印「▲」を付ける', () => {
  // Act
  const [conclusion] = rowsOf([lightOpus('a'), lightOpus('b'), lightOpus('c')])

  // Assert
  expect(conclusion).toEqual({ kind: 'conclusion', text: '▲ 結論: 見直し候補 3 件（過剰 3）', tone: 'warning' })
})

test('指摘がなければ先頭の結論は「✓」と「目立った指摘なし」', () => {
  // Act
  const [conclusion] = rowsOf([turn({ toolCount: 5 })])

  // Assert
  expect(conclusion).toEqual({ kind: 'conclusion', text: '✓ 結論: 目立った指摘なし', tone: 'success' })
})

test('結論の色は見直し候補の最も重い種類に合わせる: 不足があれば error', () => {
  // Arrange: 不足 2 件（Haiku の低 effort で重いツール）と過剰 3 件を同時に出す。
  const heavyHaiku = (turnId: string) => turn({ turnId, model: 'claude-haiku-5-5', effort: 'low', toolCount: 12 })
  const [conclusion] = rowsOf([heavyHaiku('h1'), heavyHaiku('h2'), lightOpus('a'), lightOpus('b'), lightOpus('c')])

  // Assert
  expect(conclusion).toMatchObject({ kind: 'conclusion', tone: 'error' })
  expect(conclusion?.kind === 'conclusion' ? conclusion.text : '').toMatch(/^▲ 結論: 見直し候補 \d+ 件/)
})

test('結論の色は委譲だけなら suggestion にする', () => {
  // Arrange: 主系統のツールが閾値に達し、サブエージェントを使っていない Sonnet の 1 ターン。
  const [conclusion] = rowsOf([turn({ toolCount: MAIN_DELEGATION_MIN_TOOL_CALLS })])

  // Assert
  expect(conclusion).toMatchObject({ kind: 'conclusion', tone: 'suggestion' })
  expect(conclusion?.kind === 'conclusion' ? conclusion.text : '').toContain('委譲')
})

test('注意（状況に応じた警告）が 1 件以上あれば、結論行に「注意 N 件」を足す', () => {
  // Arrange: 切替（モデル変更）で警告が出る記録。
  const switched = [
    turn({ turnId: 't1' }),
    turn({ turnId: 't2', model: 'claude-opus-5-5', firstStepCacheWrite: 100_000, firstStepPromptTokens: 200_000 }),
  ]
  const rows = rowsOf(switched)
  const alertCount = rows.filter(row => row.kind === 'badge' && row.label === ALERT_LABEL).length

  // Act
  const [conclusion] = rows

  // Assert
  expect(alertCount).toBeGreaterThan(0)
  expect(conclusion?.kind === 'conclusion' ? conclusion.text : '').toContain(`注意 ${alertCount} 件`)
})

test('注意がなければ、結論行に「注意」は出さない', () => {
  // Act
  const [conclusion] = rowsOf([turn({ toolCount: 5 })])

  // Assert
  expect(conclusion?.kind === 'conclusion' ? conclusion.text : '').not.toContain(ALERT_LABEL)
})

test('実コストが取れないときは「取得できませんでした（/model-review で再取得）」と出す', () => {
  // Act
  const rows = rowsOf([turn({})])

  // Assert
  expect(rows).toContainEqual({
    kind: 'kv',
    label: 'コスト',
    value: '推定 $3.0000 / 実コスト 取得できませんでした（/model-review で再取得）',
    tone: 'plain',
  })
})

test('ペインの末尾に、dim の「/model-review で更新」の 1 行を出す', () => {
  // Act
  const rows = rowsOf([turn({})])

  // Assert
  expect(rows.at(-1)).toEqual({ kind: 'note', text: '/model-review で更新' })
})

test('用語行は、画面に出ている行の用語だけを末尾にまとめる', () => {
  // Arrange: 実コストあり（読み込み後・差）、過剰あり（Sonnet 換算）、プロンプトありでヒット率も出る。
  const rows = rowsOf([lightOpus('a'), lightOpus('b'), lightOpus('c')], { baseline: 10, current: 14 })

  // Act
  const glossary = glossaryRows(rows)

  // Assert
  expect(glossary).toHaveLength(1)
  expect(glossary[0]).toContain('ヒット率: ')
  expect(glossary[0]).toContain('読み込み後: ')
  expect(glossary[0]).toContain('Sonnet 換算: ')
  expect(glossary[0]).toContain('差（実コスト − 推定）: + は推定より実額が大きい')
})

test('用語行は、実コストも過剰もなければヒット率だけを説明する', () => {
  // Act
  const [glossary] = glossaryRows(rowsOf([turn({})]))

  // Assert
  expect(glossary).toContain('ヒット率: ')
  expect(glossary).not.toContain('読み込み後')
  expect(glossary).not.toContain('差（実コスト')
  expect(glossary).not.toContain('Sonnet 換算')
})

test('該当する行がなければ用語行を出さない', () => {
  // Arrange: プロンプトのトークンが 0 なのでヒット率は出ず、実コストも過剰もない。
  const rows = rowsOf([turn({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })])

  // Act
  const glossary = glossaryRows(rows)

  // Assert
  expect(glossary).toEqual([])
})

test('用語の説明は 1 つ 40 字以内に収める', () => {
  // Arrange: 用語が 4 つとも出る組み合わせ。
  const [glossary] = glossaryRows(rowsOf([lightOpus('a'), lightOpus('b'), lightOpus('c')], { baseline: 10, current: 14 }))

  // Act
  const items = (glossary ?? '').replace(/^用語\s+/, '').split(' / ')

  // Assert
  expect(items).toHaveLength(4)
  expect(Math.max(...items.map(item => Array.from(item).length))).toBeLessThanOrEqual(40)
})
