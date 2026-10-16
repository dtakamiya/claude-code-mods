// $.state に置く値（atom の初期値と、その書き換え）。すべて新しいオブジェクトを返す。
import type { ReviewState, TurnRecord } from '../types'

export const EMPTY_REVIEW: ReviewState = {
  turns: [],
  sessionCostUsd: { baseline: null, current: null },
}

export function appendTurn(state: ReviewState, record: TurnRecord): ReviewState {
  return { ...state, turns: [...state.turns, record] }
}

/** 基準点は最初に取れた値だけを使う。Mod 読み込み時の総額がここに入る。 */
export function withBaseline(state: ReviewState, costUsd: number | null): ReviewState {
  if (state.sessionCostUsd.baseline !== null || costUsd === null) return state
  return { ...state, sessionCostUsd: { ...state.sessionCostUsd, baseline: costUsd } }
}

export function withCurrent(state: ReviewState, costUsd: number): ReviewState {
  return { ...state, sessionCostUsd: { ...state.sessionCostUsd, current: costUsd } }
}

/** 累計コストを取れた時点で書く。起動時に取れなかった基準点は、ここで初めて設定される。 */
export function withCostSample(state: ReviewState, costUsd: number): ReviewState {
  return withCurrent(withBaseline(state, costUsd), costUsd)
}
