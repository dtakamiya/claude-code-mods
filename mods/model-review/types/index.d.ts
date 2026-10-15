// このファイルは import を持たない（自己完結の契約）。値の形を変えたら hooks/ 側も直す。

/** 1 応答（または 1 ターン）のトークン数。ModelUsage の 4 つの数を名前だけ読みやすくしたもの。 */
export type TokenCounts = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** 完了したターン 1 件。agentId が null なら メインループ、値があればサブエージェントの 1 実行。 */
export type TurnRecord = {
  readonly turnId: string
  readonly agentId: string | null
  /** API が返した model id（取れなければ 'unknown'）。 */
  readonly model: string
  /** 最後の応答で指定された effort。effort を持たないモデルでは null。 */
  readonly effort: string | null
  readonly tokens: TokenCounts
  /** 推定コスト（USD）。単価表にないモデル、または単価不明の応答を含むとき null。 */
  readonly costUsd: number | null
  readonly toolCount: number
  readonly editCount: number
  readonly durationMs: number
  readonly reason: 'answer' | 'aborted' | 'refusal' | 'error'
}

export type ReviewState = {
  readonly turns: readonly TurnRecord[]
  /** `$.session.usage().cost.usd` の基準点（Mod 読み込み時）と直近値。取れない環境では null。 */
  readonly sessionCostUsd: {
    readonly baseline: number | null
    readonly current: number | null
  }
}

declare module 'claude-code' {
  interface PluginState {
    'model-review': { review: ReviewState }
  }
}
