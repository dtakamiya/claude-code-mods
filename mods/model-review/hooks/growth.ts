// 会話が伸びるにつれた 1 ターンあたりの費用の推移。$ に触れない純粋関数。
// メインのターンだけを見る（サブエージェントは別のコンテキストで動くため）。表示のみで、指摘（▲）にはしない。
import type { TurnRecord } from '../types'
import { formatUsd } from './format'

/** 推移の比較に使う、最初と直近それぞれのターン数（仮置き）。 */
export const GROWTH_WINDOW_TURNS = 10
/** 推移を出す最小のターン数。最初と直近が重ならないよう、窓 2 つ分。 */
export const GROWTH_MIN_TURNS = GROWTH_WINDOW_TURNS * 2
/** compact の前後それぞれに必要な最小のターン数（仮置き）。少ないと平均が 1 ターンの揺れで決まる。 */
export const COMPACT_MIN_SIDE_TURNS = 3

export const GROWTH_LABEL = '1 ターンあたりの費用の推移'

export type GrowthView = {
  readonly trend: string
  /** /compact の前後の比較。compact の直後のターンがない、または前後のターンが足りなければ null。 */
  readonly compact: string | null
  readonly note: string
}

type MainTurn = TurnRecord & { readonly costUsd: number }

const mainPricedTurns = (records: readonly TurnRecord[]): readonly MainTurn[] =>
  records.filter((record): record is MainTurn => record.agentId === null && record.costUsd !== null)

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length

const costMean = (turns: readonly MainTurn[]): number => mean(turns.map(turn => turn.costUsd))

/** プロンプト長（最初の応答）の平均。取れたターンがなければ null。 */
const promptMean = (turns: readonly MainTurn[]): number | null => {
  const lengths = turns.flatMap(turn => (turn.firstStepPromptTokens === undefined ? [] : [turn.firstStepPromptTokens]))
  return lengths.length === 0 ? null : mean(lengths)
}

const formatTokens = (tokens: number): string => (tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(Math.round(tokens)))

const promptText = (from: readonly MainTurn[], to: readonly MainTurn[]): string => {
  const a = promptMean(from)
  const b = promptMean(to)
  return a === null || b === null ? '' : `（プロンプト ${formatTokens(a)} → ${formatTokens(b)} tokens）`
}

function trendText(turns: readonly MainTurn[]): string | null {
  if (turns.length < GROWTH_MIN_TURNS) return null
  const first = turns.slice(0, GROWTH_WINDOW_TURNS)
  const recent = turns.slice(-GROWTH_WINDOW_TURNS)
  return `最初の ${GROWTH_WINDOW_TURNS} ターン ${formatUsd(costMean(first))} → 直近 ${GROWTH_WINDOW_TURNS} ターン ${formatUsd(costMean(recent))}${promptText(first, recent)}`
}

/** 最新の compact の前後。compact 直後のターン自体は再構築を含むので、どちらにも入れない。 */
function compactText(turns: readonly MainTurn[]): string | null {
  const index = turns.map(turn => turn.afterCompact === true).lastIndexOf(true)
  if (index < 0) return null
  const before = turns.slice(Math.max(0, index - GROWTH_WINDOW_TURNS), index)
  const after = turns.slice(index + 1, index + 1 + GROWTH_WINDOW_TURNS)
  if (before.length < COMPACT_MIN_SIDE_TURNS || after.length < COMPACT_MIN_SIDE_TURNS) return null
  return `/compact の前 ${before.length} ターン ${formatUsd(costMean(before))} → 後 ${after.length} ターン ${formatUsd(costMean(after))}${promptText(before, after)}`
}

function noteText(archivedTurns: number): string {
  const folded = archivedTurns > 0 ? `。畳み込み済みの古い ${archivedTurns} ターンは含みません（「最初」は残っている記録の先頭）` : ''
  return `メインのターンの 1 ターンあたりの推定コスト（5 分単価）の平均。単価不明のターン・サブエージェントを除く。compact 直後のターンは再構築を含むため比較に入れない${folded}。会話が伸びると毎回の読込が増えるためで、モデルの選び方とは別の話です`
}

/** 表示用の推移。ターンが少なくて出せなければ null。 */
export function growthView(records: readonly TurnRecord[], archivedTurns = 0): GrowthView | null {
  const turns = mainPricedTurns(records)
  const trend = trendText(turns)
  if (trend === null) return null
  return { trend, compact: compactText(turns), note: noteText(archivedTurns) }
}
