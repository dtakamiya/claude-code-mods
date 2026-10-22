// ペイン・コマンド出力で共用する注記と合計。$ に触れない純粋関数。
import type { ReviewState, TurnRecord } from '../types'
import { estimateRange, estimateTotal } from './analyze'
import { CACHE_REBUILD_STREAK, longestRebuildStreak, ttlUnderestimateSuspected } from './cache'
import { PRICE_TABLE_FETCHED_AT, PRICE_TABLE_STALE_DAYS } from './pricing'
import { UNKNOWN_MODEL } from './recorder'
import { turnsSinceBaseline } from './state'
import { findSwitches } from './switches'

/** 単価不明のターンがこの割合以上なら、単価表が古い可能性を注記する（仮置き）。 */
export const UNPRICED_STALE_RATIO = 0.3

/**
 * 注記の種類。動的な警告（rebuild / ttl / switch）と、数字をどこまで信じてよいかの信頼度（それ以外）に分ける。
 * 警告は結論行の「注意」に数え、ペインでは「注意」バッジにする。信頼度は結論行の件数に数えず、ペインでは末尾の注記にする。
 */
export type NoteKind = 'rebuild' | 'ttl' | 'switch' | 'stale' | 'priceAge' | 'diverged' | 'planMode'

export type Note = {
  readonly kind: NoteKind
  readonly text: string
  /** 結論行の理由に使う短い言い方。状態を上げる警告（rebuild / ttl）だけが持つ。 */
  readonly brief?: string
}

const ALERT_KINDS: ReadonlySet<NoteKind> = new Set(['rebuild', 'ttl', 'switch'])
/** 結論行の状態を「要確認」に上げる警告。切替は推定方法の但し書きで、切替の指摘を止めている利用者の ✓ を変えないよう除く。 */
const STATUS_RAISING_KINDS: ReadonlySet<NoteKind> = new Set(['rebuild', 'ttl'])

export const isAlert = (note: Note): boolean => ALERT_KINDS.has(note.kind)
export const raisesStatus = (note: Note): boolean => STATUS_RAISING_KINDS.has(note.kind)

/** 注記を、動的な警告と信頼度に分ける（それぞれ元の順を保つ）。 */
export const splitNotes = (notes: readonly Note[]): { readonly alerts: readonly Note[]; readonly reliability: readonly Note[] } => ({
  alerts: notes.filter(isAlert),
  reliability: notes.filter(note => !isAlert(note)),
})

export const ALWAYS_NOTE =
  '推定に含まれないもの: fast mode の割増、advisor の費用（usage に載らず取得できないため含まれません。Claude Code の更新時に再確認します）、Web 検索などトークン以外の料金。単価は Claude API の価格で、Bedrock / Vertex の価格と地域の割増は含みません。キャッシュ書込の TTL は分からないため、推定は 5 分単価（下限）〜1 時間単価（上限）の幅で示します。'

export const advisorCallTotal = (records: readonly TurnRecord[]): number =>
  records.reduce((sum, record) => sum + (record.advisorCalls ?? 0), 0)

const cacheWriteTotal = (records: readonly TurnRecord[]): number =>
  records.reduce((sum, record) => sum + record.tokens.cacheWrite, 0)

function rebuildStreakNote(records: readonly TurnRecord[]): readonly Note[] {
  const streak = longestRebuildStreak(records)
  if (streak < CACHE_REBUILD_STREAK) return []
  return [
    {
      kind: 'rebuild',
      text: `キャッシュ書込が読込を上回るターンが ${streak} 回連続しています（プレフィックスが変わり続けている可能性。モデル・effort・MCP・プラグインの変更を確認）`,
      brief: `キャッシュ書込 > 読込が ${streak} ターン連続`,
    },
  ]
}

/**
 * 実コスト（基準点からの差）と同じターンだけで上限推定を取る。基準点より前のターンは実コストに入らないため、混ぜると偽陰性になる。
 * 基準点より後に単価不明のターンがあると、その費用は実コストにだけ入り推定には入らないので、比べられない（誤って警告する）。そのときは判定しない。
 */
function ttlNote(review: ReviewState): readonly Note[] {
  const { baseline, current } = review.sessionCostUsd
  if (baseline === null || current === null) return []
  const sinceBaseline = turnsSinceBaseline(review)
  const folded = review.archived?.sinceBaseline
  if (sinceBaseline.some(record => record.costUsd === null) || (folded?.unpricedTurns ?? 0) > 0) return []
  const suspected = ttlUnderestimateSuspected({
    actualUsd: current - baseline,
    estimateUsd: estimateRange(sinceBaseline).highUsd + (folded?.highUsd ?? 0),
    cacheWriteTokens: cacheWriteTotal(sinceBaseline) + (folded?.cacheWrite ?? 0),
  })
  if (!suspected) return []
  return [
    {
      kind: 'ttl',
      text: '実コストが、キャッシュ書込を 1 時間単価にした上限の推定も大きく上回っています。fast mode・advisor・ターン外の要求・単価表の古さなどが考えられます',
      brief: '実コストが推定の上限も大きく上回る',
    },
  ]
}

function unpricedModelNames(review: ReviewState): readonly string[] {
  const recent = review.turns.filter(record => record.costUsd === null).map(record => record.model)
  const folded = (review.archived?.groups ?? []).filter(group => group.unpricedTurns > 0).map(group => group.model)
  return [...new Set([...recent, ...folded])].map(name => (name === UNKNOWN_MODEL ? '不明（モデル名なし）' : name))
}

function staleNote(review: ReviewState, unpricedTurns: number, totalTurns: number): readonly Note[] {
  if (unpricedTurns === 0) return []
  const models = unpricedModelNames(review).join('、')
  if (unpricedTurns / totalTurns < UNPRICED_STALE_RATIO) {
    return [{ kind: 'stale', text: `単価不明のモデル（${models}）の ${unpricedTurns} ターンは推定に含まれません。pricing.ts に単価を足すと含まれます` }]
  }
  return [
    {
      kind: 'stale',
      text: `単価不明のターンが ${unpricedTurns} / ${totalTurns} 件あります（モデル: ${models}）。単価表が古い可能性があります（gateway・独自のモデル名のこともあります）。pricing.ts に単価を足すと推定に含まれます（取得日: ${PRICE_TABLE_FETCHED_AT}）`,
    },
  ]
}

const MS_PER_DAY = 86_400_000

/** 取得日から日数が経ちすぎた単価表への注記。現在時刻は呼び出し側から渡す（純粋関数を保つ）。取得日を読めなければ出さない。 */
function priceAgeNote(nowMs: number | undefined): readonly Note[] {
  const fetchedMs = Date.parse(PRICE_TABLE_FETCHED_AT)
  if (nowMs === undefined || Number.isNaN(fetchedMs)) return []
  const ageDays = Math.floor((nowMs - fetchedMs) / MS_PER_DAY)
  if (ageDays <= PRICE_TABLE_STALE_DAYS) return []
  return [{ kind: 'priceAge', text: `単価表の取得から ${ageDays} 日経っています（取得日: ${PRICE_TABLE_FETCHED_AT}）。価格表の改定がないか確認してください` }]
}

/** 切替の注記を出すのは、直近この件数のターンの中に切替があるときだけ（仮置き。ペインで見て決め直す）。 */
export const SWITCH_NOTE_RECENT_TURNS = 10

function switchNote(records: readonly TurnRecord[]): readonly Note[] {
  // 窓より前だけの記録で数えた切替を引く。窓の先頭の切替は、直前のターンを含めて数えられる。
  const earlier = records.slice(0, -SWITCH_NOTE_RECENT_TURNS)
  if (findSwitches(records).count <= findSwitches(earlier).count) return []
  return [
    {
      kind: 'switch',
      text: '切替の推定は、切替直後の最初の応答のキャッシュ書込から算出しています。長い中断によるキャッシュ切れとは区別できません。Bedrock・Vertex・gateway 経由では effort 変更でもキャッシュは維持されません',
    },
  ]
}

/** モデルが途中で替わったターンの事実だけを 1 行。原因（フォールバックなど）は断定しない。 */
function divergedNote(records: readonly TurnRecord[]): readonly Note[] {
  const count = records.filter(record => (record.divergedSteps ?? 0) > 0).length
  if (count === 0) return []
  return [
    {
      kind: 'diverged',
      text: `モデルがターン開始時のセッションのモデルと食い違った応答を含むターンが ${count} 件あります（フォールバックなどの可能性。推定で、原因は断定できません）。応答したモデルの内訳を取れたターンは、モデル × effort の表でモデルごとに分けて数えています`,
    },
  ]
}

/** plan mode のターンが過剰（モデル起因）の対象外になっていることの 1 行。 */
function planModeNote(records: readonly TurnRecord[]): readonly Note[] {
  const count = records.filter(record => record.planMode === true).length
  if (count === 0) return []
  return [
    {
      kind: 'planMode',
      text: `plan mode のターンが ${count} 件あります。モデル起因の過剰の判定では、計画のために選んだモデルとみなして対象外にしています（effort 起因の過剰は対象外にしていません）`,
    },
  ]
}

/** 状況に応じた注記（常に出す 1 行を除く）。記録がなければ空。順序は従来のまま（動的な警告と信頼度に分けるのは splitNotes）。 */
export function buildNotes(review: ReviewState, nowMs?: number): readonly Note[] {
  const records = review.turns
  if (records.length === 0) return []
  const unpricedTurns = estimateTotal(records).unpricedTurns + (review.archived?.unpricedTurns ?? 0)
  const totalTurns = records.length + (review.archived?.turns ?? 0)
  return [
    ...rebuildStreakNote(records),
    ...ttlNote(review),
    ...staleNote(review, unpricedTurns, totalTurns),
    ...priceAgeNote(nowMs),
    ...switchNote(records),
    ...divergedNote(records),
    ...planModeNote(records),
  ]
}
