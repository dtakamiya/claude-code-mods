// ペイン・コマンド出力で共用する注記と合計。$ に触れない純粋関数。
import type { ReviewState, TurnRecord } from '../types'
import { estimateTotal } from './analyze'
import { CACHE_REBUILD_STREAK, longestRebuildStreak, ttlUnderestimateSuspected } from './cache'
import { PRICE_TABLE_FETCHED_AT } from './pricing'
import { findSwitches } from './switches'

/** 単価不明のターンがこの割合以上なら、単価表が古い可能性を注記する（仮置き）。 */
export const UNPRICED_STALE_RATIO = 0.3

export const ALWAYS_NOTE =
  '推定に含まれないもの: fast mode の割増、advisor の費用（未確認）。キャッシュ書込は 5 分単価で概算しています。'

export const advisorCallTotal = (records: readonly TurnRecord[]): number =>
  records.reduce((sum, record) => sum + (record.advisorCalls ?? 0), 0)

const cacheWriteTotal = (records: readonly TurnRecord[]): number =>
  records.reduce((sum, record) => sum + record.tokens.cacheWrite, 0)

function rebuildStreakNote(records: readonly TurnRecord[]): readonly string[] {
  const streak = longestRebuildStreak(records)
  if (streak < CACHE_REBUILD_STREAK) return []
  return [
    `キャッシュ書込が読込を上回るターンが ${streak} 回連続しています（プレフィックスが変わり続けている可能性。モデル・effort・MCP・プラグインの変更を確認）`,
  ]
}

function ttlNote(review: ReviewState, estimateUsd: number): readonly string[] {
  const { baseline, current } = review.sessionCostUsd
  if (baseline === null || current === null) return []
  const suspected = ttlUnderestimateSuspected({
    actualUsd: current - baseline,
    estimateUsd,
    cacheWriteTokens: cacheWriteTotal(review.turns),
  })
  if (!suspected) return []
  return ['実コストが推定を大きく上回っています。キャッシュ書込を 5 分単価で概算しているため、1 時間 TTL（サブスクのメイン会話の既定）の書込単価差の可能性があります']
}

function staleNote(records: readonly TurnRecord[], unpricedTurns: number): readonly string[] {
  if (unpricedTurns / records.length < UNPRICED_STALE_RATIO) return []
  return [`単価不明のターンが ${unpricedTurns} / ${records.length} 件あります。単価表が古い可能性があります（pricing.ts の取得日: ${PRICE_TABLE_FETCHED_AT}）`]
}

function switchNote(records: readonly TurnRecord[]): readonly string[] {
  if (findSwitches(records).count === 0) return []
  return ['切替の推定は、切替直後の最初の応答のキャッシュ書込から算出しています。長い中断によるキャッシュ切れとは区別できません。Bedrock・Vertex・gateway 経由では effort 変更でもキャッシュは維持されません']
}

/** 状況に応じた注記（常に出す 1 行を除く）。記録がなければ空。 */
export function buildNotes(review: ReviewState): readonly string[] {
  const records = review.turns
  if (records.length === 0) return []
  const { costUsd: estimateUsd, unpricedTurns } = estimateTotal(records)
  return [
    ...rebuildStreakNote(records),
    ...ttlNote(review, estimateUsd),
    ...staleNote(records, unpricedTurns),
    ...switchNote(records),
  ]
}
