// 行モデルの型。ペインの描画（pane-view.tsx）と組立（pane-model.ts / pane-sections.ts）が共有する。
import type { Level } from './analyze'
import type { BarRun, Stage } from './pane-bar'

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
