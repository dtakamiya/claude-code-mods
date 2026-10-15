// 単価表。出典: https://platform.claude.com/docs/en/about-claude/pricing （2026-10-15 取得）。
// 単位は USD / 100 万トークン（MTok）。$ には触れない純粋な表。単価が変わったらここだけを直す。
// キャッシュ書き込みは 5 分単価で概算する（TurnUsage は TTL 別の内訳を持たないため）。

export type Rates = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** プロンプト長（入力 + キャッシュ読み書き）の上限ごとの単価。上限の昇順に並べる。 */
export type RateTier = {
  readonly maxPromptTokens: number
  readonly rates: Rates
}

export type TokenUsageLike = {
  readonly model: string
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
}

const TOKENS_PER_MTOK = 1_000_000
const UNBOUNDED = Number.POSITIVE_INFINITY
const HAIKU_5_5_PROMPT_TIER_LIMIT = 100_000

const rates = (input: number, cacheWrite: number, cacheRead: number, output: number): Rates => ({
  input,
  output,
  cacheRead,
  cacheWrite,
})
const single = (tierRates: Rates): readonly RateTier[] => [{ maxPromptTokens: UNBOUNDED, rates: tierRates }]

const FABLE_5_1 = rates(10, 12.5, 0.25, 50)
const FABLE_5 = rates(10, 12.5, 1, 50)
const OPUS_5_5 = rates(4, 5, 0.2, 20)
const OPUS_5 = rates(5, 6.25, 0.5, 25)
const OPUS_4 = rates(15, 18.75, 1.5, 75)
const SONNET_5_5 = rates(2, 2.5, 0.1, 10)
const SONNET_5 = rates(2, 2.5, 0.2, 10)
const SONNET_4 = rates(3, 3.75, 0.3, 15)
const HAIKU_4_5 = rates(1, 1.25, 0.1, 5)

const RATE_TABLE: ReadonlyMap<string, readonly RateTier[]> = new Map<string, readonly RateTier[]>([
  ['claude-fable-5-1', single(FABLE_5_1)],
  ['claude-mythos-5-1', single(FABLE_5_1)],
  ['claude-fable-5', single(FABLE_5)],
  ['claude-mythos-5', single(FABLE_5)],
  ['claude-opus-5-5', single(OPUS_5_5)],
  ['claude-opus-5', single(OPUS_5)],
  ['claude-opus-4-8', single(OPUS_5)],
  ['claude-opus-4-7', single(OPUS_5)],
  ['claude-opus-4-6', single(OPUS_5)],
  ['claude-opus-4-5', single(OPUS_5)],
  ['claude-opus-4-1', single(OPUS_4)],
  ['claude-opus-4-0', single(OPUS_4)],
  ['claude-sonnet-5-5', single(SONNET_5_5)],
  ['claude-sonnet-5', single(SONNET_5)],
  ['claude-sonnet-4-6', single(SONNET_4)],
  ['claude-sonnet-4-5', single(SONNET_4)],
  ['claude-sonnet-4-0', single(SONNET_4)],
  [
    'claude-haiku-5-5',
    [
      { maxPromptTokens: HAIKU_5_5_PROMPT_TIER_LIMIT, rates: rates(0.1, 0.125, 0.01, 0.5) },
      { maxPromptTokens: UNBOUNDED, rates: rates(0.5, 0.625, 0.05, 2.5) },
    ],
  ],
  ['claude-haiku-4-5', single(HAIKU_4_5)],
])

const BEDROCK_PREFIX = 'anthropic.'
const BEDROCK_VERSION_SUFFIX = /-v\d+:\d+$/
const DATE_SUFFIX = /[-@]\d{8}$/
const BRACKET_SUFFIX = /\[[^\]]*\]$/

/**
 * API・Bedrock・Vertex・`[1m]` 付きの表記を、単価表のキー（例: `claude-haiku-4-5`）に寄せる。
 * 例: `claude-haiku-4-5-20251001`、`us.anthropic.claude-opus-4-5-20251101-v1:0`、`claude-opus-5-5[1m]`。
 */
export function normalizeModelId(raw: string): string {
  const trimmed = raw.trim().replace(BRACKET_SUFFIX, '')
  const prefixAt = trimmed.indexOf(BEDROCK_PREFIX)
  const unprefixed = prefixAt === -1 ? trimmed : trimmed.slice(prefixAt + BEDROCK_PREFIX.length)
  return unprefixed.replace(BEDROCK_VERSION_SUFFIX, '').replace(DATE_SUFFIX, '').toLowerCase()
}

export function ratesFor(model: string, promptTokens: number): Rates | null {
  const tiers = RATE_TABLE.get(normalizeModelId(model))
  if (!tiers) return null
  const tier = tiers.find(candidate => promptTokens <= candidate.maxPromptTokens) ?? tiers[tiers.length - 1]
  return tier?.rates ?? null
}

/** 1 応答の推定コスト（USD）。単価表にないモデルは null（単価不明）。プロンプト長は応答ごとに判定する。 */
export function priceUsage(usage: TokenUsageLike): number | null {
  const promptTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const tierRates = ratesFor(usage.model, promptTokens)
  if (!tierRates) return null
  const cost =
    usage.input_tokens * tierRates.input +
    usage.output_tokens * tierRates.output +
    usage.cache_read_input_tokens * tierRates.cacheRead +
    usage.cache_creation_input_tokens * tierRates.cacheWrite
  return cost / TOKENS_PER_MTOK
}
