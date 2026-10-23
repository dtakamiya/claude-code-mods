// ペインの行モデルを組み立てる純粋関数。`$` にも JSX にも依存しない。描画は pane.tsx。
// 集計は analysis.ts、節の順序と出し分けは sections.ts、文面の共通部分は summary.ts。ここはペイン固有の並び・バー・用語・結論行を持つ。
import type { ArchivedGroup, ReviewState } from '../types'
import { analyzeReview, type ReviewAnalysis } from './analysis'
import { BREAKDOWN_LABEL, type BreakdownView } from './breakdown'
import { GROWTH_LABEL, type GrowthView } from './growth'
import type { RateView } from './pace'
import { HEAVY_TOOL_CALLS, LIGHT_MAX_OUTPUT_TOKENS, LIGHT_MAX_TOOL_CALLS, mainTurnsAfter, modelRank, type Concern, type ConcernKind } from './analyze'
import { shortModel } from './domain'
import { cellWidth, formatInt, formatUsd } from './format'
import type { Drafts, LoopDraft } from './recorder'
import { CONCERN_TEXT, FINDING_LABEL, HEADING, NO_CONCERNS_TEXT, PAST_CONCERNS_HEADING, TERM_TEXT, type TermKey } from './labels'
import { CONCERN_TONE, NO_RECORDS_CONCLUSION, type Tone } from './conclusion'
import { WHATIF_NOTE } from './whatif'
import { turnLabelText } from './turnref'
import { alwaysNoteText, type FindingNote } from './notes'
import {
  buildSections,
  type ConcernsSection,
  type CostSection,
  type GroupsSection,
  type LoopsSection,
  type Section,
  type TopTurnsSection,
  type WhatIfSection,
} from './sections'
import {
  NO_TURNS_LINE,
  concernDetailText,
  groupFacts,
  hitRateText,
  moneyLineBody,
  toolDetailText,
  turnOriginLabel,
} from './summary'

/** コスト比バーの最大幅。狭い画面では barWidthFor が縮める。 */
export const BAR_WIDTH = 14
/** バーを出す最小の幅（比が読める最小）。これに収まらないときはバーを出さず、金額と割合だけにする。 */
export const MIN_BAR_WIDTH = 4
/** バーは本文の桁数のこの割合（1/5）までにとどめる。狭い画面で金額・割合より先にバーを縮める。 */
const BAR_MAX_SHARE_OF_COLUMNS = 5
/** バー行の固定部分: 先頭の字下げ 2 + 金額との間 2 + 割合との間 2 + 割合（`100%` で 4）。 */
const BAR_ROW_FIXED_CELLS = 10

/**
 * 狭（< NARROW_BELOW_COLUMNS）の区分のしきい値（本文の桁数）。仮置き・目視未確認（mr-011）。実機で inline・dock の桁数を見て決め直す。
 * 狭幅だけ行を省く。通常と広は全行を出す。
 */
export const NARROW_BELOW_COLUMNS = 40
/** 広（≥ WIDE_FROM_COLUMNS）の区分のしきい値。仮置き・目視未確認（mr-011）。 */
export const WIDE_FROM_COLUMNS = 70
/** 狭幅で行を省いたことを、信頼度の節の末尾に 1 行で示す（省いた内容は /model-review text で全文が読める）。 */
const NARROW_OMITTED_NOTE = '狭幅のため一部省略'

export type WidthClass = 'narrow' | 'normal' | 'wide'

/** 桁数として使える値（有限で正の数）だけを返す。undefined・NaN・Infinity・0・負数は不明（undefined）。 */
function knownColumns(columns: number | undefined): number | undefined {
  return columns !== undefined && Number.isFinite(columns) && columns > 0 ? columns : undefined
}

/** 桁数の区分。不明（undefined を含む）は広と同じ扱い。 */
export function widthClassOf(columns: number | undefined): WidthClass {
  const known = knownColumns(columns)
  if (known === undefined || known >= WIDE_FROM_COLUMNS) return 'wide'
  return known < NARROW_BELOW_COLUMNS ? 'narrow' : 'normal'
}

/** 描画の条件。columns は正規化後の桁数（不明は undefined）、narrow は狭幅で行を省くかどうか。 */
type Layout = { readonly columns: number | undefined; readonly narrow: boolean }

export type Tier = 'haiku' | 'sonnet' | 'opus' | 'other'

export type PaneRow =
  | { kind: 'conclusion'; text: string; tone: Tone }
  | { kind: 'message'; text: string }
  | { kind: 'blank' }
  | { kind: 'title'; turns: number; subagents: number }
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

/**
 * グループの行。1 グループのときはバーも割合も出さない（比べる相手がなく、満タンと 100% は情報がない）。
 * 狭幅はトークン行をヒット率だけにし、キャッシュ行は出さない（ヒット率は判断の中心なので残す）。
 */
function groupRow(group: ArchivedGroup, totalUsd: number, layout: Layout, singleGroup: boolean): PaneRow {
  const facts = groupFacts(group)
  const share = costShare(group.costUsd, totalUsd)
  const barWidth = singleGroup ? 0 : barWidthFor(layout.columns, facts.costText)
  return {
    kind: 'group',
    model: shortModel(group.model),
    effort: facts.effort,
    tier: tierOf(group.model),
    turns: group.turns,
    barWidth,
    filled: filledCells(share, barWidth),
    percentText: singleGroup ? '' : percentText(share),
    costText: facts.costText,
    tokenText: layout.narrow ? (facts.hit ?? '') : `${facts.hit === null ? '' : `${facts.hit} · `}入力 ${facts.input} · 出力 ${facts.output}`,
    cacheText: layout.narrow ? '' : `キャッシュ 読 ${facts.cacheRead} / 書 ${facts.cacheWrite}`,
  }
}

function breakdownRows(view: BreakdownView | null): PaneRow[] {
  if (view === null) return []
  return [
    { kind: 'kv', label: BREAKDOWN_LABEL, value: view.items, tone: 'plain' },
    ...(view.hint === null ? [] : [{ kind: 'next', text: view.hint } satisfies PaneRow]),
    { kind: 'note', text: view.note },
  ]
}

function growthRows(view: GrowthView | null): PaneRow[] {
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

/** タイトルの直下の金額行。テキストの「金額:」と同じ文面（moneyLineBody）を使う。 */
const moneyRow = (analysis: ReviewAnalysis, isSubscription: boolean): PaneRow => ({
  kind: 'kv',
  label: '金額',
  value: moneyLineBody(analysis.estimate, analysis.diff, isSubscription),
  tone: 'plain',
})

/** 直近の指摘は種類の色と「次の一手」つき。過去の指摘は色なし（plain）で、次の一手を付けない。 */
function oneConcernRows(concern: Concern, next: string | null, recent: boolean): PaneRow[] {
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

/** 所見の中の警告（再構築・TTL 乖離）。バッジは種類の名前、本文はそのまま。 */
const findingRows = (findings: readonly FindingNote[]): PaneRow[] =>
  findings.map((note): PaneRow => ({ kind: 'badge', label: FINDING_LABEL[note.kind], tone: 'warning', text: note.text }))

/**
 * 所見の節（見出し・指摘・警告・空行）。直近の指摘を先に、所見の警告を指摘の後に、窓より前にだけ該当した指摘は注記の小見出しの下に分けて並べる。
 * 止めている種類は最後に注記 1 行だけ。結論が「目立った指摘なし」を言うときは OK 行を出さない。
 * 中身が 1 行も残らないときは、見出しと空行ごと出さない（警告も中身に数える）。
 */
function concernSectionRows(section: ConcernsSection): PaneRow[] {
  const { recent, findings, past, nextSteps, numericNote, mutedLine, noConcerns } = section
  const body: PaneRow[] = [
    ...recent.flatMap(concern => oneConcernRows(concern, nextSteps.get(concern) ?? null, true)),
    ...(recent.length === 0 && !noConcerns ? [{ kind: 'ok', text: NO_CONCERNS_TEXT } satisfies PaneRow] : []),
    ...findingRows(findings),
    ...(past.length === 0
      ? []
      : [{ kind: 'note', text: PAST_CONCERNS_HEADING } satisfies PaneRow, ...past.flatMap(concern => oneConcernRows(concern, null, false))]),
    ...(numericNote === null ? [] : [{ kind: 'note', text: numericNote } satisfies PaneRow]),
    ...(mutedLine === null ? [] : [{ kind: 'note', text: mutedLine } satisfies PaneRow]),
  ]
  return body.length === 0 ? [] : [{ kind: 'heading', text: HEADING.concerns }, ...body, { kind: 'blank' }]
}

function groupSectionRows(section: GroupsSection, layout: Layout): PaneRow[] {
  const singleGroup = section.groups.length === 1
  return [
    { kind: 'heading', text: HEADING.groups },
    ...section.groups.map(group => groupRow(group, section.totalUsd, layout, singleGroup)),
    { kind: 'blank' },
  ]
}

function topTurnRows(section: TopTurnsSection, nowMs?: number): PaneRow[] {
  return [
    { kind: 'heading', text: HEADING.topTurns },
    ...section.turns.map((record): PaneRow => ({
      kind: 'turn',
      label: turnLabelText(record, mainTurnsAfter(section.records, record), turnOriginLabel(record), nowMs),
      model: shortModel(record.model),
      tier: tierOf(record.model),
      costText: formatUsd(record.costUsd),
      detail: toolDetailText(record),
    })),
    { kind: 'blank' },
  ]
}

function loopRows(section: LoopsSection): PaneRow[] {
  const { view } = section
  return [
    { kind: 'heading', text: HEADING.loops },
    ...view.rows.map((row): PaneRow => ({ kind: 'kv', label: row.label, value: row.detail, tone: 'plain' })),
    ...(view.subagentNote === null ? [] : [{ kind: 'note', text: view.subagentNote } as const]),
    { kind: 'blank' },
  ]
}

function whatIfRows(section: WhatIfSection): PaneRow[] {
  return [
    { kind: 'heading', text: HEADING.whatIf },
    ...section.options.map((text): PaneRow => ({ kind: 'example', text })),
    { kind: 'note', text: WHATIF_NOTE },
    { kind: 'blank' },
  ]
}

const advisorRows = (text: string | null): PaneRow[] => (text === null ? [] : [{ kind: 'kv', label: 'advisor', value: text, tone: 'plain' }])

/** ペイン末尾の免責。advisor の行があるときは、その行に免責があるので advisor の句を外す（レポートは ALWAYS_NOTE のまま）。 */
export const paneAlwaysNote = (hasAdvisorRow: boolean): string => alwaysNoteText({ omitAdvisor: hasAdvisorRow })

/** 画面に出る行と同じ条件で、説明すべき用語を選ぶ。 */
function shownTerms(analysis: ReviewAnalysis): TermKey[] {
  const hasActual = analysis.diff !== null
  const candidates: ReadonlyArray<readonly [TermKey, boolean]> = [
    ['hitRate', analysis.groups.some(group => hitRateText(group.tokens) !== null)],
    ['afterLoad', hasActual],
    ['sonnetEquivalent', analysis.concerns.some(concern => concern.kind === 'overspec' && concern.amountUsd !== null)],
    ['diff', hasActual],
  ]
  return candidates.flatMap(([term, shown]) => (shown ? [term] : []))
}

function glossaryRows(terms: readonly TermKey[]): PaneRow[] {
  if (terms.length === 0) return []
  return [{ kind: 'note', text: `用語  ${terms.map(term => TERM_TEXT[term]).join(' / ')}` }]
}

/**
 * コストの節。使用率・内訳・推移・advisor の行があるときだけ、見出しと空行を出す（金額は直下の金額行に出すので、ここには置かない）。
 */
function costSectionRows(section: CostSection, rate: RateView | null): PaneRow[] {
  const body: PaneRow[] = [
    ...rateRows(rate),
    ...breakdownRows(section.breakdown),
    ...growthRows(section.growth),
    ...advisorRows(section.advisorText),
  ]
  return body.length === 0 ? [] : [{ kind: 'heading', text: HEADING.cost }, ...body, { kind: 'blank' }]
}

const CRITERIA_NOTE = `軽作業 = ツール ${LIGHT_MAX_TOOL_CALLS} 回以下・編集なし・出力 ${formatInt(LIGHT_MAX_OUTPUT_TOKENS)} tokens 以下 / 重い = ツール ${HEAVY_TOOL_CALLS} 回以上・長時間・エラー`
/** 実コストが取れているときだけ、判定基準の末尾に付ける更新の案内。取れないときはコスト行の「再取得」の案内に任せる。 */
const REFRESH_SUFFIX = '。更新は /model-review'

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

/** 狭幅で省くのは高コストターンといま切り替えたら。所見・モデル × effort・コストは幅によらず出す。 */
function sectionRows(section: Section, layout: Layout, nowMs: number | undefined, rate: RateView | null): PaneRow[] {
  switch (section.kind) {
    case 'concerns':
      return concernSectionRows(section)
    case 'groups':
      return groupSectionRows(section, layout)
    case 'topTurns':
      return layout.narrow ? [] : topTurnRows(section, nowMs)
    case 'loops':
      return loopRows(section)
    case 'whatIf':
      return layout.narrow ? [] : whatIfRows(section)
    case 'cost':
      return costSectionRows(section, rate)
  }
}

/**
 * 信頼度の節（見出し・切替などの注記・畳み込み・免責）。所見の警告は所見の中に出すので、ここにはバッジを置かない。
 * 狭幅は switch 以外の注記と畳み込みの注記を省く（switch は結論の「注意」の件数に数えるので残す）。免責は残す。
 */
function reliabilityRows(analysis: ReviewAnalysis, narrow: boolean): PaneRow[] {
  const notes = narrow ? analysis.trustNotes.filter(note => note.kind === 'switch') : analysis.trustNotes
  return [
    { kind: 'heading', text: HEADING.reliability },
    ...notes.map((note): PaneRow => ({ kind: 'note', text: note.text })),
    ...(narrow || analysis.archiveNote === null ? [] : [{ kind: 'note', text: analysis.archiveNote } satisfies PaneRow]),
    { kind: 'note', text: paneAlwaysNote(analysis.advisorText !== null) },
    ...(narrow ? [{ kind: 'note', text: NARROW_OMITTED_NOTE } satisfies PaneRow] : []),
  ]
}

/**
 * 最下段の用語と判定基準。信頼度の後に空行を挟み、用語は判定基準の直前に置く。狭幅は用語を省く。
 * 実コストがあるときは判定基準の末尾に更新の案内を付ける。
 */
function closingRows(analysis: ReviewAnalysis, narrow: boolean): PaneRow[] {
  const criteria = analysis.diff === null ? CRITERIA_NOTE : `${CRITERIA_NOTE}${REFRESH_SUFFIX}`
  return [{ kind: 'blank' }, ...(narrow ? [] : glossaryRows(shownTerms(analysis))), { kind: 'note', text: criteria }]
}

/**
 * `columns` はペイン本文の桁数（bodyColumns）。バー幅と行の省略を決める。省略時は広い扱い（最大幅・全行）。
 * 桁数の正規化はここで 1 回だけ行い、バー幅と区分の両方に同じ値を渡す。
 * `muted` は設定で止めている指摘の種類（結論・指摘の節から外す）。
 * 節の順序と出し分けは sections.ts、集計は analysis.ts（同じ記録なら前回の結果を使う）。
 */
export function buildPaneRows(
  review: ReviewState,
  drafts: Drafts = {},
  nowMs?: number,
  columns?: number,
  muted?: ReadonlySet<ConcernKind>,
  rate: RateView | null = null,
): PaneRow[] {
  const live = liveRows(drafts)
  const layout: Layout = { columns: knownColumns(columns), narrow: widthClassOf(columns) === 'narrow' }
  if (review.turns.length === 0) {
    const body: PaneRow[] = live.length === 0 ? [{ kind: 'message', text: NO_TURNS_LINE }] : live.slice(0, -1)
    return [{ kind: 'conclusion', ...NO_RECORDS_CONCLUSION }, ...body]
  }
  const analysis = analyzeReview(review, nowMs, muted)
  return [
    { kind: 'conclusion', ...analysis.conclusion },
    { kind: 'blank' },
    { kind: 'title', turns: analysis.totalTurns, subagents: analysis.subagents },
    moneyRow(analysis, rate !== null),
    { kind: 'blank' },
    ...live,
    ...buildSections(analysis).flatMap(section => sectionRows(section, layout, nowMs, rate)),
    ...reliabilityRows(analysis, layout.narrow),
    ...closingRows(analysis, layout.narrow),
  ]
}
