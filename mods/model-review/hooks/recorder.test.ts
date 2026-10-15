import { test, expect } from 'claude-code/testing'

import { UNKNOWN_MODEL, beginTurn, finishTurn, recordStep, recordTool, type Drafts } from './recorder'

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
    haikuCostUsd: 0.75,
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

test('usage も step もないターンは、モデル不明・トークン 0・コスト 0 で記録する', () => {
  // Arrange
  const drafts: Drafts = {}

  // Act
  const finished = finishTurn(drafts, { turnId: 'aborted', durationMs: 5, reason: 'aborted' })

  // Assert
  expect(finished.record).toMatchObject({
    model: UNKNOWN_MODEL,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
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
