import { test, expect } from 'claude-code/testing'

import type { Snapshot } from './analyze'
import { buildBarRuns, stageOf, type BarRun } from './pane-bar'

// 架空データのみ。窓 200,000・圧縮点 167,000。
const base: Snapshot = {
  percentage: 75,
  totalTokens: 150_000,
  maxTokens: 200_000,
  categories: [],
  mcpTools: [],
  memoryFiles: [],
  agents: [],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 167_000,
}
const render = (runs: readonly BarRun[]) =>
  runs.map(r => ({ used: '█', margin: '▒', compact: '┃', buffer: '░', free: '░' })[r.kind].repeat(r.count)).join('')

test('段階: 残りが窓の 15% 超なら余裕、15% 以下で注意、5% 以下で危険、0 以下で超過（境界は以下）', () => {
  const at = (totalTokens: number) => stageOf({ ...base, totalTokens })
  expect(at(90_000)).toBe('ok') // 残り 77,000
  expect(at(136_999)).toBe('ok') // 残り 30,001（15% を超える）
  expect(at(137_000)).toBe('warn') // 残り 30,000 = ちょうど 15%
  expect(at(157_000)).toBe('danger') // 残り 10,000 = ちょうど 5%
  expect(at(156_999)).toBe('warn')
  expect(at(167_000)).toBe('over')
  expect(at(176_000)).toBe('over')
})

test('段階: 自動圧縮が無効なら使用率 60% で注意、80% で危険', () => {
  const off = { ...base, isAutoCompactEnabled: false }
  expect(stageOf({ ...off, percentage: 59 })).toBe('ok')
  expect(stageOf({ ...off, percentage: 60 })).toBe('warn')
  expect(stageOf({ ...off, percentage: 79 })).toBe('warn')
  expect(stageOf({ ...off, percentage: 80 })).toBe('danger')
})

test('段階: autoCompactThreshold が無いときも使用率で判定', () => {
  expect(stageOf({ ...base, autoCompactThreshold: undefined, percentage: 85 })).toBe('danger')
})

test('バー: 使用・余裕・圧縮点・バッファの順で幅ちょうどに並ぶ', () => {
  const bar = render(buildBarRuns(base, 40))
  expect([...bar]).toHaveLength(40)
  expect(bar).toBe('█'.repeat(30) + '▒'.repeat(3) + '┃' + '░'.repeat(6))
})

test('バー: 超過時は使用が圧縮点を越え、圧縮点は残る', () => {
  const bar = render(buildBarRuns({ ...base, totalTokens: 176_000, percentage: 88 }, 40))
  expect([...bar]).toHaveLength(40)
  expect(bar).toContain('┃')
  expect(bar.indexOf('┃')).toBeLessThan(bar.lastIndexOf('█'))
})

test('バー: 圧縮点は 1〜W-1 に丸める', () => {
  const edge = (autoCompactThreshold: number) => render(buildBarRuns({ ...base, totalTokens: 0, autoCompactThreshold }, 10))
  expect(edge(100).indexOf('┃')).toBe(1)
  expect(edge(199_999).indexOf('┃')).toBe(9)
})

test('バー: 自動圧縮が無効なら ┃ と ▒ を描かない', () => {
  const bar = render(buildBarRuns({ ...base, isAutoCompactEnabled: false }, 40))
  expect(bar).toBe('█'.repeat(30) + '░'.repeat(10))
})

test('バー: maxTokens=0 や使用超過でも幅は崩れない', () => {
  expect([...render(buildBarRuns({ ...base, maxTokens: 0 }, 20))]).toHaveLength(20)
  expect([...render(buildBarRuns({ ...base, isAutoCompactEnabled: false, totalTokens: 500_000 }, 20))]).toHaveLength(20)
})
