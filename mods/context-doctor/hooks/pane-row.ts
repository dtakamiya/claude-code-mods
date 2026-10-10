// 行モデルの型。ペインの描画（pane-view.tsx）と組立（pane-model.ts / pane-sections.ts）が共有する。
import type { Level } from './analyze'
import type { BarRun, Stage } from './pane-bar'
import { displayWidth } from './pane-text'

export type PaneRowKind =
  | 'message'
  | 'blank'
  | 'heading'
  | 'usage'
  | 'stage'
  | 'bar'
  | 'legend'
  | 'finding'
  | 'action'
  | 'item'
  | 'note'
  | 'reference'

export type PaneRow = {
  kind: PaneRowKind
  text: string
  /** usage / stage / finding の行頭ラベル（`[注意]` など）。 */
  label?: string
  /** usage / stage: ラベルの横に出す補足（圧縮点まで N）。finding: 同じ行に連結するアクション。 */
  tail?: string
  stage?: Stage
  /** finding の重大度。 */
  level?: Level
  /** bar のセル配分。 */
  runs?: readonly BarRun[]
  /** item のカテゴリ種別と、ミニバーの桁数（0 ならバーなし）。 */
  itemKind?: 'used' | 'free' | 'buffer'
  barLen?: number
}

// pane-view.tsx が実際に並べる文字列と同じ幅の計算。モデルの幅予算とテストが共有する。
export const ACTION_PREFIX = '→ '
export const ACTION_INDENT = '  '
export const FINDING_GAP = '  '
const BAR_FRAME_WIDTH = 3 // ' [' と ']'
const LABEL_GAP = 2
const TAIL_GAP = 1
const ITEM_BAR_GAP = 1
const LABEL_TEXT_GAP = 1

/** 行を描いたときの表示桁数。曖昧幅の記号（█ ▒ ┃ ░ →）は 1 桁と数える。 */
export function rowWidth(row: PaneRow): number {
  const w = displayWidth
  switch (row.kind) {
    case 'bar':
      return BAR_FRAME_WIDTH + (row.runs ?? []).reduce((n, r) => n + r.count, 0)
    case 'usage':
    case 'stage':
      return w(row.text) + (row.label ? (row.text ? LABEL_GAP : 0) + w(row.label) : 0) + (row.tail ? TAIL_GAP + w(row.tail) : 0)
    case 'finding':
      return w(row.label ?? '') + LABEL_TEXT_GAP + w(row.text) + (row.tail ? w(FINDING_GAP + ACTION_PREFIX) + w(row.tail) : 0)
    case 'action':
      return w(ACTION_INDENT + ACTION_PREFIX + row.text)
    case 'item':
      return w(row.text) + (row.barLen ? ITEM_BAR_GAP + row.barLen : 0)
    default:
      return w(row.text)
  }
}
