// サブスクの枠（5h / 7d）の消費ペースと、金額の読み替え。純粋関数（$ に触れない）。
// 「目安」であり、上限に届くとは断定しない。
import type { RateWindow } from './glance'

/** 直近のペースを測る窓。これより古い測定は捨てる。仮置き。 */
export const PACE_WINDOW_MS = 30 * 60 * 1000
/** ペースを出すのに要る、最初と最後の測定の最小の間隔。短すぎると増え方が当てにならない。仮置き。 */
export const PACE_MIN_SPAN_MS = 2 * 60 * 1000
/** ペースを出すのに要る、窓内の使用率の最小の増加（ポイント）。これ未満は「増えていない」とみなす。仮置き。 */
export const PACE_MIN_GAIN_POINTS = 0.5
/** これより大きく使用率が下がったらリセットをまたいだとみなす（ポイント）。丸めの揺れを拾わないため。仮置き。 */
export const RESET_DROP_POINTS = 1

export type RateSample = { readonly atMs: number; readonly percentUsed: number }
/** 枠の種類（kind）ごとの直近の測定。 */
export type RateHistory = Readonly<Record<string, readonly RateSample[]>>

export type Pace = {
  /** 直近のペースのまま上限（100%）に届くまでの分。ペースが出せない・増えていないときは null。 */
  readonly minutesToLimit: number | null
  /** リセットまでの分。resetsAt が無い・読めない・過去のときは null。 */
  readonly minutesToReset: number | null
}

/**
 * 測定を履歴に足す。使用率が下がったらリセットをまたいだとみなして、その測定から数え直す。
 * 窓より古い測定は捨てる。
 */
export function recordRateSamples(history: RateHistory, windows: readonly RateWindow[], nowMs: number): RateHistory {
  const next: Record<string, readonly RateSample[]> = {}
  for (const window of windows) {
    if (!Number.isFinite(window.percentUsed)) continue
    const previous = history[window.kind] ?? []
    const last = previous[previous.length - 1]
    const kept = last !== undefined && last.percentUsed - window.percentUsed > RESET_DROP_POINTS ? [] : previous
    next[window.kind] = [...kept, { atMs: nowMs, percentUsed: window.percentUsed }].filter(sample => nowMs - sample.atMs <= PACE_WINDOW_MS)
  }
  return next
}

/** 1 つの枠のペース。測定が 1 回だけ・間隔が短い・増えていない場合は minutesToLimit が null。 */
export function paceOf(window: RateWindow, samples: readonly RateSample[], nowMs: number): Pace {
  const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt)
  const minutesToReset = Number.isFinite(resetMs) && resetMs > nowMs ? Math.ceil((resetMs - nowMs) / 60000) : null
  // いま（nowMs）から見て窓より古い測定は使わない（止まっていた間の古いペースを出さない）。
  const fresh = samples.filter(sample => nowMs - sample.atMs <= PACE_WINDOW_MS)
  const first = fresh[0]
  const last = fresh[fresh.length - 1]
  if (first === undefined || last === undefined || last.atMs - first.atMs < PACE_MIN_SPAN_MS) return { minutesToLimit: null, minutesToReset }
  const gain = last.percentUsed - first.percentUsed
  const remaining = 100 - last.percentUsed
  if (gain < PACE_MIN_GAIN_POINTS || remaining <= 0) return { minutesToLimit: null, minutesToReset }
  const perMinute = gain / ((last.atMs - first.atMs) / 60000)
  // 最後の測定からの経過を差し引く（表示を描き直すたびに同じ分数が出ないように）。
  const limitAtMs = last.atMs + (remaining / perMinute) * 60000
  return { minutesToLimit: Math.max(0, Math.ceil((limitAtMs - nowMs) / 60000)), minutesToReset }
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 時間` : `${hours} 時間 ${rest} 分`
}

/** リセットより先に上限に届く見込みのときだけ true（届かないペースは status 行に出さない）。 */
export function reachesBeforeReset(pace: Pace): boolean {
  return pace.minutesToLimit !== null && (pace.minutesToReset === null || pace.minutesToLimit < pace.minutesToReset)
}

/** status 行に添える短い形。例: 「↑40分」。出さないときは null。 */
export function shortPace(pace: Pace): string | null {
  return reachesBeforeReset(pace) && pace.minutesToLimit !== null ? `↑${formatDuration(pace.minutesToLimit).replace(/ /g, '')}` : null
}

const LABELS: Readonly<Record<string, string>> = { five_hour: '5h', seven_day: '7d', spend_limit: '上限枠' }

/** ペインとテキストレポート用の 1 行。例: 「5h 72% · このペースで約 40 分で上限（目安） · リセットまで 1 時間 10 分」。 */
export function paceLine(window: RateWindow, pace: Pace): string {
  const percent = Number.isInteger(window.percentUsed) ? String(window.percentUsed) : window.percentUsed.toFixed(1)
  const parts = [`${LABELS[window.kind] ?? window.kind} ${percent}%`]
  if (pace.minutesToLimit !== null) parts.push(`このペースで約 ${formatDuration(pace.minutesToLimit)}で上限（目安）`)
  if (pace.minutesToReset !== null) parts.push(`リセットまで ${formatDuration(pace.minutesToReset)}`)
  return parts.join(' · ')
}

export const API_EQUIVALENT_NOTE = '金額は API 換算の参考値で、サブスクの請求額ではありません。'
export const PACE_NOTE = 'ペースは直近の測定から出した目安で、上限に届くとは限りません。'

export type SubscriptionView = { readonly apiNote: string; readonly lines: readonly string[]; readonly paceNote: string }

/** サブスクの枠（5h / 7d など）。ゲートウェイの上限枠（spend_limit）と、有限でない値は含めない。 */
export function subscriptionWindows(windows: readonly RateWindow[]): RateWindow[] {
  return windows.filter(window => window.kind !== 'spend_limit' && Number.isFinite(window.percentUsed))
}

/** サブスクの枠が取れているときだけ作る。取れない（サブスク外・初回前・上限枠のみ）なら null で、表示は変えない。 */
export function subscriptionView(allWindows: readonly RateWindow[], history: RateHistory, nowMs: number): SubscriptionView | null {
  const windows = subscriptionWindows(allWindows)
  if (windows.length === 0) return null
  return {
    apiNote: API_EQUIVALENT_NOTE,
    lines: windows.map(window => paceLine(window, paceOf(window, history[window.kind] ?? [], nowMs))),
    paceNote: PACE_NOTE,
  }
}
