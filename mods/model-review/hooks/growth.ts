// 会話が伸びるにつれた 1 ターンあたりの費用の推移（事実の表示のみ。指摘にはしない）。$ に触れない純粋関数。
import type { ArchivedTurns, TurnRecord } from '../types'
import { formatInt, formatUsd } from './format'

/** 推移で比べる、最初と直近の区間のターン数（仮置き）。 */
export const GROWTH_WINDOW_TURNS = 10
/** 推移を出すのに要るメインのターン数。最初と直近の区間が重ならない 2 区間ぶん（仮置き）。 */
export const GROWTH_MIN_TURNS = GROWTH_WINDOW_TURNS * 2
/** compact の前後を比べるとき、それぞれの側に要る最小のターン数（仮置き）。 */
export const COMPACT_MIN_SIDE_TURNS = 3

export const GROWTH_LABEL = '推移'

type Segment = {
  /** 区間の 1 ターンあたり推定コスト（USD）。単価不明のターンは除く。出せなければ null。 */
  readonly costUsd: number | null
  /** 区間の平均プロンプト長（tokens）。取れたターンだけで平均する。出せなければ null。 */
  readonly promptTokens: number | null
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

function segmentOf(turns: readonly TurnRecord[]): Segment {
  return {
    costUsd: mean(turns.flatMap(record => (record.costUsd === null ? [] : [record.costUsd]))),
    promptTokens: mean(turns.flatMap(record => ((record.firstStepPromptTokens ?? 0) > 0 ? [record.firstStepPromptTokens ?? 0] : []))),
  }
}

/** 「18k」「142k」。1,000 未満はそのまま。 */
const tokensText = (tokens: number): string => (tokens < 1_000 ? formatInt(Math.round(tokens)) : `${formatInt(Math.round(tokens / 1_000))}k`)

function promptText(from: Segment, to: Segment): string {
  return from.promptTokens === null || to.promptTokens === null ? '' : `（プロンプト ${tokensText(from.promptTokens)} → ${tokensText(to.promptTokens)} tokens）`
}

export type GrowthView = {
  /** 「1 ターンあたり $0.04 → $0.19（プロンプト 18k → 142k tokens）」。中断・エラー・compact 直後のターンは除く。出せなければ null。 */
  readonly trend: string | null
  /** 「compact 後は $0.06 に戻った」の形の事実。比べられなければ null。 */
  readonly compact: string | null
  /** 畳み込み済みのターンが推移に入らないことの注記。畳んだターンがなければ null。 */
  readonly note: string | null
}

const isMain = (record: TurnRecord): boolean => record.agentId === null

/** 平均に入れるターン。中断・エラー・途中から拾った記録・compact 直後（再構築を含む）のターンは、会話の伸びとは別の要因で費用が動くので外す。 */
const isComparable = (record: TurnRecord): boolean => record.reason === 'answer' && record.partial !== true && record.afterCompact !== true

/**
 * メインのターンの費用の推移。最後の compact の直後のターン（必然的な再構築を含む）は比べる対象から外し、
 * compact があればその後の区間だけで推移を見る。compact の前後は別に 1 行で並べる。
 */
export function growthView(records: readonly TurnRecord[], archived?: ArchivedTurns): GrowthView | null {
  const main = records.filter(isMain)
  const lastCompact = main.map(record => record.afterCompact === true).lastIndexOf(true)
  // 畳んだ記録がないなら、セッション最初のターンは全文のキャッシュ書込で高いので、最初の区間に入れない。
  const afterStart = lastCompact < 0 && (archived?.turns ?? 0) === 0 ? main.slice(1) : main
  const since = (lastCompact < 0 ? afterStart : main.slice(lastCompact + 1)).filter(isComparable)
  const before = lastCompact < 0 ? [] : main.slice(0, lastCompact).filter(isComparable).slice(-GROWTH_WINDOW_TURNS)

  const first = segmentOf(since.slice(0, GROWTH_WINDOW_TURNS))
  const last = segmentOf(since.slice(-GROWTH_WINDOW_TURNS))
  const trend =
    since.length >= GROWTH_MIN_TURNS && first.costUsd !== null && last.costUsd !== null
      ? `1 ターンあたり ${formatUsd(first.costUsd)} → ${formatUsd(last.costUsd)}${promptText(first, last)}`
      : null

  const prior = segmentOf(before)
  const after = segmentOf(since.slice(0, GROWTH_WINDOW_TURNS))
  const compact =
    before.length >= COMPACT_MIN_SIDE_TURNS && since.length >= COMPACT_MIN_SIDE_TURNS && prior.costUsd !== null && after.costUsd !== null
      ? `1 ターンあたり compact の前 ${formatUsd(prior.costUsd)} → 後 ${formatUsd(after.costUsd)}${promptText(prior, after)}（compact の直後のターンは除く）`
      : null

  if (trend === null && compact === null) return null
  const folded = archived?.turns ?? 0
  return { trend, compact, note: folded > 0 ? `畳み込み済みの ${folded} ターンは推移に入っていません（記録に残っているターンの先頭と直近を比べています）` : null }
}
