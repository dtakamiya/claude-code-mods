import { test, expect } from 'claude-code/testing'

import { displayWidth, padEndWidth, padStartWidth, truncateWidth } from './pane-text'

test('全角は 2 桁、半角は 1 桁で数える', () => {
  expect(displayWidth('メモリ')).toBe(6)
  expect(displayWidth('MCP ツール')).toBe(10)
})

test('padEndWidth は表示幅でそろえる', () => {
  expect(displayWidth(padEndWidth('空き', 18))).toBe(18)
  expect(displayWidth(padEndWidth('システムプロンプト', 18))).toBe(18)
})

test('幅を超える名前は … で切る', () => {
  const out = truncateWidth('とても長いカテゴリ名称です', 10)
  expect(displayWidth(out)).toBeLessThanOrEqual(10)
  expect(out.endsWith('…')).toBe(true)
})

test('padStartWidth は右寄せ', () => {
  expect(padStartWidth('9%', 4)).toBe('  9%')
})
