// ペインとテキストレポートに並べる節の、種類・順序・中身（構造データ）。$ に触れない純粋関数。
// 節の順序と「出すかどうか」はここだけで決め、文言と並べ方はペイン（pane-model.ts）とテキスト（report.ts）がそれぞれ持つ。
// 先頭の結論・金額と、末尾の注記は描画ごとに形が違うので、節には含めない。
import type { ArchivedGroup, TurnRecord } from '../types'
import type { ReviewAnalysis } from './analysis'
import type { Concern } from './analyze'
import type { BreakdownView } from './breakdown'
import type { GrowthView } from './growth'
import type { FindingNote } from './notes'
import type { CostDiff, EstimateFacts, LoopView } from './summary'

export type ConcernsSection = {
  readonly kind: 'concerns'
  readonly recent: readonly Concern[]
  /** 所見の中の警告（再構築・TTL 乖離）。指摘の後・過去の指摘の前に出す。 */
  readonly findings: readonly FindingNote[]
  readonly past: readonly Concern[]
  readonly nextSteps: ReadonlyMap<Concern, string | null>
  readonly numericNote: string | null
  readonly mutedLine: string | null
  /** 結論が「目立った指摘なし」を言っているか。 */
  readonly noConcerns: boolean
}

export type GroupsSection = { readonly kind: 'groups'; readonly groups: readonly ArchivedGroup[]; readonly totalUsd: number }
export type TopTurnsSection = { readonly kind: 'topTurns'; readonly turns: readonly TurnRecord[]; readonly records: readonly TurnRecord[] }
export type LoopsSection = { readonly kind: 'loops'; readonly view: LoopView }
export type WhatIfSection = { readonly kind: 'whatIf'; readonly options: readonly string[] }

export type CostSection = {
  readonly kind: 'cost'
  readonly estimate: EstimateFacts
  readonly totalTurns: number
  readonly diff: CostDiff | null
  readonly breakdown: BreakdownView | null
  readonly growth: GrowthView | null
  readonly advisorText: string | null
}

export type Section = ConcernsSection | GroupsSection | TopTurnsSection | LoopsSection | WhatIfSection | CostSection

/**
 * 節を表示する順に並べる。中身のない任意の節（高コストターン・ループ別・いま切り替えたら）は入れない。
 * 所見・モデル × effort・コストの節は常に入れる（所見の節を空のときに出すかどうかは描画側が決める）。
 */
export function buildSections(analysis: ReviewAnalysis): readonly Section[] {
  const concerns: ConcernsSection = {
    kind: 'concerns',
    recent: analysis.recent,
    findings: analysis.findings,
    past: analysis.past,
    nextSteps: analysis.nextSteps,
    numericNote: analysis.numericNote,
    mutedLine: analysis.mutedLine,
    noConcerns: analysis.noConcerns,
  }
  const cost: CostSection = {
    kind: 'cost',
    estimate: analysis.estimate,
    totalTurns: analysis.totalTurns,
    diff: analysis.diff,
    breakdown: analysis.breakdown,
    growth: analysis.growth,
    advisorText: analysis.advisorText,
  }
  return [
    concerns,
    { kind: 'groups', groups: analysis.groups, totalUsd: analysis.estimate.costUsd },
    ...(analysis.topTurns.length === 0 ? [] : [{ kind: 'topTurns', turns: analysis.topTurns, records: analysis.records } satisfies TopTurnsSection]),
    ...(analysis.loop === null ? [] : [{ kind: 'loops', view: analysis.loop } satisfies LoopsSection]),
    ...(analysis.switchOptions.length === 0 ? [] : [{ kind: 'whatIf', options: analysis.switchOptions } satisfies WhatIfSection]),
    cost,
  ]
}
