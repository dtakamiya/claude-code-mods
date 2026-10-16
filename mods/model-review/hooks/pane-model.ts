// ペインの行モデルを組み立てる純粋関数。`$` にも JSX にも依存しない。描画は pane.tsx。
// 集計と文面の共通部分は summary.ts。ここはペイン固有の並び・バー・用語・結論行を持つ。
import type { ReviewState } from '../types'
import {
  HEAVY_TOOL_CALLS,
  LIGHT_MAX_OUTPUT_TOKENS,
  LIGHT_MAX_TOOL_CALLS,
  findConcerns,
  groupByModelEffort,
  modelRank,
  topCostTurns,
  type Concern,
  type ConcernKind,
  type ModelGroup,
} from './analyze'
import { formatUsd, formatUsdRange } from './format'
import type { Drafts, LoopDraft } from './recorder'
import { CONCLUSION_NONE_TEXT, CONCLUSION_NO_RECORDS_TEXT, CONCERN_TEXT, HEADING, NO_CONCERNS_TEXT, TERM_TEXT, type TermKey } from './labels'
import { WHATIF_NOTE } from './whatif'
import { ALWAYS_NOTE, buildNotes } from './notes'
import {
  NO_TURNS_LINE,
  actualCostUsd,
  advisorCallText,
  allUnpricedText,
  concernDetailText,
  describeSwitchOptions,
  estimateFacts,
  groupFacts,
  hitRateText,
  loopView,
  subagentCount,
  toolDetailText,
  turnOriginLabel,
  unpricedExclusionText,
  type EstimateFacts,
} from './summary'

export const BAR_WIDTH = 14
/** 状況に応じた警告（buildNotes）のバッジ。常に出す免責・判定基準（dim の注記）と見分ける。 */
export const ALERT_LABEL = '注意'
const MODEL_ID_PREFIX = 'claude-'

export type Tone = 'success' | 'warning' | 'error' | 'suggestion' | 'plain'
export type Tier = 'haiku' | 'sonnet' | 'opus' | 'other'

export type PaneRow =
  | { kind: 'conclusion'; text: string; tone: Tone }
  | { kind: 'message'; text: string }
  | { kind: 'blank' }
  | { kind: 'title'; turns: number; subagents: number; costText: string }
  | { kind: 'heading'; text: string }
  | { kind: 'group'; model: string; effort: string; tier: Tier; turns: number; filled: number; percentText: string; costText: string; tokenText: string; cacheText: string }
  | { kind: 'turn'; label: string; model: string; tier: Tier; costText: string; detail: string }
  | { kind: 'kv'; label: string; value: string; tone: Tone }
  | { kind: 'badge'; label: string; tone: Tone; text: string }
  | { kind: 'example'; text: string }
  | { kind: 'ok'; text: string }
  | { kind: 'note'; text: string }

const TIER_OF_RANK: Readonly<Record<number, Tier>> = { 0: 'haiku', 1: 'sonnet', 2: 'opus' }
const CONCERN_TONE: Readonly<Record<ConcernKind, Tone>> = {
  overspec: 'warning',
  underspec: 'error',
  delegation: 'suggestion',
  subagent: 'warning',
  switch: 'warning',
}

const tierOf = (model: string): Tier => TIER_OF_RANK[modelRank(model)] ?? 'other'
const shortModel = (model: string): string => (model.startsWith(MODEL_ID_PREFIX) ? model.slice(MODEL_ID_PREFIX.length) : model)

const MIN_VISIBLE_SHARE = 0.01

/** コスト比（0〜1）。単価不明（null）や合計 0 は null。 */
function costShare(costUsd: number | null, totalUsd: number): number | null {
  if (costUsd === null || totalUsd <= 0) return null
  return costUsd / totalUsd
}

/** コスト比を 0〜BAR_WIDTH のセル数にする。1% 未満は 0、それ以上は最低 1 セル。 */
function filledCells(share: number | null): number {
  if (share === null || share < MIN_VISIBLE_SHARE) return 0
  return Math.min(BAR_WIDTH, Math.max(1, Math.round(share * BAR_WIDTH)))
}

function percentText(share: number | null): string {
  if (share === null) return ''
  return share < MIN_VISIBLE_SHARE ? '<1%' : `${Math.round(share * 100)}%`
}

function groupRow(group: ModelGroup, totalUsd: number): PaneRow {
  const facts = groupFacts(group)
  const share = costShare(group.costUsd, totalUsd)
  return {
    kind: 'group',
    model: shortModel(group.model),
    effort: facts.effort,
    tier: tierOf(group.model),
    turns: group.turns,
    filled: filledCells(share),
    percentText: percentText(share),
    costText: facts.costText,
    tokenText: `${facts.hit === null ? '' : `${facts.hit} · `}入力 ${facts.input} · 出力 ${facts.output}`,
    cacheText: `キャッシュ 読 ${facts.cacheRead} / 書 ${facts.cacheWrite}`,
  }
}

function costRows(review: ReviewState, estimate: EstimateFacts): PaneRow[] {
  const unpriced = estimate.unpricedTurns > 0 ? ` ${unpricedExclusionText(estimate.unpricedTurns)}` : ''
  const estimateText = estimate.allUnpriced
    ? allUnpricedText(estimate.unpricedTurns)
    : `${formatUsdRange(estimate.lowUsd, estimate.highUsd)}${unpriced}`
  const actual = actualCostUsd(review)
  if (actual === null) {
    return [{ kind: 'kv', label: 'コスト', value: `推定 ${estimateText} / 実コスト 取得できません`, tone: 'plain' }]
  }
  const diff = actual - estimate.costUsd
  const diffText = `${diff >= 0 ? '+' : '-'}${formatUsd(Math.abs(diff))}`
  return [{ kind: 'kv', label: 'コスト', value: `推定 ${estimateText} / 実 ${formatUsd(actual)}（読み込み後）/ 差 ${diffText}`, tone: 'plain' }]
}

function concernRows(concerns: readonly Concern[]): PaneRow[] {
  if (concerns.length === 0) return [{ kind: 'ok', text: NO_CONCERNS_TEXT }]
  return concerns.flatMap((concern): PaneRow[] => [
    { kind: 'badge', label: CONCERN_TEXT[concern.kind].label, tone: CONCERN_TONE[concern.kind], text: concernDetailText(concern) },
    ...concern.examples.map((text): PaneRow => ({ kind: 'example', text })),
  ])
}

function topTurnRows(records: ReviewState['turns']): PaneRow[] {
  const top = topCostTurns(records)
  if (top.length === 0) return []
  return [
    { kind: 'heading', text: HEADING.topTurns },
    ...top.map((record): PaneRow => ({
      kind: 'turn',
      label: `${record.turnId} · ${turnOriginLabel(record)}`,
      model: shortModel(record.model),
      tier: tierOf(record.model),
      costText: formatUsd(record.costUsd),
      detail: toolDetailText(record),
    })),
    { kind: 'blank' },
  ]
}

/** メインとサブエージェントの両方があるときだけ出す。 */
function loopRows(records: ReviewState['turns']): PaneRow[] {
  const view = loopView(records)
  if (view === null) return []
  return [
    { kind: 'heading', text: HEADING.loops },
    ...view.rows.map((row): PaneRow => ({ kind: 'kv', label: row.label, value: row.detail, tone: 'plain' })),
    ...(view.subagentNote === null ? [] : [{ kind: 'note', text: view.subagentNote } as const]),
    { kind: 'blank' },
  ]
}

function whatIfRows(records: ReviewState['turns']): PaneRow[] {
  const options = describeSwitchOptions(records)
  if (options.length === 0) return []
  return [
    { kind: 'heading', text: HEADING.whatIf },
    ...options.map((text): PaneRow => ({ kind: 'example', text })),
    { kind: 'note', text: WHATIF_NOTE },
    { kind: 'blank' },
  ]
}

function advisorRows(records: ReviewState['turns']): PaneRow[] {
  const text = advisorCallText(records)
  return text === null ? [] : [{ kind: 'kv', label: 'advisor', value: text, tone: 'plain' }]
}

const NO_RECORDS_CONCLUSION: PaneRow = { kind: 'conclusion', text: `結論: ${CONCLUSION_NO_RECORDS_TEXT}`, tone: 'plain' }

/** 結論の 1 行。件数のある種類だけ、ConcernKind の短い名前で並べる。 */
function conclusionRow(concerns: readonly Concern[]): PaneRow {
  const present = concerns.filter(concern => concern.count > 0)
  const total = present.reduce((sum, concern) => sum + concern.count, 0)
  if (total === 0) return { kind: 'conclusion', text: `結論: ${CONCLUSION_NONE_TEXT}`, tone: 'success' }
  const parts = present.map(concern => `${CONCERN_TEXT[concern.kind].label} ${concern.count}`).join(' / ')
  return { kind: 'conclusion', text: `結論: 見直し候補 ${total} 件（${parts}）`, tone: 'plain' }
}

/** 画面に出る行と同じ条件で、説明すべき用語を選ぶ。 */
function shownTerms(review: ReviewState, groups: readonly ModelGroup[], concerns: readonly Concern[]): TermKey[] {
  const hasActual = actualCostUsd(review) !== null
  const candidates: ReadonlyArray<readonly [TermKey, boolean]> = [
    ['hitRate', groups.some(group => hitRateText(group.tokens) !== null)],
    ['afterLoad', hasActual],
    ['sonnetEquivalent', concerns.some(concern => concern.kind === 'overspec' && concern.amountUsd !== null)],
    ['diff', hasActual],
  ]
  return candidates.flatMap(([term, shown]) => (shown ? [term] : []))
}

function glossaryRows(terms: readonly TermKey[]): PaneRow[] {
  if (terms.length === 0) return []
  return [{ kind: 'note', text: `用語  ${terms.map(term => TERM_TEXT[term]).join(' / ')}` }]
}

const concernHeading = (concerns: readonly Concern[]): string => {
  const total = concerns.reduce((sum, concern) => sum + concern.count, 0)
  return total === 0 ? HEADING.concerns : `${HEADING.concerns}· 指摘 ${total} 件`
}

const CRITERIA_NOTE = `軽作業 = ツール ${LIGHT_MAX_TOOL_CALLS} 回以下・編集なし・出力 ${LIGHT_MAX_OUTPUT_TOKENS} tokens 以下 / 重い = ツール ${HEAVY_TOOL_CALLS} 回以上・長時間・エラー`

const isStarted = (draft: LoopDraft): boolean => draft.stepCount > 0 || draft.toolCount > 0

/** 完了前のターン（ループごと）の途中経過。まだ何も起きていないものは出さない。 */
function liveRows(drafts: Drafts): PaneRow[] {
  const started = Object.values(drafts).filter(isStarted)
  if (started.length === 0) return []
  return [
    ...started.map((draft): PaneRow => ({
      kind: 'kv',
      label: '実行中',
      value: `${draft.agentId === null ? 'メイン' : 'サブエージェント'} ${shortModel(draft.model ?? '-')} · 応答 ${draft.stepCount} 回 · ツール ${draft.toolCount} 回 · 推定 ${formatUsd(draft.hasUnpricedStep ? null : draft.pricedCostUsd)}`,
      tone: 'suggestion',
    })),
    { kind: 'blank' },
  ]
}

export function buildPaneRows(review: ReviewState, drafts: Drafts = {}, nowMs?: number): PaneRow[] {
  const records = review.turns
  const live = liveRows(drafts)
  if (records.length === 0) {
    const body: PaneRow[] = live.length === 0 ? [{ kind: 'message', text: NO_TURNS_LINE }] : live.slice(0, -1)
    return [NO_RECORDS_CONCLUSION, ...body]
  }
  const estimate = estimateFacts(records)
  const concerns = findConcerns(records)
  const groups = groupByModelEffort(records)
  return [
    conclusionRow(concerns),
    { kind: 'blank' },
    {
      kind: 'title',
      turns: records.length,
      subagents: subagentCount(records),
      costText: estimate.allUnpriced ? formatUsd(null) : formatUsdRange(estimate.lowUsd, estimate.highUsd),
    },
    { kind: 'blank' },
    ...live,
    { kind: 'heading', text: concernHeading(concerns) },
    ...concernRows(concerns),
    { kind: 'blank' },
    { kind: 'heading', text: HEADING.groups },
    ...groups.map(group => groupRow(group, estimate.costUsd)),
    { kind: 'blank' },
    ...topTurnRows(records),
    ...loopRows(records),
    ...whatIfRows(records),
    { kind: 'heading', text: HEADING.cost },
    ...costRows(review, estimate),
    ...advisorRows(records),
    ...glossaryRows(shownTerms(review, groups, concerns)),
    { kind: 'blank' },
    ...buildNotes(review, nowMs).map((text): PaneRow => ({ kind: 'badge', label: ALERT_LABEL, tone: 'warning', text })),
    { kind: 'note', text: ALWAYS_NOTE },
    { kind: 'note', text: CRITERIA_NOTE },
  ]
}
