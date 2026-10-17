import { test, expect } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// 架空データのみ。Sonnet 5.5 の 1 応答（入力 1,000,000 / 出力 100,000）は $2 + $1 = $3。
const SONNET_USAGE = {
  model: 'claude-sonnet-5-5',
  input_tokens: 1_000_000,
  output_tokens: 100_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}
const SESSION_CWD = '/tmp/model-review-test'
const SESSION_START = { source: 'startup', cwd: SESSION_CWD } as never
const COMMAND_RUN = {
  command: 'model-review',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as never
const PANE_PROPS = {
  title: 'モデル振り返り',
  isFocused: false,
  bodyColumns: 60,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

/**
 * 本体の hook の下で答える engine の既定値。`usd` は呼ばれた時点の累計コスト（テストが書き換える）。
 * undefined を返すと cost を載せない（起動時に取れない環境）。
 */
function answerEngine(on: On, usd: () => number | undefined, isPlaced: boolean) {
  on('session.start', () => ({ cwd: SESSION_CWD }))
  on('command.register', () => ({ value: {} as never }))
  on('session.usage', () => {
    const current = usd()
    return { value: { cost: current === undefined ? undefined : { usd: current } } as unknown as SessionUsage }
  })
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as never)
}

// 一つのメインループのターンを、開始 → ツール → 終了の順に流す。
const runMainTurn = async ($: Engine) => {
  await $.turn.start({ text: '', turnId: 'turn-1' } as never)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'use-1', file_path: '/x', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete({
    answer: '',
    durationMs: 1_500,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
    usage: SONNET_USAGE,
  } as never)
}

test('記録がない間の /model-review はペインが開けなければ案内の 1 行を返す', async ($, on) => {
  // Arrange
  answerEngine(on, () => 0, false)
  await $.session.start(SESSION_START)

  // Act
  const ran = await $.command.run(COMMAND_RUN)

  // Assert
  expect(ran.text).toContain('記録されたターンはまだありません')
})

test('ターンの終了後、/model-review は対象ターン数と推定コストを返す', async ($, on) => {
  // Arrange
  answerEngine(on, () => 10, false)
  await $.session.start(SESSION_START)
  await runMainTurn($)

  // Act
  const ran = await $.command.run(COMMAND_RUN)

  // Assert
  expect(ran.text).toContain('対象: 1 ターン')
  expect(ran.text).toContain('claude-sonnet-5-5  effort -')
  expect(ran.text).toContain('推定 $3.0000')
})

test('基準点から現在までの実コストと、推定との差を表示する', async ($, on) => {
  // Arrange: 読み込み時の累計 10、ターン後の累計 13。実コスト 3 と推定 3 の差は 0。
  let usd = 10
  answerEngine(on, () => usd, false)
  await $.session.start(SESSION_START)
  await runMainTurn($)
  usd = 13

  // Act
  const ran = await $.command.run(COMMAND_RUN)

  // Assert
  expect(ran.text).toContain('セッション実コスト（読み込み後）: $3.0000')
  expect(ran.text).toContain('差（実コスト − 推定）: $0.0000')
})

test('Pane は先頭の結論行を terminal と desktop の両方で描く', async ($, on) => {
  // Arrange
  answerEngine(on, () => 10, true)
  await $.session.start(SESSION_START)
  await runMainTurn($)
  await $.command.run(COMMAND_RUN)

  for (const surface of ['terminal', 'desktop'] as const) {
    // Act
    const ui = await $.ui.mount({
      plugin: 'model-review',
      surface,
      component: 'Pane',
      requestId: 'model-review',
      props: PANE_PROPS,
    } as never)

    // Assert
    expect(await ui.find({ type: 'Text', text: /結論/ })).toBeDefined()
    await ui.unmount()
  }
})

test('Pane はタイトル行（ターン数）を terminal と desktop の両方で描く', async ($, on) => {
  // Arrange
  answerEngine(on, () => 10, true)
  await $.session.start(SESSION_START)
  await runMainTurn($)
  await $.command.run(COMMAND_RUN)

  for (const surface of ['terminal', 'desktop'] as const) {
    // Act
    const ui = await $.ui.mount({
      plugin: 'model-review',
      surface,
      component: 'Pane',
      requestId: 'model-review',
      props: PANE_PROPS,
    } as never)

    // Assert
    expect(await ui.find({ type: 'Text', text: /1 ターン/ })).toBeDefined()
    await ui.unmount()
  }
})

test('turn.step のモデルと effort が記録に載り、/model-review の表に出る', async ($, on) => {
  // Arrange: Haiku の 1 応答（入力 50,000 tokens、10 万以下の低い単価）。
  const haikuUsage = {
    model: 'claude-haiku-5-5',
    input_tokens: 50_000,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
  answerEngine(on, () => 0, false)
  on('turn.step', async function* () {
    return { turnId: 'turn-2', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: haikuUsage } as never
  })
  await $.session.start(SESSION_START)
  await $.turn.start({ text: '', turnId: 'turn-2' } as never)

  // Act
  const stream = $.turn.step({ turnId: 'turn-2', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1 } as never)
  for await (const chunk of stream) void chunk
  await stream.result
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-2', reason: 'answer', usage: haikuUsage } as never)
  const ran = await $.command.run(COMMAND_RUN)

  // Assert
  expect(ran.text).toContain('claude-haiku-5-5  effort low')
  expect(ran.text).toContain('推定 $0.0050')
})

test('ターン実行中は、完了前でもペインに「実行中」の行が出て、完了後は記録に切り替わる', async ($, on) => {
  // Arrange
  answerEngine(on, () => 10, true)
  await $.session.start(SESSION_START)
  await $.command.run(COMMAND_RUN)
  const mountPane = () =>
    $.ui.mount({ plugin: 'model-review', surface: 'terminal', component: 'Pane', requestId: 'model-review', props: PANE_PROPS } as never)

  // Act: ツールを 1 回呼んだところ（ターン未完了）。
  await $.turn.start({ text: '', turnId: 'turn-live' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'use-live', file_path: '/x' } as never)
  const running = await mountPane()

  // Assert
  expect(await running.find({ type: 'Text', text: /実行中/ })).toBeDefined()
  await running.unmount()

  // Act: ターンを完了する。
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'turn-live', reason: 'answer', usage: SONNET_USAGE } as never)
  const done = await mountPane()

  // Assert
  expect(await done.find({ type: 'Text', text: /1 ターン/ })).toBeDefined()
  await done.unmount()
})

test('turn.step の結果に advisor があれば、/model-review に回数が出る', async ($, on) => {
  // Arrange
  answerEngine(on, () => 0, false)
  on('turn.step', async function* () {
    return {
      turnId: 'turn-3',
      index: 0,
      answer: '',
      toolUses: [],
      serverToolUses: [{ id: 's1', name: 'advisor', input: {} }],
      stopReason: 'end_turn',
      usage: SONNET_USAGE,
    } as never
  })
  await $.session.start(SESSION_START)
  await $.turn.start({ text: '', turnId: 'turn-3' } as never)

  // Act
  const stream = $.turn.step({ turnId: 'turn-3', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1 } as never)
  for await (const chunk of stream) void chunk
  await stream.result
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-3', reason: 'answer', usage: SONNET_USAGE } as never)
  const ran = await $.command.run(COMMAND_RUN)

  // Assert
  expect(ran.text).toContain('advisor 1 回')
})

test('usage の取得に失敗しても session.start は次のハンドラに進み、/model-review は実コストを取得できない扱いで答える', async ($, on) => {
  // Arrange
  answerEngine(
    on,
    () => {
      throw new Error('usage unavailable')
    },
    false,
  )

  // Act
  const started = await $.session.start(SESSION_START)
  await runMainTurn($)
  const ran = await $.command.run(COMMAND_RUN)

  // Assert
  expect(started).toEqual({ cwd: SESSION_CWD })
  expect(ran.text).toContain('セッション実コスト: 取得できません')
})

test('起動時に基準額が取れなくても、後に取れた時点を基準にし、以後の実コストはその時点からの差になる', async ($, on) => {
  // Arrange: 起動時は累計コストが取れない。
  let usd: number | undefined
  answerEngine(on, () => usd, false)
  await $.session.start(SESSION_START)
  await runMainTurn($)

  // Act: 最初に取れた累計 13 が基準点になるので、実コストは 0。
  usd = 13
  const first = await $.command.run(COMMAND_RUN)

  // Assert
  expect(first.text).toContain('セッション実コスト（読み込み後）: $0.0000')

  // Act: 累計 16 になったら、基準点からの 3 が実コスト。
  usd = 16
  const second = await $.command.run(COMMAND_RUN)

  // Assert
  expect(second.text).toContain('セッション実コスト（読み込み後）: $3.0000')
})

const OPUS_USAGE = {
  model: 'claude-opus-5-5',
  input_tokens: 1_000_000,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

/** 軽作業（ツール 0 回）の Opus のターンを 1 つ流す。過剰の例文を出すための記録。turn.step の結果は呼び出し側で差し替えておく。 */
async function runLightOpusTurn($: Engine, turnId: string) {
  await $.turn.start({ text: '', turnId } as never)
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 } as never)
  for await (const chunk of stream) void chunk
  await stream.result
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId, reason: 'answer', usage: OPUS_USAGE } as never)
}

test('Pane のタイトル行は推定コストを先頭に出し、ターン数とサブエージェント数はその後ろに置く', async ($, on) => {
  // Arrange
  answerEngine(on, () => 10, true)
  await $.session.start(SESSION_START)
  await runMainTurn($)
  await $.command.run(COMMAND_RUN)

  // Act
  const ui = await $.ui.mount({ plugin: 'model-review', surface: 'terminal', component: 'Pane', requestId: 'model-review', props: PANE_PROPS } as never)
  const title = (await ui.findAll({ type: 'Text' })).find(element => element.text.includes('サブエージェント'))

  // Assert
  expect(title?.text).toMatch(/^推定 \$3\.0000 .*1 ターン.*サブエージェント 0/)
  await ui.unmount()
})

test('Pane のトークン行・キャッシュ行・ターン行は切り詰めず折り返し、数値を末尾で消さない', async ($, on) => {
  // Arrange: 完了したターンを 3 件流し、ターン行（コスト上位）とトークン行・キャッシュ行を出す。
  answerEngine(on, () => 10, true)
  await $.session.start(SESSION_START)
  for (const turnId of ['a', 'b', 'c']) {
    await $.turn.start({ text: '', turnId } as never)
    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId, reason: 'answer', usage: SONNET_USAGE } as never)
  }
  await $.command.run(COMMAND_RUN)

  // Act
  const ui = await $.ui.mount({ plugin: 'model-review', surface: 'terminal', component: 'Pane', requestId: 'model-review', props: PANE_PROPS } as never)
  const texts = await ui.findAll({ type: 'Text' })
  const tokenRow = texts.find(element => element.text.includes('入力 '))
  const cacheRow = texts.find(element => element.text.includes('キャッシュ 読'))
  const turnRow = texts.find(element => element.text.startsWith('  a · '))

  // Assert
  expect(tokenRow?.props.wrap).toBe('wrap')
  expect(cacheRow?.props.wrap).toBe('wrap')
  expect(turnRow?.props.wrap).toBe('wrap')
  await ui.unmount()
})

test('Pane の過剰の例文は切り詰めず折り返す', async ($, on) => {
  // Arrange: 軽作業（ツール 0 回）に Opus を 3 回使い、過剰の例文を出す。
  answerEngine(on, () => 10, true)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: OPUS_USAGE } as never
  })
  await $.session.start(SESSION_START)
  for (const turnId of ['a', 'b', 'c']) await runLightOpusTurn($, turnId)
  await $.command.run(COMMAND_RUN)

  // Act
  const ui = await $.ui.mount({ plugin: 'model-review', surface: 'terminal', component: 'Pane', requestId: 'model-review', props: PANE_PROPS } as never)
  const example = (await ui.findAll({ type: 'Text' })).find(element => element.text.startsWith('  ・'))

  // Assert
  expect(example?.props.wrap).toBe('wrap')
  await ui.unmount()
})

test('Pane の末尾に「/model-review で更新」を dim の 1 行で出す', async ($, on) => {
  // Arrange
  answerEngine(on, () => 10, true)
  await $.session.start(SESSION_START)
  await runMainTurn($)
  await $.command.run(COMMAND_RUN)

  // Act
  const ui = await $.ui.mount({ plugin: 'model-review', surface: 'terminal', component: 'Pane', requestId: 'model-review', props: PANE_PROPS } as never)

  // Assert
  expect(await ui.find({ type: 'Text', text: /^\/model-review で更新$/ })).toBeDefined()
  await ui.unmount()
})
