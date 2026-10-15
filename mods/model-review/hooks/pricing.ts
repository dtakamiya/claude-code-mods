// 単価表。出典: https://platform.claude.com/docs/en/about-claude/pricing （PRICE_TABLE_FETCHED_AT に取得）。
// 単位は USD / 100 万トークン（MTok）。$ には触れない純粋な表。単価が変わったらここだけを直す。
// キャッシュ書き込みは 5 分単価を基本にする（TurnUsage は TTL 別の内訳を持たないため）。1 時間単価は上限の見積りにだけ使う。

export type Rates = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** 1 時間 TTL の書込単価。TTL が分からないので、推定の上限側を出すためだけに使う。 */
  readonly cacheWrite1h: number
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

/** 単価表を取得した日。ペインの注記で共用する。単価を直したらここも更新する。 */
export const PRICE_TABLE_FETCHED_AT = '2026-10-15'
/** 「Haiku なら」の差額を出すときの基準モデル。 */
export const HAIKU_REFERENCE_MODEL = 'claude-haiku-5-5'
/** 切替の見積りで Opus 側の候補にするモデル。 */
export const OPUS_REFERENCE_MODEL = 'claude-opus-5-5'
/** Opus 系の軽作業で「Sonnet なら」の差額を出すときの基準モデル。 */
export const SONNET_REFERENCE_MODEL = 'claude-sonnet-5-5'

const TOKENS_PER_MTOK = 1_000_000
const UNBOUNDED = Number.POSITIVE_INFINITY
const HAIKU_5_5_PROMPT_TIER_LIMIT = 100_000

const rates = (input: number, cacheWrite: number, cacheRead: number, output: number, cacheWrite1h: number): Rates => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  cacheWrite1h,
})
const single = (tierRates: Rates): readonly RateTier[] => [{ maxPromptTokens: UNBOUNDED, rates: tierRates }]

const FABLE_5_1 = rates(10, 12.5, 0.25, 50, 20)
const FABLE_5 = rates(10, 12.5, 1, 50, 20)
const OPUS_5_5 = rates(4, 5, 0.2, 20, 8)
const OPUS_5 = rates(5, 6.25, 0.5, 25, 10)
const OPUS_4 = rates(15, 18.75, 1.5, 75, 30)
const SONNET_5_5 = rates(2, 2.5, 0.1, 10, 4)
const SONNET_5 = rates(2, 2.5, 0.2, 10, 4)
const SONNET_4 = rates(3, 3.75, 0.3, 15, 6)
const HAIKU_4_5 = rates(1, 1.25, 0.1, 5, 2)

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
      { maxPromptTokens: HAIKU_5_5_PROMPT_TIER_LIMIT, rates: rates(0.1, 0.125, 0.01, 0.5, 0.2) },
      { maxPromptTokens: UNBOUNDED, rates: rates(0.5, 0.625, 0.05, 2.5, 1) },
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

export type CacheWriteTtl = '5m' | '1h'

/**
 * 1 応答の推定コスト（USD）。単価表にないモデルは null（単価不明）。プロンプト長は応答ごとに判定する。
 * writeTtl が '1h' なら、書込を 1 時間単価で計算した上限側の値になる（既定は 5 分単価）。
 */
export function priceUsage(usage: TokenUsageLike, writeTtl: CacheWriteTtl = '5m'): number | null {
  const promptTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const tierRates = ratesFor(usage.model, promptTokens)
  if (!tierRates) return null
  const cost =
    usage.input_tokens * tierRates.input +
    usage.output_tokens * tierRates.output +
    usage.cache_read_input_tokens * tierRates.cacheRead +
    usage.cache_creation_input_tokens * (writeTtl === '1h' ? tierRates.cacheWrite1h : tierRates.cacheWrite)
  return cost / TOKENS_PER_MTOK
}

/**
 * キャッシュを読めていれば払わなかった額の推定（USD）。書込トークンを、書込単価と読込単価の差で評価する。
 * 単価不明のモデルは null。
 * 単価段はプロンプト全体の長さで決まる（priceUsage と同じ）。省略時は書込トークンだけで判定する。
 */
export function cacheRebuildCostUsd(
  model: string,
  cacheWriteTokens: number,
  promptTokens: number = cacheWriteTokens,
): number | null {
  const tierRates = ratesFor(model, Math.max(promptTokens, cacheWriteTokens))
  if (!tierRates) return null
  return (cacheWriteTokens * (tierRates.cacheWrite - tierRates.cacheRead)) / TOKENS_PER_MTOK
}
