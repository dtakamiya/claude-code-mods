import { test, expect } from 'claude-code/testing'

// 架空データのみ。
const rows = (n: number) => [
  { role: 'user' as const, text: 'q', toolUses: [] },
  { role: 'assistant' as const, text: '', toolUses: Array.from({ length: n }, () => ({ tool_use_id: 'u', tool: 'Read', input: { path: 'a.txt' } })) },
]
const completion = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }

test('turn.complete で反復があればトーストが 1 回出る', async ($, on) => {
  const toasts: string[] = []
  on('session.messages', async () => ({ value: rows(3) }))
  on('turn.complete', async () => ({ text: '' }))
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.turn.complete(completion)
  expect(toasts).toEqual(['同じ呼び出しの反復: Read ×3'])
})

test('サブエージェントのターンではトーストが出ない', async ($, on) => {
  const toasts: string[] = []
  on('session.messages', async () => ({ value: rows(3) }))
  on('turn.complete', async () => ({ text: '' }))
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.turn.complete({ ...completion, agentId: 'agent-1' })
  expect(toasts).toEqual([])
})
