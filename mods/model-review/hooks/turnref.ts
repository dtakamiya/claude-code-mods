// 利用者向けのターンの指し示し。内部の turnId ではなく、セッション内の通し番号と経過で示す。$ に触れない純粋関数。
// 依頼の本文（プロンプト）は記録しないので、ここにも出ない。
import type { TurnRecord } from '../types'

const MS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24

/** 「12 分前」の形。時計の巻き戻りなどで負になったときは「たった今」。 */
export function agoText(elapsedMs: number): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / MS_PER_MINUTE)
  if (minutes < 1) return 'たった今'
  if (minutes < MINUTES_PER_HOUR) return `${minutes} 分前`
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  return hours < HOURS_PER_DAY ? `${hours} 時間前` : `${Math.floor(hours / HOURS_PER_DAY)} 日前`
}

export const hasSeq = (record: TurnRecord): boolean => isCount(record.mainSeq)

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1

/**
 * ターン 1 件の指し示し。
 * - メイン: 「#37（12 分前）」。時刻が分からなければ「#37（8 ターン前）」「#37（最新）」。
 * - サブエージェント: 「#37 の中のサブエージェント」（親のメインのターンに結びつける）。
 * - 通し番号のない古い記録: 従来どおり「ターン <turnId>」。
 * turnsAgo は、その後に完了したメインのターン数。
 */
export function turnRefText(record: TurnRecord, turnsAgo: number, nowMs?: number): string {
  const seq = record.mainSeq
  if (!isCount(seq)) return `ターン ${record.turnId}`
  if (record.agentId !== null) return `#${seq} の中のサブエージェント`
  const completed = record.completedAtMs
  if (typeof nowMs === 'number' && typeof completed === 'number' && Number.isFinite(nowMs) && Number.isFinite(completed)) {
    return `#${seq}（${agoText(nowMs - completed)}）`
  }
  return `#${seq}（${turnsAgo <= 0 ? '最新' : `${turnsAgo} ターン前`}）`
}

/** 一覧の見出し用。通し番号があれば指し示しだけ、古い記録は従来どおり turnId と種別を添える。 */
export function turnLabelText(record: TurnRecord, turnsAgo: number, origin: string, nowMs?: number): string {
  return hasSeq(record) ? turnRefText(record, turnsAgo, nowMs) : `${record.turnId} · ${origin}`
}
