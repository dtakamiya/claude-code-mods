import { test, expect } from 'claude-code/testing'

import { HAIKU_REFERENCE_MODEL, cacheRebuildCostUsd, normalizeModelId, priceUsage, type TokenUsageLike } from './pricing'

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

test('Haiku 基準のモデル ID は単価表にあり、同じ usage を差し替えて計算できる', () => {
  // Arrange
  // Haiku 5.5 は 10 万 tokens 以下の低い単価表（入力 $0.1 / MTok）。
  const opus = usage({ model: 'claude-opus-5-5', input_tokens: 100_000 })

  // Act
  const asHaiku = priceUsage({ ...opus, model: HAIKU_REFERENCE_MODEL })

  // Assert
  expect(asHaiku?.toFixed(6)).toBe('0.010000')
})

test('キャッシュ再構築コストは、書込単価と読込単価の差にトークン数を掛けた額', () => {
  // Arrange: Opus 5.5 は書込 $5 / 読込 $0.2（MTok）。100 万 tokens で差は $4.8。

  // Act
  const cost = cacheRebuildCostUsd('claude-opus-5-5', 1_000_000)

  // Assert
  expect(cost?.toFixed(6)).toBe('4.800000')
})

test('キャッシュ再構築コストの単価段は、書込だけでなくプロンプト全体の長さで判定する', () => {
  // Arrange: Haiku 5.5 の書込 70,000 tokens。プロンプト全体が 135,000 なら高い単価段（書込 $0.625 / 読込 $0.05）。

  // Act
  const byWriteOnly = cacheRebuildCostUsd('claude-haiku-5-5', 70_000)
  const byPrompt = cacheRebuildCostUsd('claude-haiku-5-5', 70_000, 135_000)

  // Assert: 低い段は 70,000 × (0.125 − 0.01) = 0.00805、高い段は 70,000 × (0.625 − 0.05) = 0.04025。
  expect(byWriteOnly?.toFixed(5)).toBe('0.00805')
  expect(byPrompt?.toFixed(5)).toBe('0.04025')
})

test('キャッシュ再構築コストは、単価不明のモデルでは null、書込 0 では 0', () => {
  expect(cacheRebuildCostUsd('claude-unlisted-9', 1_000)).toBeNull()
  expect(cacheRebuildCostUsd('claude-opus-5-5', 0)).toBe(0)
})

test('書込を 1 時間単価にした上限は、書込トークンの分だけ 5 分単価より高い', () => {
  // Arrange: Sonnet 5.5 の書込 1,000,000 tokens。5 分 $2.5、1 時間 $4。
  const written = usage({ model: 'claude-sonnet-5-5', input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })

  // Act
  const low = priceUsage(written)
  const high = priceUsage(written, '1h')

  // Assert
  expect(low).toBe(2.5)
  expect(high).toBe(4)
})

test('書込のない応答は、5 分でも 1 時間でも同じ額になる', () => {
  const plain = usage({ model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0 })
  expect(priceUsage(plain, '1h')).toBe(priceUsage(plain))
})
