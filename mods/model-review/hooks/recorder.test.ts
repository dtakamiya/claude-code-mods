import { test, expect } from 'claude-code/testing'

import { EMPTY_REVIEW } from './state'
import { buildPaneRows } from './pane-model'
import {
  LIVE_DRAFT_LIFETIME_MS,
  MAIN_LOOP_KEY,
  UNKNOWN_MODEL,
  beginTurn,
  finishTurn,
  liveDrafts,
  markPlanMode,
  recordStep,
  recordTool,
  type Drafts,
} from './recorder'

/** 浮動小数の合計の誤差を許す比較。 */
const expectNear = (actual: number | null | undefined, expected: number): void => {
  expect(Math.abs((actual ?? Number.NaN) - expected) < 1e-9).toBe(true)
}

// 架空データのみ。
const sonnetUsage = {
  model: 'claude-sonnet-5-5',
  input_tokens: 1_000_000,
  output_tokens: 100_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}
// Sonnet 5.5: 入力 $2 / 出力 $10（MTok）。上の usage は 2 + 1 = $3。
// 同じ usage を Haiku 5.5 で計算すると、プロンプトが 10 万 tokens 超の高い単価表（入力 $0.5 / 出力 $2.5）で 0.5 + 0.25 = $0.75。

test('メインループのターンは開始・step・ツール・終了の順に 1 件の記録になる', () => {
  // Arrange
  let drafts: Drafts = {}

  // Act
  drafts = beginTurn(drafts, { turnId: 't1' })
  drafts = recordStep(drafts, { turnId: 't1', model: 'claude-sonnet-5-5', effort: 'high', usage: sonnetUsage })
  drafts = recordTool(drafts, { tool: 'Edit' })
  drafts = recordTool(drafts, { tool: 'Read' })
  const finished = finishTurn(drafts, {
    turnId: 't1',
    usage: sonnetUsage,
    durationMs: 4_200,
    reason: 'answer',
  })

  // Assert
  expect(finished.record).toEqual({
    turnId: 't1',
    agentId: null,
    model: 'claude-sonnet-5-5',
    effort: 'high',
    tokens: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 },
    costUsd: 3,
    toolCount: 2,
    editCount: 1,
    durationMs: 4_200,
    reason: 'answer',
    costUpperUsd: 3,
    costParts: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
    haikuCostUsd: 0.75,
    sonnetCostUsd: 3,
    firstStepCacheWrite: 0,
    firstStepPromptTokens: 1_000_000,
    advisorCalls: 0,
  })
  expect(finished.drafts).toEqual({})
})

test('サブエージェントのツール呼び出しはメインループの数に混ざらない', () => {
  // Arrange
  let drafts: Drafts = {}
  drafts = beginTurn(drafts, { turnId: 'main-1' })
  drafts = beginTurn(drafts, { turnId: 'sub-1', agentId: 'agent-7' })

  // Act
  drafts = recordTool(drafts, { agentId: 'agent-7', tool: 'Bash' })
  drafts = recordTool(drafts, { agentId: 'agent-7', tool: 'Write' })
  drafts = recordTool(drafts, { tool: 'Grep' })
  const sub = finishTurn(drafts, { turnId: 'sub-1', agentId: 'agent-7', durationMs: 1, reason: 'answer' })
  const main = finishTurn(sub.drafts, { turnId: 'main-1', durationMs: 1, reason: 'answer' })

  // Assert
  expect(sub.record).toMatchObject({ agentId: 'agent-7', toolCount: 2, editCount: 1 })
  expect(main.record).toMatchObject({ agentId: null, toolCount: 1, editCount: 0 })
})

test('単価不明のモデルを含むターンはコストを null にする', () => {
  // Arrange
  const unknownUsage = { ...sonnetUsage, model: 'claude-unlisted-9' }
  let drafts = beginTurn({}, { turnId: 't2' })
  drafts = recordStep(drafts, { turnId: 't2', model: 'claude-unlisted-9', usage: unknownUsage })

  // Act
  const finished = finishTurn(drafts, { turnId: 't2', usage: unknownUsage, durationMs: 1, reason: 'answer' })

  // Assert
  expect(finished.record.costUsd).toBeNull()
  expect(finished.record.model).toBe('claude-unlisted-9')
})

test('effort を持たないモデルの step は effort を null のままにする', () => {
  // Arrange
  let drafts = beginTurn({}, { turnId: 't3' })

  // Act
  drafts = recordStep(drafts, { turnId: 't3', model: 'claude-haiku-4-5', usage: null })
  const finished = finishTurn(drafts, { turnId: 't3', durationMs: 1, reason: 'answer' })

  // Assert
  expect(finished.record.effort).toBeNull()
})

test('開始を聞いていないターンは、終了の情報だけで記録しツール数は 0 になる', () => {
  // Arrange: Mod 読み込み後にだけ終了が届いた場合。
  const drafts: Drafts = {}

  // Act
  const finished = finishTurn(drafts, { turnId: 'late', usage: sonnetUsage, durationMs: 9, reason: 'answer' })

  // Assert
  expect(finished.record).toMatchObject({ turnId: 'late', model: 'claude-sonnet-5-5', toolCount: 0, costUsd: 3, effort: null })
})

test('usage も step もないターンは、モデル不明・トークン 0 で、コストは 0 円ではなく不明（null）にする', () => {
  // Arrange
  const drafts: Drafts = {}

  // Act
  const finished = finishTurn(drafts, { turnId: 'aborted', durationMs: 5, reason: 'aborted' })

  // Assert
  expect(finished.record).toMatchObject({
    model: UNKNOWN_MODEL,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
    costUpperUsd: null,
    haikuCostUsd: null,
    sonnetCostUsd: null,
    reason: 'aborted',
  })
})

test('step が複数あるターンは応答ごとの単価を合計し、モデルは最後の応答のものを使う', () => {
  // Arrange: 1 回目は Sonnet、2 回目は Haiku（フォールバック想定）。Haiku の 50,000 tokens は 10 万以下の低い単価。
  const haikuUsage = {
    model: 'claude-haiku-5-5',
    input_tokens: 50_000,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
  let drafts = beginTurn({}, { turnId: 't4' })

  // Act
  drafts = recordStep(drafts, { turnId: 't4', model: 'claude-sonnet-5-5', usage: sonnetUsage })
  drafts = recordStep(drafts, { turnId: 't4', model: 'claude-haiku-5-5', usage: haikuUsage })
  const finished = finishTurn(drafts, { turnId: 't4', usage: haikuUsage, durationMs: 1, reason: 'answer' })

  // Assert: Sonnet 3 + Haiku 50,000 × $0.10/MTok = 0.005
  expect(finished.record.model).toBe('claude-haiku-5-5')
  expect(finished.record.costUsd?.toFixed(6)).toBe('3.005000')
})

test('Haiku 換算は応答ごとに単価段を判定して足す（ターン合計では判定しない）', () => {
  // Arrange: 6 万 tokens の応答を 2 回。合計 12 万は高い単価段だが、応答ごとなら低い単価段（入力 $0.1 / MTok）。
  const stepUsage = { ...sonnetUsage, input_tokens: 60_000, output_tokens: 0 }
  let drafts = beginTurn({}, { turnId: 't5' })

  // Act
  drafts = recordStep(drafts, { turnId: 't5', model: 'claude-sonnet-5-5', usage: stepUsage })
  drafts = recordStep(drafts, { turnId: 't5', model: 'claude-sonnet-5-5', usage: stepUsage })
  const finished = finishTurn(drafts, { turnId: 't5', durationMs: 1, reason: 'answer' })

  // Assert: 60,000 × $0.1/MTok × 2 = 0.012
  expect(finished.record.haikuCostUsd?.toFixed(6)).toBe('0.012000')
})

test('単価不明の応答を含むターンは Haiku 換算も null にする', () => {
  // Arrange
  const unknownUsage = { ...sonnetUsage, model: 'claude-unlisted-9' }
  let drafts = beginTurn({}, { turnId: 't6' })
  drafts = recordStep(drafts, { turnId: 't6', model: 'claude-unlisted-9', usage: unknownUsage })

  // Act
  const finished = finishTurn(drafts, { turnId: 't6', usage: unknownUsage, durationMs: 1, reason: 'answer' })

  // Assert
  expect(finished.record.haikuCostUsd).toBeNull()
})

test('最初の応答のキャッシュ書込だけを firstStepCacheWrite に残し、advisor の回数は足し合わせる', () => {
  // Arrange
  const first = { ...sonnetUsage, cache_creation_input_tokens: 40_000 }
  const later = { ...sonnetUsage, cache_creation_input_tokens: 5_000 }
  let drafts = beginTurn({}, { turnId: 't7' })

  // Act
  drafts = recordStep(drafts, { turnId: 't7', model: 'claude-sonnet-5-5', usage: first, advisorCalls: 1 })
  drafts = recordStep(drafts, { turnId: 't7', model: 'claude-sonnet-5-5', usage: later, advisorCalls: 2 })
  const finished = finishTurn(drafts, { turnId: 't7', durationMs: 1, reason: 'answer' })

  // Assert
  expect(finished.record.firstStepCacheWrite).toBe(40_000)
  expect(finished.record.firstStepPromptTokens).toBe(1_040_000)
  expect(finished.record.advisorCalls).toBe(3)
})

test('応答がなく終了時の usage だけあるターンも Haiku 換算を計算する', () => {
  // Act
  const finished = finishTurn({}, { turnId: 'late', usage: sonnetUsage, durationMs: 9, reason: 'answer' })

  // Assert
  expect(finished.record.haikuCostUsd?.toFixed(6)).toBe('0.750000')
})

test('応答がなく終了時の usage だけあるターンは、終了時の usage から最初の書込とプロンプト長を取る', () => {
  // Arrange
  const written = { ...sonnetUsage, input_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 40_000 }

  // Act
  const withUsage = finishTurn({}, { turnId: 'late', usage: written, durationMs: 9, reason: 'answer' })
  const withoutUsage = finishTurn({}, { turnId: 'none', durationMs: 9, reason: 'aborted' })

  // Assert
  expect(withUsage.record.firstStepCacheWrite).toBe(40_000)
  expect(withUsage.record.firstStepPromptTokens).toBe(40_600)
  expect(withoutUsage.record.firstStepCacheWrite).toBeUndefined()
  expect(withoutUsage.record.firstStepPromptTokens).toBeUndefined()
})

test('Sonnet 換算は同じ usage を Sonnet 単価で計算し、単価不明の応答を含むと null にする', () => {
  // Arrange: Opus 5.5 は入力 $4 / 出力 $20。同じ usage を Sonnet 5.5（$2 / $10）にすると半額。
  const opusUsage = { ...sonnetUsage, model: 'claude-opus-5-5' }
  const unknownUsage = { ...sonnetUsage, model: 'claude-unknown-9' }

  // Act
  const known = finishTurn(
    recordStep(beginTurn({}, { turnId: 't5' }), { turnId: 't5', model: opusUsage.model, usage: opusUsage }),
    { turnId: 't5', usage: opusUsage, durationMs: 1, reason: 'answer' },
  )
  const unknown = finishTurn(
    recordStep(beginTurn({}, { turnId: 't6' }), { turnId: 't6', model: unknownUsage.model, usage: unknownUsage }),
    { turnId: 't6', usage: unknownUsage, durationMs: 1, reason: 'answer' },
  )

  // Assert
  expect(known.record.costUsd).toBe(6)
  expect(known.record.sonnetCostUsd).toBe(3)
  expect(unknown.record.sonnetCostUsd).toBeNull()
})

test('上限側の推定は書込を 1 時間単価にして足し、単価不明の応答を含むと null にする', () => {
  // Arrange: Sonnet 5.5 の書込 1,000,000 tokens。5 分 $2.5、1 時間 $4。
  const written = { ...sonnetUsage, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }
  const unknown = { ...written, model: 'claude-unknown-9' }

  // Act
  const known = finishTurn(
    recordStep(beginTurn({}, { turnId: 't7' }), { turnId: 't7', model: written.model, usage: written }),
    { turnId: 't7', usage: written, durationMs: 1, reason: 'answer' },
  )
  const unpriced = finishTurn(
    recordStep(beginTurn({}, { turnId: 't8' }), { turnId: 't8', model: unknown.model, usage: unknown }),
    { turnId: 't8', usage: unknown, durationMs: 1, reason: 'answer' },
  )

  // Assert
  expect(known.record.costUsd).toBe(2.5)
  expect(known.record.costUpperUsd).toBe(4)
  expect(unpriced.record.costUpperUsd).toBeNull()
})

test('欠損・非有限・負のトークン数は 0 として扱い、コストを NaN にしない', () => {
  // Arrange: 出力 100,000 tokens（Sonnet 5.5 で $1）だけが有効な応答。
  const malformed = {
    model: 'claude-sonnet-5-5',
    input_tokens: Number.NaN,
    output_tokens: 100_000,
    cache_read_input_tokens: -5,
    cache_creation_input_tokens: undefined,
  } as never
  let drafts = beginTurn({}, { turnId: 't9' })

  // Act
  drafts = recordStep(drafts, { turnId: 't9', model: 'claude-sonnet-5-5', usage: malformed })
  const finished = finishTurn(drafts, { turnId: 't9', usage: malformed, durationMs: 1, reason: 'answer' })

  // Assert
  expect(finished.record.tokens).toEqual({ input: 0, output: 100_000, cacheRead: 0, cacheWrite: 0 })
  expect(finished.record.costUsd).toBe(1)
  expect(finished.record.firstStepPromptTokens).toBe(0)
})

test('model が文字列でない usage は単価不明として扱い、例外にしない', () => {
  // Arrange
  const numericModel = { ...sonnetUsage, model: 42 } as never
  let drafts = beginTurn({}, { turnId: 't10' })

  // Act
  drafts = recordStep(drafts, { turnId: 't10', model: 'claude-sonnet-5-5', usage: numericModel })
  const finished = finishTurn(drafts, { turnId: 't10', usage: numericModel, durationMs: 1, reason: 'answer' })
  const endOnly = finishTurn({}, { turnId: 't11', usage: numericModel, durationMs: 1, reason: 'answer' })

  // Assert
  expect(finished.record.costUsd).toBeNull()
  expect(finished.record.haikuCostUsd).toBeNull()
  expect(finished.record.model).toBe('claude-sonnet-5-5')
  expect(endOnly.record.costUsd).toBeNull()
  expect(endOnly.record.model).toBe(UNKNOWN_MODEL)
})

test('usage がオブジェクトでなければ、usage のないターンとして記録し、コストは不明（null）にする', () => {
  // Act
  const finished = finishTurn({}, { turnId: 't12', usage: 'broken' as never, durationMs: 1, reason: 'answer' })

  // Assert
  expect(finished.record).toMatchObject({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
    firstStepPromptTokens: undefined,
  })
})

test('step の記録が欠けていれば（終了時の usage の方が多ければ）、ターン全体の usage で単価を再計算する', () => {
  // Arrange: 応答は 1 回分（入力 50 万 tokens = Sonnet $1）しか届かず、終了時の usage は全体（入力 100 万 + 出力 10 万 = Sonnet $3）。
  const partialStep = { ...sonnetUsage, input_tokens: 500_000, output_tokens: 0 }
  let drafts = beginTurn({}, { turnId: 't16' })
  drafts = recordStep(drafts, { turnId: 't16', model: 'claude-sonnet-5-5', usage: partialStep })

  // Act
  const finished = finishTurn(drafts, { turnId: 't16', usage: sonnetUsage, durationMs: 1, reason: 'answer' })

  // Assert: 過少表示（$1）ではなく全体で計算した値を使う。Haiku 換算も全体から計算する（0.75）。
  expect(finished.record.costUsd).toBe(3)
  expect(finished.record.sonnetCostUsd).toBe(3)
  expect(finished.record.haikuCostUsd).toBe(0.75)
})

test('advisor の呼び出し回数は、NaN・負数・小数・非数なら 0 として数える', () => {
  // Arrange
  const withAdvisorCalls = (advisorCalls: unknown): Drafts =>
    recordStep(beginTurn({}, { turnId: 't17' }), { turnId: 't17', model: 'claude-sonnet-5-5', usage: sonnetUsage, advisorCalls: advisorCalls as number })

  // Act
  const invalid = finishTurn(withAdvisorCalls(Number.NaN), { turnId: 't17', durationMs: 1, reason: 'answer' })
  const negative = finishTurn(withAdvisorCalls(-1), { turnId: 't17', durationMs: 1, reason: 'answer' })
  const fractional = finishTurn(withAdvisorCalls(1.5), { turnId: 't17', durationMs: 1, reason: 'answer' })
  const notNumber = finishTurn(withAdvisorCalls('2'), { turnId: 't17', durationMs: 1, reason: 'answer' })
  const valid = finishTurn(withAdvisorCalls(2), { turnId: 't17', durationMs: 1, reason: 'answer' })

  // Assert
  expect(invalid.record.advisorCalls).toBe(0)
  expect(negative.record.advisorCalls).toBe(0)
  expect(fractional.record.advisorCalls).toBe(0)
  expect(notNumber.record.advisorCalls).toBe(0)
  expect(valid.record.advisorCalls).toBe(2)
})

test('所要時間が有限な非負数でなければ、所要時間を不明（undefined）として記録する', () => {
  // Act
  const notFinite = finishTurn({}, { turnId: 't18', usage: sonnetUsage, durationMs: Number.NaN, reason: 'answer' })
  const negative = finishTurn({}, { turnId: 't19', usage: sonnetUsage, durationMs: -5, reason: 'answer' })
  const zero = finishTurn({}, { turnId: 't20', usage: sonnetUsage, durationMs: 0, reason: 'answer' })

  // Assert
  expect(notFinite.record.durationMs).toBeUndefined()
  expect(negative.record.durationMs).toBeUndefined()
  expect(zero.record.durationMs).toBe(0)
})

test('動きが止まった未完了のターンは、寿命を過ぎると実行中の一覧から外れる', () => {
  // Arrange
  const started = recordTool(beginTurn({}, { turnId: 't13' }, 1_000), { tool: 'Read' }, 1_000)

  // Act
  const within = liveDrafts(started, 1_000 + LIVE_DRAFT_LIFETIME_MS)
  const expired = liveDrafts(started, 1_000 + LIVE_DRAFT_LIFETIME_MS + 1)

  // Assert
  expect(Object.keys(within)).toEqual([MAIN_LOOP_KEY])
  expect(expired).toEqual({})
})

test('ツールや応答の動きがあれば、未完了のターンの寿命は延びる', () => {
  // Arrange
  let drafts = beginTurn({}, { turnId: 't14' }, 0)

  // Act
  drafts = recordTool(drafts, { tool: 'Read' }, LIVE_DRAFT_LIFETIME_MS)

  // Assert
  expect(Object.keys(liveDrafts(drafts, LIVE_DRAFT_LIFETIME_MS * 2))).toEqual([MAIN_LOOP_KEY])
  expect(liveDrafts(drafts, LIVE_DRAFT_LIFETIME_MS * 2 + 1)).toEqual({})
})

test('新しい turn.start は、同じループに残っていた未完了の下書きを置き換える', () => {
  // Arrange: 中断された（turn.complete の来なかった）ターンのツール呼び出し。
  let drafts = recordTool(beginTurn({}, { turnId: 'aborted' }), { tool: 'Bash' })

  // Act
  drafts = beginTurn(drafts, { turnId: 'next' })

  // Assert
  expect(drafts[MAIN_LOOP_KEY]).toMatchObject({ turnId: 'next', toolCount: 0 })
})

test('中断されたターンは、寿命を過ぎるとペインの「実行中」の行に出なくなる', () => {
  // Arrange: turn.complete が来ないまま止まったターンの、ツール 1 回の下書き。
  const stuck = recordTool(beginTurn({}, { turnId: 't15' }, 1_000), { tool: 'Read' }, 1_000)
  const isRunningRow = (rows: ReturnType<typeof buildPaneRows>): boolean =>
    rows.some(row => row.kind === 'kv' && row.label === '実行中')

  // Act
  const withinLifetime = buildPaneRows(EMPTY_REVIEW, liveDrafts(stuck, 1_000 + LIVE_DRAFT_LIFETIME_MS), 1_000 + LIVE_DRAFT_LIFETIME_MS)
  const afterLifetime = buildPaneRows(EMPTY_REVIEW, liveDrafts(stuck, 1_000 + LIVE_DRAFT_LIFETIME_MS + 1), 1_000 + LIVE_DRAFT_LIFETIME_MS + 1)

  // Assert
  expect(isRunningRow(withinLifetime)).toBe(true)
  expect(isRunningRow(afterLifetime)).toBe(false)
})

test('開始を見ていない途中拾いのターンは partial、compact 直後は afterCompact の印が付く', () => {
  // Arrange: reload で下書きが消え、step から拾い始めた
  const midway = recordStep({}, { turnId: 't1', model: 'claude-sonnet-5-5', usage: sonnetUsage })
  const started = recordStep(beginTurn({}, { turnId: 't2' }), { turnId: 't2', model: 'claude-sonnet-5-5', usage: sonnetUsage })

  // Act
  const partial = finishTurn(midway, { turnId: 't1', usage: sonnetUsage, durationMs: 1, reason: 'answer' })
  const compacted = finishTurn(started, { turnId: 't2', usage: sonnetUsage, durationMs: 1, reason: 'answer', afterCompact: true })

  // Assert
  expect(partial.record.partial).toBe(true)
  expect(partial.record.afterCompact).toBeUndefined()
  expect(compacted.record.partial).toBeUndefined()
  expect(compacted.record.afterCompact).toBe(true)
})

test('内訳は応答ごとの単価段で足し、合計は costUsd と一致する。単価不明の応答を含むと null', () => {
  // Arrange: 1 回目 Sonnet、2 回目 Haiku（10 万 tokens 以下の低い単価段）
  const haikuUsage = { model: 'claude-haiku-5-5', input_tokens: 50_000, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 20_000 }
  let drafts = beginTurn({}, { turnId: 't-parts' })

  // Act
  drafts = recordStep(drafts, { turnId: 't-parts', model: 'claude-sonnet-5-5', usage: sonnetUsage })
  drafts = recordStep(drafts, { turnId: 't-parts', model: 'claude-haiku-5-5', usage: haikuUsage })
  const record = finishTurn(drafts, { turnId: 't-parts', usage: haikuUsage, durationMs: 1, reason: 'answer' }).record

  // Assert
  const parts = record.costParts
  expectNear(parts?.input, 2 + (50_000 * 0.1) / 1e6)
  expectNear(parts?.output, 1 + (10_000 * 0.5) / 1e6)
  expectNear(parts?.cacheWrite, (20_000 * 0.125) / 1e6)
  const sum = (parts?.input ?? 0) + (parts?.output ?? 0) + (parts?.cacheRead ?? 0) + (parts?.cacheWrite ?? 0)
  expectNear(sum, record.costUsd ?? Number.NaN)

  const unknown = { ...sonnetUsage, model: 'claude-unknown-9' }
  const withUnknown = recordStep(beginTurn({}, { turnId: 't-u' }), { turnId: 't-u', model: unknown.model, usage: unknown })
  expect(finishTurn(withUnknown, { turnId: 't-u', usage: unknown, durationMs: 1, reason: 'answer' }).record.costParts).toBeNull()
})

test('step が欠けているときの内訳は、終了時の usage から再計算して costUsd と一致する', () => {
  // Arrange: step なし、終了時の usage だけ
  const drafts = beginTurn({}, { turnId: 't-nostep' })

  // Act
  const record = finishTurn(drafts, { turnId: 't-nostep', usage: sonnetUsage, durationMs: 1, reason: 'answer' }).record

  // Assert
  expect(record.costParts).toEqual({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 })
  expectNear(record.costUsd, 3)
})

test('数値の effort は文字列と区別できる形で残し、読み替えない', () => {
  // Arrange
  let drafts = beginTurn({}, { turnId: 't4' })

  // Act
  drafts = recordStep(drafts, { turnId: 't4', model: 'claude-sonnet-5-5', effort: 32000, usage: null })
  const finished = finishTurn(drafts, { turnId: 't4', durationMs: 1, reason: 'answer' })

  // Assert
  expect(finished.record.effort).toBe('n:32000')
})

// ---- 1 ターンの中でモデルが替わる（#83） ----
const opusUsage = {
  model: 'claude-opus-5-5',
  input_tokens: 1_000,
  output_tokens: 500,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}
const haikuUsage = { ...opusUsage, model: 'claude-haiku-5-5', input_tokens: 2_000 }

test('2 モデルが混ざるターンは、モデル別の内訳を応答ごとに分けて残す', () => {
  // Arrange
  let drafts: Drafts = beginTurn({}, { turnId: 't1' }, 0, 'claude-opus-5-5')

  // Act
  drafts = recordStep(drafts, { turnId: 't1', model: 'claude-opus-5-5', usage: opusUsage })
  drafts = recordStep(drafts, { turnId: 't1', model: 'claude-haiku-5-5', usage: haikuUsage })
  drafts = recordStep(drafts, { turnId: 't1', model: 'claude-haiku-5-5', usage: haikuUsage })
  const { record } = finishTurn(drafts, {
    turnId: 't1',
    usage: { ...haikuUsage, input_tokens: 1_000 + 2_000 * 2, output_tokens: 1_500 },
    durationMs: 10,
    reason: 'answer',
  })

  // Assert
  expect(record.byModel?.map(share => [share.model, share.steps, share.tokens.input])).toEqual([
    ['claude-opus-5-5', 1, 1_000],
    ['claude-haiku-5-5', 2, 4_000],
  ])
  expect(record.divergedSteps).toBe(2)
})

test('1 モデルだけのターンは byModel も divergedSteps も持たない', () => {
  // Arrange
  let drafts: Drafts = beginTurn({}, { turnId: 't1' }, 0, 'claude-opus-5-5')

  // Act
  drafts = recordStep(drafts, { turnId: 't1', model: 'claude-opus-5-5', usage: opusUsage })
  drafts = recordStep(drafts, { turnId: 't1', model: 'claude-opus-5-5', usage: opusUsage })
  const { record } = finishTurn(drafts, {
    turnId: 't1',
    usage: { ...opusUsage, input_tokens: 2_000, output_tokens: 1_000 },
    durationMs: 10,
    reason: 'answer',
  })

  // Assert
  expect('byModel' in record).toBe(false)
  expect('divergedSteps' in record).toBe(false)
})

test('セッションのモデルを読めなければ、食い違いは数えない', () => {
  // Arrange
  let drafts: Drafts = beginTurn({}, { turnId: 't1' }, 0, null)

  // Act
  drafts = recordStep(drafts, { turnId: 't1', model: 'claude-haiku-5-5', usage: haikuUsage })
  const { record } = finishTurn(drafts, { turnId: 't1', usage: haikuUsage, durationMs: 10, reason: 'answer' })

  // Assert
  expect('divergedSteps' in record).toBe(false)
})

test('サブエージェントの応答は、セッションのモデルと違っても食い違いに数えない', () => {
  // Arrange
  let drafts: Drafts = beginTurn({}, { turnId: 't1', agentId: 'a1' }, 0, 'claude-opus-5-5')

  // Act
  drafts = recordStep(drafts, { turnId: 't1', agentId: 'a1', model: 'claude-haiku-5-5', usage: haikuUsage })
  const { record } = finishTurn(drafts, { turnId: 't1', agentId: 'a1', usage: haikuUsage, durationMs: 10, reason: 'answer' })

  // Assert
  expect('divergedSteps' in record).toBe(false)
})

test('日付違いの別表記は同じモデルとして 1 行にまとめ、エイリアスのセッションモデルは比べない', () => {
  // Arrange
  let drafts: Drafts = beginTurn({}, { turnId: 't1' }, 0, 'opus')

  // Act
  drafts = recordStep(drafts, { turnId: 't1', model: 'claude-opus-5-5', usage: opusUsage })
  drafts = recordStep(drafts, { turnId: 't1', model: 'claude-opus-5-5-20260101', usage: { ...opusUsage, model: 'claude-opus-5-5-20260101' } })
  const { record } = finishTurn(drafts, {
    turnId: 't1',
    usage: { ...opusUsage, model: 'claude-opus-5-5-20260101', input_tokens: 2_000, output_tokens: 1_000 },
    durationMs: 10,
    reason: 'answer',
  })

  // Assert
  expect('byModel' in record).toBe(false)
  expect('divergedSteps' in record).toBe(false)
})

test('markPlanMode は進行中のメインのターンに印を付け、記録に planMode: true を残す', () => {
  // Arrange
  let drafts: Drafts = beginTurn({}, { turnId: 't1' }, 0, null)

  // Act
  drafts = markPlanMode(drafts)
  const { record } = finishTurn(drafts, { turnId: 't1', usage: sonnetUsage, durationMs: 10, reason: 'answer' })

  // Assert
  expect(record.planMode).toBe(true)
})

test('plan mode を見ていないターン、下書きのないときの印は記録に残さない', () => {
  // Arrange
  const drafts: Drafts = beginTurn({}, { turnId: 't1' }, 0, null)

  // Act
  const unmarked = finishTurn(drafts, { turnId: 't1', usage: sonnetUsage, durationMs: 10, reason: 'answer' }).record
  const empty = markPlanMode({})

  // Assert
  expect('planMode' in unmarked).toBe(false)
  expect(empty).toEqual({})
})

test('plan mode の印はサブエージェントの下書きには付かず、次のターンへ持ち越さない', () => {
  // Arrange
  let drafts: Drafts = beginTurn({}, { turnId: 'm1' }, 0, null)
  drafts = beginTurn(drafts, { turnId: 's1', agentId: 'sub-1' }, 0, null)

  // Act
  drafts = markPlanMode(drafts)
  const sub = finishTurn(drafts, { turnId: 's1', agentId: 'sub-1', usage: sonnetUsage, durationMs: 1, reason: 'answer' })
  const next = beginTurn(sub.drafts, { turnId: 'm2' }, 0, null)
  const second = finishTurn(next, { turnId: 'm2', usage: sonnetUsage, durationMs: 1, reason: 'answer' }).record

  // Assert
  expect('planMode' in sub.record).toBe(false)
  expect('planMode' in second).toBe(false)
})
