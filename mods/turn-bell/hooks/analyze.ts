// 仮置き。実運用で調整（30 秒）。
export const THRESHOLD_MS = 30_000

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60

export type TurnInfo = { durationMs: number; isAborted: boolean; agentId?: string }

/** 通知すべきターンか。中断・サブエージェント・不正な所要時間は通知しない。 */
export function shouldNotify(turn: TurnInfo, thresholdMs: number = THRESHOLD_MS): boolean {
  if (turn.isAborted) return false
  if (turn.agentId !== undefined) return false
  if (!Number.isFinite(turn.durationMs) || turn.durationMs < 0) return false
  return turn.durationMs >= thresholdMs
}

/** 通知文。判定は生 ms で済んでいる前提で、ここでは表示のみ四捨五入する。入力・応答・ツール名は含めない。 */
export function formatBell(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / MS_PER_SECOND)
  if (totalSeconds < SECONDS_PER_MINUTE) return `ターン完了（${totalSeconds}秒）`
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  return `ターン完了（${minutes}分${seconds}秒）`
}
