// ペイン・コマンド出力で共用する注記と合計。$ に触れない純粋関数。
import type { ReviewState, TurnRecord } from '../types'
import { estimateRange, estimateTotal } from './analyze'
import { CACHE_REBUILD_STREAK, longestRebuildStreak, ttlUnderestimateSuspected } from './cache'
import { PRICE_TABLE_FETCHED_AT, PRICE_TABLE_STALE_DAYS } from './pricing'
import { turnsSinceBaseline } from './state'
import { findSwitches } from './switches'

/** 単価不明のターンがこの割合以上なら、単価表が古い可能性を注記する（仮置き）。 */
export const UNPRICED_STALE_RATIO = 0.3

export const ALWAYS_NOTE =
  '推定に含まれないもの: fast mode の割増、advisor の費用（usage に載らず取得できないため含まれません。Claude Code の更新時に再確認します）。キャッシュ書込の TTL は分からないため、推定は 5 分単価（下限）〜1 時間単価（上限）の幅で示します。'

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

/** 実コスト（基準点からの差）と同じターンだけで上限推定を取る。基準点より前のターンは実コストに入らないため、混ぜると偽陰性になる。 */
function ttlNote(review: ReviewState): readonly string[] {
  const { baseline, current } = review.sessionCostUsd
  if (baseline === null || current === null) return []
  const sinceBaseline = turnsSinceBaseline(review)
  const suspected = ttlUnderestimateSuspected({
    actualUsd: current - baseline,
    estimateUsd: estimateRange(sinceBaseline).highUsd,
    cacheWriteTokens: cacheWriteTotal(sinceBaseline),
  })
  if (!suspected) return []
  return ['実コストが、キャッシュ書込を 1 時間単価にした上限の推定も大きく上回っています。fast mode・advisor・ターン外の要求・単価表の古さなどが考えられます']
}

function staleNote(records: readonly TurnRecord[], unpricedTurns: number): readonly string[] {
  if (unpricedTurns / records.length < UNPRICED_STALE_RATIO) return []
  const models = [...new Set(records.filter(record => record.costUsd === null).map(record => record.model))]
  return [
    `単価不明のターンが ${unpricedTurns} / ${records.length} 件あります（モデル: ${models.join('、')}）。単価表が古い可能性があります（gateway・独自のモデル名のこともあります）。pricing.ts に単価を足すと推定に含まれます（取得日: ${PRICE_TABLE_FETCHED_AT}）`,
  ]
}

const MS_PER_DAY = 86_400_000

/** 取得日から日数が経ちすぎた単価表への注記。現在時刻は呼び出し側から渡す（純粋関数を保つ）。取得日を読めなければ出さない。 */
function priceAgeNote(nowMs: number | undefined): readonly string[] {
  const fetchedMs = Date.parse(PRICE_TABLE_FETCHED_AT)
  if (nowMs === undefined || Number.isNaN(fetchedMs)) return []
  const ageDays = Math.floor((nowMs - fetchedMs) / MS_PER_DAY)
  if (ageDays <= PRICE_TABLE_STALE_DAYS) return []
  return [`単価表の取得から ${ageDays} 日経っています（取得日: ${PRICE_TABLE_FETCHED_AT}）。価格表の改定がないか確認してください`]
}

/** 切替の注記を出すのは、直近この件数のターンの中に切替があるときだけ（仮置き。ペインで見て決め直す）。 */
export const SWITCH_NOTE_RECENT_TURNS = 10

function switchNote(records: readonly TurnRecord[]): readonly string[] {
  // 窓より前だけの記録で数えた切替を引く。窓の先頭の切替は、直前のターンを含めて数えられる。
  const earlier = records.slice(0, -SWITCH_NOTE_RECENT_TURNS)
  if (findSwitches(records).count <= findSwitches(earlier).count) return []
  return ['切替の推定は、切替直後の最初の応答のキャッシュ書込から算出しています。長い中断によるキャッシュ切れとは区別できません。Bedrock・Vertex・gateway 経由では effort 変更でもキャッシュは維持されません']
}

/** 状況に応じた注記（常に出す 1 行を除く）。記録がなければ空。 */
export function buildNotes(review: ReviewState, nowMs?: number): readonly string[] {
  const records = review.turns
  if (records.length === 0) return []
  const { unpricedTurns } = estimateTotal(records)
  return [
    ...rebuildStreakNote(records),
    ...ttlNote(review),
    ...staleNote(records, unpricedTurns),
    ...priceAgeNote(nowMs),
    ...switchNote(records),
  ]
}
