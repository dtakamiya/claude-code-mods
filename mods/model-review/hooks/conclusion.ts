// 結論の 1 行。ペイン（pane-model.ts）とテキストレポート（report.ts）が同じ関数から作る。
import { partitionByRecency, type Concern, type ConcernKind } from './analyze'
import { CONCERN_TEXT, CONCLUSION_NONE_TEXT, CONCLUSION_NO_RECORDS_TEXT, PAST_CONCERNS_LABEL } from './labels'
import { raisesStatus, type Note } from './notes'

export type Tone = 'success' | 'warning' | 'error' | 'suggestion' | 'plain'
export type Conclusion = { text: string; tone: Tone }

/** 状況に応じた警告（buildNotes）のバッジ。常に出す免責・判定基準（dim の注記）と見分ける。 */
export const ALERT_LABEL = '注意'
/** 結論行の状態。印と語で重さが分かる（色だけに頼らない）。 */
type Status = { readonly mark: string; readonly word: string; readonly tone: Tone }
const STATUS = {
  critical: { mark: '✖', word: '要対応', tone: 'error' },
  review: { mark: '▲', word: '要確認', tone: 'warning' },
  info: { mark: '△', word: '参考', tone: 'suggestion' },
  unknown: { mark: '？', word: '判定不能', tone: 'plain' },
  ok: { mark: '✓', word: '問題なし', tone: 'success' },
} as const satisfies Record<string, Status>

export const CONCERN_TONE: Readonly<Record<ConcernKind, Tone>> = {
  overspec: 'warning',
  underspec: 'error',
  delegation: 'suggestion',
  subagent: 'warning',
  switch: 'warning',
}
/** 指摘の色の優先順。最も重い種類の色を結論行に使う。 */
const CONCERN_SEVERITY: readonly Tone[] = ['error', 'warning', 'suggestion']

/** 件数のある指摘のうち最も重い種類の色。件数がなければ色なし。 */
function worstConcernTone(present: readonly Concern[]): Tone {
  const tones = new Set(present.map(concern => CONCERN_TONE[concern.kind]))
  return CONCERN_SEVERITY.find(tone => tones.has(tone)) ?? 'plain'
}

/** 注意（buildNotes のうち動的な警告）が 1 件以上あるときだけ、結論行の末尾に件数を足す。 */
const alertSuffix = (alertCount: number): string => (alertCount === 0 ? '' : ` · ${ALERT_LABEL} ${alertCount} 件`)

export const NO_RECORDS_CONCLUSION: Conclusion = { text: `結論: ${CONCLUSION_NO_RECORDS_TEXT}`, tone: 'plain' }

/** 直近の窓より前にだけ該当した指摘があれば、その種類数を添える。 */
const pastText = (pastKinds: number): string => (pastKinds === 0 ? '' : `${PAST_CONCERNS_LABEL} ${pastKinds} 種`)

/** 単価が分かったターンの割合。全ターン不明なら判定できない。 */
export type PriceCoverage = { readonly unpricedTurns: number; readonly totalTurns: number }
const FULL_COVERAGE: PriceCoverage = { unpricedTurns: 0, totalTurns: 0 }

const isAllUnpriced = ({ unpricedTurns, totalTurns }: PriceCoverage): boolean => totalTurns > 0 && unpricedTurns === totalTurns
/** 一部のターンだけ単価不明のときの添え書き。全部不明のときは理由そのものになるので添えない。 */
const partialUnpricedText = ({ unpricedTurns, totalTurns }: PriceCoverage): string =>
  unpricedTurns > 0 && unpricedTurns < totalTurns ? ` · 単価不明 ${unpricedTurns}/${totalTurns} ターン` : ''

/** 件数のある指摘のうち最も重い種類の状態。指摘がなければ null。 */
function concernStatus(present: readonly Concern[]): Status | null {
  const tone = worstConcernTone(present)
  if (tone === 'error') return STATUS.critical
  if (tone === 'warning') return STATUS.review
  return tone === 'suggestion' ? STATUS.info : null
}

/**
 * 状態は重い順に 要対応（不足）> 要確認（過剰・サブ・切替の指摘、または再構築の連続・TTL 乖離）>
 * 判定不能（全ターン単価不明）> 参考（委譲だけ）> 問題なし。
 * 問題なしは「判定でき、かつ指摘も動的な警告もない」ときだけ。
 */
function statusOf(present: readonly Concern[], alerts: readonly Note[], coverage: PriceCoverage): Status {
  const byConcern = concernStatus(present)
  if (byConcern === STATUS.critical) return STATUS.critical
  if (byConcern === STATUS.review || alerts.some(raisesStatus)) return STATUS.review
  if (isAllUnpriced(coverage)) return STATUS.unknown
  return byConcern ?? STATUS.ok
}

/**
 * 結論の 1 行。▲ と件数・色は、直近の窓（isRecentConcern）に該当がある種類だけで決める。
 * 窓より前にだけ該当した種類は「過去の指摘 N 種」として数だけ添え、それだけなら問題なしにする。
 * `alerts` は動的な警告（再構築の連続・TTL 乖離・切替）。再構築と TTL は状態を上げ、切替は件数にだけ数える。
 * 単価の古さなどの信頼度は状態に入れない（ペインでは末尾の注記）。
 */
export function conclusionOf(concerns: readonly Concern[], alerts: readonly Note[], coverage: PriceCoverage = FULL_COVERAGE): Conclusion {
  const split = partitionByRecency(concerns.filter(concern => concern.count > 0))
  const recent = split.recent
  const status = statusOf(recent, alerts, coverage)
  const past = pastText(split.past.length)
  const total = recent.reduce((sum, concern) => sum + concern.count, 0)
  const lead = `${status.mark} ${status.word} · 結論: `
  const unpriced = partialUnpricedText(coverage)
  const pastPart = past === '' ? '' : ` · ${past}`
  if (total > 0) {
    const parts = recent.map(concern => `${CONCERN_TEXT[concern.kind].label} ${concern.count}`).join(' / ')
    return { text: `${lead}見直し候補 ${total} 件（${parts}）${pastPart}${unpriced}${alertSuffix(alerts.length)}`, tone: status.tone }
  }
  const raising = alerts.filter(raisesStatus)
  const [first] = raising
  if (first !== undefined) {
    const others = alerts.length - 1
    return { text: `${lead}${first.brief ?? first.text}${others > 0 ? ` · ほか ${others} 件` : ''}${pastPart}${unpriced}`, tone: status.tone }
  }
  if (status === STATUS.unknown) {
    return { text: `${lead}全 ${coverage.totalTurns} ターンが単価不明${pastPart}${alertSuffix(alerts.length)}`, tone: status.tone }
  }
  const pastNone = past === '' ? '' : `（${past}）`
  return { text: `${lead}${CONCLUSION_NONE_TEXT}${pastNone}${unpriced}${alertSuffix(alerts.length)}`, tone: status.tone }
}
