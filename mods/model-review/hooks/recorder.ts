// ターンの記録を組み立てる純粋な reducer。$ に触れず、入力を受けて新しいオブジェクトを返す。
// tool.call は turnId を持たないため、ループ（メイン or サブエージェント）ごとに下書きを持つ。
import type { CostParts, ModelShare, TurnRecord } from '../types'
import { ZERO_PARTS, addParts } from './breakdown'
import { sanitizeAgentType } from './agenttype'
import { effortToRecord } from './effort'
import { HAIKU_REFERENCE_MODEL, normalizeModelId, SONNET_REFERENCE_MODEL, priceUsage, priceUsageParts, type CacheWriteTtl, type TokenUsageLike } from './pricing'

export const MAIN_LOOP_KEY = 'main'
export const UNKNOWN_MODEL = 'unknown'
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** 応答・ツール呼び出しが止まってからこの時間を過ぎた未完了の下書きは、実行中の表示から外す（turn.complete が来ないまま中断されたターン用）。 */
export const LIVE_DRAFT_LIFETIME_MS = 10 * 60 * 1000

export type LoopDraft = {
  readonly turnId: string
  readonly agentId: string | null
  readonly model: string | null
  readonly effort: string | null
  readonly stepCount: number
  /** 記録できた応答の 4 種トークンの合計。終了時の usage と比べて、欠けた応答を見つけるために使う。 */
  readonly stepTokenTotal: number
  /** 単価が分かっている応答の推定コストの合計。 */
  readonly pricedCostUsd: number
  /** 単価が分かっている応答の推定コストの、種類別の合計（5 分単価）。 */
  readonly pricedParts: CostParts
  /** 書込を 1 時間単価で計算した推定コストの合計（上限側）。 */
  readonly pricedUpperCostUsd: number
  /** 単価不明のモデルで応答した step があるか。 */
  readonly hasUnpricedStep: boolean
  /** 同じ応答を Haiku 単価で計算した推定コストの合計（応答ごとに単価段を判定）。 */
  readonly haikuPricedCostUsd: number
  /** 同じ応答を Sonnet 単価で計算した推定コストの合計。 */
  readonly sonnetPricedCostUsd: number
  /** 最初の応答のキャッシュ書込トークン数。 */
  readonly firstStepCacheWrite: number
  /** 最初の応答のプロンプト長（入力 + 読込 + 書込）。 */
  readonly firstStepPromptTokens: number
  readonly advisorCalls: number
  readonly toolCount: number
  readonly editCount: number
  /** 最後に開始・応答・ツール呼び出しがあった時刻（ms）。取れなかったときは null。 */
  readonly lastActivityMs: number | null
  /** 応答したモデルごとの内訳（出現順）。終了時、2 モデル以上のときだけ記録に残す。 */
  readonly byModel: readonly ModelShare[]
  /** ターン開始時に読んだセッションのモデル。読めなければ null。 */
  readonly sessionModel: string | null
  /** 応答のモデルがセッションのモデルと食い違った応答の数。 */
  readonly divergedSteps: number
  /** turn.start を見て作った下書きか。false なら reload で下書きが消えた後に途中から拾った下書き。 */
  readonly started: boolean
}

export type Drafts = Readonly<Record<string, LoopDraft>>

export type StepInput = {
  readonly turnId: string
  readonly agentId?: string
  readonly model: string
  readonly effort?: string | number
  readonly usage?: TokenUsageLike | null
  /** この応答で API が実行した advisor の呼び出し回数。 */
  readonly advisorCalls?: number
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
  /** この終了が /compact の直後のターンか。 */
  readonly afterCompact?: boolean
  /** サブエージェントの種類（subagentType の名前だけ）。分からなければ無し。 */
  readonly agentType?: string | null
}

export type FinishedTurn = {
  readonly drafts: Drafts
  readonly record: TurnRecord
}

/**
 * 外部から届いた usage を検証した値。トークン数は有限な非負数、model は文字列。
 * model が文字列でなければ null にし、単価不明として扱う。
 */
export type SafeUsage = {
  readonly model: string | null
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
}

const loopKey = (agentId: string | undefined): string => agentId ?? MAIN_LOOP_KEY

const emptyDraft = (turnId: string, agentId: string | null): LoopDraft => ({
  turnId,
  agentId,
  model: null,
  effort: null,
  stepCount: 0,
  stepTokenTotal: 0,
  pricedCostUsd: 0,
  pricedParts: ZERO_PARTS,
  pricedUpperCostUsd: 0,
  hasUnpricedStep: false,
  haikuPricedCostUsd: 0,
  sonnetPricedCostUsd: 0,
  firstStepCacheWrite: 0,
  firstStepPromptTokens: 0,
  advisorCalls: 0,
  toolCount: 0,
  editCount: 0,
  lastActivityMs: null,
  byModel: [],
  sessionModel: null,
  divergedSteps: 0,
  started: false,
})

const draftOf = (drafts: Drafts, agentId: string | undefined, turnId: string): LoopDraft =>
  drafts[loopKey(agentId)] ?? emptyDraft(turnId, agentId ?? null)

const withDraft = (drafts: Drafts, agentId: string | undefined, draft: LoopDraft): Drafts => ({
  ...drafts,
  [loopKey(agentId)]: draft,
})

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** 同じループに残っていた未完了の下書きは置き換える（中断されたターンの残りを引きずらない）。 */
export function beginTurn(
  drafts: Drafts,
  turn: { readonly turnId: string; readonly agentId?: string },
  nowMs?: number,
  sessionModel?: string | null,
): Drafts {
  const started = {
    ...emptyDraft(turn.turnId, turn.agentId ?? null),
    lastActivityMs: nowMs ?? null,
    sessionModel: typeof sessionModel === 'string' ? sessionModel : null,
    started: true,
  }
  return withDraft(drafts, turn.agentId, started)
}

/** 数値として使えるのは有限な非負数だけ。それ以外（欠損・NaN・負数）は 0 とする。 */
const tokenCountOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)

/** 回数は 0 以上の整数だけを受け付ける。NaN・負数・小数・非数は 0 とする。 */
const countOf = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0)

/** 所要時間は有限な非負数だけを受け付ける。それ以外は不明（undefined）として記録しない。 */
const durationOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/** usage の値を検証する。オブジェクトでなければ usage なしとして null を返す。 */
export function sanitizeUsage(raw: unknown): SafeUsage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const fields = raw as Readonly<Record<keyof TokenUsageLike, unknown>>
  return {
    model: typeof fields.model === 'string' ? fields.model : null,
    input_tokens: tokenCountOf(fields.input_tokens),
    output_tokens: tokenCountOf(fields.output_tokens),
    cache_read_input_tokens: tokenCountOf(fields.cache_read_input_tokens),
    cache_creation_input_tokens: tokenCountOf(fields.cache_creation_input_tokens),
  }
}

/** model が不明（null）なら単価不明として null。それ以外は指定した単価（既定は 5 分単価）で計算する。 */
const priceAs = (usage: SafeUsage, model: string | null, writeTtl: CacheWriteTtl = '5m'): number | null =>
  model === null ? null : priceUsage({ ...usage, model }, writeTtl)

const promptTokensOf = (usage: SafeUsage | null): number =>
  usage === null ? 0 : usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

const totalTokensOf = (usage: SafeUsage): number =>
  usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

const addShare = (shares: readonly ModelShare[], model: string, usage: SafeUsage | null, priced: number | null): readonly ModelShare[] => {
  const tokens = tokenCountsOf(usage)
  const found = shares.find(share => share.model === model)
  const base: ModelShare = found ?? { model, tokens: ZERO_TOKENS, costUsd: 0, steps: 0 }
  const next: ModelShare = {
    model,
    tokens: {
      input: base.tokens.input + tokens.input,
      output: base.tokens.output + tokens.output,
      cacheRead: base.tokens.cacheRead + tokens.cacheRead,
      cacheWrite: base.tokens.cacheWrite + tokens.cacheWrite,
    },
    // usage がない応答は単価不明にしない（トークンも 0 のため）。
    costUsd: base.costUsd === null || (usage !== null && priced === null) ? null : base.costUsd + (priced ?? 0),
    steps: base.steps + 1,
  }
  return found === undefined ? [...shares, next] : shares.map(share => (share === found ? next : share))
}

/** メインのループだけで判定する（サブエージェントは定義のモデルで動くのが通常のため）。セッションのモデルが分かっていて、応答のモデルがそれと（日付違いなどを除いて）違うときだけ true。 */
const isDiverged = (sessionModel: string | null, stepModel: string): boolean =>
  sessionModel !== null && normalizeModelId(sessionModel) !== normalizeModelId(stepModel)

export function recordStep(drafts: Drafts, step: StepInput, nowMs?: number): Drafts {
  const prev = draftOf(drafts, step.agentId, step.turnId)
  const usage = sanitizeUsage(step.usage)
  const priced = usage ? priceAs(usage, usage.model) : null
  const parts = usage && usage.model !== null ? priceUsageParts({ ...usage, model: usage.model }) : null
  const pricedUpper = usage ? priceAs(usage, usage.model, '1h') : null
  const pricedAsHaiku = usage ? priceAs(usage, HAIKU_REFERENCE_MODEL) : null
  const pricedAsSonnet = usage ? priceAs(usage, SONNET_REFERENCE_MODEL) : null
  const next: LoopDraft = {
    ...prev,
    turnId: step.turnId,
    model: usage?.model ?? prev.model ?? step.model,
    effort: effortToRecord(step.effort),
    stepCount: prev.stepCount + 1,
    stepTokenTotal: prev.stepTokenTotal + (usage ? totalTokensOf(usage) : 0),
    pricedCostUsd: prev.pricedCostUsd + (priced ?? 0),
    pricedParts: parts === null ? prev.pricedParts : addParts(prev.pricedParts, parts),
    pricedUpperCostUsd: prev.pricedUpperCostUsd + (pricedUpper ?? 0),
    hasUnpricedStep: prev.hasUnpricedStep || (usage !== null && priced === null),
    haikuPricedCostUsd: prev.haikuPricedCostUsd + (pricedAsHaiku ?? 0),
    sonnetPricedCostUsd: prev.sonnetPricedCostUsd + (pricedAsSonnet ?? 0),
    firstStepCacheWrite: prev.stepCount === 0 ? (usage?.cache_creation_input_tokens ?? 0) : prev.firstStepCacheWrite,
    firstStepPromptTokens: prev.stepCount === 0 ? promptTokensOf(usage) : prev.firstStepPromptTokens,
    advisorCalls: prev.advisorCalls + countOf(step.advisorCalls),
    lastActivityMs: nowMs ?? prev.lastActivityMs,
    byModel: addShare(prev.byModel, usage?.model ?? step.model, usage, priced),
    divergedSteps: prev.divergedSteps + (step.agentId === undefined && isDiverged(prev.sessionModel, step.model) ? 1 : 0),
  }
  return withDraft(drafts, step.agentId, next)
}

export function recordTool(drafts: Drafts, call: ToolInput, nowMs?: number): Drafts {
  const prev = draftOf(drafts, call.agentId, '')
  const next: LoopDraft = {
    ...prev,
    toolCount: prev.toolCount + 1,
    editCount: prev.editCount + (EDIT_TOOLS.has(call.tool) ? 1 : 0),
    lastActivityMs: nowMs ?? prev.lastActivityMs,
  }
  return withDraft(drafts, call.agentId, next)
}

/**
 * 表示用に、寿命を過ぎた未完了の下書きを外したコピーを返す。元の下書きは変えないので、動きが再開すれば戻る。
 * 最後の動きの時刻が不明な下書きは外さない。
 */
export function liveDrafts(drafts: Drafts, nowMs: number): Drafts {
  const isLive = (draft: LoopDraft): boolean =>
    draft.lastActivityMs === null || nowMs - draft.lastActivityMs <= LIVE_DRAFT_LIFETIME_MS
  return Object.fromEntries(Object.entries(drafts).filter(([, draft]) => isLive(draft)))
}

function tokenCountsOf(usage: SafeUsage | null): TurnRecord['tokens'] {
  if (!usage) return ZERO_TOKENS
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }
}

/** step の合計が終了時の usage より少なければ、step の記録が欠けている（イベントの取りこぼし）とみなす。 */
const isStepRecordIncomplete = (draft: LoopDraft, usage: SafeUsage | null): boolean =>
  usage !== null && totalTokensOf(usage) > draft.stepTokenTotal

/**
 * 推定コストの共通規則。応答ごとに計算した合計を優先し、step が欠けていればターン全体の usage で計算する。
 * どちらも取れなければ null（単価不明と同じ扱い）。0 と書くと 0 円に読めてしまう。
 */
function resolveCost(
  draft: LoopDraft,
  usage: SafeUsage | null,
  perStepUsd: number,
  priceTurn: (turnUsage: SafeUsage) => number | null,
): number | null {
  if (draft.hasUnpricedStep) return null
  if (draft.stepCount > 0 && !isStepRecordIncomplete(draft, usage)) return perStepUsd
  return usage === null ? null : priceTurn(usage)
}

function costOf(draft: LoopDraft, usage: SafeUsage | null): number | null {
  return resolveCost(draft, usage, draft.pricedCostUsd, turnUsage => priceAs(turnUsage, turnUsage.model))
}

/** costOf と同じ規則の、種類別の内訳。costUsd が null のターンは null。 */
function partsOf(draft: LoopDraft, usage: SafeUsage | null): CostParts | null {
  if (draft.hasUnpricedStep) return null
  if (draft.stepCount > 0 && !isStepRecordIncomplete(draft, usage)) return draft.pricedParts
  if (usage === null || usage.model === null) return null
  return priceUsageParts({ ...usage, model: usage.model })
}

/** costOf と同じ規則で、キャッシュ書込を 1 時間単価にした推定コスト（上限側）。 */
function upperCostOf(draft: LoopDraft, usage: SafeUsage | null): number | null {
  return resolveCost(draft, usage, draft.pricedUpperCostUsd, turnUsage => priceAs(turnUsage, turnUsage.model, '1h'))
}

/** costOf と同じ規則で、Haiku 単価に置き換えた推定コスト。 */
function haikuCostOf(draft: LoopDraft, usage: SafeUsage | null): number | null {
  return resolveCost(draft, usage, draft.haikuPricedCostUsd, turnUsage => priceAs(turnUsage, HAIKU_REFERENCE_MODEL))
}

/** costOf と同じ規則で、Sonnet 単価に置き換えた推定コスト。 */
function sonnetCostOf(draft: LoopDraft, usage: SafeUsage | null): number | null {
  return resolveCost(draft, usage, draft.sonnetPricedCostUsd, turnUsage => priceAs(turnUsage, SONNET_REFERENCE_MODEL))
}

/**
 * 最初の応答のキャッシュ書込とプロンプト長。応答（step）がないターンは終了時の usage で補い、
 * どちらもなければ未取得（undefined）にする。0 と書くと切替の再構築が 0 円に読めてしまう。
 */
function firstStepOf(
  draft: LoopDraft,
  usage: SafeUsage | null,
): { readonly cacheWrite: number | undefined; readonly promptTokens: number | undefined } {
  if (draft.stepCount > 0) return { cacheWrite: draft.firstStepCacheWrite, promptTokens: draft.firstStepPromptTokens }
  if (!usage) return { cacheWrite: undefined, promptTokens: undefined }
  return { cacheWrite: usage.cache_creation_input_tokens, promptTokens: promptTokensOf(usage) }
}

/** サブエージェントのターンで、使える種類の名前があるときだけ載せる。 */
const agentTypeField = (end: TurnEndInput): { readonly agentType?: string } => {
  const type = end.agentId === undefined ? null : sanitizeAgentType(end.agentType)
  return type === null ? {} : { agentType: type }
}

/** 2 モデル以上が応答したときだけ内訳を残す。step の記録が欠けているときは合計と合わないので残さない。 */
const byModelField = (draft: LoopDraft, usage: SafeUsage | null): { readonly byModel?: readonly ModelShare[] } =>
  draft.byModel.length > 1 && !isStepRecordIncomplete(draft, usage) ? { byModel: draft.byModel } : {}

export function finishTurn(drafts: Drafts, end: TurnEndInput): FinishedTurn {
  const key = loopKey(end.agentId)
  const draft = draftOf(drafts, end.agentId, end.turnId)
  const usage = sanitizeUsage(end.usage)
  const first = firstStepOf(draft, usage)
  const record: TurnRecord = {
    turnId: end.turnId,
    agentId: end.agentId ?? null,
    model: usage?.model ?? draft.model ?? UNKNOWN_MODEL,
    effort: draft.effort,
    tokens: tokenCountsOf(usage),
    costUsd: costOf(draft, usage),
    costUpperUsd: upperCostOf(draft, usage),
    costParts: partsOf(draft, usage),
    toolCount: draft.toolCount,
    editCount: draft.editCount,
    durationMs: durationOf(end.durationMs),
    reason: end.reason,
    haikuCostUsd: haikuCostOf(draft, usage),
    sonnetCostUsd: sonnetCostOf(draft, usage),
    firstStepCacheWrite: first.cacheWrite,
    firstStepPromptTokens: first.promptTokens,
    advisorCalls: draft.advisorCalls,
    ...byModelField(draft, usage),
    ...(draft.divergedSteps > 0 ? { divergedSteps: draft.divergedSteps } : {}),
    ...(end.afterCompact === true ? { afterCompact: true } : {}),
    ...agentTypeField(end),
    ...(draft.started ? {} : { partial: true }),
  }
  const remaining = Object.fromEntries(Object.entries(drafts).filter(([candidate]) => candidate !== key))
  return { drafts: remaining, record }
}
