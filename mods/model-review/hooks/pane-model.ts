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
  topCostTurns,
  type Concern,
  type ConcernKind,
  type ModelGroup,
} from './analyze'
import type { Drafts, LoopDraft } from './recorder'
import { ALWAYS_NOTE, advisorCallTotal, buildNotes } from './notes'
import { CONCERN_AMOUNT_LABEL, NO_TURNS_LINE, formatInt, formatUsd, hitRateText } from './report'

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
  | { kind: 'group'; model: string; effort: string; tier: Tier; turns: number; filled: number; percentText: string; costText: string; tokenText: string }
  | { kind: 'turn'; label: string; model: string; tier: Tier; costText: string; detail: string }
  | { kind: 'kv'; label: string; value: string; tone: Tone }
  | { kind: 'badge'; label: string; tone: Tone; text: string }
  | { kind: 'example'; text: string }
  | { kind: 'ok'; text: string }
  | { kind: 'note'; text: string }

const TIER_OF_RANK: Readonly<Record<number, Tier>> = { 0: 'haiku', 1: 'sonnet', 2: 'opus' }
const CONCERN_BADGE: Readonly<Record<ConcernKind, { label: string; tone: Tone; text: string }>> = {
  overspec: { label: '過剰', tone: 'warning', text: '軽作業に重いモデル / effort' },
  underspec: { label: '不足', tone: 'error', text: '重い作業に軽い設定' },
  delegation: {
    label: '委譲',
    tone: 'suggestion',
    text: 'Haiku サブエージェントへの委譲なし（サブエージェントは 5 分 TTL・親のキャッシュを読まない）',
  },
  switch: { label: '切替', tone: 'warning', text: 'モデル / effort の切替でキャッシュを再構築' },
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
  const { tokens } = group
  const share = costShare(group.costUsd, totalUsd)
  const hit = hitRateText(tokens)
  return {
    kind: 'group',
    model: shortModel(group.model),
    effort: group.effort ?? NO_EFFORT_LABEL,
    tier: tierOf(group.model),
    turns: group.turns,
    filled: filledCells(share),
    percentText: percentText(share),
    costText: formatUsd(group.costUsd),
    tokenText: `${hit === null ? '' : `${hit} · `}入力 ${formatInt(tokens.input)} · 出力 ${formatInt(tokens.output)} · キャッシュ 読 ${formatInt(tokens.cacheRead)} / 書 ${formatInt(tokens.cacheWrite)}`,
  }
}

function costRows(review: ReviewState, estimateUsd: number, unpricedTurns: number): PaneRow[] {
  const unpriced = unpricedTurns > 0 ? ` （単価不明 ${unpricedTurns} ターンを除く）` : ''
  const estimate = `${formatUsd(estimateUsd)}${unpriced}`
  const { baseline, current } = review.sessionCostUsd
  if (baseline === null || current === null) {
    return [{ kind: 'kv', label: 'コスト', value: `推定 ${estimate} / 実コスト 取得できません`, tone: 'plain' }]
  }
  const actual = current - baseline
  const diff = actual - estimateUsd
  const diffText = `${diff >= 0 ? '+' : '-'}${formatUsd(Math.abs(diff))}`
  return [{ kind: 'kv', label: 'コスト', value: `推定 ${estimate} / 実 ${formatUsd(actual)}（読み込み後）/ 差 ${diffText}`, tone: 'plain' }]
}

function concernRows(concerns: readonly Concern[]): PaneRow[] {
  if (concerns.length === 0) return [{ kind: 'ok', text: '指摘なし' }]
  return concerns.flatMap((concern): PaneRow[] => {
    const badge = CONCERN_BADGE[concern.kind]
    const amountLabel = CONCERN_AMOUNT_LABEL[concern.kind]
    const amount = concern.amountUsd === null || amountLabel === null ? '' : ` · ${amountLabel} ${formatUsd(concern.amountUsd)}`
    return [
      { kind: 'badge', label: badge.label, tone: badge.tone, text: `${badge.text} · ${concern.count} 件${amount}` },
      ...concern.examples.map((text): PaneRow => ({ kind: 'example', text })),
    ]
  })
}

function topTurnRows(records: ReviewState['turns']): PaneRow[] {
  const top = topCostTurns(records)
  if (top.length === 0) return []
  return [
    { kind: 'heading', text: '高コストターン' },
    ...top.map((record): PaneRow => ({
      kind: 'turn',
      label: `${record.turnId} · ${record.agentId === null ? 'メイン' : 'サブエージェント'}`,
      model: shortModel(record.model),
      tier: tierOf(record.model),
      costText: formatUsd(record.costUsd),
      detail: `ツール ${record.toolCount} 回 · ${record.durationMs} ms`,
    })),
    { kind: 'blank' },
  ]
}

function advisorRows(records: ReviewState['turns']): PaneRow[] {
  const calls = advisorCallTotal(records)
  if (calls === 0) return []
  return [{ kind: 'kv', label: 'advisor', value: `${calls} 回（費用が usage に載るかは未確認。金額には含めていません）`, tone: 'plain' }]
}

const concernHeading = (concerns: readonly Concern[]): string => {
  const total = concerns.reduce((sum, concern) => sum + concern.count, 0)
  return total === 0 ? '妥当性（参考）' : `妥当性（参考）· 指摘 ${total} 件`
}

const CRITERIA_NOTE = `軽作業 = ツール ${LIGHT_MAX_TOOL_CALLS} 回以下・編集なし・出力 ${LIGHT_MAX_OUTPUT_TOKENS} tokens 以下 / 重い = ツール ${HEAVY_TOOL_CALLS} 回以上・長時間・エラー・中断`

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

export function buildPaneRows(review: ReviewState, drafts: Drafts = {}): PaneRow[] {
  const records = review.turns
  const live = liveRows(drafts)
  if (records.length === 0) return live.length === 0 ? [{ kind: 'message', text: NO_TURNS_LINE }] : live.slice(0, -1)
  const { costUsd: estimateUsd, unpricedTurns } = estimateTotal(records)
  const concerns = findConcerns(records)
  return [
    {
      kind: 'title',
      turns: records.length,
      subagents: records.filter(record => record.agentId !== null).length,
      costText: formatUsd(unpricedTurns === records.length ? null : estimateUsd),
    },
    { kind: 'blank' },
    ...live,
    { kind: 'heading', text: concernHeading(concerns) },
    ...concernRows(concerns),
    { kind: 'blank' },
    { kind: 'heading', text: 'モデル × effort（コスト比）' },
    ...groupByModelEffort(records).map(group => groupRow(group, estimateUsd)),
    { kind: 'blank' },
    ...topTurnRows(records),
    { kind: 'heading', text: 'コスト' },
    ...costRows(review, estimateUsd, unpricedTurns),
    ...advisorRows(records),
    { kind: 'blank' },
    ...buildNotes(review).map((text): PaneRow => ({ kind: 'note', text })),
    { kind: 'note', text: ALWAYS_NOTE },
    { kind: 'note', text: CRITERIA_NOTE },
  ]
}
