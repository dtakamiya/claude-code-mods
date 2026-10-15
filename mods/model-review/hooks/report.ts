// ペインとコマンド出力に載せる文面（日本語）を組み立てる純粋関数。
import type { ReviewState, TurnRecord } from '../types'
import {
  HEAVY_TOOL_CALLS,
  LIGHT_MAX_OUTPUT_TOKENS,
  LIGHT_MAX_TOOL_CALLS,
  estimateTotal,
  findConcerns,
  groupByModelEffort,
  type Concern,
  type ModelGroup,
} from './analyze'

const CONCERN_TITLE: Readonly<Record<Concern['kind'], string>> = {
  overspec: '過剰の可能性',
  underspec: '不足の可能性',
  delegation: '指揮者モデル運用の確認',
}

export const NO_TURNS_LINE ='記録されたターンはまだありません。この Mod の読み込み後に完了したターンが対象です。'

export function formatInt(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatUsd(value: number | null): string {
  return value === null ? '単価不明' : `$${value.toFixed(4)}`
}

function groupLine(group: ModelGroup): string {
  const { tokens } = group
  return [
    `${group.model}  effort ${group.effort ?? '-'}`,
    `ターン ${group.turns}`,
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

function concernLines(concerns: readonly Concern[]): string[] {
  if (concerns.length === 0) return ['指摘はありません。']
  return concerns.flatMap(concern => [
    `【${CONCERN_TITLE[concern.kind]}】 ${concern.count} 件`,
    ...concern.examples.map(example => `  ・${example}`),
  ])
}

const CRITERIA_LINES = [
  `判定基準（参考）: 軽作業 = ツール ${LIGHT_MAX_TOOL_CALLS} 回以下・編集系なし・出力 ${LIGHT_MAX_OUTPUT_TOKENS} tokens 以下。重い = ツール ${HEAVY_TOOL_CALLS} 回以上、または長時間・エラー・中断。`,
  '単価は pricing.ts の表（platform.claude.com の価格表、2026-10-15 取得）。Haiku 5.5 はプロンプト 10 万 tokens 超の応答で単価が上がるため、応答ごとに判定している。',
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
    '■ コスト',
    ...costLines(review, records),
    '',
    '■ 妥当性（参考・ヒューリスティック）',
    ...concernLines(findConcerns(records)),
    '',
    ...CRITERIA_LINES,
  ]
}
