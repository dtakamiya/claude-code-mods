// 放置後の再開ターンを事後に示す。$ に触れない純粋関数。既存の記録項目だけを読み、新しく記録しない。
// 断定しない: TTL は分からないので「放置後の可能性」と言う。idle compaction は afterCompact に立つと言えないので、入力の急減で除く。
import type { TurnRecord } from '../types'
import { formatDuration, formatInt, formatUsd } from './format'
import { cacheRebuildCostUsd } from './pricing'
import { MIN_REBUILD_WRITE_TOKENS } from './switches'
import { turnRefText } from './turnref'

export const MS_PER_MINUTE = 60_000
export const MS_PER_HOUR = 60 * MS_PER_MINUTE

/** キャッシュの TTL の下限（5 分）と、長い側（1 時間）。どちらが効いていたかは記録から分からない。 */
export const TTL_SHORT_MS = 5 * MS_PER_MINUTE
export const TTL_LONG_MS = MS_PER_HOUR

/**
 * 仮置き（実ログで見直す）: 直前のメインのターンの入力長に対するこの割合以下まで減ったターンは、圧縮（idle compaction・/compact）を挟んだとみなして除く。
 * idle compaction が afterCompact に立つかは読取だけでは確かめられないので、入力の急減で見分ける。
 */
export const PROMPT_DROP_RATIO = 0.5

export type ResumeEvent = {
  readonly record: TurnRecord
  /** 直前のメインのターンの完了から、このターンの開始までの間隔（ms）。 */
  readonly gapMs: number
  /** 超えた TTL。'1h' は 1 時間 TTL でも切れる間隔、'5m' は 5 分 TTL なら切れる間隔。 */
  readonly ttlOver: '5m' | '1h'
  /** このターンの書込トークン数。 */
  readonly writeTokens: number
}

export type ResumeSummary = {
  readonly count: number
  readonly latest: ResumeEvent | null
  /** latest の後に完了したメインのターン数。 */
  readonly latestTurnsAgo: number
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * 直前のメインのターンの完了から、このターンの開始までの間隔（ms）。開始は 完了 − 所要時間。
 * 時刻・所要時間が欠ける、reload を跨いだ（partial）、通し番号が連続しない（間のターンが畳まれた）ときは不明（null）。
 * 負（時計の巻き戻りなど）は 0。完了時刻は書込みの前に取るので数 ms の誤差を含む。
 */
export function idleGapMs(prev: TurnRecord, current: TurnRecord): number | null {
  if (prev.partial === true || current.partial === true) return null
  if (!isFiniteNumber(prev.completedAtMs) || !isFiniteNumber(current.completedAtMs) || !isFiniteNumber(current.durationMs)) return null
  if (isFiniteNumber(prev.mainSeq) && isFiniteNumber(current.mainSeq) && current.mainSeq !== prev.mainSeq + 1) return null
  return Math.max(0, current.completedAtMs - current.durationMs - prev.completedAtMs)
}

/**
 * 全文を書き直した形か: 最初の応答の書込が下限以上で読込より大きい。圧縮直後（afterCompact・入力の急減）と、根拠の記録が無いものは除く。
 * 直前ターンの入力長が無ければ、圧縮でないと言えないので除く。
 */
function looksRebuilt(prev: TurnRecord, current: TurnRecord): boolean {
  if (current.afterCompact === true) return false
  const { firstStepCacheWrite: write, firstStepCacheRead: read, firstStepPromptTokens: prompt } = current
  if (write === undefined || read === undefined || prompt === undefined) return false
  if (write < MIN_REBUILD_WRITE_TOKENS || write <= read) return false
  const prevPrompt = prev.firstStepPromptTokens
  if (prevPrompt === undefined || prevPrompt <= 0) return false
  return prompt > prevPrompt * PROMPT_DROP_RATIO
}

function eventOf(prev: TurnRecord, current: TurnRecord): ResumeEvent | null {
  const gapMs = idleGapMs(prev, current)
  if (gapMs === null || gapMs < TTL_SHORT_MS || !looksRebuilt(prev, current)) return null
  return { record: current, gapMs, ttlOver: gapMs >= TTL_LONG_MS ? '1h' : '5m', writeTokens: current.firstStepCacheWrite ?? 0 }
}

/** メインループで、放置後の再開の可能性があるターンを数える。サブエージェントのターンは対象外で、直前にも数えない。 */
export function findResumes(records: readonly TurnRecord[]): ResumeSummary {
  const main = records.filter(record => record.agentId === null)
  const indexed = main.flatMap((record, index) => {
    const prev = main[index - 1]
    const event = prev === undefined ? null : eventOf(prev, record)
    return event === null ? [] : [{ event, turnsAgo: main.length - 1 - index }]
  })
  const last = indexed[indexed.length - 1]
  return { count: indexed.length, latest: last?.event ?? null, latestTurnsAgo: last?.turnsAgo ?? 0 }
}

/** 1 時間以上は時間単位（切り捨て）、未満は分・秒。「約」を付けて誤差を含むことを示す。 */
const gapText = (ms: number): string => `約 ${ms >= MS_PER_HOUR ? `${Math.floor(ms / MS_PER_HOUR)} 時間` : formatDuration(ms)}`

/**
 * 1 行の注記。該当が無ければ null。TTL は断定せず、間隔と書込量の事実と「放置後の可能性」に留める。
 * 金額は、書込を読込単価との差で評価した推定（切替の再構築と同じ式）。単価不明なら金額は出さない。
 */
export function resumeNoteText(summary: ResumeSummary, nowMs?: number): string | null {
  const { latest } = summary
  if (latest === null) return null
  const ttl = latest.ttlOver === '1h' ? '5 分 TTL でも 1 時間 TTL でも切れる間隔' : 'TTL が 5 分なら切れる間隔'
  const cost = cacheRebuildCostUsd(latest.record.model, latest.writeTokens, latest.record.firstStepPromptTokens)
  const costText = cost === null ? '' : `、読んでいれば払わなかった額の推定 ${formatUsd(cost)}`
  const ref = turnRefText(latest.record, summary.latestTurnsAgo, nowMs)
  return `放置後の可能性があるターン: ${summary.count} 件。直近は ${ref}で、直前のターンから${gapText(latest.gapMs)}あいていました（${ttl}）。キャッシュ書込 ${formatInt(latest.writeTokens)} tokens${costText}。放置が原因とは断定できません`
}
