// ペインとコマンド出力に載せる文面（日本語）を組み立てる純粋関数。
import type { ReviewState, TurnRecord } from '../types'
import { cacheHitRate } from './cache'
import { formatInt, formatUsd } from './format'
import { ALWAYS_NOTE, advisorCallTotal, buildNotes } from './notes'
import { PRICE_TABLE_FETCHED_AT } from './pricing'
import {
  HEAVY_TOOL_CALLS,
  LIGHT_MAX_OUTPUT_TOKENS,
  LIGHT_MAX_TOOL_CALLS,
  estimateTotal,
  findConcerns,
  groupByModelEffort,
  topCostTurns,
  type Concern,
  type ModelGroup,
} from './analyze'

const CONCERN_TITLE: Readonly<Record<Concern['kind'], string>> = {
  overspec: '過剰の可能性',
  underspec: '不足の可能性',
  delegation: '指揮者モデル運用の確認',
  switch: 'モデル・effort の切替',
}

/** 指摘の金額の前に付ける語。金額の意味が種類ごとに違う。 */
export const CONCERN_AMOUNT_LABEL: Readonly<Record<Concern['kind'], string | null>> = {
  overspec: '最大',
  underspec: null,
  delegation: null,
  switch: '推定',
}

export const hitRateText = (tokens: ModelGroup['tokens']): string | null => {
  const rate = cacheHitRate(tokens)
  return rate === null ? null : `ヒット ${Math.round(rate * 100)}%`
}

export const NO_TURNS_LINE ='記録されたターンはまだありません。この Mod の読み込み後に完了したターンが対象です。'

export { formatInt, formatUsd }

function groupLine(group: ModelGroup): string {
  const { tokens } = group
  const hit = hitRateText(tokens)
  return [
    `${group.model}  effort ${group.effort ?? '-'}`,
    `ターン ${group.turns}`,
    ...(hit === null ? [] : [hit]),
    `入力 ${formatInt(tokens.input)}`,
    `出力 ${formatInt(tokens.output)}`,
    `キャッシュ読 ${formatInt(tokens.cacheRead)}`,
    `書 ${formatInt(tokens.cacheWrite)}`,
    `推定 ${formatUsd(group.costUsd)}`,
  ].join('  ')
}

function costLines(review: ReviewState, records: readonly TurnRecord[]): string[] {
  const estimate = estimateTotal(records)
  const estimateLine = `合計推定コスト: ${formatUsd(estimate.costUsd)}（単価不明 ${estimate.unpricedTurns} ターンを除く）`
  const { baseline, current } = review.sessionCostUsd
  if (baseline === null || current === null) {
    return [estimateLine, 'セッション実コスト: 取得できません（コストの記録がない環境）']
  }
  const actual = current - baseline
  return [
    estimateLine,
    `セッション実コスト（読み込み後）: ${formatUsd(actual)}`,
    `差（実コスト − 推定）: ${formatUsd(actual - estimate.costUsd)}（推定は単価表の値。キャッシュ書込みは 5 分単価で概算し、ターン外の要求は含まない）`,
  ]
}

function amountSuffix(concern: Concern): string {
  const label = CONCERN_AMOUNT_LABEL[concern.kind]
  return concern.amountUsd === null || label === null ? '' : ` · ${label} ${formatUsd(concern.amountUsd)}`
}

function concernLines(concerns: readonly Concern[]): string[] {
  if (concerns.length === 0) return ['指摘はありません。']
  return concerns.flatMap(concern => [
    `【${CONCERN_TITLE[concern.kind]}】 ${concern.count} 件${amountSuffix(concern)}`,
    ...concern.examples.map(example => `  ・${example}`),
  ])
}

function topTurnLines(records: readonly TurnRecord[]): string[] {
  return topCostTurns(records).map(
    record =>
      `  ${formatUsd(record.costUsd)}  ターン ${record.turnId}（${record.agentId === null ? 'メイン' : 'サブエージェント'}）${record.model}  ツール ${record.toolCount} 回 · ${record.durationMs} ms`,
  )
}

function advisorLines(records: readonly TurnRecord[]): string[] {
  const calls = advisorCallTotal(records)
  return calls === 0 ? [] : [`advisor ${calls} 回（費用が usage に載るかは未確認。金額には含めていません）`]
}

const CRITERIA_LINES = [
  `判定基準（参考）: 軽作業 = ツール ${LIGHT_MAX_TOOL_CALLS} 回以下・編集系なし・出力 ${LIGHT_MAX_OUTPUT_TOKENS} tokens 以下。重い = ツール ${HEAVY_TOOL_CALLS} 回以上、または長時間・エラー・中断。`,
  `単価は pricing.ts の表（platform.claude.com の価格表、${PRICE_TABLE_FETCHED_AT} 取得）。Haiku 5.5 はプロンプト 10 万 tokens 超の応答で単価が上がるため、応答ごとに判定している。`,
]

/** ペインに表示する行。記録がなければ案内の 1 行だけを返す。 */
export function buildReportLines(review: ReviewState): string[] {
  const records = review.turns
  if (records.length === 0) return [NO_TURNS_LINE]
  const subagentCount = records.filter(record => record.agentId !== null).length
  return [
    `対象: ${records.length} ターン（サブエージェント ${subagentCount} 件）。Mod 読み込み前のターンは含みません。`,
    '',
    '■ モデル × effort 別',
    ...groupByModelEffort(records).map(groupLine),
    '',
    '■ 高コストターン',
    ...topTurnLines(records),
    '',
    '■ コスト',
    ...costLines(review, records),
    ...advisorLines(records),
    ...buildNotes(review),
    ALWAYS_NOTE,
    '',
    '■ 妥当性（参考・ヒューリスティック）',
    ...concernLines(findConcerns(records)),
    '',
    ...CRITERIA_LINES,
  ]
}
