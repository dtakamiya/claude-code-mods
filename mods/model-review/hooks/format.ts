// 表示用の数値整形。純粋関数。
export function formatInt(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 推定の幅。上限が下限と（表示上）同じなら単独の値にする。 */
export function formatUsdRange(lowUsd: number, highUsd: number): string {
  const low = formatUsd(lowUsd)
  const high = formatUsd(highUsd)
  return low === high ? low : `${low}〜${high}`
}

export function formatUsd(value: number | null): string {
  return value === null ? '単価不明' : `$${value.toFixed(4)}`
}

const MS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60

/** ミリ秒を「3 分 20 秒」「45 秒」の形にする。1 秒未満は「1 秒未満」。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / MS_PER_SECOND)
  if (totalSeconds < 1) return '1 秒未満'
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  if (minutes === 0) return `${seconds} 秒`
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`
}
