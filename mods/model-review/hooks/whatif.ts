// 「いまモデルを替えたらどうなるか」の見積り。$ に触れない純粋関数。
// 直近のメインループのターンのトークン内訳を、各モデルの単価で置き換えて比べる（実際の切替結果ではなく目安）。
import type { TurnRecord } from '../types'
import { formatUsd } from './format'
import {
  HAIKU_REFERENCE_MODEL,
  OPUS_REFERENCE_MODEL,
  SONNET_REFERENCE_MODEL,
  cacheRebuildCostUsd,
  normalizeModelId,
  priceUsage,
} from './pricing'
import { UNKNOWN_MODEL } from './recorder'

const CANDIDATE_MODELS: readonly string[] = [HAIKU_REFERENCE_MODEL, SONNET_REFERENCE_MODEL, OPUS_REFERENCE_MODEL]
const MODEL_ID_PREFIX = 'claude-'

export type SwitchOption = {
  readonly model: string
  /** 切替直後の最初の応答でキャッシュを書き直す追加コスト（書込単価 − 読込単価）。 */
  readonly rebuildUsd: number
  /** 同じトークン内訳の 1 ターンを、いまのモデルの単価と比べた差。負なら安くなる。 */
  readonly perTurnDeltaUsd: number
  /** 再構築コストを 1 ターンあたりの節約で回収できるまでのターン数。安くならない・再構築が 0 のときは null。 */
  readonly breakEvenTurns: number | null
}

const usageOf = (record: TurnRecord, model: string) => ({
  model,
  input_tokens: record.tokens.input,
  output_tokens: record.tokens.output,
  cache_read_input_tokens: record.tokens.cacheRead,
  cache_creation_input_tokens: record.tokens.cacheWrite,
})

/** 再構築コストを見積もれる記録。firstStepCacheWrite が無い旧記録（0.3.0 など）は不明なので基準にしない。 */
type UsableRecord = TurnRecord & { readonly firstStepCacheWrite: number }

const isUsable = (record: TurnRecord): record is UsableRecord =>
  record.agentId === null &&
  record.model !== UNKNOWN_MODEL &&
  record.costUsd !== null &&
  record.partial !== true &&
  record.afterCompact !== true &&
  typeof record.firstStepCacheWrite === 'number' &&
  (record.firstStepPromptTokens ?? 0) > 0

/** 再構築コストを 1 ターンあたりの節約で回収できるまでのターン数。安くならない・再構築が 0 のときは null。 */
export function breakEvenTurns(rebuildUsd: number, savingPerTurnUsd: number): number | null {
  return savingPerTurnUsd > 0 && rebuildUsd > 0 ? Math.ceil(rebuildUsd / savingPerTurnUsd) : null
}

function optionFor(record: UsableRecord, currentUsd: number, model: string): SwitchOption | null {
  const candidateUsd = priceUsage(usageOf(record, model))
  const rebuildUsd = cacheRebuildCostUsd(model, record.firstStepCacheWrite, record.firstStepPromptTokens)
  if (candidateUsd === null || rebuildUsd === null) return null
  const perTurnDeltaUsd = candidateUsd - currentUsd
  return { model, rebuildUsd, perTurnDeltaUsd, breakEvenTurns: breakEvenTurns(rebuildUsd, -perTurnDeltaUsd) }
}

/** 見積りの基準にする直近のメインのターンのモデル。基準にできるターンがなければ null。 */
export function baseModelOf(records: readonly TurnRecord[]): string | null {
  return [...records].reverse().find(isUsable)?.model ?? null
}

/**
 * 直近のメインループのターンを基準にした切替の見積り。基準にできるターンがなければ空。
 * 再構築コストは、切替の判定（switches.ts）と同じく「そのターンの最初の応答の書込」を使う。
 */
export function estimateSwitchOptions(records: readonly TurnRecord[]): readonly SwitchOption[] {
  const latest = [...records].reverse().find(isUsable)
  if (latest === undefined) return []
  const currentUsd = priceUsage(usageOf(latest, latest.model))
  if (currentUsd === null) return []
  const currentId = normalizeModelId(latest.model)
  return CANDIDATE_MODELS.filter(model => model !== currentId).flatMap(model => optionFor(latest, currentUsd, model) ?? [])
}

const shortModel = (model: string): string => (model.startsWith(MODEL_ID_PREFIX) ? model.slice(MODEL_ID_PREFIX.length) : model)

const signedUsd = (value: number): string => `${value < 0 ? '-' : '+'}${formatUsd(Math.abs(value))}`

export function describeOption(option: SwitchOption): string {
  const recover = option.breakEvenTurns === null ? '' : ` · 約 ${option.breakEvenTurns} ターンで回収`
  return `${shortModel(option.model)} へ: 再構築 +${formatUsd(option.rebuildUsd)} · 1 ターンあたり ${signedUsd(option.perTurnDeltaUsd)}${recover}`
}

export const WHATIF_NOTE =
  '直近のメインのターンのトークン内訳を各モデルの単価で置き換えた目安です。実際の使用量・キャッシュの温度・effort の違いは含みません。'
