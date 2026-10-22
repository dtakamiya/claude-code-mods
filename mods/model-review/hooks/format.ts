// 表示用の数値整形。純粋関数。
export function formatInt(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 全角・ハングル・CJK 記号・全角形が占める 2 桁の範囲（East Asian Width の W / F の主なもの）。 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
]

/** 端末で占める桁数。全角は 2、それ以外は 1。`.length` は全角を 1 と数えるので、桁数の見積りにはこちらを使う。 */
export function cellWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    width += WIDE_RANGES.some(([from, to]) => code >= from && code <= to) ? 2 : 1
  }
  return width
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

/** 符号つきの金額（`+$0.3839` / `-$0.0187`）。0 は + とする。 */
export const signedUsdText = (usd: number): string => `${usd >= 0 ? '+' : '-'}${formatUsd(Math.abs(usd))}`
