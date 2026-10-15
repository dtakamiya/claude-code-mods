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
