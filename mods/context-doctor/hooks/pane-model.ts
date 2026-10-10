// 純粋関数: ペインの値 + 所見 + 幅・高さ → 描画用の行モデル。`$` にも JSX にも依存しない。
import type { Finding, Snapshot } from './analyze'
import type { PaneRow } from './pane-row'
import { breakdownCount, breakdownRows, findingRows, headerRows, pickFindings, referenceRows, type Tier } from './pane-sections'
import type { PaneView } from '../types'

export type { PaneRow } from './pane-row'

/** 仮置き: これ未満の本文幅では狭幅表示にする。目視確認の結果で調整する。 */
export const NARROW_BODY_COLUMNS = 40
/** 仮置き: この桁数以上で所見を 1 行に連結する。 */
export const WIDE_BODY_COLUMNS = 68

const SUPPORTED_VIEW_VERSION = 1
const MAX_FINDINGS = 3
const MAX_FINDINGS_NARROW = 2
const EMPTY_MESSAGE = 'まだ内訳がありません（最初の応答後に開き直してください）'
const pad2 = (n: number) => String(n).padStart(2, '0')

export type PaneModelInput = {
  view: PaneView
  findings: readonly Finding[]
  bodyColumns: number
  /** `dock`（fullscreen の横置き）のときだけ「参考」を出す。 */
  placement?: 'dock' | 'inline'
  /** 本体が使える行数。超えるときは下位の情報から省く。無ければ省かない。 */
  bodyRows?: number
  /** 通常は view.measuredAtMs。無ければ測定時刻は出さない。 */
  measuredAtMs?: number
}

/** 何を出すか。高さが足りないとき、`RELAXATIONS` の順に 1 つずつ緩める。 */
type Options = {
  reference: boolean
  deferred: boolean
  footer: boolean
  legend: boolean
  findingCount: number
  /** 内訳の表示件数（超えた分は畳む）。 */
  breakdownVisible: number
}

const RELAXATIONS: readonly ((o: Options) => Options)[] = [
  o => ({ ...o, reference: false }),
  o => ({ ...o, deferred: false }),
  o => ({ ...o, footer: false }),
  o => ({ ...o, legend: false }),
  o => ({ ...o, findingCount: Math.min(o.findingCount, 2) }),
  o => ({ ...o, findingCount: 1 }),
]

const tierOf = (bodyColumns: number): Tier =>
  bodyColumns < NARROW_BODY_COLUMNS ? 'narrow' : bodyColumns >= WIDE_BODY_COLUMNS ? 'wide' : 'regular'

const clock = (ms: number) => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`

function footerRow(tier: Tier, at?: number): PaneRow {
  const time = at === undefined ? '' : clock(at)
  const text = tier === 'narrow' ? `${time} 推定値` : `${at === undefined ? '' : `測定 ${time} ・`}推定値 ・しきい値は仮置き`
  return { kind: 'note', text: text.trim() }
}

const BLANK: PaneRow = { kind: 'blank', text: '' }

function compose(s: Snapshot, findings: readonly Finding[], tier: Tier, input: PaneModelInput, o: Options, at?: number): PaneRow[] {
  const shown = pickFindings(findings, o.findingCount)
  const reference = o.reference && input.placement === 'dock' ? referenceRows(findings, input.bodyColumns) : []
  return [
    ...headerRows(s, tier, input.bodyColumns, o.legend),
    BLANK,
    { kind: 'heading', text: tier === 'narrow' ? '所見' : '所見（今すぐ効く順）' },
    ...findingRows(shown, tier, input.bodyColumns),
    BLANK,
    ...breakdownRows(s, tier, o.breakdownVisible, o.deferred),
    ...(reference.length > 0 ? [BLANK, ...reference] : []),
    ...(o.footer ? [BLANK, footerRow(tier, at)] : []),
  ]
}

/** 空・版違い・Snapshot なしは「内訳なし」の1行。それ以外は幅に応じた 3 段、高さに応じて省略。 */
export function buildPaneRows(input: PaneModelInput): readonly PaneRow[] {
  const { view, findings, bodyColumns, bodyRows } = input
  const at = input.measuredAtMs ?? view.measuredAtMs
  if (view.v !== SUPPORTED_VIEW_VERSION || view.status !== 'ok' || !view.snapshot) {
    return [{ kind: 'message', text: EMPTY_MESSAGE }]
  }
  const s: Snapshot = view.snapshot
  const tier = tierOf(bodyColumns)
  const total = breakdownCount(s)
  const initial: Options = {
    reference: true,
    deferred: true,
    footer: true,
    legend: true,
    findingCount: tier === 'narrow' ? MAX_FINDINGS_NARROW : MAX_FINDINGS,
    breakdownVisible: total,
  }
  const build = (o: Options) => compose(s, findings, tier, input, o, at)
  if (bodyRows === undefined) return build(initial)

  const relaxed = RELAXATIONS.reduce(
    (o, relax) => (build(o).length > bodyRows ? relax(o) : o),
    initial,
  )
  // 内訳は、収まるまで下位を 1 件ずつ畳む（畳む行が 1 行増えるので、2 件以上減らせるときだけ）。
  const fitted = Array.from({ length: Math.max(0, total - 1) }, (_, i) => total - 2 - i)
    .filter(v => v >= 1)
    .reduce((o, v) => (build(o).length > bodyRows ? { ...o, breakdownVisible: v } : o), relaxed)
  return build(fitted)
}
