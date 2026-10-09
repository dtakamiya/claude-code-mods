// 自己完結の契約（import 不可）。PaneViewSnapshot は hooks/analyze.ts の Snapshot と同形で、
// 形が変わったら両方を直し、PaneView.v を上げる。
export type PaneViewSnapshot = {
  percentage: number
  totalTokens: number
  maxTokens: number
  categories: readonly { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[]
  mcpTools: readonly { serverName: string; tokens: number; isLoaded: boolean }[]
  memoryFiles: readonly { path: string; type: string; tokens: number }[]
  skills?: { totalSkills: number; includedSkills: number; tokens: number }
  agents: readonly { tokens: number }[]
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number }
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
}

/** ペインが読む値。幅に依存しないデータ（Snapshot と測定時刻）だけを持つ。`v` は形の版。 */
export type PaneView = {
  v: 1
  status: 'empty' | 'ok'
  snapshot?: PaneViewSnapshot
  measuredAtMs?: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-doctor': { view: PaneView }
  }
}
