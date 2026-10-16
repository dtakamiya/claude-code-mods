// ペインとコマンド出力に載せる文面（日本語）を組み立てる純粋関数。
// 集計と文面の部品は summary.ts。ここはテキスト出力だけに出す行と、その並びを持つ。
import type { ReviewState, TurnRecord } from '../types'
import { formatUsd, formatUsdRange } from './format'
import { ALWAYS_NOTE, buildNotes } from './notes'
import { PRICE_TABLE_FETCHED_AT } from './pricing'
import { HEADING, CONCERN_TEXT, NO_CONCERNS_TEXT } from './labels'
import { WHATIF_NOTE } from './whatif'
import {
  HEAVY_TOOL_CALLS,
  LIGHT_MAX_OUTPUT_TOKENS,
  LIGHT_MAX_TOOL_CALLS,
  findConcerns,
  groupByModelEffort,
  topCostTurns,
  type Concern,
  type ModelGroup,
} from './analyze'
import {
  NO_TURNS_LINE,
  actualCostUsd,
  advisorCallText,
  allUnpricedText,
  concernDetailText,
  describeSwitchOptions,
  estimateFacts,
  groupFacts,
  loopView,
  subagentCount,
  toolDetailText,
  turnOriginLabel,
  unpricedExclusionText,
} from './summary'

export { formatInt, formatUsd } from './format'
export { NO_TURNS_LINE } from './summary'

function groupLine(group: ModelGroup): string {
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

function costLines(review: ReviewState, records: readonly TurnRecord[]): string[] {
  const estimate = estimateFacts(records)
  const estimateLine = estimate.allUnpriced
    ? `合計推定コスト: ${allUnpricedText(records.length)}`
    : `合計推定コスト: ${formatUsdRange(estimate.lowUsd, estimate.highUsd)}${unpricedExclusionText(estimate.unpricedTurns)}`
  const actual = actualCostUsd(review)
  if (actual === null) {
    return [estimateLine, 'セッション実コスト: 取得できません（コストの記録がない環境）']
  }
  return [
    estimateLine,
    `セッション実コスト（読み込み後）: ${formatUsd(actual)}`,
    `差（実コスト − 推定）: ${formatUsd(actual - estimate.costUsd)}（推定は単価表の値。キャッシュ書込みは 5 分単価で概算し、ターン外の要求は含まない）`,
  ]
}

function concernLines(concerns: readonly Concern[]): string[] {
  if (concerns.length === 0) return [`  ${NO_CONCERNS_TEXT}`]
  return concerns.flatMap(concern => [
    `  【${CONCERN_TEXT[concern.kind].label}】 ${concernDetailText(concern)}`,
    ...concern.examples.map(example => `    ・${example}`),
  ])
}

function topTurnLines(records: readonly TurnRecord[]): string[] {
  return topCostTurns(records).map(
    record =>
      `  ${formatUsd(record.costUsd)}  ターン ${record.turnId}（${turnOriginLabel(record)}）${record.model}  ${toolDetailText(record)}`,
  )
}

function topTurnSection(records: readonly TurnRecord[]): string[] {
  const lines = topTurnLines(records)
  return lines.length === 0 ? [] : [`■ ${HEADING.topTurns}`, ...lines, '']
}

function advisorLines(records: readonly TurnRecord[]): string[] {
  const text = advisorCallText(records)
  return text === null ? [] : [`advisor ${text}`]
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

/** ペインに表示する行。記録がなければ案内の 1 行だけを返す。 */
export function buildReportLines(review: ReviewState, nowMs?: number): string[] {
  const records = review.turns
  if (records.length === 0) return [NO_TURNS_LINE]
  return [
    `対象: ${records.length} ターン（サブエージェント ${subagentCount(records)} 件）。Mod 読み込み前のターンは含みません。`,
    '',
    `■ ${HEADING.concerns}（ヒューリスティック）`,
    ...concernLines(findConcerns(records)),
    '',
    `■ ${HEADING.groups}`,
    ...groupByModelEffort(records).map(groupLine),
    '',
    ...topTurnSection(records),
    ...loopLines(records),
    ...whatIfLines(records),
    `■ ${HEADING.cost}`,
    ...costLines(review, records),
    ...advisorLines(records),
    ...buildNotes(review, nowMs),
    ALWAYS_NOTE,
    '',
    ...CRITERIA_LINES,
  ]
}
