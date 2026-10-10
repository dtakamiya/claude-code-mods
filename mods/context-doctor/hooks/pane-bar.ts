// 純粋関数: 使用率の段階判定と、1 本のバーのセル配分。`$` にも JSX にも依存しない。
import { THRESHOLDS, type Snapshot } from './analyze'

/** 仮置き（実測の裏付けなし）: 圧縮点までの残りが窓のこの割合以下なら「注意」。 */
export const WARN_COMPACT_SHARE = 0.15
/** 仮置き（実測の裏付けなし）: 自動圧縮が無効なとき、この使用率（%）以上で「注意」。 */
export const WARN_FALLBACK_PERCENT = 60

export type Stage = 'ok' | 'warn' | 'danger' | 'over'
export const STAGE_LABEL: Record<Stage, string> = { ok: '余裕', warn: '注意', danger: '危険', over: '超過' }

export type BarKind = 'used' | 'margin' | 'compact' | 'buffer' | 'free'
export type BarRun = { kind: BarKind; count: number }

const hasCompactPoint = (s: Snapshot): s is Snapshot & { autoCompactThreshold: number } =>
  s.isAutoCompactEnabled && s.autoCompactThreshold !== undefined

/** 段階は既存の所見（compactionFinding）と同じ条件にそろえる。 */
export function stageOf(s: Snapshot): Stage {
  if (hasCompactPoint(s)) {
    const left = s.autoCompactThreshold - s.totalTokens
    if (left <= 0) return 'over'
    if (s.maxTokens > 0 && left <= s.maxTokens * THRESHOLDS.nearCompactShare) return 'danger'
    if (s.maxTokens > 0 && left <= s.maxTokens * WARN_COMPACT_SHARE) return 'warn'
    return 'ok'
  }
  if (s.percentage >= THRESHOLDS.fallbackPercent) return 'danger'
  if (s.percentage >= WARN_FALLBACK_PERCENT) return 'warn'
  return 'ok'
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const cellOf = (amount: number, maxTokens: number, width: number) => (maxTokens > 0 ? Math.round((amount / maxTokens) * width) : 0)

function toRuns(kinds: readonly BarKind[]): BarRun[] {
  return kinds.reduce<BarRun[]>((runs, kind) => {
    const last = runs[runs.length - 1]
    return last?.kind === kind ? [...runs.slice(0, -1), { kind, count: last.count + 1 }] : [...runs, { kind, count: 1 }]
  }, [])
}

/** 幅 `width` のバー: 使用 → 余裕 → 圧縮点（常に 1 桁）→ バッファ。超過時は使用が圧縮点を越える。 */
export function buildBarRuns(s: Snapshot, width: number): BarRun[] {
  const w = Math.max(1, Math.floor(width))
  const used = clamp(cellOf(s.totalTokens, s.maxTokens, w), 0, w)
  if (!hasCompactPoint(s) || w < 2) {
    return toRuns(Array.from({ length: w }, (_, i): BarKind => (i < used ? 'used' : 'free')))
  }
  const compactAt = clamp(cellOf(s.autoCompactThreshold, s.maxTokens, w), 1, w - 1)
  return toRuns(
    Array.from({ length: w }, (_, i): BarKind => {
      if (i === compactAt) return 'compact'
      if (i < used) return 'used'
      return i < compactAt ? 'margin' : 'buffer'
    }),
  )
}
