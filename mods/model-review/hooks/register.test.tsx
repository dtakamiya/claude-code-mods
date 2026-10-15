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

/** 本体の hook の下で答える engine の既定値。`usd` は呼ばれた時点の累計コスト（テストが書き換える）。 */
function answerEngine(on: On, usd: () => number, isPlaced: boolean) {
  on('session.start', () => ({ cwd: SESSION_CWD }))
  on('command.register', () => ({ value: {} as never }))
  on('session.usage', () => ({ value: { cost: { usd: usd() } } as unknown as SessionUsage }))
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

test('Pane は記録した行（対象ターン数）を terminal と desktop の両方で描く', async ($, on) => {
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
    expect(await ui.find({ type: 'Text', text: /対象: 1 ターン/ })).toBeDefined()
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
