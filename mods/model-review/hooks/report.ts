// テキストレポート（/model-review text・copy）の行を組み立てる純粋関数。
// 集計は analysis.ts、節の順序と出し分けは sections.ts（ペインと共有）、文面の部品は summary.ts。ここはテキストだけの並びと書式を持つ。
import type { ArchivedGroup, ReviewState, TurnRecord } from '../types'
import { analyzeReview, type ReviewAnalysis } from './analysis'
import { BREAKDOWN_LABEL } from './breakdown'
import { GROWTH_LABEL } from './growth'
import type { RateView } from './pace'
import { formatInt, formatUsd } from './format'
import { ALWAYS_NOTE, type FindingNote } from './notes'
import { PRICE_TABLE_FETCHED_AT } from './pricing'
import { CONCERN_TEXT, FINDING_LABEL, HEADING, NO_CONCERNS_TEXT, PAST_CONCERNS_HEADING } from './labels'
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
  NO_TURNS_LINE,
  concernDetailText,
  groupFacts,
  moneyLineFrom,
  toolDetailText,
  turnOriginLabel,
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

/** 差の推定の基準の注記。金額行の「差」に付く説明で、金額行を長くしないよう別行にする。 */
const DIFF_BASIS_NOTE = '※ 差の推定は単価表の値。ターン外の要求は含まない'

/**
 * コストの節の本文。推定・実・差は結論の次の金額行に 1 回だけ出すので、ここでは再掲しない。
 * 内訳・推移と、差がある場合の基準の注記だけを並べる。
 */
function costLines(section: CostSection): string[] {
  const { breakdown, growth, diff } = section
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
  return [...breakdownLines, ...growthLines, ...(diff === null ? [] : [DIFF_BASIS_NOTE])]
}

/** 指摘 1 件の行。過去の指摘には「次の一手」を付けない（いま直す対象ではないため）。 */
function oneConcernLines(concern: Concern, next: string | null): string[] {
  return [
    `  【${CONCERN_TEXT[concern.kind].label}】 ${concernDetailText(concern)}`,
    ...concern.examples.map(example => `    ・${example}`),
    ...(next === null ? [] : [`    → ${next}`]),
  ]
}

/** 所見の中の警告 1 行（指摘の【過剰】と同じ形）。 */
const findingLine = (note: FindingNote): string => `  【${FINDING_LABEL[note.kind]}】 ${note.text}`

/**
 * 直近の指摘を先に、所見の警告（再構築・TTL 乖離）を指摘の後に、窓より前にだけ該当した指摘は小見出しの下に分けて並べる。
 * 止めている種類は最後に 1 行だけ。
 */
function concernLines(section: ConcernsSection): string[] {
  const { recent, findings, past, nextSteps, numericNote, mutedLine } = section
  return [
    `■ ${HEADING.concerns} · ヒューリスティック`,
    ...(recent.length === 0 ? [`  ${NO_CONCERNS_TEXT}`] : recent.flatMap(concern => oneConcernLines(concern, nextSteps.get(concern) ?? null))),
    ...findings.map(findingLine),
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

/** コストの節。見出しの後に、推定・内訳・推移・実コスト・使用率・advisor を並べ、節の終わりに空行を置く（次は信頼度）。 */
function costSectionLines(section: CostSection, rate: RateView | null): string[] {
  return [
    `■ ${HEADING.cost}`,
    ...costLines(section),
    ...rateLines(rate),
    ...(section.advisorText === null ? [] : [`advisor ${section.advisorText}`]),
    '',
  ]
}

function sectionLines(section: Section, nowMs: number | undefined, rate: RateView | null): string[] {
  switch (section.kind) {
    case 'concerns':
      return concernLines(section)
    case 'groups':
      return [`■ ${HEADING.groupsText}`, ...section.groups.map(groupLine), '']
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
  `判定基準（参考）: 軽作業 = ツール ${LIGHT_MAX_TOOL_CALLS} 回以下・編集系なし・出力 ${formatInt(LIGHT_MAX_OUTPUT_TOKENS)} tokens 以下。重い = ツール ${HEAVY_TOOL_CALLS} 回以上、または長時間・エラー。`,
  `単価は pricing.ts の表（platform.claude.com の価格表、${PRICE_TABLE_FETCHED_AT} 取得）。Haiku 5.5 はプロンプト 10 万 tokens 超の応答で単価が上がるため、応答ごとに判定している。`,
]

/** 末尾の信頼度（切替などの注記・畳み込み・免責）と判定基準。コストの節の後に、空行を挟んで続く。 */
const footerLines = (analysis: ReviewAnalysis): string[] => [
  `■ ${HEADING.reliability}`,
  ...analysis.trustNotes.map(note => note.text),
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
