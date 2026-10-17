// effort の表記。$ に触れない純粋関数。
// 型の effort は 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number。数値が届く条件は未検証で、
// 公式に対応表がないため、数値は high などに読み替えず「数値の effort」として別に残す（過剰・不足の判定の対象外）。
import type { TurnRecord } from '../types'

/** 数値の effort を記録するときの接頭辞（文字列の effort と衝突させない）。 */
const NUMERIC_PREFIX = 'n:'

/** step の effort を記録用の文字列にする。数値は `n:32000` の形で、文字列の effort とは別のグループになる。 */
export const effortToRecord = (effort: string | number | undefined): string | null =>
  effort === undefined ? null : typeof effort === 'number' ? `${NUMERIC_PREFIX}${effort}` : effort

export const isNumericEffort = (effort: string | null): boolean => effort !== null && effort.startsWith(NUMERIC_PREFIX)

/** 表示用の effort。数値は「数値 32000」と書き、文字列の effort と区別する。なければ '-'。 */
export const effortText = (effort: string | null): string =>
  effort === null ? '-' : isNumericEffort(effort) ? `数値 ${effort.slice(NUMERIC_PREFIX.length)}` : effort

/** 数値の effort のターンがあれば、判定に入れていないことを書いた 1 行。なければ null。 */
export function numericEffortNote(records: readonly TurnRecord[]): string | null {
  const count = records.filter(record => isNumericEffort(record.effort)).length
  return count === 0 ? null : `effort が数値のターン ${count} 件は、effort による過剰・不足の判定に入れていません（数値は high などに読み替えません）`
}
