// モデル・effort の切替と、その直後のキャッシュ再構築コストの推定。$ に触れない純粋関数。
// 切替直後のターンの最初の応答の書込トークンを、読めていれば払わなかった額として評価する。
// 長い中断によるキャッシュ切れ（TTL）とは区別できないので、金額はあくまで推定。
import type { TurnRecord } from '../types'
import { effortText } from './effort'
import { formatUsd } from './format'
import { turnRefText } from './turnref'
import { cacheRebuildCostUsd, isThirdPartyModelId, normalizeModelId, ratesFor } from './pricing'
import { UNKNOWN_MODEL } from './domain'

/** API キー・サブスク経由で、effort を変えてもキャッシュが維持されるモデル（公式ドキュメントの記載）。 */
export const CACHE_SAFE_EFFORT_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
])
export const SWITCH_EXAMPLE_LIMIT = 3
/**
 * 切替直後の最初の応答の書込がこの値（トークン）未満なら、再構築は起きていないとみなして件数・合計から分ける。
 * 通常のターンでも新しい内容の分は書くので、0 でなく下限を置く。仮置き（実データ未検証・H4）。
 */
export const MIN_REBUILD_WRITE_TOKENS = 2_000

type SwitchKind = 'model' | 'effort'

type SwitchEvent = {
  readonly record: TurnRecord
  readonly text: string
  readonly costUsd: number | null
  /** 再構築が起きたか。書込が分からない切替は、起きていないと言えないので true。 */
  readonly rebuilt: boolean
}

export type SwitchSummary = {
  /** 再構築があった（または書込が分からず否定できない）切替の件数。 */
  readonly count: number
  /** 書込が下限未満で、再構築がないとみなして件数・合計から外した切替の件数。 */
  readonly noRebuildCount: number
  /** 再構築コストの推定合計。単価がわかる切替がなければ null。 */
  readonly costUsd: number | null
  readonly examples: readonly string[]
  /** 最も新しい切替の直後のターン。切替がなければ null。 */
  readonly latest: TurnRecord | null
}

/** 同じモデルで effort を変えてもキャッシュが維持されるか。 */
export const keepsCacheOnEffortChange = (model: string): boolean =>
  !isThirdPartyModelId(model) && CACHE_SAFE_EFFORT_MODELS.has(normalizeModelId(model))

/** 単価表にあるモデルか。単価表にないモデル（ゲートウェイ名など）はキャッシュの扱いを判断できない。 */
const isPricedModel = (model: string): boolean => ratesFor(model, 0) !== null

/** 同じモデルの effort 変更が、キャッシュを切らす切替として数えられるか。 */
const effortChangeCountsAsSwitch = (model: string): boolean => isPricedModel(model) && !keepsCacheOnEffortChange(model)

/**
 * effort の切替として数えるのは、両方のターンで effort が分かっているときだけ。
 * 応答のない（中断した）ターンなどは effort が null になるので、high → null → high を 2 回の切替と数えない。
 */
const isEffortChange = (prev: TurnRecord, current: TurnRecord): boolean =>
  prev.effort !== null && current.effort !== null && prev.effort !== current.effort

function switchKind(prev: TurnRecord, current: TurnRecord): SwitchKind | null {
  if (prev.model === UNKNOWN_MODEL || current.model === UNKNOWN_MODEL) return null
  if (normalizeModelId(prev.model) !== normalizeModelId(current.model)) return 'model'
  if (!isEffortChange(prev, current) || !effortChangeCountsAsSwitch(current.model)) return null
  return 'effort'
}

function describe(kind: SwitchKind, prev: TurnRecord, current: TurnRecord, turnsAgo: number): string {
  const change =
    kind === 'model'
      ? `${prev.model} → ${current.model}`
      : `effort ${effortText(prev.effort)} → ${effortText(current.effort)}（${current.model}）`
  return `${turnRefText(current, turnsAgo)}: ${change}`
}

function eventOf(prev: TurnRecord, current: TurnRecord, turnsAgo: number): SwitchEvent | null {
  const kind = switchKind(prev, current)
  if (kind === null) return null
  // 0.3.0 の記録（firstStepCacheWrite なし）は不明（null）として扱い、0 円とは読ませない。
  // reload を跨いだ記録（partial）と compact 直後の記録は、書込が切替のせいと言えないので不明扱い。
  const writeUnknown =
    current.firstStepCacheWrite === undefined || current.partial === true || current.afterCompact === true
  const costUsd = writeUnknown
    ? null
    : cacheRebuildCostUsd(current.model, current.firstStepCacheWrite ?? 0, current.firstStepPromptTokens)
  // 書込が分からない切替は、再構築がないとは言えないので件数に残す。
  const rebuilt = writeUnknown || (current.firstStepCacheWrite ?? 0) >= MIN_REBUILD_WRITE_TOKENS
  const costText = costUsd === null ? '' : ` · 再構築の推定 ${formatUsd(costUsd)}`
  return { record: current, text: `${describe(kind, prev, current, turnsAgo)}${costText}`, costUsd, rebuilt }
}

/** メインループの切替を数える。サブエージェントのターンは対象外。 */
export function findSwitches(records: readonly TurnRecord[]): SwitchSummary {
  const main = records.filter(record => record.agentId === null)
  const chronological = main.flatMap((record, index) => {
    const prev = main[index - 1]
    return prev === undefined ? [] : (eventOf(prev, record, main.length - 1 - index) ?? [])
  })
  const rebuiltChronological = chronological.filter(event => event.rebuilt)
  const events = [...rebuiltChronological].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1))
  const known = events.flatMap(event => event.costUsd ?? [])
  return {
    count: events.length,
    noRebuildCount: chronological.length - events.length,
    costUsd: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0),
    examples: events.slice(0, SWITCH_EXAMPLE_LIMIT).map(event => event.text),
    latest: rebuiltChronological[rebuiltChronological.length - 1]?.record ?? null,
  }
}
