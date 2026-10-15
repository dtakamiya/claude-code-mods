// ターンの記録を組み立てる純粋な reducer。$ に触れず、入力を受けて新しいオブジェクトを返す。
// tool.call は turnId を持たないため、ループ（メイン or サブエージェント）ごとに下書きを持つ。
import type { TurnRecord } from '../types'
import { priceUsage, type TokenUsageLike } from './pricing'

export const MAIN_LOOP_KEY = 'main'
export const UNKNOWN_MODEL = 'unknown'
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export type LoopDraft = {
  readonly turnId: string
  readonly agentId: string | null
  readonly model: string | null
  readonly effort: string | null
  readonly stepCount: number
  /** 単価が分かっている応答の推定コストの合計。 */
  readonly pricedCostUsd: number
  /** 単価不明のモデルで応答した step があるか。 */
  readonly hasUnpricedStep: boolean
  readonly toolCount: number
  readonly editCount: number
}

export type Drafts = Readonly<Record<string, LoopDraft>>

export type StepInput = {
  readonly turnId: string
  readonly agentId?: string
  readonly model: string
  readonly effort?: string | number
  readonly usage?: TokenUsageLike | null
}

export type ToolInput = {
  readonly agentId?: string
  readonly tool: string
}

export type TurnEndInput = {
  readonly turnId: string
  readonly agentId?: string
  readonly usage?: TokenUsageLike
  readonly durationMs: number
  readonly reason: TurnRecord['reason']
}

export type FinishedTurn = {
  readonly drafts: Drafts
  readonly record: TurnRecord
}

const loopKey = (agentId: string | undefined): string => agentId ?? MAIN_LOOP_KEY

const emptyDraft = (turnId: string, agentId: string | null): LoopDraft => ({
  turnId,
  agentId,
  model: null,
  effort: null,
  stepCount: 0,
  pricedCostUsd: 0,
  hasUnpricedStep: false,
  toolCount: 0,
  editCount: 0,
})

const draftOf = (drafts: Drafts, agentId: string | undefined, turnId: string): LoopDraft =>
  drafts[loopKey(agentId)] ?? emptyDraft(turnId, agentId ?? null)

const withDraft = (drafts: Drafts, agentId: string | undefined, draft: LoopDraft): Drafts => ({
  ...drafts,
  [loopKey(agentId)]: draft,
})

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

export function beginTurn(drafts: Drafts, turn: { readonly turnId: string; readonly agentId?: string }): Drafts {
  return withDraft(drafts, turn.agentId, emptyDraft(turn.turnId, turn.agentId ?? null))
}

export function recordStep(drafts: Drafts, step: StepInput): Drafts {
  const prev = draftOf(drafts, step.agentId, step.turnId)
  const usage = step.usage ?? null
  const priced = usage ? priceUsage(usage) : null
  const next: LoopDraft = {
    ...prev,
    turnId: step.turnId,
    model: usage?.model ?? prev.model ?? step.model,
    effort: step.effort === undefined ? null : String(step.effort),
    stepCount: prev.stepCount + 1,
    pricedCostUsd: prev.pricedCostUsd + (priced ?? 0),
    hasUnpricedStep: prev.hasUnpricedStep || (usage !== null && priced === null),
  }
  return withDraft(drafts, step.agentId, next)
}

export function recordTool(drafts: Drafts, call: ToolInput): Drafts {
  const prev = draftOf(drafts, call.agentId, '')
  const next: LoopDraft = {
    ...prev,
    toolCount: prev.toolCount + 1,
    editCount: prev.editCount + (EDIT_TOOLS.has(call.tool) ? 1 : 0),
  }
  return withDraft(drafts, call.agentId, next)
}

function tokenCountsOf(usage: TokenUsageLike | undefined): TurnRecord['tokens'] {
  if (!usage) return ZERO_TOKENS
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }
}

/** 応答ごとに計算した合計を優先する。step が一つもないターンだけ、ターン全体の usage で計算する。 */
function costOf(draft: LoopDraft, usage: TokenUsageLike | undefined): number | null {
  if (draft.hasUnpricedStep) return null
  if (draft.stepCount > 0) return draft.pricedCostUsd
  if (!usage) return 0
  return priceUsage(usage)
}

export function finishTurn(drafts: Drafts, end: TurnEndInput): FinishedTurn {
  const key = loopKey(end.agentId)
  const draft = draftOf(drafts, end.agentId, end.turnId)
  const record: TurnRecord = {
    turnId: end.turnId,
    agentId: end.agentId ?? null,
    model: end.usage?.model ?? draft.model ?? UNKNOWN_MODEL,
    effort: draft.effort,
    tokens: tokenCountsOf(end.usage),
    costUsd: costOf(draft, end.usage),
    toolCount: draft.toolCount,
    editCount: draft.editCount,
    durationMs: end.durationMs,
    reason: end.reason,
  }
  const remaining = Object.fromEntries(Object.entries(drafts).filter(([candidate]) => candidate !== key))
  return { drafts: remaining, record }
}
