// 表示用の数値整形。純粋関数。
export function formatInt(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatUsd(value: number | null): string {
  return value === null ? '単価不明' : `$${value.toFixed(4)}`
}
