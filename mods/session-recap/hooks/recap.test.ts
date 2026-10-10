import { test, expect } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { MESSAGE_LIMIT, render, summarize } from './recap'

// 架空データのみ。
const messages = [
  { toolUses: [{ tool: 'Read' }, { tool: 'Bash', isError: true as const }] },
  { toolUses: [] },
  { toolUses: [{ tool: 'Read' }, { tool: 'Read' }, { tool: 'Bash' }] },
]

test('ツール別に回数とエラー件数を集計し、回数の多い順に並べる', () => {
  const r = summarize(messages)
  expect(r.tools).toEqual([
    { tool: 'Read', calls: 3, errors: 0 },
    { tool: 'Bash', calls: 2, errors: 1 },
  ])
  expect(r.totalCalls).toBe(5)
  expect(r.totalErrors).toBe(1)
  expect(r.messageCount).toBe(3)
})

test('同数のときは tool 名の昇順', () => {
  const r = summarize([{ toolUses: [{ tool: 'b' }, { tool: 'a' }] }])
  expect(r.tools.map(t => t.tool)).toEqual(['a', 'b'])
})

test('メッセージが空でも落ちず、呼び出しなしを表示する', () => {
  const text = render(summarize([]))
  expect(text).toContain('ツール呼び出しはまだありません')
})

test('出力に件数上限の注記があり、原因を断定する文言がない', () => {
  const text = render(summarize(messages))
  expect(text).toContain(`最大 ${MESSAGE_LIMIT} 件`)
  expect(text).toContain('観察のみ')
  expect(text).not.toMatch(/が原因|のせい|失敗しました/)
})

test('入力値や結果本文は出力に現れない', () => {
  const secret = 'SECRET-COMMAND-xyz'
  const withInput = [{ toolUses: [{ tool: 'Bash', input: { command: secret }, text: secret }] }]
  expect(render(summarize(withInput))).not.toContain(secret)
})

test('/recap は tool 名の集計を text で返す', async ($, on) => {
  on('session.messages', () => ({ value: messages as unknown as SessionMessage[] }))
  const ran = await $.command.run({
    command: 'recap',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(ran.text).toBe(render(summarize(messages)))
})
