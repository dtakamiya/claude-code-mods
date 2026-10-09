import { test, expect } from 'claude-code/testing'

import { analyze } from './analyze'

const base = { percentage: 10, totalTokens: 1000, maxTokens: 10000, categories: [], mcpTools: [], memoryFiles: [] }

test('所見なし: 余裕があり内訳も小さいとき', () => {
  expect(analyze(base)).toEqual([])
})

test('high: 使用率が80%以上のとき', () => {
  expect(analyze({ ...base, percentage: 85 })[0]?.level).toBe('high')
})

test('mid: MCP ツール定義が窓の10%以上のとき', () => {
  expect(analyze({ ...base, mcpTools: [{ tokens: 1500 }] })[0]?.issue).toContain('MCP')
})
