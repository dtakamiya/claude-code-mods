// $.state に置く値（atom の初期値と、その書き換え）。すべて新しいオブジェクトを返す。
import type { ReviewState, TurnRecord } from '../types'

export const EMPTY_REVIEW: ReviewState = {
  turns: [],
  sessionCostUsd: { baseline: null, current: null },
}

export function appendTurn(state: ReviewState, record: TurnRecord): ReviewState {
  return { ...state, turns: [...state.turns, record] }
}

/** 有限な金額だけを受け付ける。NaN・Infinity は null と同じく無視する（状態を壊さない）。 */
const isUsableCost = (costUsd: number | null): costUsd is number => costUsd !== null && Number.isFinite(costUsd)

/**
 * 基準点は最初に取れた有限の値だけを使う。Mod 読み込み時の総額がここに入る。
 * 基準点を取った時点のターン数（turns の長さ）も残す。これより後のターンだけが基準点からの実コストに入る。
 */
export function withBaseline(state: ReviewState, costUsd: number | null): ReviewState {
  if (state.sessionCostUsd.baseline !== null || !isUsableCost(costUsd)) return state
  return {
    ...state,
    sessionCostUsd: { ...state.sessionCostUsd, baseline: costUsd, baselineTurns: state.turns.length },
  }
}

export function withCurrent(state: ReviewState, costUsd: number): ReviewState {
  if (!isUsableCost(costUsd)) return state
  return { ...state, sessionCostUsd: { ...state.sessionCostUsd, current: costUsd } }
}

/** 基準点からの実コストに入るターン（基準点より後に完了したもの）。基準点ターン数がなければ最初から数える。 */
export function turnsSinceBaseline(review: ReviewState): readonly TurnRecord[] {
  return review.turns.slice(review.sessionCostUsd.baselineTurns ?? 0)
}

/** 累計コストを取れた時点で書く。起動時に取れなかった基準点は、ここで初めて設定される。 */
export function withCostSample(state: ReviewState, costUsd: number): ReviewState {
  return withCurrent(withBaseline(state, costUsd), costUsd)
}
