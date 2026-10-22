import { test, expect } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { render, summarize } from './recap'

// 架空データのみ。
const messages = [
  { toolUses: [{ tool: 'Read' }, { tool: 'Bash', isError: true as const }] },
  { toolUses: [] },
  { toolUses: [{ tool: 'Read' }, { tool: 'Read' }, { tool: 'Bash' }] },
]

const FAILED_TEXT = 'ツール利用の振り返りを作れませんでした（セッションの読み取りに失敗）。'

const runOf = (command: string) => ({
  command,
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

test('session.start で tool-recap が登録され、旧名 recap は登録されない', async ($, on) => {
  const registered: string[] = []
  on('session.start', () => ({ cwd: '/sandbox' }))
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: {} as never }
  })

  await $.session.start({} as never)

  expect(registered).toEqual(['tool-recap'])
})

test('tool-recap は集計結果を text で返す', async ($, on) => {
  on('session.messages', () => ({ value: messages as unknown as SessionMessage[] }))

  const ran = await $.command.run(runOf('tool-recap'))

  expect(ran.text).toBe(render(summarize(messages)))
})

test('集計が失敗しても固定文言を返し、例外の中身は出さない', async ($, on) => {
  on('session.messages', () => {
    throw new Error('SECRET-leak-xyz')
  })

  const ran = await $.command.run(runOf('tool-recap'))

  expect(ran.text).toBe(FAILED_TEXT)
  expect(ran.text).not.toContain('SECRET-leak-xyz')
})
