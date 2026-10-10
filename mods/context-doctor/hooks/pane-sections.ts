// 純粋関数: ペインの各セクション（ヘッダ・所見・内訳）の行を組み立てる。`$` に依存しない。
import { fmt, THRESHOLDS, type Finding, type Level, type Row, type Snapshot } from './analyze'
import { buildBarRuns, STAGE_LABEL, stageOf } from './pane-bar'
import { displayWidth, padEndWidth, padStartWidth } from './pane-text'
import type { PaneRow } from './pane-row'

export type Tier = 'narrow' | 'regular' | 'wide'

/** 仮置き: 内訳の名前列の表示幅。 */
const NAME_WIDTH = 18
const TOKEN_WIDTH = 7
const PERCENT_WIDTH = 4
const NARROW_PERCENT_WIDTH = 5
/** 仮置き: ミニバーの倍率（割合 × この値）と上限桁数。 */
const MINI_BAR_SCALE = 16
const MINI_BAR_MAX = 8
/** 仮置き: 通常以上でのバー幅の上限と、狭幅で差し引く桁数（`[` `]` と余白）。 */
const BAR_WIDTH_MAX = 40
const NARROW_BAR_MARGIN = 4
const LEVEL_LABEL: Partial<Record<Level, string>> = { high: '要対応', mid: '注意' }
const LEVEL_RANK: Record<Level, number> = { high: 0, mid: 1, info: 2 }
const NO_FINDING_TEXT = '所見なし（今すぐ効く対応はありません）'

const share = (n: number, total: number) => (total > 0 ? n / total : 0)
const percent = (n: number, total: number) => `${Math.round(share(n, total) * 100)}%`
const sumOf = (xs: readonly { tokens: number }[]) => xs.reduce((a, c) => a + c.tokens, 0)

function remainingText(s: Snapshot): string {
  if (!s.isAutoCompactEnabled || s.autoCompactThreshold === undefined) {
    return `自動圧縮は無効（${THRESHOLDS.fallbackPercent}% で要対応・仮置き）`
  }
  const left = s.autoCompactThreshold - s.totalTokens
  return left <= 0 ? `圧縮点を ${fmt(-left)} 超過` : `圧縮点まで ${fmt(left)}`
}

function legendText(s: Snapshot): string {
  const buffer = sumOf(s.categories.filter(c => c.kind === 'buffer'))
  if (!s.isAutoCompactEnabled || s.autoCompactThreshold === undefined) return ' █使用  ░空き'
  return ` █使用  ▒余裕  ┃圧縮点 ${fmt(s.autoCompactThreshold)}  ░バッファ ${fmt(buffer)}`
}

/** 使用率・段階・バー（・凡例）。tier で行の分け方が変わる。 */
export function headerRows(s: Snapshot, tier: Tier, bodyColumns: number, showLegend: boolean): PaneRow[] {
  const stage = stageOf(s)
  const label = `[${STAGE_LABEL[stage]}]`
  const tail = remainingText(s)
  const barWidth = tier === 'narrow' ? Math.max(1, Math.min(BAR_WIDTH_MAX, bodyColumns - NARROW_BAR_MARGIN)) : BAR_WIDTH_MAX
  const bar: PaneRow = { kind: 'bar', text: '', stage, runs: buildBarRuns(s, barWidth) }
  const legend: PaneRow[] = showLegend && tier !== 'narrow' ? [{ kind: 'legend', text: legendText(s) }] : []
  if (tier === 'narrow') return [{ kind: 'usage', text: `${s.percentage}%`, label, stage }, bar, { kind: 'note', text: tail }]
  const unit = tier === 'wide' ? ' トークン' : ''
  const text = `${s.percentage}% 使用  ${fmt(s.totalTokens)} / ${fmt(s.maxTokens)}${unit}（推定）`
  if (tier === 'wide') return [{ kind: 'usage', text, label, tail, stage }, bar, ...legend]
  return [{ kind: 'usage', text }, { kind: 'stage', text: '', label, tail, stage }, bar, ...legend]
}

/** 重大度順、同順位は回収トークンの多い順（安定）。high / mid のみ。 */
export function pickFindings(findings: readonly Finding[], max: number): Finding[] {
  return findings
    .filter(f => f.level !== 'info')
    .map((f, i) => ({ f, i }))
    .sort((a, b) => LEVEL_RANK[a.f.level] - LEVEL_RANK[b.f.level] || (b.f.tokens ?? 0) - (a.f.tokens ?? 0) || a.i - b.i)
    .slice(0, max)
    .map(x => x.f)
}

export function findingRows(shown: readonly Finding[], tier: Tier): PaneRow[] {
  if (shown.length === 0) return [{ kind: 'message', text: NO_FINDING_TEXT }]
  const narrow = tier === 'narrow'
  const headlineOf = (f: Finding) => (narrow ? (f.shortHeadline ?? f.headline) : f.headline) ?? f.observation
  const actionOf = (f: Finding) => (narrow ? (f.shortAction ?? f.action) : f.action)
  const labelOf = (f: Finding) => `[${LEVEL_LABEL[f.level] ?? ''}]`
  if (tier === 'wide') {
    const width = Math.max(...shown.map(f => displayWidth(headlineOf(f))))
    return shown.map(f => ({ kind: 'finding', level: f.level, label: labelOf(f), text: padEndWidth(headlineOf(f), width), tail: actionOf(f) }))
  }
  return shown.flatMap((f): PaneRow[] => [
    { kind: 'finding', level: f.level, label: labelOf(f), text: headlineOf(f) },
    ...(actionOf(f) ? [{ kind: 'action' as const, text: actionOf(f) as string }] : []),
  ])
}

type BreakdownItem = Row & { kind: 'used' | 'free' | 'buffer' }

/** used・free・buffer を tokens 降順（安定）に。deferred は含めない。 */
function breakdownItems(s: Snapshot): BreakdownItem[] {
  return s.categories
    .filter((c): c is BreakdownItem => c.kind !== 'deferred')
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.tokens - a.c.tokens || a.i - b.i)
    .map(x => x.c)
}

export const breakdownCount = (s: Snapshot) => breakdownItems(s).length

function itemRow(c: BreakdownItem, s: Snapshot, narrow: boolean): PaneRow {
  const pct = percent(c.tokens, s.maxTokens)
  const name = padEndWidth(c.name, NAME_WIDTH)
  if (narrow) return { kind: 'item', itemKind: c.kind, text: `${name}${padStartWidth(pct, NARROW_PERCENT_WIDTH)}` }
  const barLen = c.tokens > 0 ? Math.min(MINI_BAR_MAX, Math.max(1, Math.round(share(c.tokens, s.maxTokens) * MINI_BAR_SCALE))) : 0
  return {
    kind: 'item',
    itemKind: c.kind,
    text: `${name} ${padStartWidth(fmt(c.tokens), TOKEN_WIDTH)} ${padStartWidth(pct, PERCENT_WIDTH)}`,
    barLen,
  }
}

/** `visible` 件を超える下位は `他 n 件 合計 x%` に畳む。割合の合計は保つ。 */
export function breakdownRows(s: Snapshot, tier: Tier, visible: number, showDeferred: boolean): PaneRow[] {
  const items = breakdownItems(s)
  const narrow = tier === 'narrow'
  const shown = items.slice(0, visible)
  const rest = items.slice(visible)
  const folded: PaneRow[] =
    rest.length === 0
      ? []
      : [{ kind: 'note', text: `他 ${rest.length} 件 合計 ${percent(sumOf(rest), s.maxTokens)}` }]
  const deferred = sumOf(s.categories.filter(c => c.kind === 'deferred'))
  const deferredRow: PaneRow[] = showDeferred && deferred > 0 && !narrow ? [{ kind: 'note', text: `窓外（遅延読込） ${fmt(deferred)}` }] : []
  return [
    { kind: 'heading', text: narrow ? '内訳' : '内訳（窓に占める割合・降順）' },
    ...shown.map(c => itemRow(c, s, narrow)),
    ...folded,
    ...deferredRow,
  ]
}

const REFERENCE_MAX = 3
export function referenceRows(findings: readonly Finding[]): PaneRow[] {
  const infos = findings.filter(f => f.level === 'info').slice(0, REFERENCE_MAX)
  if (infos.length === 0) return []
  return [{ kind: 'heading', text: '参考' }, ...infos.map((f): PaneRow => ({ kind: 'reference', text: `・${f.headline ?? f.observation}` }))]
}
