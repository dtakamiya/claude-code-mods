// サブスクの使用率（5h / 7d など）の消費ペースと、リセットまでの見込み。$ に触れない純粋関数。
// 上限への到達は断定せず、直近の測定の増え方から出した「目安」として示す。
import { formatPercent, rateLabel, type RateWindow } from './glance'

/** ペースを求めるのに使う、直近の測定の窓（ms）。これより古い測定は捨てる（仮置き）。 */
export const PACE_WINDOW_MS = 15 * 60_000
/** ペースを出すのに要る、最初と最後の測定の間隔（ms）。短いと 1 回の増分に左右される（仮置き）。 */
export const PACE_MIN_SPAN_MS = 2 * 60_000
/** リセット時刻がこれ以上ずれたら、別の枠（リセットをまたいだ）とみなす。同じ枠でも報告が数秒揺れることがあるため（仮置き）。 */
export const RESET_CHANGE_TOLERANCE_MS = 5 * 60_000
/** 1 つの枠で覚える測定の最大数。 */
export const PACE_MAX_POINTS = 60

export type RateWindowInput = RateWindow & { readonly resetsAt?: string }

type Point = { readonly atMs: number; readonly percent: number }

export type WindowSamples = {
  readonly points: readonly Point[]
  /** リセット時刻（ms）。`resetsAt` が無い・読めないときは null。 */
  readonly resetsAtMs: number | null
}

/** 枠の種類ごとの直近の測定。 */
export type RateSamples = Readonly<Record<string, WindowSamples>>

const resetsAtMsOf = (resetsAt: string | undefined): number | null => {
  const parsed = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 測定を足す。リセットをまたいだ（使用率が下がった、またはリセット時刻が替わった）枠は、それまでの測定を捨てる。
 * 今回の測定に無い枠は前の測定のまま残す（一部の枠だけの報告でも履歴を消さない）。有限でない使用率は無視する。
 */
export function addRateSamples(samples: RateSamples, limits: readonly RateWindowInput[], nowMs: number): RateSamples {
  const updated = Object.fromEntries(
    limits
      .filter(limit => Number.isFinite(limit.percentUsed))
      .map((limit): [string, WindowSamples] => {
        const prev = samples[limit.kind]
        const resetsAtMs = resetsAtMsOf(limit.resetsAt)
        const last = prev?.points[prev.points.length - 1]
        const crossedReset =
          last !== undefined && (limit.percentUsed < last.percent || (resetsAtMs !== null && prev?.resetsAtMs != null && Math.abs(resetsAtMs - prev.resetsAtMs) >= RESET_CHANGE_TOLERANCE_MS))
        const kept = prev === undefined || crossedReset ? [] : prev.points.filter(point => point.atMs >= nowMs - PACE_WINDOW_MS)
        return [limit.kind, { points: [...kept, { atMs: nowMs, percent: limit.percentUsed }].slice(-PACE_MAX_POINTS), resetsAtMs }]
      }),
  )
  return { ...samples, ...updated }
}

export type WindowPace = {
  readonly kind: string
  readonly percent: number
  /** リセットまでの時間（ms）。分からなければ null。 */
  readonly resetInMs: number | null
  /** このペースで上限に届くまでの時間（ms）。測定が足りない・消費が増えていないときは null。 */
  readonly etaMs: number | null
}

function paceOf(kind: string, window: WindowSamples, nowMs: number): WindowPace | null {
  const first = window.points[0]
  const last = window.points[window.points.length - 1]
  if (first === undefined || last === undefined) return null
  const resetInMs = window.resetsAtMs === null ? null : Math.max(0, window.resetsAtMs - nowMs)
  // 最後の測定から増えていない時間も含めて、いまのペースとする（増えた直後の値だけで楽観・悲観しない）。
  const span = Math.max(nowMs, last.atMs) - first.atMs
  const delta = last.percent - first.percent
  // 最後の測定が古いときは、いまの消費ペースとは言えない。
  const hasPace = span >= PACE_MIN_SPAN_MS && delta > 0 && nowMs - last.atMs <= PACE_WINDOW_MS
  const etaMs = !hasPace ? null : last.percent >= 100 ? 0 : ((100 - last.percent) / delta) * span
  return { kind, percent: last.percent, resetInMs, etaMs }
}

/** 枠ごとのペース。測定のない枠と、リセット時刻を過ぎた枠（次の報告まで古い値のため）は含まない。 */
export function ratePaces(samples: RateSamples, nowMs: number): readonly WindowPace[] {
  return Object.entries(samples).flatMap(([kind, window]) => {
    if (window.resetsAtMs !== null && window.resetsAtMs < nowMs) return []
    const pace = paceOf(kind, window, nowMs)
    return pace === null ? [] : [pace]
  })
}

const MS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 60

/** 「40 分」「1 時間 10 分」。1 分未満は「1 分未満」。 */
export function formatSpan(ms: number): string {
  const minutes = Math.round(ms / MS_PER_MINUTE)
  if (minutes < 1) return '1 分未満'
  if (minutes < MINUTES_PER_HOUR) return `${minutes} 分`
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  const rest = minutes % MINUTES_PER_HOUR
  return rest === 0 ? `${hours} 時間` : `${hours} 時間 ${rest} 分`
}

/** リセットより前に上限へ届く見込みか。届く見込みなら true（リセット時刻が不明なら、ペースがあれば true）。 */
const reachesBeforeReset = (pace: WindowPace): boolean =>
  pace.etaMs !== null && (pace.resetInMs === null || pace.etaMs < pace.resetInMs)

/** 「72% · このペースだと約 40 分で上限（目安） · リセットまで 1 時間 10 分」。枠のラベルは含まない。 */
export function paceText(pace: WindowPace): string {
  const parts = [formatPercent(pace.percent)]
  if (pace.percent >= 100) {
    parts.push('上限に達しています')
  } else if (pace.etaMs !== null) {
    parts.push(
      reachesBeforeReset(pace)
        ? `このペースだと約 ${formatSpan(pace.etaMs)}で上限（目安）`
        : 'このペースならリセットまでは持つ見込み（目安）',
    )
  }
  if (pace.resetInMs !== null) parts.push(`リセットまで ${formatSpan(pace.resetInMs)}`)
  return parts.join(' · ')
}

/** 「5h 72% · このペースだと約 40 分で上限（目安） · リセットまで 1 時間 10 分」。 */
export const paceLine = (pace: WindowPace): string => `${rateLabel(pace.kind)} ${paceText(pace)}`

/** status 行用の短い印。上限に届く見込みのときだけ「↑40分」「↑1時間10分」。 */
export function paceHint(pace: WindowPace): string | undefined {
  if (pace.etaMs === null || pace.percent >= 100 || !reachesBeforeReset(pace)) return undefined
  const minutes = Math.max(1, Math.round(pace.etaMs / MS_PER_MINUTE))
  if (minutes < MINUTES_PER_HOUR) return `↑${minutes}分`
  const rest = minutes % MINUTES_PER_HOUR
  return `↑${Math.floor(minutes / MINUTES_PER_HOUR)}時間${rest === 0 ? '' : `${rest}分`}`
}

/** status 行に添える印（枠の種類 → 印）。 */
export function paceHints(samples: RateSamples, nowMs: number): ReadonlyMap<string, string> {
  return new Map(ratePaces(samples, nowMs).flatMap((pace): [string, string][] => {
    const hint = paceHint(pace)
    return hint === undefined ? [] : [[pace.kind, hint]]
  }))
}

export const SUBSCRIPTION_COST_NOTE =
  '金額は API 換算の参考値で、請求額ではありません。サブスクの枠は上の使用率で見てください（ペースは直近の測定からの目安で、上限への到達を断定しません）'

export type RateView = {
  /** 枠ごとの 1 行（ラベルと本文）。 */
  readonly rows: readonly { readonly label: string; readonly text: string }[]
  readonly note: string
}

/** ペイン・レポート用。枠の測定がなければ（サブスク外）null で、表示は今のまま。 */
export function rateView(samples: RateSamples, nowMs: number): RateView | null {
  const paces = ratePaces(samples, nowMs)
  if (paces.length === 0) return null
  return {
    rows: paces.map(pace => ({ label: rateLabel(pace.kind), text: paceText(pace) })),
    note: SUBSCRIPTION_COST_NOTE,
  }
}
