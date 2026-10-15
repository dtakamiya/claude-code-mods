// キャッシュまわりの判定。$ に触れない純粋関数。閾値は名前付き定数（仮置き）。
import type { TokenCounts, TurnRecord } from '../types'

/** 書込が読込を上回るターンがこの回数以上続いたら、プレフィックスが変わり続けている可能性として注記する。 */
export const CACHE_REBUILD_STREAK = 3
/** 実コストが推定をこの割合より多く上回るとき、推定の見落としを疑う。 */
export const CACHE_TTL_DIFF_RATIO = 0.2
/** TTL 単価差を疑うために必要な、キャッシュ書込の合計トークン数。 */
export const CACHE_TTL_MIN_WRITE_TOKENS = 50_000

/** キャッシュ読込 ÷（入力 + 読込 + 書込）。分母が 0 なら null。 */
export function cacheHitRate(tokens: TokenCounts): number | null {
  const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return promptTokens === 0 ? null : tokens.cacheRead / promptTokens
}

/** メインループで、書込が読込を上回るターンの最長の連続回数。 */
export function longestRebuildStreak(records: readonly TurnRecord[]): number {
  const scan = records
    .filter(record => record.agentId === null)
    .reduce(
      (acc, record) => {
        const streak = record.tokens.cacheWrite > record.tokens.cacheRead ? acc.streak + 1 : 0
        return { streak, longest: Math.max(acc.longest, streak) }
      },
      { streak: 0, longest: 0 },
    )
  return scan.longest
}

export type TtlCheck = {
  readonly actualUsd: number
  readonly estimateUsd: number
  readonly cacheWriteTokens: number
}

/** 実コストが推定を大きく上回るか。推定には、書込を 1 時間単価にした上限（notes.ts）を渡す。TTL 以外（fast mode・advisor・ターン外の要求・単価表の古さ）の可能性もある。 */
export function ttlUnderestimateSuspected(check: TtlCheck): boolean {
  if (check.estimateUsd <= 0 || check.cacheWriteTokens < CACHE_TTL_MIN_WRITE_TOKENS) return false
  return (check.actualUsd - check.estimateUsd) / check.estimateUsd > CACHE_TTL_DIFF_RATIO
}
