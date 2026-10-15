import { test, expect } from 'claude-code/testing'

import { normalizeModelId, priceUsage, type TokenUsageLike } from './pricing'

// 架空データのみ。
const usage = (overrides: Partial<TokenUsageLike>): TokenUsageLike => ({
  model: 'claude-opus-5-5',
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...overrides,
})

test('日付サフィックス・Bedrock 接頭辞・バージョン・[1m] を除いて単価表のキーに寄せる', () => {
  expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
  expect(normalizeModelId('us.anthropic.claude-opus-4-5-20251101-v1:0')).toBe('claude-opus-4-5')
  expect(normalizeModelId('anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  expect(normalizeModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
  expect(normalizeModelId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5')
  expect(normalizeModelId('  Claude-Haiku-5-5 ')).toBe('claude-haiku-5-5')
})

test('単価表にないモデルはコストを null（単価不明）にする', () => {
  // Arrange
  const unknown = usage({ model: 'claude-unlisted-9', input_tokens: 1_000 })

  // Act
  const cost = priceUsage(unknown)

  // Assert
  expect(cost).toBeNull()
})

test('入力・出力・キャッシュ読み書きをそれぞれの単価で計算する', () => {
  // Arrange: Opus 5.5 は入力 $4 / 出力 $20 / キャッシュ書込 $5 / キャッシュ読 $0.20（MTok）。
  const sample = usage({
    model: 'claude-opus-5-5',
    input_tokens: 1_000_000,
    output_tokens: 100_000,
    cache_creation_input_tokens: 200_000,
    cache_read_input_tokens: 2_000_000,
  })

  // Act
  const cost = priceUsage(sample)

  // Assert: 4 + 2 + 1 + 0.4 = 7.4
  expect(cost?.toFixed(6)).toBe('7.400000')
})

test('Bedrock 表記のモデルも同じ単価で計算する', () => {
  // Arrange
  const direct = usage({ model: 'claude-haiku-4-5', input_tokens: 500_000, output_tokens: 100_000 })
  const bedrock = { ...direct, model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' }

  // Act / Assert
  expect(priceUsage(bedrock)).toBe(priceUsage(direct))
})

test('Haiku 5.5 はプロンプトが 10 万 tokens 以下なら低い単価表を使う', () => {
  // Arrange: プロンプト合計 100,000（入力 + キャッシュ読み書き）は上限ちょうどで低い方。
  const atLimit = usage({ model: 'claude-haiku-5-5', input_tokens: 90_000, cache_read_input_tokens: 10_000, output_tokens: 1_000_000 })

  // Act
  const cost = priceUsage(atLimit)

  // Assert: 入力 90,000 × $0.10 + キャッシュ読 10,000 × $0.01 + 出力 1,000,000 × $0.50（いずれも MTok 単位）
  expect(cost?.toFixed(7)).toBe('0.5091000')
})

test('Haiku 5.5 はプロンプトが 10 万 tokens を超えると高い単価表を使う', () => {
  // Arrange
  const overLimit = usage({ model: 'claude-haiku-5-5', input_tokens: 100_001, output_tokens: 1_000_000 })

  // Act
  const cost = priceUsage(overLimit)

  // Assert: 入力 0.0500005 + 出力 2.5
  expect(cost?.toFixed(7)).toBe('2.5500005')
})
