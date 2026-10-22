// ペインとコマンド出力に載せる文面（日本語）を組み立てる純粋関数。
// 集計と文面の部品は summary.ts。ここはテキスト出力だけに出す行と、その並びを持つ。
import type { ArchivedGroup, ReviewState, TurnRecord } from '../types'
import { BREAKDOWN_LABEL, breakdownView } from './breakdown'
import { GROWTH_LABEL, growthView } from './growth'
import type { RateView } from './pace'
import { numericEffortNote } from './effort'
import { applyMute } from './mute'
import { archiveNote, mergeGroups } from './archive'
import { formatUsd, formatUsdRange } from './format'
import { ALWAYS_NOTE, buildNotes, splitNotes } from './notes'
import { PRICE_TABLE_FETCHED_AT } from './pricing'
import { HEADING, CONCERN_TEXT, NO_CONCERNS_TEXT, PAST_CONCERNS_HEADING } from './labels'
import { NO_RECORDS_CONCLUSION } from './conclusion'
import { WHATIF_NOTE } from './whatif'
import { nextStepText } from './nextstep'
import {
  HEAVY_TOOL_CALLS,
  LIGHT_MAX_OUTPUT_TOKENS,
  LIGHT_MAX_TOOL_CALLS,
  findConcerns,
  groupByModelEffort,
  partitionByRecency,
  mainTurnsAfter,
  topCostTurns,
  type Concern,
  type ConcernKind,
} from './analyze'
import {
  NO_TURNS_LINE,
  advisorCallText,
  allUnpricedText,
  buildVerdict,
  concernDetailText,
  costDiff,
  describeSwitchOptions,
  estimateFacts,
  groupFacts,
  loopView,
  moneyLineText,
  subagentCount,
  toolDetailText,
  turnOriginLabel,
  unpricedExclusionText,
} from './summary'
import { hasSeq, turnRefText } from './turnref'

export { formatInt, formatUsd } from './format'
export { NO_TURNS_LINE } from './summary'

function groupLine(group: ArchivedGroup): string {
  const facts = groupFacts(group)
  return [
    `${group.model}  effort ${facts.effort}`,
    `ターン ${group.turns}`,
    ...(facts.hit === null ? [] : [facts.hit]),
    `入力 ${facts.input}`,
    `出力 ${facts.output}`,
    `キャッシュ読 ${facts.cacheRead}`,
    `書 ${facts.cacheWrite}`,
    `推定 ${facts.costText}`,
  ].join('  ')
}

function rateLines(rate: RateView | null): string[] {
  return rate === null ? [] : [...rate.rows.map(row => `使用率 ${row.label}: ${row.text}`), `  ${rate.note}`]
}

function costLines(review: ReviewState, records: readonly TurnRecord[], isSubscription: boolean): string[] {
  const totalLabel = isSubscription ? '合計推定コスト（API 換算・参考）' : '合計推定コスト'
  const estimate = estimateFacts(records, review.archived)
  const estimateLine = estimate.allUnpriced
    ? `${totalLabel}: ${allUnpricedText(records.length + (review.archived?.turns ?? 0))}`
    : `${totalLabel}: ${formatUsdRange(estimate.lowUsd, estimate.highUsd)}${estimate.unpricedTurns > 0 ? unpricedExclusionText(estimate.unpricedTurns) : ''}`
  const view = breakdownView(records, review.archived)
  const breakdownLines = view === null ? [] : [`${BREAKDOWN_LABEL}: ${view.items}`, ...(view.hint === null ? [] : [`  → ${view.hint}`]), `  ${view.note}`]
  const growth = growthView(records, review.archived?.turns)
  const growthLines = growth === null ? [] : [`${GROWTH_LABEL}: ${growth.trend}`, ...(growth.compact === null ? [] : [`  compact の前後: ${growth.compact}`]), ...(growth.hint === null ? [] : [`  → ${growth.hint}`]), `  ${growth.note}`]
  const diff = costDiff(review)
  if (diff === null) {
    return [estimateLine, ...breakdownLines, ...growthLines, 'セッション実コスト: 取得できません（コストの記録がない環境）']
  }
  return [
    estimateLine,
    ...breakdownLines,
    ...growthLines,
    `セッション実コスト（${isSubscription ? 'API 換算・請求額ではない・' : ''}読み込み後）: ${formatUsd(diff.actualUsd)}`,
    `差（実コスト − 推定）: ${formatUsd(diff.diffUsd)}（推定は単価表の値。キャッシュ書込みは 5 分単価で概算し、ターン外の要求は含まない）`,
  ]
}

/** 指摘 1 件の行。過去の指摘には「次の一手」を付けない（いま直す対象ではないため）。 */
function oneConcernLines(concern: Concern, records: readonly TurnRecord[], withNext: boolean): string[] {
  const next = withNext ? nextStepText(concern, records) : null
  return [
    `  【${CONCERN_TEXT[concern.kind].label}】 ${concernDetailText(concern)}`,
    ...concern.examples.map(example => `    ・${example}`),
    ...(next === null ? [] : [`    → ${next}`]),
  ]
}

/** 直近の指摘を先に、窓より前にだけ該当した指摘は小見出しの下に分けて並べる。止めている種類は最後に 1 行だけ。 */
function concernLines(
  concerns: readonly Concern[],
  records: readonly TurnRecord[],
  mutedLine: string | null,
  archived: ReviewState['archived'],
): string[] {
  const { recent, past } = partitionByRecency(concerns)
  const numericNote = numericEffortNote(records, archived)
  return [
    ...(recent.length === 0 ? [`  ${NO_CONCERNS_TEXT}`] : recent.flatMap(concern => oneConcernLines(concern, records, true))),
    ...(past.length === 0 ? [] : [`  ${PAST_CONCERNS_HEADING}`, ...past.flatMap(concern => oneConcernLines(concern, records, false))]),
    ...(numericNote === null ? [] : [`  ${numericNote}`]),
    ...(mutedLine === null ? [] : [`  ${mutedLine}`]),
  ]
}

/** 通し番号のある記録は「#37（12 分前）」、古い記録は従来どおり「ターン <turnId>（種別）」。 */
const reportTurnRef = (record: TurnRecord, records: readonly TurnRecord[], nowMs?: number): string =>
  !hasSeq(record)
    ? `${turnRefText(record, 0)}（${turnOriginLabel(record)}）`
    : turnRefText(record, mainTurnsAfter(records, record), nowMs)

function topTurnLines(records: readonly TurnRecord[], nowMs?: number): string[] {
  return topCostTurns(records).map(
    record =>
      `  ${formatUsd(record.costUsd)}  ${reportTurnRef(record, records, nowMs)}  ${record.model}  ${toolDetailText(record)}`,
  )
}

function topTurnSection(records: readonly TurnRecord[], nowMs?: number): string[] {
  const lines = topTurnLines(records, nowMs)
  return lines.length === 0 ? [] : [`■ ${HEADING.topTurns}`, ...lines, '']
}

function advisorLines(records: readonly TurnRecord[], archived: ReviewState['archived']): string[] {
  const text = advisorCallText(records, archived)
  return text === null ? [] : [`advisor ${text}`]
}

function archiveNoteLines(review: ReviewState): string[] {
  const text = archiveNote(review.archived)
  return text === null ? [] : [text]
}

function loopLines(records: readonly TurnRecord[]): string[] {
  const view = loopView(records)
  if (view === null) return []
  return [
    `■ ${HEADING.loops}`,
    ...view.rows.map(row => `  ${row.label}  ${row.detail}`),
    ...(view.subagentNote === null ? [] : [`  ${view.subagentNote}`]),
    '',
  ]
}

function whatIfLines(records: readonly TurnRecord[]): string[] {
  const options = describeSwitchOptions(records)
  if (options.length === 0) return []
  return [`■ ${HEADING.whatIf}`, ...options.map(text => `  ${text}`), `  ${WHATIF_NOTE}`, '']
}

const CRITERIA_LINES = [
  `判定基準（参考）: 軽作業 = ツール ${LIGHT_MAX_TOOL_CALLS} 回以下・編集系なし・出力 ${LIGHT_MAX_OUTPUT_TOKENS} tokens 以下。重い = ツール ${HEAVY_TOOL_CALLS} 回以上、または長時間・エラー。`,
  `単価は pricing.ts の表（platform.claude.com の価格表、${PRICE_TABLE_FETCHED_AT} 取得）。Haiku 5.5 はプロンプト 10 万 tokens 超の応答で単価が上がるため、応答ごとに判定している。`,
]

/**
 * テキストレポートの行。先頭はペインと同じ結論の 1 行。記録がなければ結論と案内の 2 行だけを返す。
 * `muted` は設定で止めている指摘の種類（結論・指摘の節から外す）。
 */
export function buildReportLines(
  review: ReviewState,
  nowMs?: number,
  muted: ReadonlySet<ConcernKind> = new Set(),
  rate: RateView | null = null,
): string[] {
  const records = review.turns
  if (records.length === 0) return [NO_RECORDS_CONCLUSION.text, NO_TURNS_LINE]
  const { concerns, mutedLine } = applyMute(findConcerns(records), muted)
  const notes = buildNotes(review, nowMs)
  return [
    buildVerdict(review, concerns, splitNotes(notes).alerts).text,
    moneyLineText(review, rate !== null),
    '',
    `対象: ${records.length + (review.archived?.turns ?? 0)} ターン（サブエージェント ${subagentCount(records, review.archived)} 件）。Mod 読み込み前のターンは含みません。`,
    '',
    `■ ${HEADING.concerns}（ヒューリスティック）`,
    ...concernLines(concerns, records, mutedLine, review.archived),
    '',
    `■ ${HEADING.groups}`,
    ...mergeGroups(review.archived, groupByModelEffort(records)).map(groupLine),
    '',
    ...topTurnSection(records, nowMs),
    ...loopLines(records),
    ...whatIfLines(records),
    `■ ${HEADING.cost}`,
    ...costLines(review, records, rate !== null),
    ...rateLines(rate),
    ...advisorLines(records, review.archived),
    ...notes.map(note => note.text),
    ...archiveNoteLines(review),
    ALWAYS_NOTE,
    '',
    ...CRITERIA_LINES,
  ]
}
