// 記録・分析・文言のどの層からも使う、最下層の定義（値と小さな演算）。$ にも他の hooks モジュールにも依存しない。
// 分析や文言が記録側（recorder）や表示側（breakdown）を import しないよう、共通の部品はここに置く。
import type { CostParts, TokenCounts } from '../types'

/** API が model id を返さなかったターンのモデル名。 */
export const UNKNOWN_MODEL = 'unknown'

/** 結論の ▲ は、メインの直近この数のターンの中に該当がある指摘だけで決める。窓より前だけの指摘は「過去の指摘」として別に並べる。対処が効いたかを画面で分かるようにするため（仮置き）。 */
export const RECENT_CONCERN_MAIN_TURNS = 20

export const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

export const ZERO_PARTS: CostParts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const addParts = (a: CostParts, b: CostParts): CostParts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

/** 推定コストの足し算。どちらかが単価不明（null）なら合計も不明。 */
export const addCost = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b)

const MODEL_ID_PREFIX = 'claude-'

/** 表示用の短いモデル名（`claude-` を外す）。 */
export const shortModel = (model: string): string => (model.startsWith(MODEL_ID_PREFIX) ? model.slice(MODEL_ID_PREFIX.length) : model)
