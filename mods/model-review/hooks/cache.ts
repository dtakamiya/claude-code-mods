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

/** メインループで、書込が読込を上回るターンの最長の連続回数。/compact 直後のターンは必然的な再構築なので数えず、連続も切る。 */
export function longestRebuildStreak(records: readonly TurnRecord[]): number {
  const scan = records
    .filter(record => record.agentId === null)
    .reduce(
      (acc, record) => {
        const rebuilt = record.afterCompact !== true && record.tokens.cacheWrite > record.tokens.cacheRead
        const streak = rebuilt ? acc.streak + 1 : 0
        return { streak, longest: Math.max(acc.longest, streak) }
      },
      { streak: 0, longest: 0 },
    )
  return scan.longest
}

/**
 * 仮置き（実ログで見直す）: キャッシュの読込・書込がともに 0 のメインのターンが、最新からこの回数以上続いたら、キャッシュが効いていない可能性として注記する。
 * 再構築の連続（CACHE_REBUILD_STREAK）に合わせた。
 */
export const NO_CACHE_STREAK = 3
/**
 * 仮置き（実ログで見直す）: キャッシュ未使用とみなすターンの入力（input + 読込 + 書込）の下限。短い入力は 0/0 が正常なことがあるので除く。
 * キャッシュできる最小長の公式値は未確認のため、それに依らない十分大きい目安にしている。
 */
export const NO_CACHE_MIN_PROMPT_TOKENS = 10_000

export type NoCacheStreak = { readonly streak: number; readonly promptTokens: number }

/**
 * メインループで、最新のターンから遡って、キャッシュの読込・書込がともに 0 で入力が下限以上のターンが何回続いているか。
 * 過去に未使用でも最新が使用済みなら 0。サブエージェントは数えず連続も切らない。/compact 直後のターンは数えず、連続を切る（再構築と同じ扱い）。
 * promptTokens は連続したターンの入力の合計。
 */
export function noCacheStreak(records: readonly TurnRecord[]): NoCacheStreak {
  const main = records.filter(record => record.agentId === null)
  let streak = 0
  let promptTokens = 0
  for (let index = main.length - 1; index >= 0; index -= 1) {
    const record = main[index]
    if (record === undefined || record.afterCompact === true) break
    const { input, cacheRead, cacheWrite } = record.tokens
    const prompt = input + cacheRead + cacheWrite
    if (cacheRead !== 0 || cacheWrite !== 0 || prompt < NO_CACHE_MIN_PROMPT_TOKENS) break
    streak += 1
    promptTokens += prompt
  }
  return { streak, promptTokens }
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
