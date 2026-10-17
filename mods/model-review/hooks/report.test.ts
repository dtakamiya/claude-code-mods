import { test, expect } from 'claude-code/testing'

import type { ReviewState, TurnRecord } from '../types'
import { HEADING, NO_CONCERNS_TEXT } from './labels'
import { buildPaneRows, type PaneRow } from './pane-model'
import { NO_TURNS_LINE, buildReportLines, formatInt, formatUsd } from './report'
import { NEXT_STEP_PREFIX } from './nextstep'

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

const withTurns = (turns: readonly TurnRecord[], baseline: number | null, current: number | null): ReviewState => ({
  turns,
  sessionCostUsd: { baseline, current },
})

test('記録がないときは案内の 1 行だけを返す', () => {
  // Arrange
  const empty = withTurns([], null, null)

  // Act
  const lines = buildReportLines(empty)

  // Assert
  expect(lines).toEqual(['結論: まだ記録がありません', NO_TURNS_LINE])
})

test('先頭行はペインの結論行と一致する（記録なし・指摘なし・指摘あり。単価表が古い注意つき）', () => {
  // Arrange: lightOpus 3 件は過剰、toolCount 5 は指摘なし。
  const light = (id: string) => turn({ turnId: id, model: 'claude-opus-5-5', toolCount: 1, tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 } })
  const reviews = [
    withTurns([], null, null),
    withTurns([turn({ toolCount: 5 })], null, null),
    withTurns([light('a'), light('b'), light('c')], null, null),
  ]

  for (const review of reviews) {
    // Act: 単価表の取得日から十分経った時刻で、注意（注意 N 件）の数も一致させる。
    const nowMs = Date.parse('2099-01-01T00:00:00Z')
    const [first] = buildReportLines(review, nowMs)
    const [conclusion] = buildPaneRows(review, {}, nowMs)

    // Assert
    expect(conclusion?.kind === 'conclusion' ? conclusion.text : undefined).toBe(first)
    if (review.turns.length > 0) expect(first).toContain('注意 1 件')
  }
})

test('実コストと推定の差を、同じ基準点から計算して表示する', () => {
  // Arrange: 推定 0.25 + 0.25 = 0.5、実コスト 0.75 - 0.25 = 0.5（基準点から）。
  const review = withTurns([turn({ turnId: 'a' }), turn({ turnId: 'b' })], 1.0, 1.75)

  // Act
  const text = buildReportLines(review).join('\n')

  // Assert
  expect(text).toContain('合計推定コスト: $0.5000')
  expect(text).toContain('セッション実コスト（読み込み後）: $0.7500')
  expect(text).toContain('差（実コスト − 推定）: $0.2500')
})

test('基準点がない環境では実コストを取得できないと表示する', () => {
  // Arrange
  const review = withTurns([turn()], null, null)

  // Act
  const text = buildReportLines(review).join('\n')

  // Assert
  expect(text).toContain('セッション実コスト: 取得できません')
})

test('単価不明のモデルは推定コストを「単価不明」と表示する', () => {
  // Arrange
  const review = withTurns([turn({ model: 'claude-unlisted-9', costUsd: null })], null, null)

  // Act
  const text = buildReportLines(review).join('\n')

  // Assert
  expect(text).toContain('claude-unlisted-9  effort high')
  expect(text).toContain('推定 単価不明')
  expect(text).toContain('合計推定コスト: 算出できません（全 1 ターンが単価不明）')
  expect(text).toContain('モデル: claude-unlisted-9')
})

test('単価不明が一部のときは、除いた件数つきで合計を出す', () => {
  // Arrange
  const review = withTurns([turn({ turnId: 'a', model: 'claude-unlisted-9', costUsd: null }), turn({ turnId: 'b' })], null, null)

  // Act
  const text = buildReportLines(review).join('\n')

  // Assert
  expect(text).toContain('単価不明 1 ターンを除く')
})

test('単価不明が 0 件のときは、除外の文言を出さない', () => {
  // Arrange
  const review = withTurns([turn({ turnId: 'a' }), turn({ turnId: 'b' })], null, null)

  // Act
  const text = buildReportLines(review).join('\n')

  // Assert
  expect(text).toContain('合計推定コスト: $0.5000')
  expect(text).not.toContain('ターンを除く')
})

test('単価がわかるターンがなければ、高コストターンの見出しは出さない', () => {
  // Arrange
  const review = withTurns([turn({ model: 'claude-unlisted-9', costUsd: null })], null, null)

  // Act
  const text = buildReportLines(review).join('\n')

  // Assert
  expect(text).not.toContain('高コストターン')
})

test('妥当性の指摘があれば、種類と件数を見出しに出す', () => {
  // Arrange: 軽作業を Opus で 3 回実行（同じ設定は 1 行にまとまる）。
  const light = (turnId: string) =>
    turn({ turnId, model: 'claude-opus-5-5', effort: 'medium', costUsd: 0.5, sonnetCostUsd: 0.25 })
  const review = withTurns([light('l1'), light('l2'), light('l3')], null, null)

  // Act
  const text = buildReportLines(review).join('\n')

  // Assert
  expect(text).toContain('【過剰】 軽作業に重いモデル / effort · 3 / 3 件')
  expect(text).toContain('claude-opus-5-5 / effort medium: 軽作業 3 件')
  expect(text).toContain('判定基準（参考）')
})

test('数値は桁区切りで表示する', () => {
  // Act / Assert
  expect(formatInt(1_234_567)).toBe('1,234,567')
  expect(formatInt(999)).toBe('999')
  expect(formatUsd(null)).toBe('単価不明')
  expect(formatUsd(0.5)).toBe('$0.5000')
})

test('コマンド出力にも、ヒット率・高コストターン・切替・注記が出る', () => {
  // Arrange
  const turns = [
    turn({ turnId: 'a', toolCount: 5, tokens: { input: 100, output: 5, cacheRead: 800, cacheWrite: 100 } }),
    turn({ turnId: 'b', toolCount: 5, model: 'claude-opus-5-5', costUsd: 2, firstStepCacheWrite: 100_000, advisorCalls: 1 }),
  ]

  // Act
  const text = buildReportLines(withTurns(turns, null, null)).join('\n')

  // Assert
  expect(text).toContain('ヒット 80%')
  expect(text).toContain('■ 高コストターン')
  expect(text).toContain('【切替】')
  expect(text).toContain('advisor 1 回')
  expect(text).toContain('fast mode')
})

test('見出しの順序と用語はペインと同じで、妥当性が最初に来る', () => {
  // Arrange: 指摘・ループ別・切替見積りが全部出る記録。
  const review = withTurns(
    [
      turn({ turnId: 't1', toolCount: 0, firstStepCacheWrite: 100_000, firstStepPromptTokens: 200_000 }),
      turn({ turnId: 's1', agentId: 'a1', model: 'claude-haiku-5-5' }),
    ],
    null,
    null,
  )

  // Act
  const text = buildReportLines(review).join('\n')
  const headingsOf = (rows: PaneRow[]) => rows.flatMap(row => (row.kind === 'heading' ? [row.text.split('· ')[0]?.trim() ?? ''] : []))
  const paneOrder = headingsOf(buildPaneRows(review))
  const reportOrder = paneOrder.map(heading => text.indexOf(`■ ${heading}`))

  // Assert: ペインの見出しがすべてテキストにあり、同じ順序で並ぶ。
  expect(paneOrder[0]).toBe(HEADING.concerns)
  expect(reportOrder.every(index => index >= 0)).toBe(true)
  expect(reportOrder).toEqual([...reportOrder].sort((a, b) => a - b))
})

test('指摘がないときは、ペインと同じ文言を出す', () => {
  // Arrange
  const text = buildReportLines(withTurns([turn({ toolCount: 5 })], null, null)).join('\n')

  // Assert
  expect(text).toContain(NO_CONCERNS_TEXT)
})

test('指摘の例の後に、ペインとテキストで同じ「次の一手」の候補を 1 行添える', () => {
  // Arrange: Sonnet 5.5 / xhigh の軽作業 3 件は effort 起因の過剰。
  const records = ['a', 'b', 'c'].map(id => turn({ turnId: id, effort: 'xhigh' }))
  const review = withTurns(records, null, null)

  // Act
  const lines = buildReportLines(review)
  const rows = buildPaneRows(review)

  // Assert: テキストは例の直後に「→ 候補: 」、ペインは 'next' 行。文言は同じ。
  const nextLine = lines.find(line => line.includes(`→ ${NEXT_STEP_PREFIX}`)) ?? ''
  const nextRow = rows.find((row): row is Extract<PaneRow, { kind: 'next' }> => row.kind === 'next')
  expect(nextLine).toContain('/effort high などで effort を high 以下へ')
  expect(nextRow?.text).toBe(nextLine.trim().replace(/^→ /, ''))
  const badgeIndex = lines.findIndex(line => line.startsWith('  【過剰】'))
  expect(lines.indexOf(nextLine)).toBeGreaterThan(badgeIndex)
})

test('指摘がなければ「次の一手」の行は出さない', () => {
  const review = withTurns([turn({ toolCount: 5 })], null, null)

  expect(buildReportLines(review).some(line => line.includes(NEXT_STEP_PREFIX))).toBe(false)
  expect(buildPaneRows(review).some(row => row.kind === 'next')).toBe(false)
})

test('数値の effort のターンがあれば、指摘の節に判定外の注記を出す（ペインと同じ）', () => {
  // Arrange
  const review = withTurns([turn({ effort: 'n:32000' })], null, null)

  // Act
  const lines = buildReportLines(review)
  const rows = buildPaneRows(review)

  // Assert
  expect(lines.some(line => line.includes('effort が数値のターン 1 件'))).toBe(true)
  expect(rows.some(row => row.kind === 'note' && row.text.includes('effort が数値のターン 1 件'))).toBe(true)
})
