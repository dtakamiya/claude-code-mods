// status 行の常時表示と、上限超過トーストの判定。純粋関数（$ に触れない）。
import { formatUsd } from './format'

export type RateWindow = { readonly kind: string; readonly percentUsed: number }

export type Glance = {
  /** 累計の実コスト（USD）。取れない環境では undefined。 */
  readonly costUsd?: number
  readonly rateLimits: readonly RateWindow[]
}

/** 利用者が設定した上限。null は無効。既定はどちらも無効。 */
export type Limits = { readonly costUsd: number | null; readonly ratePercent: number | null }

const RATE_LABELS: Readonly<Record<string, string>> = { five_hour: '5h', seven_day: '7d', spend_limit: '上限枠' }
const UNITS_TO_REDRAW: readonly string[] = ['cost', 'rateLimits']

/** 設定値を上限にする。正の有限な数だけ有効で、0・負・NaN・数以外は無効（null）。 */
export function readLimits(options: Readonly<Record<string, unknown>>): Limits {
  const positive = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  return { costUsd: positive(options.costLimitUsd), ratePercent: positive(options.rateLimitPercent) }
}

/** 設定で表示を切れる。省略時は表示する。 */
export function readShowStatus(options: Readonly<Record<string, unknown>>): boolean {
  return options.showStatus !== false
}

/** コストか使用率が動いた測定だけ描き直す。context だけの変化では描き直さない。 */
export function needsRedraw(changed: readonly string[]): boolean {
  return changed.some(unit => UNITS_TO_REDRAW.includes(unit))
}

export const rateLabel = (kind: string): string => RATE_LABELS[kind] ?? kind
export const formatPercent = (percent: number): string => `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`

// status 行は短く。コストは 2 桁（レポートの 4 桁表示より粗くてよい）。
const formatCostShort = (usd: number): string => `$${usd.toFixed(2)}`

/**
 * status 行の 1 行。コストも使用率も無ければ undefined（行を消す）。
 * 使用率が空（サブスク外・初回前）のときはコストだけを出す。`hints` は枠の種類ごとの短い印（消費ペース）。
 */
export function formatStatus(glance: Glance, hints: ReadonlyMap<string, string> = new Map()): string | undefined {
  const parts: string[] = []
  if (glance.costUsd !== undefined && Number.isFinite(glance.costUsd)) parts.push(`実コスト ${formatCostShort(glance.costUsd)}`)
  for (const window of glance.rateLimits) {
    if (Number.isFinite(window.percentUsed)) parts.push(`${rateLabel(window.kind)} ${formatPercent(window.percentUsed)}${hints.has(window.kind) ? `（${hints.get(window.kind)}）` : ''}`)
  }
  return parts.length === 0 ? undefined : parts.join(' · ')
}

export type AlertResult = {
  /** 今回新しく知らせるトースト文。 */
  readonly alerts: readonly string[]
  /** 次回に渡す「通知済みの上限」。超過が解けたもの（枠のリセットなど）は外れ、次に超えたとき再び知らせる。 */
  readonly notified: ReadonlySet<string>
}

/** 上限を超えた項目のうち、まだ知らせていないものだけを返す。同じ上限は超過が続く限り 1 度だけ。 */
export function evaluateAlerts(glance: Glance, limits: Limits, notified: ReadonlySet<string>): AlertResult {
  const exceeded = new Map<string, string>()
  if (limits.costUsd !== null && glance.costUsd !== undefined && glance.costUsd >= limits.costUsd) {
    exceeded.set('cost', `実コストが上限 ${formatUsd(limits.costUsd)} に達しました（現在 ${formatCostShort(glance.costUsd)}）`)
  }
  if (limits.ratePercent !== null) {
    for (const window of glance.rateLimits) {
      if (window.percentUsed >= limits.ratePercent) {
        exceeded.set(
          `rate:${window.kind}`,
          `${rateLabel(window.kind)} の使用率が上限 ${formatPercent(limits.ratePercent)} に達しました（現在 ${formatPercent(window.percentUsed)}）`,
        )
      }
    }
  }
  const alerts = [...exceeded].filter(([key]) => !notified.has(key)).map(([, text]) => text)
  // コストが取れない測定では判断できないので、知らせ済みの印を保つ（戻ったときの再通知を防ぐ）。
  const kept = new Set(exceeded.keys())
  if (glance.costUsd === undefined && notified.has('cost')) kept.add('cost')
  return { alerts, notified: kept }
}
