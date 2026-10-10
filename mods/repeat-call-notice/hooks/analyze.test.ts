import { test, expect } from 'claude-code/testing'

import { findRepeats, formatNotice } from './analyze'

// 架空データのみ。N=3。
type Use = { tool: string; input: Record<string, unknown> }
const use = (tool: string, input: Record<string, unknown> = { path: 'a.txt' }): Use => ({ tool, input })
const asst = (...toolUses: Use[]) => ({ role: 'assistant' as const, toolUses })
const prompt = () => ({ role: 'user' as const, toolUses: [] as Use[] })
const toolResult = () => ({
  role: 'user' as const,
  toolUses: [] as Use[],
  toolResults: [{ tool_use_id: 'x', text: '', isError: false }],
})
const times = (n: number, u: Use) => Array.from({ length: n }, () => u)

test('同一 tool・同一 input が N 回ちょうどで報告される', () => {
  expect(findRepeats([prompt(), asst(...times(3, use('Read')))], 3)).toEqual([{ tool: 'Read', count: 3 }])
})

test('N-1 回では報告されない', () => {
  expect(findRepeats([prompt(), asst(...times(2, use('Read')))], 3)).toEqual([])
})

test('4 回・5 回は実際の回数で報告される', () => {
  expect(findRepeats([prompt(), asst(...times(4, use('Read')))], 3)[0].count).toBe(4)
  expect(findRepeats([prompt(), asst(...times(5, use('Read')))], 3)[0].count).toBe(5)
})

test('input が 1 キーだけ違う呼び出しは組にならない', () => {
  const calls = [use('Read', { path: 'a.txt' }), use('Read', { path: 'b.txt' }), use('Read', { path: 'c.txt' })]
  expect(findRepeats([prompt(), asst(...calls)], 3)).toEqual([])
})

test('同一 input でも tool が違えば組にならない', () => {
  const calls = [use('Read'), use('Write'), use('Edit')]
  expect(findRepeats([prompt(), asst(...calls)], 3)).toEqual([])
})

test('メッセージが空、または toolUses の無い assistant のみなら空', () => {
  expect(findRepeats([], 3)).toEqual([])
  expect(findRepeats([asst()], 3)).toEqual([])
})

test('複数組は回数降順・同数は初出順で全て返す', () => {
  const messages = [
    prompt(),
    asst(
      ...times(3, use('Read', { path: 'a.txt' })),
      ...times(4, use('Bash', { command: 'ls' })),
      ...times(3, use('Read', { path: 'b.txt' })),
    ),
  ]
  expect(findRepeats(messages, 3)).toEqual([
    { tool: 'Bash', count: 4 },
    { tool: 'Read', count: 3 },
    { tool: 'Read', count: 3 },
  ])
})

test('キー順だけ違う入れ子 input は同一の組として数える', () => {
  const calls = [
    use('Edit', { a: 1, b: { x: 1, y: [1, { p: 1, q: 2 }] } }),
    use('Edit', { b: { y: [1, { q: 2, p: 1 }], x: 1 }, a: 1 }),
    use('Edit', { a: 1, b: { x: 1, y: [1, { p: 1, q: 2 }] } }),
  ]
  expect(findRepeats([prompt(), asst(...calls)], 3)).toEqual([{ tool: 'Edit', count: 3 }])
})

test('最後のプロンプトより前の反復は数えない', () => {
  const messages = [prompt(), asst(...times(3, use('Read'))), prompt(), asst(use('Read'))]
  expect(findRepeats(messages, 3)).toEqual([])
})

test('toolResults を持つ user メッセージではターンが分割されない', () => {
  const messages = [prompt(), asst(use('Read')), toolResult(), asst(use('Read')), toolResult(), asst(use('Read'))]
  expect(findRepeats(messages, 3)).toEqual([{ tool: 'Read', count: 3 }])
})

test('循環参照の input は例外を投げず、他と一致しない 1 件として数える', () => {
  const circular: Record<string, unknown> = { path: 'a.txt' }
  circular.self = circular
  const calls = [use('Read', circular), use('Read', circular), use('Read', circular)]
  expect(findRepeats([prompt(), asst(...calls)], 3)).toEqual([])
})

test('input の目印文字列が戻り値にも通知文にも含まれない', () => {
  const marker = 'SECRET-MARKER-0000'
  const calls = times(3, use('Bash', { command: marker }))
  const repeats = findRepeats([prompt(), asst(...calls)], 3)
  expect(repeats.length).toBe(1)
  expect(JSON.stringify(repeats)).not.toContain(marker)
  expect(formatNotice(repeats)).not.toContain(marker)
})

test('4 組以上は 3 組と「ほか k 組」、同 tool 2 組は別々に並ぶ', () => {
  const repeats = [
    { tool: 'Read', count: 5 },
    { tool: 'Read', count: 4 },
    { tool: 'Bash', count: 3 },
    { tool: 'Grep', count: 3 },
    { tool: 'Glob', count: 3 },
  ]
  expect(formatNotice(repeats)).toBe('同じ呼び出しの反復: Read ×5、Read ×4、Bash ×3、ほか 2 組')
})
