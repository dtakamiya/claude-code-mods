// ループ（メイン / サブエージェント）別の集計。$ に触れない純粋関数。
// サブエージェントは親のキャッシュを読まず、TTL も 5 分が既定なので、メインと分けて見る。
import type { TokenCounts, TurnRecord } from '../types'
import { cacheHitRate } from './cache'
import { estimateTotal, type AgentTypeSummary } from './analyze'
import { formatInt, formatUsd } from './format'

export type LoopKind = 'main' | 'subagent'

export type LoopSummary = {
  readonly kind: LoopKind
  readonly turns: number
  /** サブエージェントの種類数（agentId の異なり数）。メインは 0。 */
  readonly agents: number
  readonly tokens: TokenCounts
  /** 読込 ÷（入力 + 読込 + 書込）。分母が 0 なら null。 */
  readonly hitRate: number | null
  /** 推定コスト。単価不明のターンは含めない。 */
  readonly costUsd: number
  readonly unpricedTurns: number
}

const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

function summarize(kind: LoopKind, records: readonly TurnRecord[]): LoopSummary | null {
  if (records.length === 0) return null
  const tokens = records.reduce((sum, record) => addTokens(sum, record.tokens), ZERO_TOKENS)
  const { costUsd, unpricedTurns } = estimateTotal(records)
  const agents = new Set(records.flatMap(record => record.agentId ?? [])).size
  return { kind, turns: records.length, agents, tokens, hitRate: cacheHitRate(tokens), costUsd, unpricedTurns }
}

/** メイン → サブエージェントの順。該当のターンがないループは含めない。 */
export function summarizeLoops(records: readonly TurnRecord[]): readonly LoopSummary[] {
  const main = summarize('main', records.filter(record => record.agentId === null))
  const sub = summarize('subagent', records.filter(record => record.agentId !== null))
  return [main, sub].flatMap(summary => summary ?? [])
}

const LOOP_LABEL: Readonly<Record<LoopKind, string>> = { main: 'メイン', subagent: 'サブエージェント' }

export const loopLabel = (kind: LoopKind): string => LOOP_LABEL[kind]

export function describeLoop(summary: LoopSummary): string {
  const hit = summary.hitRate === null ? 'ヒット -' : `ヒット ${Math.round(summary.hitRate * 100)}%`
  const agents = summary.kind === 'subagent' ? `（${summary.agents} 実行）` : ''
  const unpriced = summary.unpricedTurns > 0 ? `（単価不明 ${summary.unpricedTurns} ターンを除く）` : ''
  return [
    `ターン ${summary.turns}${agents}`,
    hit,
    `キャッシュ 読 ${formatInt(summary.tokens.cacheRead)} / 書 ${formatInt(summary.tokens.cacheWrite)}`,
    `推定 ${formatUsd(summary.costUsd)}${unpriced}`,
  ].join(' · ')
}

/** サブエージェントのヒット率がメインよりこの値（0〜1）以上低いとき、注記を出す（仮置き）。 */
export const SUBAGENT_HIT_GAP = 0.2

export const SUBAGENT_CACHE_NOTE =
  'サブエージェントは親のキャッシュを読まず、TTL は 5 分が既定です。ヒット率が低いのは、短く何度も呼ぶ使い方では起こりやすい動きです。'

/** サブエージェントのヒット率がメインより大きく低いか。どちらかのヒット率が分からなければ false。 */
export function subagentHitRateLow(summaries: readonly LoopSummary[]): boolean {
  const main = summaries.find(summary => summary.kind === 'main')?.hitRate ?? null
  const sub = summaries.find(summary => summary.kind === 'subagent')?.hitRate ?? null
  if (main === null || sub === null) return false
  return main - sub >= SUBAGENT_HIT_GAP
}

export function describeAgentType(summary: AgentTypeSummary): string {
  const hit = summary.hitRate === null ? 'ヒット -' : `ヒット ${Math.round(summary.hitRate * 100)}%`
  const unpriced = summary.unpricedTurns > 0 ? `（単価不明 ${summary.unpricedTurns} ターンを除く）` : ''
  return [`ターン ${summary.turns}`, summary.models.join(' / '), hit, `推定 ${formatUsd(summary.costUsd)}${unpriced}`].join(' · ')
}
