// モデル切替の直前トースト。$ に触れない純粋関数。切替は止めず、知らせるだけ。
import { formatInt } from './format'

export type PreSwitch = {
  readonly fromModel: string
  readonly toModel: string
  readonly contextTokens: number
  readonly isCacheWarm: boolean
  readonly estimatedCacheWriteUsd: number
  readonly pricing: 'configured' | 'catalog' | 'default'
}

/** 設定で切れる。省略時は知らせる。 */
export function readNotifyOnSwitch(options: Readonly<Record<string, unknown>>): boolean {
  return options.notifyOnSwitch !== false
}

/** 入力が数として使えるか。使えない見積りは出さない。 */
const isUsable = (value: number): boolean => Number.isFinite(value) && value >= 0

/**
 * トースト文。キャッシュが温かくない（捨てるものがない）・同じモデルへの切替・見積りが使えないときは undefined。
 * 見積りは engine の値で、単価が既定の仮定のときはそう添える。
 * 毎回出るトーストなので、「温かいキャッシュ」などの用語や「切替は止めません」の断りは書かず、かかる額を先に短く書く。
 */
export function formatSwitchNotice(input: PreSwitch): string | undefined {
  if (!input.isCacheWarm || input.fromModel === input.toModel) return undefined
  if (!isUsable(input.contextTokens) || !isUsable(input.estimatedCacheWriteUsd)) return undefined
  const usd = `約 $${input.estimatedCacheWriteUsd.toFixed(2)}`
  const assumed = input.pricing === 'default' ? '・単価は仮定' : ''
  return `${input.fromModel} → ${input.toModel}: キャッシュを作り直すため${usd} かかる見込み（${formatInt(Math.round(input.contextTokens))} tokens${assumed}）`
}
