// ペイン（pane-model.ts）とテキスト出力（report.ts）で共用する集計・文面の部品。$ にも JSX にも依存しない純粋関数。
// 並びと見出しは各の組み立て側が持つ。ここには「同じ数字・同じ言い回し」だけを置く。
import type { ArchivedTurns, ReviewState, TurnRecord } from '../types'
import { cacheHitRate } from './cache'
import { estimateRange, estimateTotal, summarizeAgentTypes, type Concern, type ModelGroup } from './analyze'
import { effortText } from './effort'
import { formatDuration, formatInt, formatUsd, formatUsdRange, signedUsdText } from './format'
import { CONCERN_TEXT, countText } from './labels'

export { countText } from './labels'
import { UNKNOWN_AGENT_TYPE } from './agenttype'
import { describeAgentType, describeLoop, loopLabel, subagentHitRateLow, summarizeLoops, SUBAGENT_CACHE_NOTE } from './loops'
import { conclusionOf, type Conclusion, type PriceCoverage } from './conclusion'
import { advisorCallTotal, type Note } from './notes'
import { turnsSinceBaseline } from './state'
import { describeOption, estimateSwitchOptions } from './whatif'

export const NO_TURNS_LINE = '記録されたターンはまだありません。この Mod の読み込み後に完了したターンが対象です。'

/** 指摘の金額の前に付ける語。金額の意味が種類ごとに違う。 */
export const CONCERN_AMOUNT_LABEL: Readonly<Record<Concern['kind'], string | null>> = {
  overspec: 'Sonnet 換算',
  underspec: null,
  delegation: '対象の推定',
  subagent: '推定',
  switch: '推定',
}


/** 金額の付け足し（` · Sonnet 換算 $0.2500`）。金額がないか語がない種類は空文字。 */
const concernAmountSuffix = (concern: Concern): string => {
  const label = CONCERN_AMOUNT_LABEL[concern.kind]
  return concern.amountUsd === null || label === null ? '' : ` · ${label} ${formatUsd(concern.amountUsd)}`
}

/** 切替の件数の後ろに付ける、再構築がないため件数に入れなかった切替の件数。なければ空文字。 */
const noRebuildSuffix = (concern: Concern): string =>
  concern.noRebuildCount === undefined ? '' : `（再構築なし ${concern.noRebuildCount} 件は除く）`

/** 最後に該当したのがメインの何ターン前か（` · 最後は 3 ターン前`）。分からない種類は空文字。 */
export const lastSeenSuffix = (concern: Concern): string => {
  if (concern.lastTurnsAgo === undefined) return ''
  return concern.lastTurnsAgo === 0 ? ' · 最後は最新のターン' : ` · 最後は ${concern.lastTurnsAgo} ターン前`
}

/** 指摘の 1 行分の文面（種類の説明 · 件数 · 金額 · 最後に該当したターン）。種類の名前（【過剰】など）は含まない。 */
export const concernDetailText = (concern: Concern): string =>
  `${CONCERN_TEXT[concern.kind].summary} · ${countText(concern)}${noRebuildSuffix(concern)}${concernAmountSuffix(concern)}${lastSeenSuffix(concern)}`

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
    effort: effortText(group.effort),
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
export const toolDetailText = (record: TurnRecord): string =>
  record.durationMs === undefined
    ? `ツール ${record.toolCount} 回`
    : `ツール ${record.toolCount} 回 · ${formatDuration(record.durationMs)}`

/** サブエージェントのターン数。 */
export const subagentCount = (records: readonly TurnRecord[], archived?: ArchivedTurns): number =>
  records.filter(record => record.agentId !== null).length + (archived?.subagents ?? 0)

export type EstimateFacts = {
  readonly costUsd: number
  readonly unpricedTurns: number
  /** 全ターンが単価不明なら true（推定を出せない）。 */
  readonly allUnpriced: boolean
  readonly lowUsd: number
  readonly highUsd: number
}

/** 推定の合計・単価不明の件数・幅をまとめて求める。 */
export function estimateFacts(records: readonly TurnRecord[], archived?: ArchivedTurns): EstimateFacts {
  const recent = estimateTotal(records)
  const range = estimateRange(records)
  const unpricedTurns = recent.unpricedTurns + (archived?.unpricedTurns ?? 0)
  const turnCount = records.length + (archived?.turns ?? 0)
  return {
    costUsd: recent.costUsd + (archived?.pricedUsd ?? 0),
    unpricedTurns,
    allUnpriced: turnCount > 0 && unpricedTurns === turnCount,
    lowUsd: range.lowUsd + (archived?.pricedUsd ?? 0),
    highUsd: range.highUsd + (archived?.highUsd ?? 0),
  }
}

/** 全ターン単価不明のときの推定の文面。 */
export const allUnpricedText = (turnCount: number): string => `算出できません（全 ${turnCount} ターンが単価不明）`

/** 単価不明のターンを合計から除いたことの文面。0 件なら空文字（除いたものがない）。 */
export const unpricedExclusionText = (unpricedTurns: number): string =>
  unpricedTurns > 0 ? `（単価不明 ${unpricedTurns} ターンを除く）` : ''

/** 読み込み後の実コスト。基準点か現在値が取れなければ null。 */
export const actualCostUsd = (review: ReviewState): number | null => {
  const { baseline, current } = review.sessionCostUsd
  return baseline === null || current === null ? null : current - baseline
}

export type CostDiff = {
  /** 読み込み後の実コスト。 */
  readonly actualUsd: number
  /** 実コストに入るターン（基準点より後に完了したもの。畳んだぶんを含む）の推定。 */
  readonly estimateUsd: number
  /** 実コスト − 推定。+ は推定より実額が大きい。 */
  readonly diffUsd: number
}

/**
 * 実コストと推定の差。実コストは基準点からの差なので、推定も基準点より後のターンだけで比べる
 * （読み込み前のターンを混ぜると、差が過大・符号が逆になる）。実コストが取れなければ null。
 */
export function costDiff(review: ReviewState): CostDiff | null {
  const actualUsd = actualCostUsd(review)
  if (actualUsd === null) return null
  const estimateUsd = estimateTotal(turnsSinceBaseline(review)).costUsd + (review.archived?.sinceBaseline.lowUsd ?? 0)
  return { actualUsd, estimateUsd, diffUsd: actualUsd - estimateUsd }
}

export { signedUsdText } from './format'

/** 差の向きの説明。差がちょうど 0 なら空文字。 */
const diffDirectionText = (diffUsd: number): string => (diffUsd > 0 ? '（実が大きい）' : diffUsd < 0 ? '（推定が大きい）' : '')

/** 合計推定の文面。全ターン単価不明なら理由、単価不明のターンがあれば除いたことを添える。 */
export function estimateRangeText(estimate: EstimateFacts): string {
  if (estimate.allUnpriced) return allUnpricedText(estimate.unpricedTurns)
  const unpriced = estimate.unpricedTurns > 0 ? ` ${unpricedExclusionText(estimate.unpricedTurns)}` : ''
  return `${formatUsdRange(estimate.lowUsd, estimate.highUsd)}${unpriced}`
}

/** 実コストが取れないときの文言。ペイン・テキストの金額行・コストの節で同じ説明にする。 */
export const ACTUAL_COST_UNAVAILABLE_TEXT = '実コスト 取得できません（取れない環境もあります。/model-review で再取得）'

/** 実額の語。サブスクの累計コストは API 単価での換算で請求額ではないので、そう明示する。 */
export const actualWord = (isSubscription: boolean): string => (isSubscription ? '実（API 換算）' : '実')

/** 金額の 1 行（推定の幅 · 実額 · 差）。テキスト出力の結論の次に出す。 */
export function moneyLineText(review: ReviewState, isSubscription: boolean): string {
  return moneyLineFrom(estimateFacts(review.turns, review.archived), costDiff(review), isSubscription)
}

/** moneyLineText の、計算済みの推定と差から組み立てる版（集計を 1 回で済ませる呼び出し側用）。 */
export function moneyLineFrom(estimate: EstimateFacts, diff: CostDiff | null, isSubscription: boolean): string {
  return `金額: ${moneyLineBody(estimate, diff, isSubscription)}`
}

/**
 * 金額の文面の本体（「推定 … · 実 … · 差 …」）。ペインの金額行（「金額  」の後ろ）と、テキストの「金額: 」の行で同じ。
 * 語の前に付くラベル（「金額」「金額:」）は呼び出し側が付ける。
 */
export function moneyLineBody(estimate: EstimateFacts, diff: CostDiff | null, isSubscription: boolean): string {
  const word = isSubscription ? 'API 換算の推定' : '推定'
  const actualPart =
    diff === null
      ? ACTUAL_COST_UNAVAILABLE_TEXT
      : `${actualWord(isSubscription)} ${formatUsd(diff.actualUsd)}（読み込み後）· 差 ${signedUsdText(diff.diffUsd)}${diffDirectionText(diff.diffUsd)}`
  return `${word} ${estimateRangeText(estimate)} · ${actualPart}`
}

/** 単価が分からないターン数と全ターン数。結論の状態（判定不能・理由の添え書き）に使う。結論行とペインの判定で同じ数え方にする。 */
export function priceCoverageOf(review: ReviewState): PriceCoverage {
  return { unpricedTurns: estimateFacts(review.turns, review.archived).unpricedTurns, totalTurns: review.turns.length + (review.archived?.turns ?? 0) }
}

/** 結論の 1 行（状態）。`alerts` は動的な警告だけ（信頼度の注記は含めない）。 */
export function buildVerdict(review: ReviewState, concerns: readonly Concern[], alerts: readonly Note[]): Conclusion {
  return conclusionOf(concerns, alerts, priceCoverageOf(review))
}

/** advisor の呼び出し回数の文面（「2 回（費用が…）」）。0 回なら null。 */
export function advisorCallText(records: readonly TurnRecord[], archived?: ArchivedTurns): string | null {
  const calls = advisorCallTotal(records) + (archived?.advisorCalls ?? 0)
  return calls === 0 ? null : `${calls} 回（費用は usage に載らず取得できないため、金額には含まれません）`
}

export type LoopRow = { readonly label: string; readonly detail: string }

export type LoopView = {
  /** メイン → サブエージェント。サブエージェントの直後に、種類の名前が分かるものがあれば種類別の行（└ 種類名）を並べる。 */
  readonly rows: readonly LoopRow[]
  /** サブエージェントのヒット率が低いときの注記。低くなければ null。 */
  readonly subagentNote: string | null
}

/** ループ別の集計。メインとサブエージェントの両方があるときだけ返す（片方だけなら、モデル × effort と同じ内容になる）。 */
export function loopView(records: readonly TurnRecord[]): LoopView | null {
  const summaries = summarizeLoops(records)
  if (summaries.length < 2) return null
  const byType = summarizeAgentTypes(records)
  // 種類が 1 つだけでも、名前が分かっていれば出す（どの種類かが分かる）。「種類不明」だけなら出さない。
  const showTypes = byType.length >= 2 || (byType.length === 1 && byType[0]?.type !== UNKNOWN_AGENT_TYPE)
  return {
    rows: summaries.flatMap(summary => [
      { label: loopLabel(summary.kind), detail: describeLoop(summary) },
      ...(summary.kind === 'subagent' && showTypes ? byType.map(type => ({ label: `└ ${type.type}`, detail: describeAgentType(type) })) : []),
    ]),
    subagentNote: subagentHitRateLow(summaries) ? SUBAGENT_CACHE_NOTE : null,
  }
}

/** 切替の見積りの文面。基準にできるターンがなければ空配列。 */
export const describeSwitchOptions = (records: readonly TurnRecord[]): string[] =>
  estimateSwitchOptions(records).map(option => describeOption(option))
