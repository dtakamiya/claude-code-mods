// 結論の 1 行。ペイン（pane-model.ts）とテキストレポート（report.ts）が同じ関数から作る。
import type { Concern, ConcernKind } from './analyze'
import { CONCERN_TEXT, CONCLUSION_NONE_TEXT, CONCLUSION_NO_RECORDS_TEXT } from './labels'

export type Tone = 'success' | 'warning' | 'error' | 'suggestion' | 'plain'
export type Conclusion = { text: string; tone: Tone }

/** 状況に応じた警告（buildNotes）のバッジ。常に出す免責・判定基準（dim の注記）と見分ける。 */
export const ALERT_LABEL = '注意'
/** 結論行の先頭の印。指摘ありは ▲、なしは ✓（色だけに頼らない）。 */
const CONCLUSION_MARK_CONCERN = '▲'
const CONCLUSION_MARK_NONE = '✓'

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

/** 注意（buildNotes）が 1 件以上あるときだけ、結論行の末尾に件数を足す。 */
const alertSuffix = (alertCount: number): string => (alertCount === 0 ? '' : ` · ${ALERT_LABEL} ${alertCount} 件`)

export const NO_RECORDS_CONCLUSION: Conclusion = { text: `結論: ${CONCLUSION_NO_RECORDS_TEXT}`, tone: 'plain' }

/** 結論の 1 行。件数のある種類だけ、ConcernKind の短い名前で並べる。色は最も重い種類に合わせる。 */
export function conclusionOf(concerns: readonly Concern[], alertCount: number): Conclusion {
  const present = concerns.filter(concern => concern.count > 0)
  const total = present.reduce((sum, concern) => sum + concern.count, 0)
  if (total === 0) {
    return { text: `${CONCLUSION_MARK_NONE} 結論: ${CONCLUSION_NONE_TEXT}${alertSuffix(alertCount)}`, tone: 'success' }
  }
  const parts = present.map(concern => `${CONCERN_TEXT[concern.kind].label} ${concern.count}`).join(' / ')
  return {
    text: `${CONCLUSION_MARK_CONCERN} 結論: 見直し候補 ${total} 件（${parts}）${alertSuffix(alertCount)}`,
    tone: worstConcernTone(present),
  }
}
