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
  /** 所要時間（ms）。有限な非負数で取れなかったときは無し（undefined）。 */
  readonly durationMs?: number
  readonly reason: 'answer' | 'aborted' | 'refusal' | 'error'
  // 以下は 0.4.0 で足した項目。0.3.0 で $.state に残った記録には無いので、読むときは `?? 0` などで補う。
  /** 同じ応答を Haiku 5.5 の単価で計算した推定コスト（USD）。応答ごとに単価段を判定して足す。単価不明の応答を含むとき null。 */
  readonly haikuCostUsd?: number | null
  /** キャッシュ書込を 1 時間単価で計算した推定コスト（USD、上限側）。0.6.0 で追加。単価不明の応答を含むとき null。 */
  readonly costUpperUsd?: number | null
  /** 同じ応答を Sonnet 5.5 の単価で計算した推定コスト（USD）。0.5.0 で追加。単価不明の応答を含むとき null。 */
  readonly sonnetCostUsd?: number | null
  /** ターン最初の応答のキャッシュ書込トークン数。モデル切替の再構築コストの目安に使う（後続の追記分を含めない）。 */
  readonly firstStepCacheWrite?: number
  /** ターン最初の応答のプロンプト長（入力 + キャッシュ読込 + 書込）。単価段の判定に使う。 */
  readonly firstStepPromptTokens?: number
  /** API が実行した advisor サーバーツールの呼び出し回数。 */
  readonly advisorCalls?: number
  /** /compact（自動を含む）の直後のターン。必然的なキャッシュ再構築を含むので、書込多め・切替コストの判定から外す。0.14.2 で追加。 */
  readonly afterCompact?: boolean
  /** ターンの開始を見ていない（reload を跨いだ）記録。最初の応答の書込が実際と違うので、切替コストの基準から外す。0.14.2 で追加。 */
  readonly partial?: boolean
}

/** 畳み込んだ古いターンの、モデル × effort 別の集計。ModelGroup（hooks/analyze.ts）と同じ形。 */
export type ArchivedGroup = {
  readonly model: string
  readonly effort: string | null
  readonly turns: number
  readonly unpricedTurns: number
  readonly tokens: TokenCounts
  /** 単価不明のターンを含むとき null。 */
  readonly costUsd: number | null
}

/** 上限を超えて turns から外した古いターンの集計。0.14.4 で追加。指摘・切替・ループ別などは直近の turns だけで判定する。 */
export type ArchivedTurns = {
  readonly turns: number
  readonly subagents: number
  readonly advisorCalls: number
  readonly groups: readonly ArchivedGroup[]
  /** 単価のあるターンの推定コストの合計（下限。単価不明は含まない）。 */
  readonly pricedUsd: number
  readonly unpricedTurns: number
  /** 推定の幅（5 分単価 〜 1 時間単価）。 */
  readonly highUsd: number
  /** 畳んだターンのうち、基準点より後に完了したぶん。実コストとの比較（TTL の注記）で使う。 */
  readonly sinceBaseline: { readonly lowUsd: number; readonly highUsd: number; readonly cacheWrite: number }
}

export type ReviewState = {
  readonly turns: readonly TurnRecord[]
  /** 上限を超えて畳んだ古いターンの集計。畳んでいなければ無い。 */
  readonly archived?: ArchivedTurns
  /** `$.session.usage().cost.usd` の基準点（Mod 読み込み時）と直近値。取れない環境では null。 */
  readonly sessionCostUsd: {
    readonly baseline: number | null
    readonly current: number | null
    /** 基準点を取った時点の turns の長さ。これより前のターンは実コストに入らない。古い状態では無いので 0 とみなす。 */
    readonly baselineTurns?: number
  }
}

declare module 'claude-code' {
  interface PluginState {
    'model-review': { review: ReviewState }
  }
}
