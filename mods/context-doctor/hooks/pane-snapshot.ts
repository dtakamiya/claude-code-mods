// 純粋関数: 内訳 → Snapshot の組立と、$.state へ書く前の整形。`$` に触れない。
import type { SessionContextBreakdown } from 'claude-code'

import type { Snapshot } from './analyze'
import type { PaneView } from '../types'

/** Snapshot の組立に使う内訳の項目。 */
export type BreakdownSource = Pick<
  SessionContextBreakdown,
  | 'percentage'
  | 'totalTokens'
  | 'maxTokens'
  | 'categories'
  | 'mcpTools'
  | 'memoryFiles'
  | 'skills'
  | 'agents'
  | 'slashCommands'
  | 'autoCompactThreshold'
  | 'isAutoCompactEnabled'
>

/** register.ts が従来インラインで行っていた組立。値は加工せずそのまま渡す（挙動不変）。 */
export function buildSnapshot(b: BreakdownSource): Snapshot {
  return {
    percentage: b.percentage,
    totalTokens: b.totalTokens,
    maxTokens: b.maxTokens,
    categories: b.categories,
    mcpTools: b.mcpTools,
    memoryFiles: b.memoryFiles,
    skills: b.skills,
    agents: b.agents,
    slashCommands: b.slashCommands,
    autoCompactThreshold: b.autoCompactThreshold,
    isAutoCompactEnabled: b.isAutoCompactEnabled,
  }
}

/** `undefined` のキーを再帰的に落とした新しい値を返す（$.state は undefined を受け付けない）。入力は変更しない。 */
export function dropUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropUndefined) as T
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, dropUndefined(v)] as const)
  return Object.fromEntries(entries) as T
}

/** atom に書く値。書込前に undefined キーを落とす。 */
export function buildPaneView(snapshot: Snapshot, measuredAtMs: number): PaneView {
  return dropUndefined({ v: 1, status: 'ok', snapshot, measuredAtMs })
}
