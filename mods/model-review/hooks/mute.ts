// 利用者が意図して選んだ設定の指摘を、種類ごとに止める（設定 mutedConcerns）。$ に触れない純粋関数。
// 止めた種類は結論行と指摘の節から外し、「止めている指摘」の 1 行だけを残す（何も見えなくはしない）。
import { isRecentConcern, type Concern, type ConcernKind } from './analyze'
import { CONCERN_TEXT } from './labels'
import { countText } from './summary'

const KINDS = Object.keys(CONCERN_TEXT) as ConcernKind[]

/** 設定に書ける名前（ConcernKind の英名と、画面の短い名前）から種類へ。 */
const KIND_BY_NAME: ReadonlyMap<string, ConcernKind> = new Map(
  KINDS.flatMap(kind => [[kind, kind] as const, [CONCERN_TEXT[kind].label, kind] as const]),
)

/** 名前の区切り: カンマ（半角・全角）・読点・空白。 */
const NAME_SEPARATOR = /[,，、\s]+/

/** 全角英字・半角カナも同じ名前として読む（NFKC）。大文字小文字は無視する。 */
const normalizeName = (name: string): string => name.normalize('NFKC').trim().toLowerCase()

/** 設定 mutedConcerns を読む。文字列以外・空・知らない名前は無視する。 */
export function readMutedConcerns(options: Readonly<Record<string, unknown>>): ReadonlySet<ConcernKind> {
  const value = options.mutedConcerns
  if (typeof value !== 'string') return new Set()
  return new Set(value.split(NAME_SEPARATOR).flatMap(name => KIND_BY_NAME.get(normalizeName(name)) ?? []))
}

/** 止めた種類とそれ以外に分ける（順序は保つ）。 */
export function splitMuted(
  concerns: readonly Concern[],
  muted: ReadonlySet<ConcernKind>,
): { readonly shown: readonly Concern[]; readonly hidden: readonly Concern[] } {
  return {
    shown: concerns.filter(concern => !muted.has(concern.kind)),
    hidden: concerns.filter(concern => muted.has(concern.kind)),
  }
}

/** 止めている種類 1 つ分。該当があれば件数（指摘の節と同じ表記）を添え、窓より前にだけ該当したものは「過去」と書く。 */
function mutedPart(kind: ConcernKind, hit: Concern | undefined): string {
  const label = CONCERN_TEXT[kind].label
  if (hit === undefined) return label
  return `${label} ${countText(hit)}${isRecentConcern(hit) ? '' : '（過去）'}`
}

/** 指摘の節に残す 1 行。止めている種類を画面の順（CONCERN_TEXT の順）に並べる。何も止めていなければ null。 */
export function mutedLineText(muted: ReadonlySet<ConcernKind>, hidden: readonly Concern[]): string | null {
  if (muted.size === 0) return null
  const parts = KINDS.filter(kind => muted.has(kind)).map(kind => mutedPart(kind, hidden.find(concern => concern.kind === kind)))
  return `止めている指摘（設定 mutedConcerns）: ${parts.join(' / ')}`
}

/** ペインとテキストレポートが同じ扱いにするための入口。表示する指摘と、止めている 1 行を返す。 */
export function applyMute(
  concerns: readonly Concern[],
  muted: ReadonlySet<ConcernKind>,
): { readonly concerns: readonly Concern[]; readonly mutedLine: string | null } {
  const { shown, hidden } = splitMuted(concerns, muted)
  return { concerns: shown, mutedLine: mutedLineText(muted, hidden) }
}
