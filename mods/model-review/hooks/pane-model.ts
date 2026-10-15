// ペインの行モデルを組み立てる純粋関数。`$` にも JSX にも依存しない。描画は pane.tsx。
import type { ReviewState } from '../types'
import {
  HEAVY_TOOL_CALLS,
  LIGHT_MAX_OUTPUT_TOKENS,
  LIGHT_MAX_TOOL_CALLS,
  estimateTotal,
  findConcerns,
  groupByModelEffort,
  modelRank,
  type Concern,
  type ConcernKind,
  type ModelGroup,
} from './analyze'
import { NO_TURNS_LINE, formatInt, formatUsd } from './report'

export const BAR_WIDTH = 14
const MODEL_ID_PREFIX = 'claude-'
const NO_EFFORT_LABEL = '-'

export type Tone = 'success' | 'warning' | 'error' | 'suggestion' | 'plain'
export type Tier = 'haiku' | 'sonnet' | 'opus' | 'other'

export type PaneRow =
  | { kind: 'message'; text: string }
  | { kind: 'blank' }
  | { kind: 'title'; turns: number; subagents: number; costText: string }
  | { kind: 'heading'; text: string }
  | { kind: 'group'; model: string; effort: string; tier: Tier; turns: number; filled: number; costText: string; tokenText: string }
  | { kind: 'kv'; label: string; value: string; tone: Tone }
  | { kind: 'badge'; label: string; tone: Tone; text: string }
  | { kind: 'example'; text: string }
  | { kind: 'ok'; text: string }
  | { kind: 'note'; text: string }

const TIER_OF_RANK: Readonly<Record<number, Tier>> = { 0: 'haiku', 1: 'sonnet', 2: 'opus' }
const CONCERN_BADGE: Readonly<Record<ConcernKind, { label: string; tone: Tone; text: string }>> = {
  overspec: { label: '過剰', tone: 'warning', text: '軽作業に重いモデル / effort' },
  underspec: { label: '不足', tone: 'error', text: '重い作業に軽い設定' },
  delegation: { label: '委譲', tone: 'suggestion', text: 'Haiku サブエージェントへの委譲なし' },
}

const tierOf = (model: string): Tier => TIER_OF_RANK[modelRank(model)] ?? 'other'
const shortModel = (model: string): string => (model.startsWith(MODEL_ID_PREFIX) ? model.slice(MODEL_ID_PREFIX.length) : model)

/** コスト比を 0〜BAR_WIDTH のセル数にする。単価不明（null）は 0。 */
function filledCells(costUsd: number | null, totalUsd: number): number {
  if (costUsd === null || totalUsd <= 0) return 0
  return Math.min(BAR_WIDTH, Math.max(1, Math.round((costUsd / totalUsd) * BAR_WIDTH)))
}

function groupRow(group: ModelGroup, totalUsd: number): PaneRow {
  const { tokens } = group
  return {
    kind: 'group',
    model: shortModel(group.model),
    effort: group.effort ?? NO_EFFORT_LABEL,
    tier: tierOf(group.model),
    turns: group.turns,
    filled: filledCells(group.costUsd, totalUsd),
    costText: formatUsd(group.costUsd),
    tokenText: `入力 ${formatInt(tokens.input)} · 出力 ${formatInt(tokens.output)} · キャッシュ 読 ${formatInt(tokens.cacheRead)} / 書 ${formatInt(tokens.cacheWrite)}`,
  }
}

function costRows(review: ReviewState, estimateUsd: number, unpricedTurns: number): PaneRow[] {
  const unpriced = unpricedTurns > 0 ? ` （単価不明 ${unpricedTurns} ターンを除く）` : ''
  const estimate: PaneRow = { kind: 'kv', label: '推定', value: `${formatUsd(estimateUsd)}${unpriced}`, tone: 'plain' }
  const { baseline, current } = review.sessionCostUsd
  if (baseline === null || current === null) {
    return [estimate, { kind: 'kv', label: '実コスト', value: '取得できません', tone: 'plain' }]
  }
  const actual = current - baseline
  const diff = actual - estimateUsd
  return [
    estimate,
    { kind: 'kv', label: '実コスト', value: `${formatUsd(actual)}（読み込み後）`, tone: 'plain' },
    { kind: 'kv', label: '差', value: `${diff >= 0 ? '+' : '-'}${formatUsd(Math.abs(diff))}（実 − 推定）`, tone: 'plain' },
  ]
}

function concernRows(concerns: readonly Concern[]): PaneRow[] {
  if (concerns.length === 0) return [{ kind: 'ok', text: '指摘なし' }]
  return concerns.flatMap((concern): PaneRow[] => {
    const badge = CONCERN_BADGE[concern.kind]
    return [
      { kind: 'badge', label: badge.label, tone: badge.tone, text: `${badge.text} · ${concern.count} 件` },
      ...concern.examples.map((text): PaneRow => ({ kind: 'example', text })),
    ]
  })
}

const CRITERIA_NOTE = `軽作業 = ツール ${LIGHT_MAX_TOOL_CALLS} 回以下・編集なし・出力 ${LIGHT_MAX_OUTPUT_TOKENS} tokens 以下 / 重い = ツール ${HEAVY_TOOL_CALLS} 回以上・長時間・エラー・中断`

export function buildPaneRows(review: ReviewState): PaneRow[] {
  const records = review.turns
  if (records.length === 0) return [{ kind: 'message', text: NO_TURNS_LINE }]
  const { costUsd: estimateUsd, unpricedTurns } = estimateTotal(records)
  return [
    {
      kind: 'title',
      turns: records.length,
      subagents: records.filter(record => record.agentId !== null).length,
      costText: formatUsd(unpricedTurns === records.length ? null : estimateUsd),
    },
    { kind: 'blank' },
    { kind: 'heading', text: 'モデル × effort（コスト比）' },
    ...groupByModelEffort(records).map(group => groupRow(group, estimateUsd)),
    { kind: 'blank' },
    { kind: 'heading', text: 'コスト' },
    ...costRows(review, estimateUsd, unpricedTurns),
    { kind: 'blank' },
    { kind: 'heading', text: '妥当性（参考）' },
    ...concernRows(findConcerns(records)),
    { kind: 'blank' },
    { kind: 'note', text: CRITERIA_NOTE },
  ]
}
