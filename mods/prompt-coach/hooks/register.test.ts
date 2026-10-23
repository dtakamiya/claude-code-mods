import { test, expect } from 'claude-code/testing'

import { COACH_OFF_TEXT, COACH_ON_TEXT, NOTICE_PREFIX, RULE_MESSAGES } from './analyze'

// 架空データのみ。
const composer = { kind: 'composer' as const }
const submitOf = (text: string) => ({ text, origin: composer, wait: false })
const completion = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }
const runOf = (command: string, args: string) => ({
  command,
  args,
  origin: composer,
  presentation: { isFullscreen: false, columns: 80 },
})
const NOTICE_NO_SCOPE = `${NOTICE_PREFIX}${RULE_MESSAGES['no-scope']}`
const NOTICE_VAGUE = `${NOTICE_PREFIX}${RULE_MESSAGES['vague-target']}`

test('prompt.submit は本文と起源を変えずに次の hook へ渡す', async ($, on) => {
  const received: unknown[] = []
  on('prompt.submit', (_$, e) => {
    received.push(e)
    return { text: e.text }
  })
  const input = submitOf('リファクタして')

  const result = await $.prompt.submit(input)

  expect(received).toEqual([input])
  expect(result).toEqual({ text: 'リファクタして' })
})

test('当たった送信では ui.status に 1 行を出し、turn.complete で消す', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.prompt.submit(submitOf('リファクタして'))
  await $.turn.complete(completion)

  expect(statuses).toEqual([NOTICE_NO_SCOPE, undefined])
})

test('当たらない送信では ui.status を出さない', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  await $.prompt.submit(submitOf('はい'))

  expect(statuses).toEqual([])
})

test('サブエージェントの turn.complete では表示を消さない', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.prompt.submit(submitOf('リファクタして'))
  await $.turn.complete({ ...completion, agentId: 'agent-1' })

  expect(statuses).toEqual([NOTICE_NO_SCOPE])
})

test('session.start で tool 名ではなく coach が登録される', async ($, on) => {
  const registered: string[] = []
  on('session.start', () => ({ cwd: '/sandbox' }))
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: {} as never }
  })

  await $.session.start({} as never)

  expect(registered).toEqual(['coach'])
})

test('/coach off の間は指南を出さず、on で再開する', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('command.run', { command: 'coach' }, () => ({ text: '' }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  const off = await $.command.run(runOf('coach', 'off'))
  await $.prompt.submit(submitOf('リファクタして'))
  const resumed = await $.command.run(runOf('coach', 'on'))
  await $.prompt.submit(submitOf('リファクタして'))

  expect(off.text).toBe(COACH_OFF_TEXT)
  expect(resumed.text).toBe(COACH_ON_TEXT)
  expect(statuses).toEqual([NOTICE_NO_SCOPE])
})

test('session.start で頻度の状態が戻り、同じ 1 通目の指南が再び出る', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('session.start', () => ({ cwd: '/sandbox' }))
  on('command.register', () => ({ value: {} as never }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  await $.prompt.submit(submitOf('これ直して'))
  await $.session.start({} as never)
  await $.prompt.submit(submitOf('これ直して'))

  expect(statuses).toEqual([NOTICE_VAGUE, NOTICE_VAGUE])
})

test('判定が失敗しても本文を出さず固定文言だけログに残し、送信は通す', async ($, on) => {
  // Arrange: origin が無い入力は判定中に例外になる。本文の目印はログに出てはいけない。
  const marker = 'SECRET-MARKER-0000'
  const logs: string[] = []
  const received: unknown[] = []
  on('prompt.submit', (_$, e) => {
    received.push(e)
    return { text: e.text }
  })
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })

  // Act
  await $.prompt.submit({ text: `これ ${marker}`, wait: false, origin: undefined as never })

  // Assert
  expect(received.length).toBe(1)
  expect(logs.some(line => line.startsWith('prompt-coach:'))).toBe(true)
  expect(logs.some(line => line.includes(marker))).toBe(false)
})

test('モデル・ファイル書込・通信・プロセス実行の API を一度も呼ばない', async ($, on) => {
  // Arrange: 呼ばれたら記録して失敗させる bottom hook を並べる。
  const attempted: string[] = []
  on('session.start', () => ({ cwd: '/sandbox' }))
  on('command.register', () => ({ value: {} as never }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('command.run', { command: 'coach' }, () => ({ text: '' }))
  on('model.complete', () => {
    attempted.push('model.complete')
    throw new Error('model.complete は呼ばない')
  })
  on('model.classify', () => {
    attempted.push('model.classify')
    throw new Error('model.classify は呼ばない')
  })
  on('model.fork', () => {
    attempted.push('model.fork')
    throw new Error('model.fork は呼ばない')
  })
  on('fs.write', () => {
    attempted.push('fs.write')
    throw new Error('fs.write は呼ばない')
  })
  on('http.fetch', () => {
    attempted.push('http.fetch')
    throw new Error('http.fetch は呼ばない')
  })
  on('process.run', () => {
    attempted.push('process.run')
    throw new Error('process.run は呼ばない')
  })
  // process.spawn はストリーミングのイベントなので、非同期ジェネレータの形で置く。
  on('process.spawn', async function* () {
    attempted.push('process.spawn')
    throw new Error('process.spawn は呼ばない')
  })

  // Act: 起動から停止・再開・判定・ターン終了まで一通り通す。
  await $.session.start({} as never)
  await $.prompt.submit(submitOf('リファクタして'))
  await $.turn.complete(completion)
  await $.command.run(runOf('coach', 'off'))
  await $.command.run(runOf('coach', 'on'))

  // Assert
  expect(attempted).toEqual([])
})
