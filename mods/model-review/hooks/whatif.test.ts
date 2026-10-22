import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { describeOption, estimateSwitchOptions } from './whatif'

// 架空データのみ。
const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 't1',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  tokens: { input: 100_000, output: 10_000, cacheRead: 400_000, cacheWrite: 100_000 },
  costUsd: 0.59,
  toolCount: 1,
  editCount: 0,
  durationMs: 1_000,
  reason: 'answer',
  firstStepCacheWrite: 100_000,
  firstStepPromptTokens: 600_000,
  firstStepCacheRead: 400_000,
  ...overrides,
})

test('いまのモデルを除いた候補ごとに、再構築コスト・1 ターンの差・回収ターン数を出す', () => {
  // Arrange: Sonnet 5.5 の 1 ターンは $0.59。Opus 5.5 は $1.18（+$0.59）、Haiku 5.5 はプロンプト 60 万 tokens の高い単価段で $0.1575。
  // 再構築は最初の応答の読込 + 書込（50 万 tokens）を書き直す額。Haiku は (0.625 - 0.05) × 0.5 = $0.2875、Opus は (5 - 0.2) × 0.5 = $2.4。
  const records = [turn()]

  // Act
  const options = estimateSwitchOptions(records)
  const haiku = options.find(option => option.model === 'claude-haiku-5-5')
  const opus = options.find(option => option.model === 'claude-opus-5-5')

  // Assert
  expect(options.map(option => option.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
  expect(haiku?.rebuildUsd?.toFixed(6)).toBe('0.287500')
  expect(haiku?.perTurnDeltaUsd?.toFixed(6)).toBe('-0.432500')
  expect(haiku?.breakEvenTurns).toBe(1)
  expect(opus?.rebuildUsd?.toFixed(6)).toBe('2.400000')
  expect(opus?.perTurnDeltaUsd?.toFixed(6)).toBe('0.590000')
  expect(opus?.breakEvenTurns).toBeNull()
})

test('基準は直近のメインのターン。サブエージェントや単価不明・プロンプト長不明のターンは基準にしない', () => {
  // Arrange: 最後のメインが Opus。その後ろにサブエージェントがある。
  const records = [
    turn({ turnId: 'a', model: 'claude-sonnet-5-5' }),
    turn({ turnId: 'b', model: 'claude-opus-5-5', costUsd: 1.18 }),
    turn({ turnId: 'sub', agentId: 'agent-1', model: 'claude-haiku-5-5' }),
    turn({ turnId: 'c', costUsd: null }),
    turn({ turnId: 'd', firstStepPromptTokens: undefined }),
  ]

  // Act
  const options = estimateSwitchOptions(records)

  // Assert
  expect(options.map(option => option.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
})

test('基準にできるターンがない、またはモデルの単価が不明なときは空を返す', () => {
  expect(estimateSwitchOptions([])).toEqual([])
  expect(estimateSwitchOptions([turn({ model: 'mystery-model' })])).toEqual([])
})

test('firstStepCacheWrite のない旧記録は基準にせず、直近の新しい記録で見積もる（再構築を 0 円とみなさない）', () => {
  // Arrange: 直近は旧記録（Opus・再構築の記録なし）。その前に新しい記録（Sonnet）がある。
  const records = [
    turn({ turnId: 'new', model: 'claude-sonnet-5-5' }),
    turn({ turnId: 'old', model: 'claude-opus-5-5', costUsd: 1.18, firstStepCacheWrite: undefined }),
  ]

  // Act
  const options = estimateSwitchOptions(records)
  const haiku = options.find(option => option.model === 'claude-haiku-5-5')

  // Assert: 基準は Sonnet の記録なので、候補は Haiku と Opus。Haiku の再構築は 0.2875。
  expect(options.map(option => option.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
  expect(haiku?.rebuildUsd?.toFixed(6)).toBe('0.287500')
})

test('firstStepCacheWrite のない旧記録しかなければ、再構築が不明なので空を返す', () => {
  expect(estimateSwitchOptions([turn({ firstStepCacheWrite: undefined })])).toEqual([])
})

test('文面はモデル名・再構築・差額の符号・回収ターン数を含む', () => {
  // Arrange
  const [haiku] = estimateSwitchOptions([turn()])

  // Act
  const text = haiku ? describeOption(haiku) : ''

  // Assert
  expect(text).toBe('haiku-5-5 へ: 再構築 +$0.2875 · 1 ターンあたり -$0.4325 · 約 1 ターンで回収')
})

test('温かいキャッシュの定常ターンでは、書込（追記分）ではなく読込を含むキャッシュ全体を書き直す額を再構築とする', () => {
  // Arrange: Opus 5.5 の定常ターン。最初の応答は読込 145,000・書込 5,000（前回からの追記分だけ）。
  const steady = turn({
    model: 'claude-opus-5-5',
    tokens: { input: 200, output: 1_000, cacheRead: 145_000, cacheWrite: 5_000 },
    costUsd: 0.0738,
    firstStepCacheRead: 145_000,
    firstStepCacheWrite: 5_000,
    firstStepPromptTokens: 150_200,
  })

  // Act
  const sonnet = estimateSwitchOptions([steady]).find(option => option.model === 'claude-sonnet-5-5')

  // Assert: (2.5 - 0.1) × 0.15 = $0.36。書込 5,000 だけで見積もると $0.012 で、30 倍小さく出る。
  expect(sonnet?.rebuildUsd?.toFixed(6)).toBe('0.360000')
})

test('キャッシュ読込を持たない旧記録は、プロンプト全体で再構築を見積もる（書込だけで小さく見積もらない）', () => {
  // Arrange: 0.32.0 までの記録。プロンプト 60 万 tokens、書込 10 万。
  const [haiku] = estimateSwitchOptions([turn({ firstStepCacheRead: undefined })])

  // Assert: (0.625 - 0.05) × 0.6 = $0.345。
  expect(haiku?.rebuildUsd?.toFixed(6)).toBe('0.345000')
})

test('いまのモデルと候補の費用は、記録が応答ごとに単価段を判定した値を使う（ターン合計の長さで判定しない）', () => {
  // Arrange: 合計ではプロンプト 60 万 tokens だが、応答ごとに見ると Haiku の低い単価段に収まり、Haiku 換算は $0.05。
  const record = turn({ haikuCostUsd: 0.05, sonnetCostUsd: 0.59 })

  // Act
  const haiku = estimateSwitchOptions([record]).find(option => option.model === 'claude-haiku-5-5')

  // Assert: 0.05 - 0.59。
  expect(haiku?.perTurnDeltaUsd?.toFixed(6)).toBe('-0.540000')
})

test('応答ごとの換算を持たない記録は、ターン合計を最初の応答のプロンプト長の単価段で計算する', () => {
  // Arrange: Haiku 5.5 のターン。合計では 60 万 tokens だが、最初の応答は 5 万 tokens。
  const record = turn({ model: 'claude-haiku-5-5', costUsd: 0.1, firstStepPromptTokens: 50_000, firstStepCacheRead: 40_000, firstStepCacheWrite: 10_000 })

  // Act
  const sonnet = estimateSwitchOptions([record]).find(option => option.model === 'claude-sonnet-5-5')

  // Assert: sonnetCostUsd が無いので合計を Sonnet 単価（単価段は 1 つ）で計算: 0.2 + 0.1 + 0.04 + 0.25 = $0.59。差は 0.59 - 0.1。
  expect(sonnet?.perTurnDeltaUsd?.toFixed(6)).toBe('0.490000')
})

test('compact 直後・partial のターンは基準にしない', () => {
  // Arrange
  const records = [turn({ afterCompact: true }), turn({ partial: true })]

  // Act
  const options = estimateSwitchOptions(records)

  // Assert
  expect(options).toEqual([])
})
