// テキストレポート（/model-review text・copy）の行を組み立てる純粋関数。
// 集計は analysis.ts、節の順序と出し分けは sections.ts（ペインと共有）、文面の部品は summary.ts。ここはテキストだけの並びと書式を持つ。
import type { ArchivedGroup, ReviewState, TurnRecord } from '../types'
import { analyzeReview, type ReviewAnalysis } from './analysis'
import { BREAKDOWN_LABEL } from './breakdown'
import { GROWTH_LABEL } from './growth'
import type { RateView } from './pace'
import { formatUsd, formatUsdRange } from './format'
import { ALWAYS_NOTE } from './notes'
import { PRICE_TABLE_FETCHED_AT } from './pricing'
import { HEADING, CONCERN_TEXT, NO_CONCERNS_TEXT, PAST_CONCERNS_HEADING } from './labels'
import { NO_RECORDS_CONCLUSION } from './conclusion'
import { WHATIF_NOTE } from './whatif'
import { HEAVY_TOOL_CALLS, LIGHT_MAX_OUTPUT_TOKENS, LIGHT_MAX_TOOL_CALLS, mainTurnsAfter, type Concern, type ConcernKind } from './analyze'
import {
  buildSections,
  type ConcernsSection,
  type CostSection,
  type LoopsSection,
  type Section,
  type TopTurnsSection,
  type WhatIfSection,
} from './sections'
import {
  ACTUAL_COST_UNAVAILABLE_TEXT,
  NO_TURNS_LINE,
  allUnpricedText,
  concernDetailText,
  groupFacts,
  moneyLineFrom,
  signedUsdText,
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

function costLines(section: CostSection, isSubscription: boolean): string[] {
  const totalLabel = isSubscription ? '合計推定コスト（API 換算・参考）' : '合計推定コスト'
  const { estimate, breakdown, growth, diff } = section
  const estimateLine = estimate.allUnpriced
    ? `${totalLabel}: ${allUnpricedText(section.totalTurns)}`
    : `${totalLabel}: ${formatUsdRange(estimate.lowUsd, estimate.highUsd)}${estimate.unpricedTurns > 0 ? unpricedExclusionText(estimate.unpricedTurns) : ''}`
  const breakdownLines =
    breakdown === null ? [] : [`${BREAKDOWN_LABEL}: ${breakdown.items}`, ...(breakdown.hint === null ? [] : [`  → ${breakdown.hint}`]), `  ${breakdown.note}`]
  const growthLines =
    growth === null
      ? []
      : [
          `${GROWTH_LABEL}: ${growth.trend}`,
          ...(growth.compact === null ? [] : [`  compact の前後: ${growth.compact}`]),
          ...(growth.hint === null ? [] : [`  → ${growth.hint}`]),
          `  ${growth.note}`,
        ]
  if (diff === null) {
    return [estimateLine, ...breakdownLines, ...growthLines, `セッション${ACTUAL_COST_UNAVAILABLE_TEXT.replace(' ', ': ')}`]
  }
  return [
    estimateLine,
    ...breakdownLines,
    ...growthLines,
    `セッション実コスト（${isSubscription ? 'API 換算・請求額ではない・' : ''}読み込み後）: ${formatUsd(diff.actualUsd)}`,
    `差（実コスト − 推定）: ${signedUsdText(diff.diffUsd)}（${diffDirection(diff.diffUsd)}推定は単価表の値。ターン外の要求は含まない）`,
  ]
}

/** 差の向き。括弧を重ねないよう、後ろの説明と同じ括弧の中に入れる文の頭として返す。差が 0 なら空文字。 */
const diffDirection = (diffUsd: number): string => (diffUsd > 0 ? '実が大きい。' : diffUsd < 0 ? '推定が大きい。' : '')

/** 指摘 1 件の行。過去の指摘には「次の一手」を付けない（いま直す対象ではないため）。 */
function oneConcernLines(concern: Concern, next: string | null): string[] {
  return [
    `  【${CONCERN_TEXT[concern.kind].label}】 ${concernDetailText(concern)}`,
    ...concern.examples.map(example => `    ・${example}`),
    ...(next === null ? [] : [`    → ${next}`]),
  ]
}

/** 直近の指摘を先に、窓より前にだけ該当した指摘は小見出しの下に分けて並べる。止めている種類は最後に 1 行だけ。 */
function concernLines(section: ConcernsSection): string[] {
  const { recent, past, nextSteps, numericNote, mutedLine } = section
  return [
    `■ ${HEADING.concerns} · ヒューリスティック`,
    ...(recent.length === 0 ? [`  ${NO_CONCERNS_TEXT}`] : recent.flatMap(concern => oneConcernLines(concern, nextSteps.get(concern) ?? null))),
    ...(past.length === 0 ? [] : [`  ${PAST_CONCERNS_HEADING}`, ...past.flatMap(concern => oneConcernLines(concern, null))]),
    ...(numericNote === null ? [] : [`  ${numericNote}`]),
    ...(mutedLine === null ? [] : [`  ${mutedLine}`]),
    '',
  ]
}

/** 通し番号のある記録は「#37（12 分前）」、古い記録は従来どおり「ターン <turnId>（種別）」。 */
const reportTurnRef = (record: TurnRecord, records: readonly TurnRecord[], nowMs?: number): string =>
  !hasSeq(record)
    ? `${turnRefText(record, 0)}（${turnOriginLabel(record)}）`
    : turnRefText(record, mainTurnsAfter(records, record), nowMs)

function topTurnLines(section: TopTurnsSection, nowMs?: number): string[] {
  return [
    `■ ${HEADING.topTurns}`,
    ...section.turns.map(
      record => `  ${formatUsd(record.costUsd)}  ${reportTurnRef(record, section.records, nowMs)}  ${record.model}  ${toolDetailText(record)}`,
    ),
    '',
  ]
}

function loopLines(section: LoopsSection): string[] {
  const { view } = section
  return [
    `■ ${HEADING.loops}`,
    ...view.rows.map(row => `  ${row.label}  ${row.detail}`),
    ...(view.subagentNote === null ? [] : [`  ${view.subagentNote}`]),
    '',
  ]
}

const whatIfLines = (section: WhatIfSection): string[] => [`■ ${HEADING.whatIf}`, ...section.options.map(text => `  ${text}`), `  ${WHATIF_NOTE}`, '']

/** コストの節。見出しの後に、金額・内訳・推移・実コスト・使用率・advisor を並べる。末尾の注記は footerLines。 */
function costSectionLines(section: CostSection, rate: RateView | null): string[] {
  return [
    `■ ${HEADING.cost}`,
    ...costLines(section, rate !== null),
    ...rateLines(rate),
    ...(section.advisorText === null ? [] : [`advisor ${section.advisorText}`]),
  ]
}

function sectionLines(section: Section, nowMs: number | undefined, rate: RateView | null): string[] {
  switch (section.kind) {
    case 'concerns':
      return concernLines(section)
    case 'groups':
      return [`■ ${HEADING.groups}`, ...section.groups.map(groupLine), '']
    case 'topTurns':
      return topTurnLines(section, nowMs)
    case 'loops':
      return loopLines(section)
    case 'whatIf':
      return whatIfLines(section)
    case 'cost':
      return costSectionLines(section, rate)
  }
}

const CRITERIA_LINES = [
  `判定基準（参考）: 軽作業 = ツール ${LIGHT_MAX_TOOL_CALLS} 回以下・編集系なし・出力 ${LIGHT_MAX_OUTPUT_TOKENS} tokens 以下。重い = ツール ${HEAVY_TOOL_CALLS} 回以上、または長時間・エラー。`,
  `単価は pricing.ts の表（platform.claude.com の価格表、${PRICE_TABLE_FETCHED_AT} 取得）。Haiku 5.5 はプロンプト 10 万 tokens 超の応答で単価が上がるため、応答ごとに判定している。`,
]

/** 末尾の注記（注記の全件・畳み込み・免責・判定基準）。コストの節の続きに並ぶ。 */
const footerLines = (analysis: ReviewAnalysis): string[] => [
  ...analysis.notes.map(note => note.text),
  ...(analysis.archiveNote === null ? [] : [analysis.archiveNote]),
  ALWAYS_NOTE,
  '',
  ...CRITERIA_LINES,
]

/**
 * テキストレポートの行。先頭はペインと同じ結論の 1 行。記録がなければ結論と案内の 2 行だけを返す。
 * `muted` は設定で止めている指摘の種類（結論・指摘の節から外す）。
 * 節の順序と出し分けは sections.ts、集計は analysis.ts で、ペインと同じものを使う。
 */
export function buildReportLines(review: ReviewState, nowMs?: number, muted?: ReadonlySet<ConcernKind>, rate: RateView | null = null): string[] {
  if (review.turns.length === 0) return [NO_RECORDS_CONCLUSION.text, NO_TURNS_LINE]
  const analysis = analyzeReview(review, nowMs, muted)
  return [
    analysis.conclusion.text,
    moneyLineFrom(analysis.estimate, analysis.diff, rate !== null),
    '',
    `対象: ${analysis.totalTurns} ターン（サブエージェント ${analysis.subagents} 件）。Mod 読み込み前のターンは含みません。`,
    '',
    ...buildSections(analysis).flatMap(section => sectionLines(section, nowMs, rate)),
    ...footerLines(analysis),
  ]
}
