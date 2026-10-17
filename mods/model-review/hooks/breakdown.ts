// 推定コストの内訳（入力・出力・キャッシュ書込・読込のどれが効いているか）。$ に触れない純粋関数。
import type { ArchivedTurns, CostParts, TurnRecord } from '../types'
import { formatUsd } from './format'

export const ZERO_PARTS: CostParts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const addParts = (a: CostParts, b: CostParts): CostParts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

/** 書込または出力がこの割合以上を占めるとき、見直しの手がかりを添える（仮置き）。 */
export const BREAKDOWN_HINT_SHARE = 0.5

export type CostBreakdown = {
  readonly parts: CostParts
  /** 内訳の合計（USD）。内訳を持つターンの推定コスト（下限）の合計と一致する。 */
  readonly totalUsd: number
  /** 単価不明、または内訳を持たない（古い記録の）ため、内訳から除いたターン数。 */
  readonly excludedTurns: number
}

const sumParts = (parts: CostParts): number => parts.input + parts.output + parts.cacheRead + parts.cacheWrite

/** 畳んだぶんのうち内訳に入らないターン数。内訳を持たない古い集計は、単価のあるターンを全部除く。 */
const archivedExcluded = (archived: ArchivedTurns | undefined): number => {
  if (archived === undefined) return 0
  return archived.costParts === undefined ? archived.turns : archived.unpricedTurns + (archived.partsMissingTurns ?? 0)
}

/** 直近の記録と畳んだ集計から内訳を足し合わせる。内訳が 0 円（出せるものがない）なら null。 */
export function costBreakdown(records: readonly TurnRecord[], archived?: ArchivedTurns): CostBreakdown | null {
  const recent = records.reduce(
    (acc, record) =>
      record.costParts == null
        ? { ...acc, excluded: acc.excluded + 1 }
        : { ...acc, parts: addParts(acc.parts, record.costParts) },
    { parts: archived?.costParts ?? ZERO_PARTS, excluded: archivedExcluded(archived) },
  )
  const totalUsd = sumParts(recent.parts)
  return totalUsd > 0 ? { parts: recent.parts, totalUsd, excludedTurns: recent.excluded } : null
}

const percent = (value: number, total: number): string => `${Math.round((value / total) * 100)}%`

export const BREAKDOWN_LABEL = '内訳'

/** 「書込 58% · 出力 25% · 読込 12% · 入力 5%」。割合の大きい順。0% の種類も並べる（ないことが分かる）。 */
export function breakdownItems(breakdown: CostBreakdown): string {
  const { parts, totalUsd } = breakdown
  const items = [
    { label: '書込', value: parts.cacheWrite },
    { label: '出力', value: parts.output },
    { label: '読込', value: parts.cacheRead },
    { label: '入力', value: parts.input },
  ].sort((a, b) => b.value - a.value)
  return items.map(item => `${item.label} ${percent(item.value, totalUsd)}`).join(' · ')
}

/** 書込や出力が大きいときだけ、関係する既存の指摘・注記を指す 1 行。大きくなければ null。 */
export function breakdownHint(breakdown: CostBreakdown): string | null {
  const { parts, totalUsd } = breakdown
  if (parts.cacheWrite / totalUsd >= BREAKDOWN_HINT_SHARE) {
    return '書込が大きい: プレフィックスが変わり続けている可能性（「キャッシュ書込が読込を上回るターンが連続」の注意・モデル切替・MCP・プラグインを確認）'
  }
  if (parts.output / totalUsd >= BREAKDOWN_HINT_SHARE) {
    return '出力が大きい: effort や冗長な出力を見直す（過剰・不足の指摘を参照）'
  }
  return null
}

/** 除いたターンの注記と、金額の定義。 */
export function breakdownNote(breakdown: CostBreakdown): string {
  const excluded = breakdown.excludedTurns > 0 ? `、単価不明または内訳のない ${breakdown.excludedTurns} ターンを除く` : ''
  return `内訳の合計 ${formatUsd(breakdown.totalUsd)}（推定の下限と同じ基準。書込は 5 分単価${excluded}。1 時間 TTL ならもっと大きくなる幅があります）`
}

export type BreakdownView = {
  readonly items: string
  /** 書込や出力が大きいときの手がかり。大きくなければ null。 */
  readonly hint: string | null
  readonly note: string
}

/** 表示用の内訳。出せなければ null。 */
export function breakdownView(records: readonly TurnRecord[], archived?: ArchivedTurns): BreakdownView | null {
  const breakdown = costBreakdown(records, archived)
  return breakdown === null ? null : { items: breakdownItems(breakdown), hint: breakdownHint(breakdown), note: breakdownNote(breakdown) }
}
