// ペインとテキストレポートが使う集計を、1 回の呼び出しでまとめて求める。$ に触れない純粋関数。
// 描画は最大で毎秒 10 回走るが、記録（ReviewState）が変わるのはターンの完了とコストの測定のときだけ。
// 同じ記録・同じ設定・同じ日なら、前回の結果をそのまま返す（描画のたびに最大 500 ターン分を数え直さない）。
import type { ArchivedGroup, ReviewState, TurnRecord } from '../types'
import { groupByModelEffort, findConcerns, partitionByRecency, topCostTurns, type Concern, type ConcernKind } from './analyze'
import { archiveNote, mergeGroups } from './archive'
import { breakdownView, type BreakdownView } from './breakdown'
import { conclusionOf, saysNoConcerns, type Conclusion, type PriceCoverage } from './conclusion'
import { numericEffortNote } from './effort'
import { growthView, type GrowthView } from './growth'
import { applyMute } from './mute'
import { nextStepText } from './nextstep'
import { buildNotes, splitNotes, type Note } from './notes'
import {
  advisorCallText,
  costDiff,
  describeSwitchOptions,
  estimateFacts,
  loopView,
  subagentCount,
  type CostDiff,
  type EstimateFacts,
  type LoopView,
} from './summary'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export type ReviewAnalysis = {
  readonly records: readonly TurnRecord[]
  readonly archived: ReviewState['archived']
  /** 畳んだぶんを含む全ターン数と、そのうちのサブエージェントのターン数。 */
  readonly totalTurns: number
  readonly subagents: number
  readonly estimate: EstimateFacts
  readonly coverage: PriceCoverage
  /** 止めている種類を除いた指摘と、止めている種類の 1 行。 */
  readonly concerns: readonly Concern[]
  readonly mutedLine: string | null
  readonly recent: readonly Concern[]
  readonly past: readonly Concern[]
  /** 直近の指摘ごとの「次の一手」（なければ null）。過去の指摘には付けない。 */
  readonly nextSteps: ReadonlyMap<Concern, string | null>
  readonly groups: readonly ArchivedGroup[]
  /** 注記（テキストの並び順のまま）と、その動的な警告・信頼度への分け方。 */
  readonly notes: readonly Note[]
  readonly alerts: readonly Note[]
  readonly reliability: readonly Note[]
  readonly conclusion: Conclusion
  /** 結論が「目立った指摘なし」を言っているか（ペインで OK 行と空の見出しを出さないため）。 */
  readonly noConcerns: boolean
  readonly diff: CostDiff | null
  readonly switchOptions: readonly string[]
  readonly loop: LoopView | null
  readonly breakdown: BreakdownView | null
  readonly growth: GrowthView | null
  readonly advisorText: string | null
  readonly archiveNote: string | null
  readonly numericNote: string | null
  readonly topTurns: readonly TurnRecord[]
}

function computeAnalysis(review: ReviewState, nowMs: number | undefined, muted: ReadonlySet<ConcernKind>): ReviewAnalysis {
  const records = review.turns
  const archived = review.archived
  const estimate = estimateFacts(records, archived)
  const totalTurns = records.length + (archived?.turns ?? 0)
  const coverage: PriceCoverage = { unpricedTurns: estimate.unpricedTurns, totalTurns }
  const { concerns, mutedLine } = applyMute(findConcerns(records), muted)
  const { recent, past } = partitionByRecency(concerns)
  const notes = buildNotes(review, nowMs)
  const { alerts, reliability } = splitNotes(notes)
  return {
    records,
    archived,
    totalTurns,
    subagents: subagentCount(records, archived),
    estimate,
    coverage,
    concerns,
    mutedLine,
    recent,
    past,
    nextSteps: new Map(recent.map(concern => [concern, nextStepText(concern, records)])),
    groups: mergeGroups(archived, groupByModelEffort(records)),
    notes,
    alerts,
    reliability,
    conclusion: conclusionOf(concerns, alerts, coverage),
    noConcerns: saysNoConcerns(concerns, alerts, coverage),
    diff: costDiff(review),
    switchOptions: describeSwitchOptions(records),
    loop: loopView(records),
    breakdown: breakdownView(records, archived),
    growth: growthView(records, archived?.turns),
    advisorText: advisorCallText(records, archived),
    archiveNote: archiveNote(archived),
    numericNote: numericEffortNote(records, archived),
    topTurns: topCostTurns(records),
  }
}

type CacheEntry = {
  readonly review: ReviewState
  readonly muted: ReadonlySet<ConcernKind>
  /** 時刻に依存するのは単価表の古さの注記（日単位）だけなので、日が変わるまでは同じ結果を使える。 */
  readonly day: number | null
  readonly analysis: ReviewAnalysis
}

let cache: CacheEntry | null = null

const EMPTY_MUTED: ReadonlySet<ConcernKind> = new Set()

const dayOf = (nowMs: number | undefined): number | null => (nowMs === undefined || !Number.isFinite(nowMs) ? null : Math.floor(nowMs / MS_PER_DAY))

/**
 * 集計をまとめて返す。記録・止めている種類（の Set）・日が前回と同じなら、前回の結果をそのまま返す。
 * 記録は値を差し替える（書き換えない）ので、同じ参照なら中身も同じとみなせる。
 */
export function analyzeReview(review: ReviewState, nowMs?: number, muted: ReadonlySet<ConcernKind> = EMPTY_MUTED): ReviewAnalysis {
  const day = dayOf(nowMs)
  if (cache !== null && cache.review === review && cache.muted === muted && cache.day === day) return cache.analysis
  const analysis = computeAnalysis(review, nowMs, muted)
  cache = { review, muted, day, analysis }
  return analysis
}
