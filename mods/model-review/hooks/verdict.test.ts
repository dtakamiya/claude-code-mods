import { expect, test } from 'claude-code/testing'

import type { ArchivedTurns, ReviewState, TurnRecord } from '../types'
import { PRICE_TABLE_FETCHED_AT, PRICE_TABLE_STALE_DAYS } from './pricing'
import { buildPaneRows, type PaneRow } from './pane-model'
import { NO_TURNS_LINE, buildReportLines } from './report'
import { costDiff } from './summary'

// 架空データのみ。D0（実コスト差）・D1（結論行の状態化）・D2（テキストの金額行）・D3（動的警告と信頼度の分離）の受け入れ確認。

/** 健全なメインの Sonnet 1 ターン（編集あり・キャッシュ高ヒット）。 */
const healthy = (turnId: string, overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId,
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  tokens: { input: 100, output: 300, cacheRead: 20_000, cacheWrite: 500 },
  costUsd: 0.01,
  costUpperUsd: 0.012,
  toolCount: 5,
  editCount: 2,
  durationMs: 5_000,
  reason: 'answer',
  firstStepCacheWrite: 500,
  firstStepPromptTokens: 20_600,
  ...overrides,
})

/** 浮動小数の誤差を避けて、100 万分の 1 ドル単位の整数で比べる。 */
const micro = (usd: number | undefined): number => Math.round((usd ?? Number.NaN) * 1e6)

const times = (count: number, make: (index: number) => TurnRecord): TurnRecord[] => Array.from({ length: count }, (_, index) => make(index))

const review = (turns: readonly TurnRecord[], sessionCostUsd: ReviewState['sessionCostUsd'] = { baseline: null, current: null }): ReviewState => ({
  turns,
  sessionCostUsd,
})

const conclusionText = (rows: readonly PaneRow[]): string => {
  const first = rows[0]
  return first?.kind === 'conclusion' ? first.text : ''
}
const conclusionTone = (rows: readonly PaneRow[]): string | undefined => {
  const first = rows[0]
  return first?.kind === 'conclusion' ? first.tone : undefined
}

/** ペインとテキストの結論行が一致することも確かめて、その行を返す。 */
function verdictOf(state: ReviewState, nowMs?: number): { text: string; tone: string | undefined } {
  const rows = buildPaneRows(state, {}, nowMs)
  const [first] = buildReportLines(state, nowMs)
  expect(conclusionText(rows)).toBe(first)
  return { text: conclusionText(rows), tone: conclusionTone(rows) }
}

// 書込が読込を上回る再構築が 5 回連続する（S7 相当）。
const rebuildStreak = (): TurnRecord[] =>
  times(5, index => healthy(`r${index}`, { tokens: { input: 100, output: 300, cacheRead: 100, cacheWrite: 40_000 }, durationMs: 800 }))

test('S7 再構築が連続しているとき、結論は ✓ にならず「要確認」と理由が先頭に出る', () => {
  // Arrange / Act
  const { text, tone } = verdictOf(review(rebuildStreak()))

  // Assert
  expect(text.startsWith('▲ 要確認 · 結論: ')).toBe(true)
  expect(text).toContain('キャッシュ書込 > 読込が 5 ターン連続')
  expect(text).not.toContain('✓')
  expect(tone).toBe('warning')
})

test('S8 再構築の連続と TTL 乖離が重なるとき、最重要の理由 1 つと「ほか 1 件」が出る', () => {
  // Arrange: 実コスト 0.9 は、書込を 1 時間単価にした上限（約 0.32）も大きく上回る。
  const turns = times(4, index => healthy(`t${index}`, { tokens: { input: 100, output: 300, cacheRead: 5_000, cacheWrite: 30_000 }, costUsd: 0.05, costUpperUsd: 0.08 }))

  // Act
  const { text, tone } = verdictOf(review(turns, { baseline: 1, current: 1.9 }))

  // Assert
  expect(text).toContain('▲ 要確認')
  expect(text).toContain('キャッシュ書込 > 読込が 4 ターン連続')
  expect(text).toContain('ほか 1 件')
  expect(tone).toBe('warning')
})

test('S4 全ターンが単価不明のとき、「判定不能」と理由 1 行で、✓ にしない', () => {
  // Arrange
  const turns = times(4, index => healthy(`u${index}`, { model: 'my-gw/foo-large', costUsd: null, costUpperUsd: null }))

  // Act
  const { text, tone } = verdictOf(review(turns))

  // Assert
  expect(text.startsWith('？ 判定不能 · 結論: ')).toBe(true)
  expect(text).toContain('全 4 ターンが単価不明')
  expect(text).not.toContain('✓')
  expect(tone).toBe('plain')
})

test('S4b 5 ターン中 1 ターンだけ単価不明なら、状態はそのままで理由に「単価不明 1/5 ターン」を足す', () => {
  // Arrange: モデルは同じなので切替の指摘は出ない。
  const turns = [...times(4, index => healthy(`h${index}`)), healthy('u', { costUsd: null, costUpperUsd: null })]

  // Act
  const { text, tone } = verdictOf(review(turns))

  // Assert
  expect(text).toBe('✓ 問題なし · 結論: 目立った指摘なし · 単価不明 1/5 ターン')
  expect(tone).toBe('success')
})

test('S1 記録がなければ、結論は従来どおり「まだ記録がありません」で、テキストは 2 行のまま（金額行を足さない）', () => {
  // Arrange / Act
  const lines = buildReportLines(review([]))

  // Assert
  expect(lines).toEqual(['結論: まだ記録がありません', NO_TURNS_LINE])
})

test('S2 健全なセッションは「問題なし」（回帰）', () => {
  // Arrange / Act
  const { text, tone } = verdictOf(review(times(6, index => healthy(`h${index}`))))

  // Assert
  expect(text).toBe('✓ 問題なし · 結論: 目立った指摘なし')
  expect(tone).toBe('success')
})

test('S9 サブエージェントがコストの大半のときは、従来どおり指摘ありとして「要確認」（回帰）', () => {
  // Arrange: キャッシュを使わない Haiku のサブエージェント 4 回。
  const sub = (id: string): TurnRecord =>
    healthy(`s${id}`, { agentId: id, model: 'claude-haiku-5-5', tokens: { input: 150_000, output: 5_000, cacheRead: 0, cacheWrite: 0 }, toolCount: 12, costUsd: 0.2, costUpperUsd: 0.2 })
  const turns = [healthy('main'), sub('a'), sub('b'), sub('c'), sub('d')]

  // Act
  const { text, tone } = verdictOf(review(turns))

  // Assert
  expect(text).toBe('▲ 要確認 · 結論: 見直し候補 4 件（サブ 4）')
  expect(tone).toBe('warning')
})

test('不足があれば「要対応」（error）、委譲だけなら「参考」（suggestion）', () => {
  // Arrange: 重い作業（ツール 12 回）を Haiku の low で 2 件 / ツール多数のメイン Sonnet（委譲だけ）。
  const heavyHaiku = (id: string): TurnRecord => healthy(id, { model: 'claude-haiku-5-5', effort: 'low', toolCount: 12 })
  const underspec = verdictOf(review([heavyHaiku('h1'), heavyHaiku('h2')]))
  const delegation = verdictOf(review(times(6, index => healthy(`d${index}`, { toolCount: 6, editCount: 0 }))))

  // Assert
  expect(underspec.text.startsWith('✖ 要対応 · 結論: 見直し候補')).toBe(true)
  expect(underspec.tone).toBe('error')
  expect(delegation.text.startsWith('△ 参考 · 結論: 見直し候補 1 件（委譲 1）')).toBe(true)
  expect(delegation.tone).toBe('suggestion')
})

test('切替の注記は注意の件数には数えるが、状態を ▲ に上げない（切替を止めている利用者は ✓ のまま）', () => {
  // Arrange: 切替の指摘（concern）は止め、切替の注記（推定方法の但し書き）だけが出る記録。
  const turns = [healthy('a'), healthy('b', { model: 'claude-opus-5-5', toolCount: 5, editCount: 2, firstStepCacheWrite: 100_000, firstStepPromptTokens: 200_000 })]
  const muted = new Set(['switch'] as const)

  // Act
  const rows = buildPaneRows(review(turns), {}, undefined, undefined, muted)
  const lines = buildReportLines(review(turns), undefined, muted)

  // Assert
  expect(conclusionText(rows)).toBe('✓ 問題なし · 結論: 目立った指摘なし · 注意 1 件')
  expect(lines[0]).toBe(conclusionText(rows))
  // 切替は所見のバッジにせず、信頼度の注記に出す。
  expect(rows.filter(row => row.kind === 'badge' && row.label === '注意')).toHaveLength(0)
  expect(rows.some(row => row.kind === 'note' && row.text === '切替の推定は、切替直後の最初の応答のキャッシュ書込から算出しています。長い中断によるキャッシュ切れとは区別できません。Bedrock・Vertex・gateway 経由では effort 変更でもキャッシュは維持されません')).toBe(true)
})

test('D3 単価表が古いだけなら、動的な警告がないので ✓ のまま。注意に数えず、ペインでは信頼度の注記に回る', () => {
  // Arrange: 取得日から基準日数を十分超えた時刻。
  const nowMs = Date.parse(PRICE_TABLE_FETCHED_AT) + (PRICE_TABLE_STALE_DAYS + 30) * 86_400_000
  const state = review(times(3, index => healthy(`h${index}`)))

  // Act
  const rows = buildPaneRows(state, {}, nowMs)
  const lines = buildReportLines(state, nowMs)
  const ageNote = (text: string): boolean => text.includes('単価表の取得から')

  // Assert
  expect(conclusionText(rows)).toBe('✓ 問題なし · 結論: 目立った指摘なし')
  expect(lines[0]).toBe(conclusionText(rows))
  expect(rows.some(row => row.kind === 'badge' && ageNote(row.text))).toBe(false)
  expect(rows.some(row => row.kind === 'note' && ageNote(row.text))).toBe(true)
  expect(lines.some(ageNote)).toBe(true)
})

// ---- D0: 実コスト差は、実コストに入るターン（基準点より後）の推定と比べる ----

test('D0 基準点より前のターンは、差の推定に入れない（符号が逆転しない）', () => {
  // Arrange: 6 ターン（各 0.01）のうち読み込み前が 3。実コスト 0.04、基準点後の推定 0.03 → 差 +0.01（全ターンの 0.06 と比べると -0.02 になってしまう）。
  const state: ReviewState = { turns: times(6, index => healthy(`h${index}`)), sessionCostUsd: { baseline: 5, current: 5.04, baselineTurns: 3 } }

  // Act
  const diff = costDiff(state)
  const rows = buildPaneRows(state)
  const lines = buildReportLines(state)

  // Assert
  expect(micro(diff?.actualUsd)).toBe(40_000)
  expect(micro(diff?.estimateUsd)).toBe(30_000)
  expect(micro(diff?.diffUsd)).toBe(10_000)
  expect(rows.some(row => row.kind === 'kv' && row.value.includes('差 +$0.0100'))).toBe(true)
  expect(lines).toContain('差（実 − 推定）: +$0.0100（実が大きい。推定は単価表の値。ターン外の要求は含まない）')
})

test('D0 畳み込み済みのターンは、基準点より後に畳んだぶんだけを差の推定に足す', () => {
  // Arrange: 畳んだターンのうち基準点後のぶんが 0.5、残りの直近ターンが 0.1。
  const archived: ArchivedTurns = {
    turns: 10,
    subagents: 0,
    advisorCalls: 0,
    groups: [],
    pricedUsd: 0.9,
    unpricedTurns: 0,
    highUsd: 0.9,
    sinceBaseline: { lowUsd: 0.5, highUsd: 0.5, cacheWrite: 0 },
  }
  const state: ReviewState = { turns: [healthy('a', { costUsd: 0.1 })], archived, sessionCostUsd: { baseline: 0, current: 1, baselineTurns: 0 } }

  // Act
  const diff = costDiff(state)

  // Assert
  expect(micro(diff?.estimateUsd)).toBe(600_000)
  expect(micro(diff?.diffUsd)).toBe(400_000)
})

test('D0 基準点か現在値が取れなければ、差は null', () => {
  expect(costDiff(review([healthy('a')]))).toBeNull()
})

// ---- D2: テキスト出力の先頭に結論の次の行として金額行を足す ----

test('D2 テキストは結論の次に金額行（推定の幅・実額・差）が入り、既存の行は後ろにそのまま続く', () => {
  // Arrange: 推定 0.01 × 2、実コスト 0.05 → 差 +0.03。
  const state = review(times(2, index => healthy(`h${index}`)), { baseline: 1, current: 1.05 })

  // Act
  const lines = buildReportLines(state)

  // Assert
  expect(lines[0]).toBe('✓ 問題なし · 結論: 目立った指摘なし')
  expect(lines[1]).toBe('金額: 推定 $0.0200〜$0.0240 · 実 $0.0500（読み込み後）· 差 +$0.0300（実が大きい）')
  expect(lines[2]).toBe('')
  expect(lines[3]).toContain('対象: 2 ターン')
})

test('D2 実コストが取れないとき、全ターン単価不明のときの金額行', () => {
  // Arrange
  const noActual = buildReportLines(review([healthy('a')]))
  const unpriced = buildReportLines(review([healthy('a', { costUsd: null, costUpperUsd: null })]))

  // Assert
  expect(noActual[1]).toBe('金額: 推定 $0.0100〜$0.0120 · 実コスト 取得できません（取れない環境もあります。/model-review で再取得）')
  expect(unpriced[1]).toBe('金額: 推定 算出できません（全 1 ターンが単価不明） · 実コスト 取得できません（取れない環境もあります。/model-review で再取得）')
})
