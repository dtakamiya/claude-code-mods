// ペイン（pane-model.ts）とテキスト出力（report.ts）で共用する集計・文面の部品。$ にも JSX にも依存しない純粋関数。
// 並びと見出しは各の組み立て側が持つ。ここには「同じ数字・同じ言い回し」だけを置く。
import type { ReviewState, TurnRecord } from '../types'
import { cacheHitRate } from './cache'
import { estimateRange, estimateTotal, type Concern, type ModelGroup } from './analyze'
import { formatDuration, formatInt, formatUsd } from './format'
import { CONCERN_TEXT } from './labels'
import { describeLoop, loopLabel, subagentHitRateLow, summarizeLoops, SUBAGENT_CACHE_NOTE } from './loops'
import { advisorCallTotal } from './notes'
import { describeOption, estimateSwitchOptions } from './whatif'

export const NO_TURNS_LINE = '記録されたターンはまだありません。この Mod の読み込み後に完了したターンが対象です。'

/** effort がないグループの表記。 */
const EFFORT_NONE_TEXT = '-'

/** 指摘の金額の前に付ける語。金額の意味が種類ごとに違う。 */
export const CONCERN_AMOUNT_LABEL: Readonly<Record<Concern['kind'], string | null>> = {
  overspec: 'Sonnet 換算',
  underspec: null,
  delegation: null,
  subagent: '推定',
  switch: '推定',
}

/** 件数の表記。母数があれば「116 / 200 件」。 */
export const countText = (concern: Concern): string =>
  concern.outOf === undefined ? `${concern.count} 件` : `${concern.count} / ${concern.outOf} 件`

/** 金額の付け足し（` · Sonnet 換算 $0.2500`）。金額がないか語がない種類は空文字。 */
const concernAmountSuffix = (concern: Concern): string => {
  const label = CONCERN_AMOUNT_LABEL[concern.kind]
  return concern.amountUsd === null || label === null ? '' : ` · ${label} ${formatUsd(concern.amountUsd)}`
}

/** 指摘の 1 行分の文面（種類の説明 · 件数 · 金額）。種類の名前（【過剰】など）は含まない。 */
export const concernDetailText = (concern: Concern): string =>
  `${CONCERN_TEXT[concern.kind].summary} · ${countText(concern)}${concernAmountSuffix(concern)}`

/** キャッシュ読 ÷ 全プロンプト。分母が 0 なら null。 */
export const hitRateText = (tokens: ModelGroup['tokens']): string | null => {
  const rate = cacheHitRate(tokens)
  return rate === null ? null : `ヒット ${Math.round(rate * 100)}%`
}

export type GroupFacts = {
  readonly effort: string
  /** ヒット率の文面。分母が 0 なら null。 */
  readonly hit: string | null
  readonly input: string
  readonly output: string
  readonly cacheRead: string
  readonly cacheWrite: string
  readonly costText: string
}

/** モデル × effort のグループを、表示用の文字列にそろえる。 */
export function groupFacts(group: ModelGroup): GroupFacts {
  const { tokens } = group
  return {
    effort: group.effort ?? EFFORT_NONE_TEXT,
    hit: hitRateText(tokens),
    input: formatInt(tokens.input),
    output: formatInt(tokens.output),
    cacheRead: formatInt(tokens.cacheRead),
    cacheWrite: formatInt(tokens.cacheWrite),
    costText: formatUsd(group.costUsd),
  }
}

/** ターンの起点の表記。メインかサブエージェントか。 */
export const turnOriginLabel = (record: TurnRecord): string => (record.agentId === null ? 'メイン' : 'サブエージェント')

/** ツール回数と所要時間の文面（「ツール 3 回 · 2 分 5 秒」）。 */
export const toolDetailText = (record: TurnRecord): string => `ツール ${record.toolCount} 回 · ${formatDuration(record.durationMs)}`

/** サブエージェントのターン数。 */
export const subagentCount = (records: readonly TurnRecord[]): number => records.filter(record => record.agentId !== null).length

export type EstimateFacts = {
  readonly costUsd: number
  readonly unpricedTurns: number
  /** 全ターンが単価不明なら true（推定を出せない）。 */
  readonly allUnpriced: boolean
  readonly lowUsd: number
  readonly highUsd: number
}

/** 推定の合計・単価不明の件数・幅をまとめて求める。 */
export function estimateFacts(records: readonly TurnRecord[]): EstimateFacts {
  const { costUsd, unpricedTurns } = estimateTotal(records)
  const { lowUsd, highUsd } = estimateRange(records)
  return { costUsd, unpricedTurns, allUnpriced: unpricedTurns === records.length, lowUsd, highUsd }
}

/** 全ターン単価不明のときの推定の文面。 */
export const allUnpricedText = (turnCount: number): string => `算出できません（全 ${turnCount} ターンが単価不明）`

/** 単価不明のターンを合計から除いたことの文面。 */
export const unpricedExclusionText = (unpricedTurns: number): string => `（単価不明 ${unpricedTurns} ターンを除く）`

/** 読み込み後の実コスト。基準点か現在値が取れなければ null。 */
export const actualCostUsd = (review: ReviewState): number | null => {
  const { baseline, current } = review.sessionCostUsd
  return baseline === null || current === null ? null : current - baseline
}

/** advisor の呼び出し回数の文面（「2 回（費用が…）」）。0 回なら null。 */
export function advisorCallText(records: readonly TurnRecord[]): string | null {
  const calls = advisorCallTotal(records)
  return calls === 0 ? null : `${calls} 回（費用が usage に載るかは未確認。金額には含めていません）`
}

export type LoopRow = { readonly label: string; readonly detail: string }

export type LoopView = {
  readonly rows: readonly LoopRow[]
  /** サブエージェントのヒット率が低いときの注記。低くなければ null。 */
  readonly subagentNote: string | null
}

/** ループ別の集計。メインとサブエージェントの両方があるときだけ返す（片方だけなら、モデル × effort と同じ内容になる）。 */
export function loopView(records: readonly TurnRecord[]): LoopView | null {
  const summaries = summarizeLoops(records)
  if (summaries.length < 2) return null
  return {
    rows: summaries.map(summary => ({ label: loopLabel(summary.kind), detail: describeLoop(summary) })),
    subagentNote: subagentHitRateLow(summaries) ? SUBAGENT_CACHE_NOTE : null,
  }
}

/** 切替の見積りの文面。基準にできるターンがなければ空配列。 */
export const describeSwitchOptions = (records: readonly TurnRecord[]): string[] =>
  estimateSwitchOptions(records).map(option => describeOption(option))
