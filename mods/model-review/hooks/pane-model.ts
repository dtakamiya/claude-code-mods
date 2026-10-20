// ペインの行モデルを組み立てる純粋関数。`$` にも JSX にも依存しない。描画は pane.tsx。
// 集計と文面の共通部分は summary.ts。ここはペイン固有の並び・バー・用語・結論行を持つ。
import type { ArchivedGroup, ReviewState } from '../types'
import { BREAKDOWN_LABEL, breakdownView } from './breakdown'
import { GROWTH_LABEL, growthView } from './growth'
import type { RateView } from './pace'
import { numericEffortNote } from './effort'
import { applyMute } from './mute'
import {
  HEAVY_TOOL_CALLS,
  LIGHT_MAX_OUTPUT_TOKENS,
  LIGHT_MAX_TOOL_CALLS,
  findConcerns,
  mainTurnsAfter,
  groupByModelEffort,
  partitionByRecency,
  modelRank,
  topCostTurns,
  type Concern,
  type ConcernKind,
} from './analyze'
import { archiveNote, mergeGroups } from './archive'
import { cellWidth, formatUsd, formatUsdRange } from './format'
import type { Drafts, LoopDraft } from './recorder'
import { CONCERN_TEXT, HEADING, NO_CONCERNS_TEXT, PAST_CONCERNS_HEADING, TERM_TEXT, type TermKey } from './labels'
import { ALERT_LABEL, CONCERN_TONE, NO_RECORDS_CONCLUSION, type Tone } from './conclusion'
import { WHATIF_NOTE } from './whatif'
import { nextStepText } from './nextstep'
import { turnLabelText } from './turnref'
import { ALWAYS_NOTE, buildNotes, splitNotes } from './notes'
import {
  NO_TURNS_LINE,
  actualCostUsd,
  advisorCallText,
  buildVerdict,
  concernDetailText,
  costDiff,
  describeSwitchOptions,
  estimateFacts,
  estimateRangeText,
  groupFacts,
  hitRateText,
  loopView,
  signedUsdText,
  subagentCount,
  toolDetailText,
  turnOriginLabel,
  type EstimateFacts,
} from './summary'

/** コスト比バーの最大幅。狭い画面では barWidthFor が縮める。 */
export const BAR_WIDTH = 14
/** バーを出す最小の幅（比が読める最小）。これに収まらないときはバーを出さず、金額と割合だけにする。 */
export const MIN_BAR_WIDTH = 4
/** バーは本文の桁数のこの割合（1/5）までにとどめる。狭い画面で金額・割合より先にバーを縮める。 */
const BAR_MAX_SHARE_OF_COLUMNS = 5
/** バー行の固定部分: 先頭の字下げ 2 + 金額との間 2 + 割合との間 2 + 割合（`100%` で 4）。 */
const BAR_ROW_FIXED_CELLS = 10
const MODEL_ID_PREFIX = 'claude-'

export type Tier = 'haiku' | 'sonnet' | 'opus' | 'other'

export type PaneRow =
  | { kind: 'conclusion'; text: string; tone: Tone }
  | { kind: 'message'; text: string }
  | { kind: 'blank' }
  | { kind: 'title'; turns: number; subagents: number; costText: string }
  | { kind: 'heading'; text: string }
  | { kind: 'group'; model: string; effort: string; tier: Tier; turns: number; barWidth: number; filled: number; percentText: string; costText: string; tokenText: string; cacheText: string }
  | { kind: 'turn'; label: string; model: string; tier: Tier; costText: string; detail: string }
  | { kind: 'kv'; label: string; value: string; tone: Tone }
  | { kind: 'badge'; label: string; tone: Tone; text: string }
  | { kind: 'example'; text: string }
  | { kind: 'next'; text: string }
  | { kind: 'ok'; text: string }
  | { kind: 'note'; text: string }

const TIER_OF_RANK: Readonly<Record<number, Tier>> = { 0: 'haiku', 1: 'sonnet', 2: 'opus' }

const tierOf = (model: string): Tier => TIER_OF_RANK[modelRank(model)] ?? 'other'
const shortModel = (model: string): string => (model.startsWith(MODEL_ID_PREFIX) ? model.slice(MODEL_ID_PREFIX.length) : model)

const MIN_VISIBLE_SHARE = 0.01

/** コスト比（0〜1）。単価不明（null）や合計 0 は null。 */
function costShare(costUsd: number | null, totalUsd: number): number | null {
  if (costUsd === null || totalUsd <= 0) return null
  return costUsd / totalUsd
}

/**
 * 本文の桁数（bodyColumns）と金額の桁数から、バーが収まる幅を決める。金額は削らず、バーを縮める。
 * MIN_BAR_WIDTH に収まらなければ 0（バーを出さない）。桁数が分からなければ（undefined）最大幅。
 */
export function barWidthFor(columns: number | undefined, costText: string): number {
  if (columns === undefined) return BAR_WIDTH
  const room = columns - BAR_ROW_FIXED_CELLS - cellWidth(costText)
  const width = Math.min(BAR_WIDTH, room, Math.floor(columns / BAR_MAX_SHARE_OF_COLUMNS))
  return width < MIN_BAR_WIDTH ? 0 : width
}

/** コスト比を 0〜width のセル数にする。1% 未満は 0、それ以上は最低 1 セル。 */
function filledCells(share: number | null, width: number): number {
  if (share === null || share < MIN_VISIBLE_SHARE) return 0
  return Math.min(width, Math.max(1, Math.round(share * width)))
}

function percentText(share: number | null): string {
  if (share === null) return ''
  return share < MIN_VISIBLE_SHARE ? '<1%' : `${Math.round(share * 100)}%`
}

function groupRow(group: ArchivedGroup, totalUsd: number, columns: number | undefined): PaneRow {
  const facts = groupFacts(group)
  const share = costShare(group.costUsd, totalUsd)
  const barWidth = barWidthFor(columns, facts.costText)
  return {
    kind: 'group',
    model: shortModel(group.model),
    effort: facts.effort,
    tier: tierOf(group.model),
    turns: group.turns,
    barWidth,
    filled: filledCells(share, barWidth),
    percentText: percentText(share),
    costText: facts.costText,
    tokenText: `${facts.hit === null ? '' : `${facts.hit} · `}入力 ${facts.input} · 出力 ${facts.output}`,
    cacheText: `キャッシュ 読 ${facts.cacheRead} / 書 ${facts.cacheWrite}`,
  }
}

function breakdownRows(records: ReviewState['turns'], archived: ReviewState['archived']): PaneRow[] {
  const view = breakdownView(records, archived)
  if (view === null) return []
  return [
    { kind: 'kv', label: BREAKDOWN_LABEL, value: view.items, tone: 'plain' },
    ...(view.hint === null ? [] : [{ kind: 'next', text: view.hint } satisfies PaneRow]),
    { kind: 'note', text: view.note },
  ]
}

function growthRows(records: ReviewState['turns'], archived: ReviewState['archived']): PaneRow[] {
  const view = growthView(records, archived?.turns)
  if (view === null) return []
  return [
    { kind: 'kv', label: GROWTH_LABEL, value: view.trend, tone: 'plain' },
    ...(view.compact === null ? [] : [{ kind: 'kv', label: '  compact の前後', value: view.compact, tone: 'plain' } satisfies PaneRow]),
    ...(view.hint === null ? [] : [{ kind: 'note', text: `→ ${view.hint}` } satisfies PaneRow]),
    { kind: 'note', text: view.note },
  ]
}

function rateRows(rate: RateView | null): PaneRow[] {
  if (rate === null) return []
  return [
    ...rate.rows.map((row): PaneRow => ({ kind: 'kv', label: `使用率 ${row.label}`, value: row.text, tone: 'plain' })),
    { kind: 'note', text: rate.note },
  ]
}

function costRows(review: ReviewState, estimate: EstimateFacts, isSubscription: boolean): PaneRow[] {
  const estimateWord = isSubscription ? 'API 換算の推定' : '推定'
  const estimateText = estimateRangeText(estimate)
  const diff = costDiff(review)
  if (diff === null) {
    return [{ kind: 'kv', label: 'コスト', value: `${estimateWord} ${estimateText} / 実コスト 取得できませんでした（/model-review で再取得）`, tone: 'plain' }]
  }
  return [{ kind: 'kv', label: 'コスト', value: `${estimateWord} ${estimateText} / 実 ${formatUsd(diff.actualUsd)}（読み込み後）/ 差 ${signedUsdText(diff.diffUsd)}`, tone: 'plain' }]
}

/** 直近の指摘は種類の色と「次の一手」つき。過去の指摘は色なし（plain）で、次の一手を付けない。 */
function oneConcernRows(concern: Concern, records: ReviewState['turns'], recent: boolean): PaneRow[] {
  const next = recent ? nextStepText(concern, records) : null
  return [
    {
      kind: 'badge',
      label: CONCERN_TEXT[concern.kind].label,
      tone: recent ? CONCERN_TONE[concern.kind] : 'plain',
      text: concernDetailText(concern),
    },
    ...concern.examples.map((text): PaneRow => ({ kind: 'example', text })),
    ...(next === null ? [] : [{ kind: 'next', text: next } satisfies PaneRow]),
  ]
}

/** 直近の指摘を先に、窓より前にだけ該当した指摘は注記の小見出しの下に分けて並べる。止めている種類は最後に注記 1 行だけ。 */
function concernRows(
  concerns: readonly Concern[],
  records: ReviewState['turns'],
  mutedLine: string | null,
  archived: ReviewState['archived'],
): PaneRow[] {
  const { recent, past } = partitionByRecency(concerns)
  const numericNote = numericEffortNote(records, archived)
  return [
    ...(recent.length === 0
      ? [{ kind: 'ok', text: NO_CONCERNS_TEXT } satisfies PaneRow]
      : recent.flatMap(concern => oneConcernRows(concern, records, true))),
    ...(past.length === 0
      ? []
      : [{ kind: 'note', text: PAST_CONCERNS_HEADING } satisfies PaneRow, ...past.flatMap(concern => oneConcernRows(concern, records, false))]),
    ...(numericNote === null ? [] : [{ kind: 'note', text: numericNote } satisfies PaneRow]),
    ...(mutedLine === null ? [] : [{ kind: 'note', text: mutedLine } satisfies PaneRow]),
  ]
}

function topTurnRows(records: ReviewState['turns'], nowMs?: number): PaneRow[] {
  const top = topCostTurns(records)
  if (top.length === 0) return []
  return [
    { kind: 'heading', text: HEADING.topTurns },
    ...top.map((record): PaneRow => ({
      kind: 'turn',
      label: turnLabelText(record, mainTurnsAfter(records, record), turnOriginLabel(record), nowMs),
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

function advisorRows(records: ReviewState['turns'], archived: ReviewState['archived']): PaneRow[] {
  const text = advisorCallText(records, archived)
  return text === null ? [] : [{ kind: 'kv', label: 'advisor', value: text, tone: 'plain' }]
}

function archiveNoteRows(review: ReviewState): PaneRow[] {
  const text = archiveNote(review.archived)
  return text === null ? [] : [{ kind: 'note', text }]
}

/** 画面に出る行と同じ条件で、説明すべき用語を選ぶ。 */
function shownTerms(review: ReviewState, groups: readonly ArchivedGroup[], concerns: readonly Concern[]): TermKey[] {
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

/** 件数は結論行だけに出し、見出しは内訳であることを示す。 */
const CONCERN_DETAIL_HEADING = `${HEADING.concerns}· 見直し候補の内訳`

const CRITERIA_NOTE = `軽作業 = ツール ${LIGHT_MAX_TOOL_CALLS} 回以下・編集なし・出力 ${LIGHT_MAX_OUTPUT_TOKENS} tokens 以下 / 重い = ツール ${HEAVY_TOOL_CALLS} 回以上・長時間・エラー`
/** 実コストが取れなかったときの、ペイン末尾の案内。 */
const REFRESH_NOTE = '/model-review で更新'

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

/**
 * `columns` はペイン本文の桁数（bodyColumns）。バー幅を合わせる。省略時は最大幅。
 * `muted` は設定で止めている指摘の種類（結論・指摘の節から外す）。
 */
export function buildPaneRows(
  review: ReviewState,
  drafts: Drafts = {},
  nowMs?: number,
  columns?: number,
  muted: ReadonlySet<ConcernKind> = new Set(),
  rate: RateView | null = null,
): PaneRow[] {
  const records = review.turns
  const live = liveRows(drafts)
  if (records.length === 0) {
    const body: PaneRow[] = live.length === 0 ? [{ kind: 'message', text: NO_TURNS_LINE }] : live.slice(0, -1)
    return [{ kind: 'conclusion', ...NO_RECORDS_CONCLUSION }, ...body]
  }
  const estimate = estimateFacts(records, review.archived)
  const { concerns, mutedLine } = applyMute(findConcerns(records), muted)
  const groups = mergeGroups(review.archived, groupByModelEffort(records))
  const { alerts, reliability } = splitNotes(buildNotes(review, nowMs))
  return [
    { kind: 'conclusion', ...buildVerdict(review, concerns, alerts) },
    { kind: 'blank' },
    {
      kind: 'title',
      turns: records.length + (review.archived?.turns ?? 0),
      subagents: subagentCount(records, review.archived),
      costText: estimate.allUnpriced ? formatUsd(null) : formatUsdRange(estimate.lowUsd, estimate.highUsd),
    },
    { kind: 'blank' },
    ...live,
    { kind: 'heading', text: CONCERN_DETAIL_HEADING },
    ...concernRows(concerns, records, mutedLine, review.archived),
    { kind: 'blank' },
    { kind: 'heading', text: HEADING.groups },
    ...groups.map(group => groupRow(group, estimate.costUsd, columns)),
    { kind: 'blank' },
    ...topTurnRows(records, nowMs),
    ...loopRows(records),
    ...whatIfRows(records),
    { kind: 'heading', text: HEADING.cost },
    ...costRows(review, estimate, rate !== null),
    ...rateRows(rate),
    ...breakdownRows(records, review.archived),
    ...growthRows(records, review.archived),
    ...advisorRows(records, review.archived),
    ...glossaryRows(shownTerms(review, groups, concerns)),
    { kind: 'blank' },
    ...alerts.map((note): PaneRow => ({ kind: 'badge', label: ALERT_LABEL, tone: 'warning', text: note.text })),
    ...reliability.map((note): PaneRow => ({ kind: 'note', text: note.text })),
    ...archiveNoteRows(review),
    { kind: 'note', text: ALWAYS_NOTE },
    { kind: 'note', text: CRITERIA_NOTE },
    { kind: 'note', text: REFRESH_NOTE },
  ]
}
