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

/** 次の一手（/compact の候補）を添える、直近の平均が最初の平均の何倍以上か（仮置き）。 */
export const GROWTH_HINT_RATIO = 3

/** 候補の条件として、プロンプト長（最初の応答）も直近が最初のこの倍率以上に伸びていること（仮置き）。費用の上昇が会話の伸び由来かを確かめる。 */
export const GROWTH_HINT_PROMPT_RATIO = 1.5

export const GROWTH_LABEL = '1 ターンあたりの費用の推移'

export type GrowthView = {
  readonly trend: string
  /** /compact の前後の比較。compact の直後のターンがない、または前後のターンが足りなければ null。 */
  readonly compact: string | null
  /** 増え方が大きいときの候補（/compact と、文脈を捨ててよいときの /clear）。出さないときは null。表示のみで自動では実行しない。 */
  readonly hint: string | null
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

/**
 * 直近の平均が最初の `GROWTH_HINT_RATIO` 倍以上のときだけ候補を添える。
 * 次のときは添えない: 畳み込み済みのターンがある（「最初」が会話の始まりではない）、直近の窓の中で compact 済み（すでに縮めた後）、
 * プロンプト長が取れない・伸びていない（モデルや effort の変更など、会話の伸びが原因ではない上昇かもしれない）。
 */
function hintText(turns: readonly MainTurn[], archivedTurns: number): string | null {
  if (archivedTurns > 0 || turns.length < GROWTH_MIN_TURNS) return null
  const firstTurns = turns.slice(0, GROWTH_WINDOW_TURNS)
  const recentTurns = turns.slice(-GROWTH_WINDOW_TURNS)
  const first = costMean(firstTurns)
  const recent = costMean(recentTurns)
  // 浮動小数の誤差で境界がぶれないよう、わずかな余裕を持って比べる。
  if (first <= 0 || recent < first * GROWTH_HINT_RATIO * (1 - 1e-9)) return null
  const firstPrompt = promptMean(firstTurns)
  const recentPrompt = promptMean(recentTurns)
  if (firstPrompt === null || recentPrompt === null || firstPrompt <= 0 || recentPrompt < firstPrompt * GROWTH_HINT_PROMPT_RATIO) return null
  const lastCompact = turns.map(turn => turn.afterCompact === true).lastIndexOf(true)
  if (lastCompact >= turns.length - GROWTH_WINDOW_TURNS) return null
  return `直近の平均が最初の ${GROWTH_HINT_RATIO} 倍以上です。候補: /compact で会話を縮めると、次のターンから読込が減る目安です（最初の 1 回は書き直しの費用がかかります）。文脈を捨ててよい区切りなら /clear も選べます。品質に響くことがあるため、判断は任せます（自動では実行しません）`
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
  return { trend, compact: compactText(turns), hint: hintText(turns, archivedTurns), note: noteText(archivedTurns) }
}
