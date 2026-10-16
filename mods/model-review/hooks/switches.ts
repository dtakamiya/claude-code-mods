// モデル・effort の切替と、その直後のキャッシュ再構築コストの推定。$ に触れない純粋関数。
// 切替直後のターンの最初の応答の書込トークンを、読めていれば払わなかった額として評価する。
// 長い中断によるキャッシュ切れ（TTL）とは区別できないので、金額はあくまで推定。
import type { TurnRecord } from '../types'
import { formatUsd } from './format'
import { cacheRebuildCostUsd, normalizeModelId, ratesFor } from './pricing'
import { UNKNOWN_MODEL } from './recorder'

/** API キー・サブスク経由で、effort を変えてもキャッシュが維持されるモデル（公式ドキュメントの記載）。 */
export const CACHE_SAFE_EFFORT_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
])
/** Bedrock（`anthropic.`）・Vertex（`@`）の表記。これらでは effort を変えるとキャッシュが維持されない。 */
const THIRD_PARTY_MARKERS: readonly string[] = ['anthropic.', '@']
export const SWITCH_EXAMPLE_LIMIT = 3

type SwitchKind = 'model' | 'effort'

type SwitchEvent = {
  readonly turnId: string
  readonly text: string
  readonly costUsd: number | null
}

export type SwitchSummary = {
  readonly count: number
  /** 再構築コストの推定合計。単価がわかる切替がなければ null。 */
  readonly costUsd: number | null
  readonly examples: readonly string[]
}

const isThirdPartyId = (model: string): boolean => THIRD_PARTY_MARKERS.some(marker => model.includes(marker))

const keepsCacheOnEffortChange = (model: string): boolean =>
  !isThirdPartyId(model) && CACHE_SAFE_EFFORT_MODELS.has(normalizeModelId(model))

/** 単価表にあるモデルか。単価表にないモデル（ゲートウェイ名など）はキャッシュの扱いを判断できない。 */
const isPricedModel = (model: string): boolean => ratesFor(model, 0) !== null

/** 同じモデルの effort 変更が、キャッシュを切らす切替として数えられるか。 */
const effortChangeCountsAsSwitch = (model: string): boolean => isPricedModel(model) && !keepsCacheOnEffortChange(model)

function switchKind(prev: TurnRecord, current: TurnRecord): SwitchKind | null {
  if (prev.model === UNKNOWN_MODEL || current.model === UNKNOWN_MODEL) return null
  if (normalizeModelId(prev.model) !== normalizeModelId(current.model)) return 'model'
  if (prev.effort === current.effort || !effortChangeCountsAsSwitch(current.model)) return null
  return 'effort'
}

function describe(kind: SwitchKind, prev: TurnRecord, current: TurnRecord): string {
  const change =
    kind === 'model'
      ? `${prev.model} → ${current.model}`
      : `effort ${prev.effort ?? '-'} → ${current.effort ?? '-'}（${current.model}）`
  return `ターン ${current.turnId}: ${change}`
}

function eventOf(prev: TurnRecord, current: TurnRecord): SwitchEvent | null {
  const kind = switchKind(prev, current)
  if (kind === null) return null
  // 0.3.0 の記録（firstStepCacheWrite なし）は不明（null）として扱い、0 円とは読ませない。
  const costUsd =
    current.firstStepCacheWrite === undefined
      ? null
      : cacheRebuildCostUsd(current.model, current.firstStepCacheWrite, current.firstStepPromptTokens)
  const costText = costUsd === null ? '' : ` · 再構築の推定 ${formatUsd(costUsd)}`
  return { turnId: current.turnId, text: `${describe(kind, prev, current)}${costText}`, costUsd }
}

/** メインループの切替を数える。サブエージェントのターンは対象外。 */
export function findSwitches(records: readonly TurnRecord[]): SwitchSummary {
  const main = records.filter(record => record.agentId === null)
  const events = main
    .flatMap((record, index) => {
      const prev = main[index - 1]
      return prev === undefined ? [] : (eventOf(prev, record) ?? [])
    })
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1))
  const known = events.flatMap(event => event.costUsd ?? [])
  return {
    count: events.length,
    costUsd: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0),
    examples: events.slice(0, SWITCH_EXAMPLE_LIMIT).map(event => event.text),
  }
}
