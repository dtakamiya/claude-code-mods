import { test, expect } from 'claude-code/testing'

// 架空値のみ。
const completion = { answer: '', durationMs: 45000, isAborted: false, turnId: 't1', reason: 'answer' as const }

const setup = ($: unknown, on: any) => {
  const toasts: string[] = []
  let nextCalls = 0
  on('turn.complete', async () => {
    nextCalls += 1
    return { text: '' }
  })
  on('ui.toast', async (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { toasts, nextCount: () => nextCalls }
}

test('閾値以上のターンでトーストが 1 回出て next も呼ばれる', async ($, on) => {
  const s = setup($, on)
  await $.turn.complete(completion)
  expect(s.toasts).toEqual(['ターン完了（45秒）'])
  expect(s.nextCount()).toBe(1)
})

test('閾値未満ではトーストが出ないが next は呼ばれる', async ($, on) => {
  const s = setup($, on)
  await $.turn.complete({ ...completion, durationMs: 1000 })
  expect(s.toasts).toEqual([])
  expect(s.nextCount()).toBe(1)
})

test('中断・サブエージェントではトーストが出ないが next は呼ばれる', async ($, on) => {
  const s = setup($, on)
  await $.turn.complete({ ...completion, isAborted: true })
  await $.turn.complete({ ...completion, agentId: 'agent-1' })
  expect(s.toasts).toEqual([])
  expect(s.nextCount()).toBe(2)
})
