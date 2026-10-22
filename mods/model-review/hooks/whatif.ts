// 「いまモデルを替えたらどうなるか」の見積り。$ に触れない純粋関数。
// 直近のメインループのターンのトークン内訳を、各モデルの単価で置き換えて比べる（実際の切替結果ではなく目安）。
import type { TurnRecord } from '../types'
import { formatUsd, signedUsdText } from './format'
import {
  HAIKU_REFERENCE_MODEL,
  OPUS_REFERENCE_MODEL,
  SONNET_REFERENCE_MODEL,
  cacheRebuildCostUsd,
  normalizeModelId,
  priceUsage,
} from './pricing'
import { UNKNOWN_MODEL, shortModel } from './domain'

const CANDIDATE_MODELS: readonly string[] = [HAIKU_REFERENCE_MODEL, SONNET_REFERENCE_MODEL, OPUS_REFERENCE_MODEL]

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

/**
 * 切り替えると書き直すキャッシュの量。キャッシュはモデルごとなので、最初の応答が読んだ分と書いた分の全体を書き直す。
 * 温かいときの書込は前回からの追記分だけなので、書込だけでは再構築を小さく見積もる。
 * 読込を持たない旧記録（0.32.0 まで）は、プロンプト全体（キャッシュしない入力を含むので少し大きめ）で代用する。
 */
const rebuildTokensOf = (record: UsableRecord): number =>
  record.firstStepCacheRead === undefined
    ? (record.firstStepPromptTokens ?? record.firstStepCacheWrite)
    : record.firstStepCacheRead + record.firstStepCacheWrite

/**
 * 候補のモデルで同じ応答を計算した費用。単価段は応答ごとに決まるので、記録が応答ごとに計算した値（Haiku・Sonnet 換算）を優先する。
 * 無ければターン合計のトークンを、最初の応答のプロンプト長の単価段で計算する（合計の長さで判定すると高い段に入りうる）。
 */
function candidateCostOf(record: UsableRecord, model: string): number | null {
  const perResponse = model === HAIKU_REFERENCE_MODEL ? record.haikuCostUsd : model === SONNET_REFERENCE_MODEL ? record.sonnetCostUsd : undefined
  if (typeof perResponse === 'number') return perResponse
  return priceUsage(usageOf(record, model), '5m', record.firstStepPromptTokens)
}

function optionFor(record: UsableRecord, currentUsd: number, model: string): SwitchOption | null {
  const candidateUsd = candidateCostOf(record, model)
  const rebuildUsd = cacheRebuildCostUsd(model, rebuildTokensOf(record), record.firstStepPromptTokens)
  if (candidateUsd === null || rebuildUsd === null) return null
  const perTurnDeltaUsd = candidateUsd - currentUsd
  return { model, rebuildUsd, perTurnDeltaUsd, breakEvenTurns: breakEvenTurns(rebuildUsd, -perTurnDeltaUsd) }
}


/**
 * 直近のメインループのターンを基準にした切替の見積り。基準にできるターンがなければ空。
 * 再構築コストは、そのターンの最初の応答が使ったキャッシュ全体（読込 + 書込）を候補のモデルで書き直す額。
 * 実際に切り替えた直後のターンを見る switches.ts は、書込そのものが再構築なので書込だけを使う。
 */
export function estimateSwitchOptions(records: readonly TurnRecord[]): readonly SwitchOption[] {
  const latest = [...records].reverse().find(isUsable)
  if (latest === undefined) return []
  // isUsable で単価ありを確かめている。応答ごとに単価段を判定した記録の値を、いまのモデルの費用とする。
  const currentUsd = latest.costUsd
  if (currentUsd === null || priceUsage(usageOf(latest, latest.model)) === null) return []
  const currentId = normalizeModelId(latest.model)
  return CANDIDATE_MODELS.filter(model => model !== currentId).flatMap(model => optionFor(latest, currentUsd, model) ?? [])
}


export function describeOption(option: SwitchOption): string {
  const recover = option.breakEvenTurns === null ? '' : ` · 約 ${option.breakEvenTurns} ターンで回収`
  return `${shortModel(option.model)} へ: 再構築 +${formatUsd(option.rebuildUsd)} · 1 ターンあたり ${signedUsdText(option.perTurnDeltaUsd)}${recover}`
}

export const WHATIF_NOTE =
  '直近のメインのターンのトークン内訳を各モデルの単価で置き換えた目安です。実際の使用量・キャッシュの温度・effort の違いは含みません。'
