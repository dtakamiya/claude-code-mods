// 集計と妥当性の判定。$ に触れない純粋関数。判定は参考（LLM は使わず、閾値は下の名前付き定数）。
import type { TokenCounts, TurnRecord } from '../types'
import { formatUsd } from './format'
import { normalizeModelId } from './pricing'
import { findSwitches } from './switches'

export const RANK_UNRANKED = -1
export const RANK_HAIKU = 0
export const RANK_SONNET = 1
export const RANK_OPUS = 2

/** 「軽作業」: ツール呼び出しがこの回数以下、編集系なし、出力トークンがこの値以下。 */
export const LIGHT_MAX_TOOL_CALLS = 3
export const LIGHT_MAX_OUTPUT_TOKENS = 1_000
/** 「重い」ターン: ツール呼び出しがこの回数以上、またはこの時間（ms）以上。 */
export const HEAVY_TOOL_CALLS = 10
export const LONG_TURN_MS = 120_000
/** メインループが非 Haiku でこの回数以上ツールを呼び、Haiku のサブエージェントがなければ指摘する。 */
export const MAIN_DELEGATION_MIN_TOOL_CALLS = 10
export const HIGH_EFFORTS: ReadonlySet<string> = new Set(['xhigh', 'max'])
export const LOW_EFFORT = 'low'
export const EXAMPLE_LIMIT = 3
/** 「Haiku なら」の差額がこれ未満の軽作業は、モデル起因の過剰として指摘しない（仮置き）。 */
export const MIN_OVERSPEC_SAVINGS_USD = 0.01
/** Sonnet の low effort で、エラー・中断がこの回数以上連続したら不足として指摘する（仮置き）。 */
export const UNDERSPEC_ERROR_STREAK = 2
export const TOP_COST_TURN_LIMIT = 3

export type ModelGroup = {
  readonly model: string
  readonly effort: string | null
  readonly turns: number
  readonly unpricedTurns: number
  readonly tokens: TokenCounts
  /** 単価不明のターンを含むとき null。 */
  readonly costUsd: number | null
}

export type ConcernKind = 'overspec' | 'underspec' | 'delegation' | 'switch'

export type Concern = {
  readonly kind: ConcernKind
  readonly count: number
  readonly examples: readonly string[]
  /** 金額の目安（USD）。過剰は Haiku 換算の差額の上限。分からなければ null。 */
  readonly amountUsd: number | null
}

const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function modelRank(model: string): number {
  const id = normalizeModelId(model)
  if (id.includes('haiku')) return RANK_HAIKU
  if (id.includes('sonnet')) return RANK_SONNET
  if (id.includes('opus') || id.includes('fable') || id.includes('mythos')) return RANK_OPUS
  return RANK_UNRANKED
}

const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

const addCost = (total: number | null, cost: number | null): number | null =>
  total === null || cost === null ? null : total + cost

function addToGroup(group: ModelGroup | undefined, record: TurnRecord): ModelGroup {
  const base: ModelGroup = group ?? {
    model: record.model,
    effort: record.effort,
    turns: 0,
    unpricedTurns: 0,
    tokens: ZERO_TOKENS,
    costUsd: 0,
  }
  return {
    model: base.model,
    effort: base.effort,
    turns: base.turns + 1,
    unpricedTurns: base.unpricedTurns + (record.costUsd === null ? 1 : 0),
    tokens: addTokens(base.tokens, record.tokens),
    costUsd: addCost(base.costUsd, record.costUsd),
  }
}

/** モデル × effort 別に集計し、ターン数の多い順に並べる。 */
export function groupByModelEffort(records: readonly TurnRecord[]): readonly ModelGroup[] {
  const groups = records.reduce<Readonly<Record<string, ModelGroup>>>((acc, record) => {
    const key = `${record.model}\u0000${record.effort ?? ''}`
    return { ...acc, [key]: addToGroup(acc[key], record) }
  }, {})
  return Object.values(groups).sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model))
}

/** 推定の幅。下限は 5 分単価、上限は書込を 1 時間単価にした値。上限のない古い記録は下限と同じ値で足す。 */
export function estimateRange(records: readonly TurnRecord[]): { lowUsd: number; highUsd: number } {
  return records.reduce(
    (total, record) =>
      record.costUsd === null
        ? total
        : {
            lowUsd: total.lowUsd + record.costUsd,
            highUsd: total.highUsd + (record.costUpperUsd ?? record.costUsd),
          },
    { lowUsd: 0, highUsd: 0 },
  )
}

export function estimateTotal(records: readonly TurnRecord[]): { costUsd: number; unpricedTurns: number } {
  return records.reduce(
    (total, record) =>
      record.costUsd === null
        ? { costUsd: total.costUsd, unpricedTurns: total.unpricedTurns + 1 }
        : { costUsd: total.costUsd + record.costUsd, unpricedTurns: total.unpricedTurns },
    { costUsd: 0, unpricedTurns: 0 },
  )
}

const isLightTurn = (record: TurnRecord): boolean =>
  record.toolCount <= LIGHT_MAX_TOOL_CALLS &&
  record.editCount === 0 &&
  record.tokens.output <= LIGHT_MAX_OUTPUT_TOKENS

/** 同じ応答を Haiku 単価で計算した場合との差額（上限）。0.3.0 の記録や単価不明は null。 */
const haikuSavingsUsd = (record: TurnRecord): number | null => {
  const haiku = record.haikuCostUsd ?? null
  if (record.costUsd === null || haiku === null) return null
  return Math.max(0, record.costUsd - haiku)
}

/** 同じ応答を Sonnet 単価で計算した場合との差額（上限）。Opus 系のみ意味がある。古い記録や単価不明は null。 */
const sonnetSavingsUsd = (record: TurnRecord): number | null => {
  const sonnet = record.sonnetCostUsd ?? null
  if (record.costUsd === null || sonnet === null || modelRank(record.model) <= RANK_SONNET) return null
  return Math.max(0, record.costUsd - sonnet)
}

/** モデル起因: Haiku より上位で、差額が下限以上（差額が分からないときは従来どおり指摘する）。 */
const isModelOverspec = (record: TurnRecord): boolean => {
  if (!isLightTurn(record) || modelRank(record.model) <= RANK_HAIKU) return false
  const savings = haikuSavingsUsd(record)
  return savings === null || savings >= MIN_OVERSPEC_SAVINGS_USD
}

/** effort 起因: モデルによらず、差額では絞らない。 */
const isEffortOverspec = (record: TurnRecord): boolean =>
  isLightTurn(record) && HIGH_EFFORTS.has(record.effort ?? '')

const isOverspecTurn = (record: TurnRecord): boolean => isModelOverspec(record) || isEffortOverspec(record)

const isFailureTurn = (record: TurnRecord): boolean => record.reason === 'error' || record.reason === 'aborted'

const isHaikuUnderspecTurn = (record: TurnRecord): boolean =>
  (record.toolCount >= HEAVY_TOOL_CALLS || record.durationMs >= LONG_TURN_MS || isFailureTurn(record)) &&
  modelRank(record.model) === RANK_HAIKU &&
  record.effort === LOW_EFFORT

/** メインループで Sonnet / low の失敗が連続しているターン（連続 UNDERSPEC_ERROR_STREAK 回目以降）。 */
function sonnetLowFailureStreakTurns(records: readonly TurnRecord[]): ReadonlySet<TurnRecord> {
  const scan = records
    .filter(record => record.agentId === null)
    .reduce<{ readonly streak: number; readonly hits: readonly TurnRecord[] }>(
      (acc, record) => {
        const failed =
          isFailureTurn(record) && modelRank(record.model) === RANK_SONNET && record.effort === LOW_EFFORT
        const streak = failed ? acc.streak + 1 : 0
        const isHit = failed && streak >= UNDERSPEC_ERROR_STREAK
        return { streak, hits: isHit ? [...acc.hits, record] : acc.hits }
      },
      { streak: 0, hits: [] },
    )
  return new Set(scan.hits)
}

const underspecTurns = (records: readonly TurnRecord[]): readonly TurnRecord[] => {
  const streakTurns = sonnetLowFailureStreakTurns(records)
  return records.filter(record => isHaikuUnderspecTurn(record) || streakTurns.has(record))
}

const loopLabel = (record: TurnRecord): string => (record.agentId === null ? 'メイン' : 'サブエージェント')

const overspecLine = (record: TurnRecord): string => {
  const savings = isModelOverspec(record) ? haikuSavingsUsd(record) : null
  const sonnetSavings = isModelOverspec(record) ? sonnetSavingsUsd(record) : null
  const sonnetText = sonnetSavings === null ? '' : ` · Sonnet なら約 ${formatUsd(sonnetSavings)} 減`
  const haikuText = savings === null ? '' : ` · Haiku なら約 ${formatUsd(savings)} 減（上限）`
  const savingsText = `${sonnetText}${haikuText}`
  return `[${loopLabel(record)}] ターン ${record.turnId}: ツール ${record.toolCount} 回・出力 ${record.tokens.output} tokens の軽作業を ${record.model} / effort ${record.effort ?? '-'} で実行${savingsText}`
}

const underspecLine = (record: TurnRecord): string =>
  `[${loopLabel(record)}] ターン ${record.turnId}: ツール ${record.toolCount} 回・${record.durationMs} ms・終了理由 ${record.reason} を ${record.model} / effort low で実行`

function concernOf(
  kind: ConcernKind,
  count: number,
  lines: readonly string[],
  amountUsd: number | null = null,
): Concern | null {
  if (count === 0) return null
  return { kind, count, examples: lines.slice(0, EXAMPLE_LIMIT), amountUsd }
}

/** 差額の大きい順（差額が分からないものは後ろ）。元の配列は変えない。 */
const bySavingsDesc = (records: readonly TurnRecord[]): readonly TurnRecord[] =>
  [...records].sort((a, b) => (haikuSavingsUsd(b) ?? -1) - (haikuSavingsUsd(a) ?? -1))

function overspecConcern(records: readonly TurnRecord[]): Concern | null {
  const overspec = bySavingsDesc(records.filter(isOverspecTurn))
  const known = overspec.filter(isModelOverspec).flatMap(record => haikuSavingsUsd(record) ?? [])
  const amountUsd = known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0)
  return concernOf('overspec', overspec.length, overspec.map(overspecLine), amountUsd)
}

function delegationConcern(records: readonly TurnRecord[]): Concern | null {
  const mainNonHaikuTools = records
    .filter(record => record.agentId === null && modelRank(record.model) !== RANK_HAIKU)
    .reduce((sum, record) => sum + record.toolCount, 0)
  const hasHaikuSubagent = records.some(
    record => record.agentId !== null && modelRank(record.model) === RANK_HAIKU,
  )
  if (mainNonHaikuTools < MAIN_DELEGATION_MIN_TOOL_CALLS || hasHaikuSubagent) return null
  return concernOf('delegation', 1, [
    `メインループが非 Haiku モデルでツールを ${mainNonHaikuTools} 回呼んだが、Haiku のサブエージェントへの委譲がない`,
  ])
}

function switchConcern(records: readonly TurnRecord[]): Concern | null {
  const summary = findSwitches(records)
  return concernOf('switch', summary.count, summary.examples, summary.costUsd)
}

/** 妥当性の指摘。該当しない種類は含めない。 */
export function findConcerns(records: readonly TurnRecord[]): readonly Concern[] {
  const underspec = underspecTurns(records)
  const concerns = [
    overspecConcern(records),
    concernOf('underspec', underspec.length, underspec.map(underspecLine)),
    delegationConcern(records),
    switchConcern(records),
  ]
  return concerns.filter((concern): concern is Concern => concern !== null)
}

/** コストの高いターン（単価不明は除く）。降順で上位 limit 件。元の配列は変えない。 */
export function topCostTurns(records: readonly TurnRecord[], limit: number = TOP_COST_TURN_LIMIT): readonly TurnRecord[] {
  return records
    .filter(record => record.costUsd !== null)
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    .slice(0, limit)
}
