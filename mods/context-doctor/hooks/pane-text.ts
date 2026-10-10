// 純粋関数: 表示幅（東アジア全角を 2 桁）で揃える文字列ヘルパー。`$` に依存しない。
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/
const ELLIPSIS = '…'

const charWidth = (ch: string) => (WIDE_CHAR.test(ch) ? 2 : 1)

export const displayWidth = (text: string) => [...text].reduce((w, ch) => w + charWidth(ch), 0)

/** 幅 `width` に収まるよう末尾を切る。切ったときだけ `…` を付ける。 */
export function truncateWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  const chars = [...text]
  let out = ''
  let used = 0
  for (const ch of chars) {
    if (used + charWidth(ch) > width - 1) break
    out += ch
    used += charWidth(ch)
  }
  return out + ELLIPSIS
}

export function padEndWidth(text: string, width: number): string {
  const fitted = truncateWidth(text, width)
  return fitted + ' '.repeat(Math.max(0, width - displayWidth(fitted)))
}

export const padStartWidth = (text: string, width: number) => ' '.repeat(Math.max(0, width - displayWidth(text))) + text
