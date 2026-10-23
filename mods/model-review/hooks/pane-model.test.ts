import { expect, test } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import { MAIN_DELEGATION_MIN_TOOL_CALLS } from './analyze'
import { ALERT_LABEL } from './conclusion'
import { cellWidth, formatUsdRange } from './format'
import { FINDING_LABEL, HEADING, NO_CONCERNS_TEXT, TERM_TEXT } from './labels'
import { ALWAYS_NOTE } from './notes'
import { BAR_WIDTH, MIN_BAR_WIDTH, barWidthFor, buildPaneRows, type PaneRow } from './pane-model'
import { beginTurn, recordStep, recordTool } from './recorder'
import type { RateView } from './pace'
import { costDiff, estimateFacts, moneyLineFrom } from './summary'

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

test('先頭はターン数・サブエージェント数のタイトル行（推定の金額はタイトルに出さず、直下の金額行に任せる）', () => {
  // Arrange
  const turns = [turn({}), turn({ turnId: 't2', agentId: 'a1', model: 'claude-haiku-5-5', costUsd: 1 })]

  // Act
  const title = buildPaneRows(review(turns)).find(row => row.kind === 'title')

  // Assert
  expect(title).toEqual({ kind: 'title', turns: 2, subagents: 1 })
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
  expect(conclusion?.kind === 'conclusion' ? conclusion.text : '').toMatch(/^✓ 問題なし · 結論:/)
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
    label: '金額',
    value: '推定 $3.0000 · 実 $4.0000（読み込み後）· 差 +$1.0000（実が大きい）',
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

test('所見セクションは内訳より上にあり、見出しは「所見」と書く', () => {
  // Act
  const heavy = (turnId: string) => turn({ turnId, model: 'claude-opus-5-5', effort: 'max' })
  const rows = buildPaneRows(review([heavy('a'), heavy('b'), heavy('c')]))

  // Assert
  const headings = rows.flatMap(row => (row.kind === 'heading' ? [row.text] : []))
  expect(headings[0]).toBe(HEADING.concerns)
  expect(headings[0]).toBe('所見')
  expect(headings[1]).toContain('モデル × effort')
})

test('結論が指摘なしを言うとき、ペインは OK 行も妥当性の見出しも出さない（軽作業に重い設定ならバッジは出す）', () => {
  // Arrange
  const heavyForLight = (turnId: string) => turn({ turnId, model: 'claude-opus-5-5', effort: 'max' })

  // Act
  const clean = buildPaneRows(review([turn({ toolCount: 5 })]))
  const flagged = buildPaneRows(review([heavyForLight('a'), heavyForLight('b'), heavyForLight('c')]))

  // Assert
  expect(clean[0]).toMatchObject({ kind: 'conclusion', text: '✓ 問題なし · 結論: 目立った指摘なし' })
  expect(clean.some(row => row.kind === 'ok')).toBe(false)
  expect(clean.some(row => row.kind === 'heading' && row.text.startsWith(HEADING.concerns))).toBe(false)
  expect(flagged.some(row => row.kind === 'badge' && row.label === '過剰')).toBe(true)
})

test('結論が要確認（注意で ▲）のときは、指摘がなくても OK 行と見出しを出す', () => {
  // Arrange: キャッシュ書込が読込を上回るターンが 5 回連続する（状態を上げる注意）。
  const rebuild = (turnId: string) => turn({ turnId, tokens: { input: 100, output: 300, cacheRead: 100, cacheWrite: 40_000 }, durationMs: 800, toolCount: 5, editCount: 2 })
  const rows = buildPaneRows(review(['r0', 'r1', 'r2', 'r3', 'r4'].map(rebuild)))

  // Assert
  expect(rows[0]).toMatchObject({ kind: 'conclusion', tone: 'warning' })
  expect(rows).toContainEqual({ kind: 'ok', text: NO_CONCERNS_TEXT })
  expect(rows.some(row => row.kind === 'heading' && row.text.startsWith(HEADING.concerns))).toBe(true)
})

test('全件単価不明のときは、判定不能の結論に加えて OK 行を出す', () => {
  // Arrange
  const unpriced = (turnId: string) => turn({ turnId, costUsd: null, costUpperUsd: null })

  // Act
  const rows = buildPaneRows(review(['u0', 'u1', 'u2'].map(unpriced)))

  // Assert
  expect(rows[0]).toMatchObject({ kind: 'conclusion', tone: 'plain' })
  expect(rows).toContainEqual({ kind: 'ok', text: NO_CONCERNS_TEXT })
})

const rowsOf = (turns: TurnRecord[], cost?: ReviewState['sessionCostUsd']): PaneRow[] => buildPaneRows(review(turns, cost))
/** 所見の中の警告（再構築・TTL 乖離）のバッジの名前。 */
const FINDING_LABELS: readonly string[] = Object.values(FINDING_LABEL)
const noteTexts = (rows: PaneRow[]): string[] =>
  rows.flatMap(row => (row.kind === 'note' || (row.kind === 'badge' && FINDING_LABELS.includes(row.label)) ? [row.text] : []))

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
  const cost = rows.find(row => row.kind === 'kv' && row.label === '金額')

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
  expect(notes.some(text => text.includes('単価表が古い可能性') && text.includes('2026-10-19'))).toBe(true)
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

test('advisor がないときは、末尾の注記に fast mode と advisor の費用の免責を出す', () => {
  // Act
  const notes = noteTexts(rowsOf([turn({ toolCount: 5 })]))

  // Assert
  expect(notes).toContain(ALWAYS_NOTE)
})

test('advisor の行があるときは、末尾の注記から advisor の句を外す（金額の免責は advisor 行に出ている）', () => {
  // Act
  const notes = noteTexts(rowsOf([turn({ toolCount: 5, advisorCalls: 2 })]))

  // Assert
  expect(notes).toContain('含まない: fast mode の割増・トークン以外の料金（Web 検索など）・Bedrock / Vertex 価格と地域割増。推定は書込の TTL 不明のため 5 分単価（下限）〜1 時間単価（上限）の幅')
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

test('推定は、上限のあるターンがあれば幅でコスト行に表示する', () => {
  // Arrange: 下限 $3、上限 $4.2。
  const cost = buildPaneRows(review([turn({ costUsd: 3, costUpperUsd: 4.2 })])).find(row => row.kind === 'kv' && row.label === '金額')

  // Assert
  expect(cost?.kind === 'kv' ? cost.value : '').toContain('$3.0000〜$4.2000')
})

test('再構築の警告は所見の中の「再構築」バッジにし、常に出す免責は注記のまま残す', () => {
  // Arrange: キャッシュ書込が読込を上回るターンが 5 回連続する。
  const rows = rowsOf(rebuildingRun())

  // Act
  const findingBadges = rows.filter(row => row.kind === 'badge' && row.label === FINDING_LABEL.rebuild)
  const notes = rows.filter(row => row.kind === 'note')

  // Assert
  expect(findingBadges).toHaveLength(1)
  expect(findingBadges[0]).toMatchObject({ kind: 'badge', tone: 'warning' })
  expect(notes.some(row => row.kind === 'note' && row.text.includes('含まない:'))).toBe(true)
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
  expect(conclusion).toEqual({ kind: 'conclusion', text: '▲ 要確認 · 結論: 見直し候補 3 件（過剰 3）', tone: 'warning' })
})

test('指摘がなければ先頭の結論は「✓」と「目立った指摘なし」', () => {
  // Act
  const [conclusion] = rowsOf([turn({ toolCount: 5 })])

  // Assert
  expect(conclusion).toEqual({ kind: 'conclusion', text: '✓ 問題なし · 結論: 目立った指摘なし', tone: 'success' })
})

test('結論の色は見直し候補の最も重い種類に合わせる: 不足があれば error', () => {
  // Arrange: 不足 2 件（Haiku の低 effort で重いツール）と過剰 3 件を同時に出す。
  const heavyHaiku = (turnId: string) => turn({ turnId, model: 'claude-haiku-5-5', effort: 'low', toolCount: 12 })
  const [conclusion] = rowsOf([heavyHaiku('h1'), heavyHaiku('h2'), lightOpus('a'), lightOpus('b'), lightOpus('c')])

  // Assert
  expect(conclusion).toMatchObject({ kind: 'conclusion', tone: 'error' })
  expect(conclusion?.kind === 'conclusion' ? conclusion.text : '').toMatch(/^✖ 要対応 · 結論: 見直し候補 \d+ 件/)
})

test('結論の色は委譲だけなら suggestion にする', () => {
  // Arrange: 主系統のツールが閾値に達し、サブエージェントを使っていない Sonnet の 1 ターン。
  const [conclusion] = rowsOf([turn({ toolCount: MAIN_DELEGATION_MIN_TOOL_CALLS })])

  // Assert
  expect(conclusion).toMatchObject({ kind: 'conclusion', tone: 'suggestion' })
  expect(conclusion?.kind === 'conclusion' ? conclusion.text : '').toContain('委譲')
})

test('注意（動的な警告）が 1 件以上あれば、結論行に「注意 N 件」を足す。件数は所見の警告と信頼度の切替注記を数える', () => {
  // Arrange: 切替（モデル変更）で警告が出る記録。切替はバッジではなく信頼度の注記になる。
  const rows = rowsOf([
    turn({ turnId: 't1' }),
    turn({ turnId: 't2', model: 'claude-opus-5-5', firstStepCacheWrite: 100_000, firstStepPromptTokens: 200_000 }),
  ])
  const warningCount =
    rows.filter(row => row.kind === 'badge' && FINDING_LABELS.includes(row.label)).length +
    rows.filter(row => row.kind === 'note' && row.text.startsWith('切替の推定')).length

  // Act
  const [conclusion] = rows

  // Assert
  expect(warningCount).toBeGreaterThan(0)
  expect(conclusion?.kind === 'conclusion' ? conclusion.text : '').toContain(`注意 ${warningCount} 件`)
})

test('注意がなければ、結論行に「注意」は出さない', () => {
  // Act
  const [conclusion] = rowsOf([turn({ toolCount: 5 })])

  // Assert
  expect(conclusion?.kind === 'conclusion' ? conclusion.text : '').not.toContain(ALERT_LABEL)
})

test('実コストが取れないときは、ペイン・テキストと同じ「取得できません（…/model-review で再取得）」を出す', () => {
  // Act
  const rows = rowsOf([turn({})])

  // Assert
  expect(rows).toContainEqual({
    kind: 'kv',
    label: '金額',
    value: '推定 $3.0000 · 実コスト 取得できません（取れない環境もあります。/model-review で再取得）',
    tone: 'plain',
  })
})

test('実コストがあるときは、判定基準の末尾に「。更新は /model-review」を付け、独立した行は出さない', () => {
  // Act
  const rows = rowsOf([turn({})], { baseline: 10, current: 14 })
  const last = rows.at(-1)

  // Assert
  expect(last?.kind === 'note' ? last.text : '').toMatch(/^軽作業 = .*。更新は \/model-review$/)
  expect(rows).not.toContainEqual({ kind: 'note', text: '/model-review で更新' })
})

test('実コストが取れないときは、判定基準に更新の案内を付けない（コスト行の再取得の案内に任せる）', () => {
  // Act
  const rows = rowsOf([turn({})])

  // Assert
  expect(rows.some(row => row.kind === 'note' && row.text.includes('更新は'))).toBe(false)
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
  expect(glossary[0]).toContain(TERM_TEXT.diff)
})

test('用語行は、実コストも過剰もなければヒット率だけを説明する', () => {
  // Act
  const [glossary] = glossaryRows(rowsOf([turn({})]))

  // Assert
  expect(glossary).toContain('ヒット率: ')
  expect(glossary).not.toContain('読み込み後')
  expect(glossary).not.toContain('差（実')
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

// ---- mr-012（段階 B）: 節の並び・金額行・所見と信頼度の振り分け ----

/** キャッシュ書込が読込を上回るターン（再構築の警告の材料）。 */
const rebuildingTurn = (turnId: string): TurnRecord =>
  turn({ turnId, tokens: { input: 100, output: 300, cacheRead: 100, cacheWrite: 40_000 }, durationMs: 800, toolCount: 5, editCount: 2 })
const rebuildingRun = (): TurnRecord[] => ['r0', 'r1', 'r2', 'r3', 'r4'].map(rebuildingTurn)

const indexOfRow = (rows: PaneRow[], predicate: (row: PaneRow) => boolean): number => rows.findIndex(predicate)
const headingAt = (rows: PaneRow[], text: string): number => indexOfRow(rows, row => row.kind === 'heading' && row.text === text)
const badgeAt = (rows: PaneRow[], label: string): number => indexOfRow(rows, row => row.kind === 'badge' && row.label === label)
const noteStartingAt = (rows: PaneRow[], prefix: string): number => indexOfRow(rows, row => row.kind === 'note' && row.text.startsWith(prefix))

test('金額行はタイトルの直下（rows[3]）に 1 つだけ出し、コスト節には出さない', () => {
  // Arrange: 読み込み後の実コストがあるセッション。
  const rows = rowsOf([turn({ toolCount: 5 })], { baseline: 10, current: 14 })

  // Assert
  expect(rows[2]).toEqual({ kind: 'title', turns: 1, subagents: 0 })
  expect(rows[3]).toMatchObject({ kind: 'kv', label: '金額' })
  expect(rows.filter(row => row.kind === 'kv' && row.label === '金額')).toHaveLength(1)
  expect(rows.some(row => row.kind === 'kv' && row.label === 'コスト')).toBe(false)
})

test('サブスク（使用率が取れる）の金額行は、テキストの金額行と同じ文面になる', () => {
  // Arrange
  const state = review([turn({})], { baseline: 10, current: 14 })
  const rate: RateView = { rows: [{ label: '5h', text: '72%' }], note: '使用率は枠の測定' }

  // Act
  const money = buildPaneRows(state, {}, undefined, undefined, undefined, rate).find(row => row.kind === 'kv' && row.label === '金額')
  const value = money?.kind === 'kv' ? money.value : ''

  // Assert
  expect(`金額: ${value}`).toBe(moneyLineFrom(estimateFacts(state.turns, state.archived), costDiff(state), true))
  expect(value).toContain('API 換算の推定')
  expect(value).toContain('実（API 換算） $4.0000（読み込み後）')
})

test('実コストが推定より小さいときは、差を「-$」の符号と「推定が大きい」の向きで出す', () => {
  // Arrange: 推定 $3、実 $1（基準 10 → 11）。
  const rows = rowsOf([turn({ costUsd: 3 })], { baseline: 10, current: 11 })

  // Assert
  expect(rows).toContainEqual({
    kind: 'kv',
    label: '金額',
    value: '推定 $3.0000 · 実 $1.0000（読み込み後）· 差 -$2.0000（推定が大きい）',
    tone: 'plain',
  })
})

test('再構築の警告は所見の中に置く: 直近の指摘の後、モデル × effort の節より前', () => {
  // Arrange: 軽作業の Opus 3 件（直近の過剰）のあとに、キャッシュ書込が続く 5 ターン。
  const rows = rowsOf([lightOpus('a'), lightOpus('b'), lightOpus('c'), ...rebuildingRun()])

  // Act
  const overspendAt = badgeAt(rows, '過剰')
  const rebuildAt = badgeAt(rows, FINDING_LABEL.rebuild)

  // Assert
  expect(headingAt(rows, HEADING.concerns)).toBeLessThan(overspendAt)
  expect(overspendAt).toBeLessThan(rebuildAt)
  expect(rebuildAt).toBeLessThan(headingAt(rows, HEADING.groups))
  expect(rows[rebuildAt]).toMatchObject({ kind: 'badge', tone: 'warning' })
})

test('TTL 乖離の警告も所見の中の「TTL 乖離」バッジで出す', () => {
  // Arrange: 推定 $3、実 $4（+33%）、書込 100,000 tokens。
  const rows = rowsOf([turn({ toolCount: 5, costUsd: 3, tokens: { input: 0, output: 10, cacheRead: 0, cacheWrite: 100_000 } })], {
    baseline: 10,
    current: 14,
  })

  // Assert
  const ttlAt = badgeAt(rows, FINDING_LABEL.ttl)
  expect(ttlAt).toBeGreaterThan(headingAt(rows, HEADING.concerns))
  expect(ttlAt).toBeLessThan(headingAt(rows, HEADING.groups))
})

test('切替の警告は信頼度の節の注記にし、バッジは出さない', () => {
  // Arrange: 切替（モデル変更）で警告が出る記録。
  const rows = rowsOf([
    turn({ turnId: 't1' }),
    turn({ turnId: 't2', model: 'claude-opus-5-5', firstStepCacheWrite: 100_000, firstStepPromptTokens: 200_000 }),
  ])

  // Assert
  expect(noteStartingAt(rows, '切替の推定')).toBeGreaterThan(headingAt(rows, HEADING.reliability))
  expect(rows.some(row => row.kind === 'badge' && row.label === ALERT_LABEL)).toBe(false)
  expect(rows.some(row => row.kind === 'badge' && row.text.includes('切替の推定'))).toBe(false)
})

test('末尾は信頼度・空行・用語・判定基準の順で、用語は判定基準の直前に来る', () => {
  // Arrange: 用語が出る記録（実コストと過剰）。
  const rows = rowsOf([lightOpus('a'), lightOpus('b'), lightOpus('c')], { baseline: 10, current: 14 })

  // Act
  const reliabilityAt = headingAt(rows, HEADING.reliability)
  const glossaryAt = noteStartingAt(rows, '用語')
  const criteriaAt = noteStartingAt(rows, '軽作業 = ')

  // Assert
  expect(reliabilityAt).toBeLessThan(glossaryAt)
  expect(glossaryAt).toBeLessThan(criteriaAt)
  expect(criteriaAt).toBe(glossaryAt + 1)
  expect(criteriaAt).toBe(rows.length - 1)
})

test('コスト節の中身がないとき（使用率・内訳・推移・advisor がない）は、見出しごと出さない', () => {
  // Arrange: 内訳のない 1 ターン（推移も出ない）。
  const rows = rowsOf([turn({})])

  // Assert
  expect(headingAt(rows, HEADING.cost)).toBe(-1)
  expect(headingAt(rows, HEADING.reliability)).toBeGreaterThan(-1)
})

test('コスト節に中身（advisor の行）があるときは、見出しと行を出す', () => {
  // Arrange: advisor の呼び出しが 1 回ある 1 ターン。
  const rows = rowsOf([turn({ toolCount: 5, advisorCalls: 1 })])

  // Assert
  expect(headingAt(rows, HEADING.cost)).toBeGreaterThan(-1)
  expect(rows).toContainEqual(expect.objectContaining({ kind: 'kv', label: 'advisor' }))
})

test('判定基準の出力の上限は、桁区切りの 1,000 で出す', () => {
  // Act
  const last = rowsOf([turn({})]).at(-1)

  // Assert
  expect(last?.kind === 'note' ? last.text : '').toContain('出力 1,000 tokens 以下')
})
