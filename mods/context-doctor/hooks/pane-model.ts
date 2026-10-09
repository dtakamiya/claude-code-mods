// 純粋関数: ペインの値 + 所見 + 幅 → 描画用の行モデル。`$` にも JSX にも依存しない。
import { fmt, type Finding, type Level, type Snapshot } from './analyze'
import type { PaneView } from '../types'

/** 仮置き: これ未満の本文幅ではコンパクト表示にする。目視確認の結果で調整する。 */
export const NARROW_BODY_COLUMNS = 40

const SUPPORTED_VIEW_VERSION = 1
const TOP_N = 3
const LEVEL_LABEL: Record<Level, string> = { high: '要対応', mid: '注意', info: '参考' }
const EMPTY_MESSAGE = 'まだ内訳がありません（最初の応答後に開き直してください）'
const pad2 = (n: number) => String(n).padStart(2, '0')

export type PaneRow = {
  kind: 'message' | 'heading' | 'usage' | 'bar' | 'item' | 'finding' | 'note'
  text: string
  /** 0〜1。bar / item の長さ。 */
  ratio?: number
  /** finding の行頭（所見の最初の行）なら重大度。 */
  level?: Level
}

export type PaneModelInput = {
  view: PaneView
  findings: readonly Finding[]
  bodyColumns: number
  /** 通常は view.measuredAtMs。無ければ測定時刻は出さない。 */
  measuredAtMs?: number
}

const ratioOf = (n: number, total: number) => (total > 0 ? Math.min(1, Math.max(0, n / total)) : 0)
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
const sumTokens = (xs: readonly { tokens: number }[]) => xs.reduce((a, c) => a + c.tokens, 0)

function topUsed(s: Snapshot) {
  return [...s.categories].filter(c => c.kind === 'used').sort((a, b) => b.tokens - a.tokens).slice(0, TOP_N)
}

function remainingText(s: Snapshot, compact: boolean): string | undefined {
  if (!s.isAutoCompactEnabled || s.autoCompactThreshold === undefined) return undefined
  const left = s.autoCompactThreshold - s.totalTokens
  if (left <= 0) return `圧縮点を ${fmt(-left)} 超過`
  return compact ? `圧縮点まで ${fmt(left)}` : `圧縮点 ${fmt(s.autoCompactThreshold)} まで ${fmt(left)}`
}

function findingRows(f: Finding): PaneRow[] {
  const head: PaneRow = { kind: 'finding', level: f.level, text: `[${LEVEL_LABEL[f.level]}] 観察: ${f.observation}` }
  const rest: PaneRow[] = [
    ...(f.hypothesis ? [{ kind: 'finding' as const, text: `仮説: ${f.hypothesis}` }] : []),
    ...(f.suggestion ? [{ kind: 'finding' as const, text: `→ ${f.suggestion}` }] : []),
  ]
  return [head, ...rest]
}

function regularRows(s: Snapshot, findings: readonly Finding[], at?: number): PaneRow[] {
  const remaining = remainingText(s, false)
  const used = topUsed(s)
  const kindSum = (k: 'free' | 'buffer') => sumTokens(s.categories.filter(c => c.kind === k))
  return [
    { kind: 'usage', text: `コンテキスト ${s.percentage}%   ${fmt(s.totalTokens)} / ${fmt(s.maxTokens)} トークン（推定）` },
    { kind: 'bar', ratio: ratioOf(s.totalTokens, s.maxTokens), text: remaining ?? '' },
    { kind: 'heading', text: '内訳（使用上位）' },
    ...used.map((c): PaneRow => ({ kind: 'item', text: `${c.name} ${fmt(c.tokens)}`, ratio: ratioOf(c.tokens, s.maxTokens) })),
    { kind: 'note', text: `空き ${fmt(kindSum('free'))} ／ 圧縮バッファ ${fmt(kindSum('buffer'))}` },
    { kind: 'heading', text: '所見' },
    ...(findings.length === 0 ? [{ kind: 'message' as const, text: '所見なし。' }] : findings.flatMap(findingRows)),
    { kind: 'note', text: `${at === undefined ? '' : `測定 ${clock(at)}`}（推定値）  ※しきい値は仮置き`.trim() },
  ]
}

function compactRows(s: Snapshot, findings: readonly Finding[], at?: number): PaneRow[] {
  const remaining = remainingText(s, true)
  const used = topUsed(s)
  return [
    { kind: 'usage', text: `ctx ${s.percentage}% ${fmt(s.totalTokens)}/${fmt(s.maxTokens)}` },
    ...(remaining ? [{ kind: 'note' as const, text: remaining }] : []),
    ...used.map((c, i): PaneRow => ({ kind: 'item', text: `${i === 0 ? '上位: ' : '      '}${c.name} ${fmt(c.tokens)}` })),
    ...findings.map((f): PaneRow => ({ kind: 'finding', level: f.level, text: `[${LEVEL_LABEL[f.level]}] ${f.observation}` })),
    { kind: 'note', text: `${at === undefined ? '' : `測定 ${clock(at)} `}推定値`.trim() },
  ]
}

/** 空・版違い・Snapshot なしは「内訳なし」の1行。それ以外は幅に応じて通常／コンパクト。 */
export function buildPaneRows(input: PaneModelInput): readonly PaneRow[] {
  const { view, findings, bodyColumns } = input
  const at = input.measuredAtMs ?? view.measuredAtMs
  if (view.v !== SUPPORTED_VIEW_VERSION || view.status !== 'ok' || !view.snapshot) {
    return [{ kind: 'message', text: EMPTY_MESSAGE }]
  }
  return bodyColumns < NARROW_BODY_COLUMNS
    ? compactRows(view.snapshot, findings, at)
    : regularRows(view.snapshot, findings, at)
}
