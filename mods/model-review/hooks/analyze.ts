// 集計と妥当性の判定。$ に触れない純粋関数。判定は参考（LLM は使わず、閾値は下の名前付き定数）。
import type { TokenCounts, TurnRecord } from '../types'
import { cacheHitRate } from './cache'
import { formatDuration, formatInt, formatUsd } from './format'
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
/** メインループが非 Haiku でこの回数以上ツールを呼び、サブエージェントを一度も使っていなければ指摘する（仮置き）。 */
export const MAIN_DELEGATION_MIN_TOOL_CALLS = 30
/** 委譲の判定は、記録の末尾（新しい順）からこの数のターンだけを窓として見る。古いサブエージェントの利用で指摘を消さないため（仮置き）。 */
export const DELEGATION_WINDOW_TURNS = 20
/** 時間による重い判定は、ツールがこの回数以上使われたターンにだけ適用する。承認待ちなど、ツールを使わない長い停止を重い作業と誤認しないため（仮置き）。 */
export const MIN_TOOLS_FOR_DURATION_HEAVY = 3
/** 過剰は、該当ターンがこの数以上あるときだけ指摘する。1〜2 ターンの軽さは切替の根拠にならない（仮置き）。 */
export const MIN_OVERSPEC_TURNS = 3
/** サブエージェントが推定コストのこの割合以上を占め、かつ MIN_SUBAGENT_TURNS 以上あるとき指摘する（仮置き）。 */
export const SUBAGENT_COST_SHARE = 0.5
export const MIN_SUBAGENT_TURNS = 3
export const HIGH_EFFORTS: ReadonlySet<string> = new Set(['xhigh', 'max'])
export const LOW_EFFORT = 'low'
export const EXAMPLE_LIMIT = 3
/** 「Haiku なら」の差額がこれ未満の軽作業は、モデル起因の過剰として指摘しない（仮置き）。 */
export const MIN_OVERSPEC_SAVINGS_USD = 0.01
/** Sonnet の low effort で、エラーがこの回数以上連続したら不足として指摘する（仮置き）。 */
export const UNDERSPEC_ERROR_STREAK = 2
/** 不足は、該当（重いターン・エラーの連続エピソード）がこの数以上あるときだけ指摘する。1 件の偶発を根拠にしない（仮置き）。 */
export const MIN_UNDERSPEC_TURNS = 2
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

export type ConcernKind = 'overspec' | 'underspec' | 'delegation' | 'subagent' | 'switch'

export type Concern = {
  readonly kind: ConcernKind
  readonly count: number
  readonly examples: readonly string[]
  /** 金額の目安（USD）。過剰は Haiku 換算の差額の上限。分からなければ null。 */
  readonly amountUsd: number | null
  /** 件数の母数（全ターン数）。割合で読める種類にだけ付ける。 */
  readonly outOf?: number
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

/** 中断・拒否のターンは出力が途中で切れているだけなので、軽作業とは見なさない。 */
const isLightTurn = (record: TurnRecord): boolean =>
  record.reason === 'answer' &&
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

/** モデル起因: Opus 系の軽作業で、Sonnet 換算の差額が下限以上。差額が分からないときは指摘しない。Sonnet・Haiku はモデルでは指摘しない。 */
const isModelOverspec = (record: TurnRecord): boolean => {
  if (!isLightTurn(record) || modelRank(record.model) !== RANK_OPUS) return false
  const savings = sonnetSavingsUsd(record)
  return savings !== null && savings >= MIN_OVERSPEC_SAVINGS_USD
}

/** effort 起因: モデルによらず、差額では絞らない。 */
const isEffortOverspec = (record: TurnRecord): boolean =>
  isLightTurn(record) && HIGH_EFFORTS.has(record.effort ?? '')

const isOverspecTurn = (record: TurnRecord): boolean => isModelOverspec(record) || isEffortOverspec(record)

/** 失敗はエラー終了のみ。ユーザーの中断（aborted）はモデルの不足とは言えないので含めない。 */
const isFailureTurn = (record: TurnRecord): boolean => record.reason === 'error'

const isHeavyTurn = (record: TurnRecord): boolean =>
  record.toolCount >= HEAVY_TOOL_CALLS ||
  (record.toolCount >= MIN_TOOLS_FOR_DURATION_HEAVY && record.durationMs >= LONG_TURN_MS)

/** 重いターンだけを根拠にする。エラー終了は API 側の原因もありうるので、Haiku では単独の根拠にしない。 */
const isHaikuUnderspecTurn = (record: TurnRecord): boolean =>
  isHeavyTurn(record) &&
  modelRank(record.model) === RANK_HAIKU &&
  record.effort === LOW_EFFORT

/** メインループで Sonnet / low の失敗になったターン。 */
const isSonnetLowFailure = (record: TurnRecord): boolean =>
  isFailureTurn(record) && modelRank(record.model) === RANK_SONNET && record.effort === LOW_EFFORT

/** メインループで Sonnet / low の失敗が連続した塊（エピソード）を、新しい順ではなく発生順に切り出す。 */
function sonnetLowFailureRuns(records: readonly TurnRecord[]): readonly (readonly TurnRecord[])[] {
  const { runs, current } = records
    .filter(record => record.agentId === null)
    .reduce<{ readonly runs: readonly (readonly TurnRecord[])[]; readonly current: readonly TurnRecord[] }>(
      (acc, record) =>
        isSonnetLowFailure(record)
          ? { runs: acc.runs, current: [...acc.current, record] }
          : { runs: acc.current.length === 0 ? acc.runs : [...acc.runs, acc.current], current: [] },
      { runs: [], current: [] },
    )
  return current.length === 0 ? runs : [...runs, current]
}

/** 連続 UNDERSPEC_ERROR_STREAK 回以上のエピソードは 1 件とし、その最後のターンで代表する。 */
const sonnetLowFailureEpisodes = (records: readonly TurnRecord[]): readonly TurnRecord[] =>
  sonnetLowFailureRuns(records)
    .filter(run => run.length >= UNDERSPEC_ERROR_STREAK)
    .flatMap(run => run.slice(-1))

const underspecTurns = (records: readonly TurnRecord[]): readonly TurnRecord[] => {
  const episodes = new Set(sonnetLowFailureEpisodes(records))
  return records.filter(record => isHaikuUnderspecTurn(record) || episodes.has(record))
}

const loopLabel = (record: TurnRecord): string => (record.agentId === null ? 'メイン' : 'サブエージェント')

const underspecLine = (record: TurnRecord): string =>
  isHeavyTurn(record)
    ? `[${loopLabel(record)}] ターン ${record.turnId}: ツール ${record.toolCount} 回・${formatDuration(record.durationMs)} を ${record.model} / effort low で実行（終了理由 ${record.reason}）`
    : `[${loopLabel(record)}] ターン ${record.turnId}: エラー終了が連続（${record.model} / effort low）。API 側の原因の可能性もあります`

function concernOf(
  kind: ConcernKind,
  count: number,
  lines: readonly string[],
  amountUsd: number | null = null,
): Concern | null {
  if (count === 0) return null
  return { kind, count, examples: lines.slice(0, EXAMPLE_LIMIT), amountUsd }
}

const sumKnown = (values: readonly (number | null)[]): number | null => {
  const known = values.flatMap(value => value ?? [])
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0)
}

type OverspecGroup = {
  readonly loop: string
  readonly model: string
  readonly effort: string
  readonly turns: readonly TurnRecord[]
  readonly sonnetUsd: number | null
  readonly haikuUsd: number | null
}

/** ループ × モデル × effort ごとにまとめる。差額は、モデル起因のターンだけで足す。 */
function overspecGroups(overspec: readonly TurnRecord[]): readonly OverspecGroup[] {
  const byKey = overspec.reduce<Readonly<Record<string, readonly TurnRecord[]>>>((acc, record) => {
    const key = [loopLabel(record), record.model, record.effort ?? '-'].join('\u0000')
    return { ...acc, [key]: [...(acc[key] ?? []), record] }
  }, {})
  return Object.values(byKey)
    .flatMap((turns): OverspecGroup[] => {
      const [first] = turns
      if (first === undefined) return []
      const modelTurns = turns.filter(isModelOverspec)
      return [
        {
          loop: loopLabel(first),
          model: first.model,
          effort: first.effort ?? '-',
          turns,
          sonnetUsd: sumKnown(modelTurns.map(sonnetSavingsUsd)),
          haikuUsd: sumKnown(modelTurns.map(haikuSavingsUsd)),
        },
      ]
    })
    .sort((a, b) => (b.haikuUsd ?? -1) - (a.haikuUsd ?? -1) || b.turns.length - a.turns.length)
}

function overspecGroupLine(group: OverspecGroup): string {
  const sonnet = group.sonnetUsd === null ? '' : ` · Sonnet なら約 ${formatUsd(group.sonnetUsd)} 減`
  const haiku = group.haikuUsd === null ? '' : ` · Haiku なら最大約 ${formatUsd(group.haikuUsd)} 減（上限）`
  const latest = group.turns[group.turns.length - 1]
  const latestText = latest === undefined ? '' : ` · 直近 ターン ${latest.turnId}`
  return `[${group.loop}] ${group.model} / effort ${group.effort}: 軽作業 ${group.turns.length} 件（ツール ${LIGHT_MAX_TOOL_CALLS} 回以下・出力 ${formatInt(LIGHT_MAX_OUTPUT_TOKENS)} tokens 以下）${sonnet}${haiku}${latestText}`
}

function overspecConcern(records: readonly TurnRecord[]): Concern | null {
  const overspec = records.filter(isOverspecTurn)
  if (overspec.length < MIN_OVERSPEC_TURNS) return null
  const amountUsd = sumKnown(overspec.filter(isModelOverspec).map(sonnetSavingsUsd))
  return concernOf('overspec', overspec.length, overspecGroups(overspec).map(overspecGroupLine), amountUsd)
}

/** 直近 DELEGATION_WINDOW_TURNS ターンの窓だけで、メインの非 Haiku ツール回数とサブエージェントの有無を見る。 */
function delegationConcern(records: readonly TurnRecord[]): Concern | null {
  const recent = records.slice(-DELEGATION_WINDOW_TURNS)
  const mainNonHaikuTools = recent
    .filter(record => record.agentId === null && modelRank(record.model) !== RANK_HAIKU)
    .reduce((sum, record) => sum + record.toolCount, 0)
  const usesSubagents = recent.some(record => record.agentId !== null)
  if (mainNonHaikuTools < MAIN_DELEGATION_MIN_TOOL_CALLS || usesSubagents) return null
  return concernOf('delegation', 1, [
    `直近 ${DELEGATION_WINDOW_TURNS} ターンで、メインループが非 Haiku モデルでツールを ${mainNonHaikuTools} 回呼んだが、サブエージェントを使っていない`,
  ])
}

/** サブエージェントがコストの大半を占め、親のキャッシュを読めていないとき。 */
function subagentConcern(records: readonly TurnRecord[]): Concern | null {
  // 単価不明のターンは比率の母数に入らないので、件数にも数えない（count が outOf を超えないように）。
  const subs = records.filter(record => record.agentId !== null && record.costUsd !== null)
  if (subs.length < MIN_SUBAGENT_TURNS) return null
  const total = estimateTotal(records).costUsd
  const subCost = estimateTotal(subs).costUsd
  if (total <= 0 || subCost / total < SUBAGENT_COST_SHARE) return null
  const hit = cacheHitRate(subs.reduce((sum, record) => addTokens(sum, record.tokens), ZERO_TOKENS))
  const hitText = hit === null ? '' : ` · キャッシュヒット ${Math.round(hit * 100)}%`
  return concernOf(
    'subagent',
    subs.length,
    [`サブエージェント ${subs.length} ターンが推定コストの ${Math.round((subCost / total) * 100)}%（${formatUsd(subCost)}）${hitText}`],
    subCost,
  )
}

/** 不足: 件数が MIN_UNDERSPEC_TURNS 未満なら指摘しない。例は新しいターンから順に並べる。 */
function underspecConcern(records: readonly TurnRecord[]): Concern | null {
  const underspec = underspecTurns(records)
  if (underspec.length < MIN_UNDERSPEC_TURNS) return null
  return concernOf('underspec', underspec.length, [...underspec].reverse().map(underspecLine))
}

function switchConcern(records: readonly TurnRecord[]): Concern | null {
  const summary = findSwitches(records)
  return concernOf('switch', summary.count, summary.examples, summary.costUsd)
}

/** 「N 件」を割合で読む種類。 */
const RATIO_CONCERNS: ReadonlySet<ConcernKind> = new Set(['overspec', 'underspec', 'subagent'])

/** 割合の母数。サブエージェントは比率と同じく単価ありのターンだけを数え、それ以外は全ターン。 */
const ratioBase = (kind: ConcernKind, records: readonly TurnRecord[]): number =>
  kind === 'subagent' ? records.filter(record => record.costUsd !== null).length : records.length

/** 妥当性の指摘。該当しない種類は含めない。 */
export function findConcerns(records: readonly TurnRecord[]): readonly Concern[] {
  const concerns = [
    overspecConcern(records),
    underspecConcern(records),
    delegationConcern(records),
    subagentConcern(records),
    switchConcern(records),
  ]
  return concerns
    .filter((concern): concern is Concern => concern !== null)
    .map(concern =>
      RATIO_CONCERNS.has(concern.kind) ? { ...concern, outOf: ratioBase(concern.kind, records) } : concern,
    )
}

/** コストの高いターン（単価不明は除く）。降順で上位 limit 件。元の配列は変えない。 */
export function topCostTurns(records: readonly TurnRecord[], limit: number = TOP_COST_TURN_LIMIT): readonly TurnRecord[] {
  return records
    .filter(record => record.costUsd !== null)
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    .slice(0, limit)
}
