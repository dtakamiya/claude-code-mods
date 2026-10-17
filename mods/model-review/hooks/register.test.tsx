import { test, expect, mock } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'
import { LIVE_DRAFT_LIFETIME_MS } from './recorder'
import type { Engine } from 'claude-code/testing'

// 架空データのみ。Sonnet 5.5 の 1 応答（入力 1,000,000 / 出力 100,000）は $2 + $1 = $3。
const SONNET_USAGE = {
  model: 'claude-sonnet-5-5',
  input_tokens: 1_000_000,
  output_tokens: 100_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}
const CLOCK_START = 1_700_000_000_000
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
function answerEngine(
  on: On,
  usd: () => number | undefined,
  isPlaced: boolean,
  withClock = true,
  opened: unknown[] = [],
  registered: unknown[] = [],
) {
  on('session.start', () => ({ cwd: SESSION_CWD }))
  on('command.register', (_$, e) => {
    registered.push(e)
    return { value: {} as never }
  })
  on('session.usage', () => {
    const current = usd()
    return { value: { cost: current === undefined ? undefined : { usd: current } } as unknown as SessionUsage }
  })
  on('ui.open', (_$, e) => {
    opened.push(e)
    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // 時計を答えないと、記録の途中（時刻の取得）で例外が出る。例外耐性のテストで使う。
  const clock = withClock ? mock.clock(on, { now: CLOCK_START }) : undefined
  on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as never)
  return clock as ReturnType<typeof mock.clock>
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

/** ui.copy を答え、コピーされた文字列を記録する。 */
function answerCopy(on: On, copied: string[], result: { isCopied: true } | { isCopied: false; reason: 'no-clipboard' } = { isCopied: true }) {
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: result } as never
  })
}
const COMMAND_COPY = { ...(COMMAND_RUN as object), args: 'copy' } as never

test('/model-review copy は、ペインが置ける画面でもテキストレポートだけをクリップボードに入れる', async ($, on) => {
  // Arrange
  const opened: unknown[] = []
  answerEngine(on, () => 10, true, true, opened)
  const copied: string[] = []
  answerCopy(on, copied)
  await $.session.start(SESSION_START)
  await runMainTurn($)

  // Act
  const ran = await $.command.run(COMMAND_COPY)

  // Assert
  expect(ran.text).toContain('コピーしました')
  expect(copied).toHaveLength(1)
  expect(copied[0]).toContain('対象: 1 ターン')
  expect(copied[0]?.split('\n')[0]).toMatch(/結論:/)
  expect(opened).toHaveLength(0)
})

test('コピー内容は isPlaced が偽のときの通常出力と同じ（入力・プロンプトを含まない）', async ($, on) => {
  // Arrange
  answerEngine(on, () => 10, false)
  const copied: string[] = []
  answerCopy(on, copied)
  await $.session.start(SESSION_START)
  await runMainTurn($)

  // Act
  const plain = await $.command.run(COMMAND_RUN)
  await $.command.run(COMMAND_COPY)

  // Assert
  expect(copied[0]).toBe(plain.text)
  expect(copied[0]).not.toContain('/x')
  expect(plain.text?.split('\n')[0]).toMatch(/^[▲✓] 結論:/)
})

test('コピーに失敗したら理由を返し、記録がなければ結論と案内だけをコピーする', async ($, on) => {
  // Arrange
  answerEngine(on, () => 0, false)
  const copied: string[] = []
  answerCopy(on, copied, { isCopied: false, reason: 'no-clipboard' })
  await $.session.start(SESSION_START)

  // Act
  const ran = await $.command.run(COMMAND_COPY)

  // Assert
  expect(ran.text).toContain('コピーできませんでした: no-clipboard')
  expect(copied).toEqual(['結論: まだ記録がありません\n記録されたターンはまだありません。この Mod の読み込み後に完了したターンが対象です。'])
})

const commandWith = (args: string) => ({ ...(COMMAND_RUN as object), args }) as never

test('不明な引数はペインを開かず、何もコピーせず、help への案内を返す', async ($, on) => {
  // Arrange
  const opened: unknown[] = []
  answerEngine(on, () => 0, true, true, opened)
  const copied: string[] = []
  answerCopy(on, copied)
  await $.session.start(SESSION_START)

  // Act
  const typo = await $.command.run(commandWith('cpy'))
  const other = await $.command.run(commandWith('save'))

  // Assert
  expect(typo.text).toBe('不明な引数です。/model-review help を参照してください。')
  expect(other.text).toBe(typo.text)
  expect(opened).toHaveLength(0)
  expect(copied).toHaveLength(0)
})

test('/model-review help は使える引数の一覧を返し、ペインを開かない', async ($, on) => {
  // Arrange
  const opened: unknown[] = []
  answerEngine(on, () => 0, true, true, opened)
  await $.session.start(SESSION_START)

  // Act
  const ran = await $.command.run(commandWith(' HELP '))

  // Assert
  expect(ran.text?.split('\n')[0]).toBe('/model-review の使い方')
  expect(ran.text).toContain('copy')
  expect(ran.text).toContain('text')
  expect(opened).toHaveLength(0)
})

test('/model-review text はペインが置ける画面でもペインを開かず、テキストレポート（copy と同じ内容）を返す', async ($, on) => {
  // Arrange: copy の内容は、ペインを置けないときの通常出力と同じ（上のテストで固定）。
  const opened: unknown[] = []
  answerEngine(on, () => 10, true, true, opened)
  const copied: string[] = []
  answerCopy(on, copied)
  await $.session.start(SESSION_START)
  await runMainTurn($)
  await $.command.run(COMMAND_COPY)

  // Act
  const ran = await $.command.run(commandWith('text'))

  // Assert
  expect(ran.text).toBe(copied[0])
  expect(ran.text).toContain('対象: 1 ターン')
  expect(opened).toHaveLength(0)
})

// Opus 5.5 の軽い 1 応答（ツールなし・出力 100 tokens）。Sonnet 換算の差額が過剰の下限を超えるよう入力を多めにする。
const OPUS_LIGHT_USAGE = { ...SONNET_USAGE, model: 'claude-opus-5-5', input_tokens: 50_000, output_tokens: 100 }

/** 応答（turn.step）を流さず、終了時の usage だけで Opus の軽作業のターンを 1 つ記録する。 */
const completeLightOpusTurn = async ($: Engine, turnId: string) => {
  await $.turn.start({ text: '', turnId } as never)
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId, reason: 'answer', usage: OPUS_LIGHT_USAGE } as never)
}

test('設定 mutedConcerns の種類は結論の件数から外れ、テキストレポートに「止めている指摘」として件数つきで出る', { options: { mutedConcerns: 'overspec' } }, async ($, on) => {
  // Arrange: Opus の軽作業 3 件で過剰になる記録。
  answerEngine(on, () => 10, false)
  await $.session.start(SESSION_START)
  for (const id of ['o1', 'o2', 'o3']) await completeLightOpusTurn($, id)

  // Act
  const ran = await $.command.run(commandWith('text'))

  // Assert
  expect(ran.text?.startsWith('✓ 結論: 目立った指摘なし')).toBe(true)
  expect(ran.text).toContain('止めている指摘（設定 mutedConcerns）: 過剰 3 / 3 件')
  expect(ran.text).not.toContain('【過剰】')
})

test('同じ記録でも設定がなければ、過剰は結論と指摘の節に出る', async ($, on) => {
  // Arrange
  answerEngine(on, () => 10, false)
  await $.session.start(SESSION_START)
  for (const id of ['o1', 'o2', 'o3']) await completeLightOpusTurn($, id)

  // Act
  const ran = await $.command.run(commandWith('text'))

  // Assert
  expect(ran.text?.startsWith('▲ 結論: 見直し候補 3 件（過剰 3）')).toBe(true)
  expect(ran.text).toContain('【過剰】')
})

test('設定 mutedConcerns が既定（空）なら、「止めている指摘」は出ない', async ($, on) => {
  // Arrange
  answerEngine(on, () => 10, false)
  await $.session.start(SESSION_START)
  await runMainTurn($)

  // Act
  const ran = await $.command.run(commandWith('text'))

  // Assert
  expect(ran.text).not.toContain('止めている指摘')
})

test('コマンドは引数のヒントつきで登録する', async ($, on) => {
  // Arrange
  const registered: unknown[] = []
  answerEngine(on, () => 0, false, true, [], registered)

  // Act
  await $.session.start(SESSION_START)

  // Assert
  expect(registered).toHaveLength(1)
  expect(registered[0]).toMatchObject({ name: 'model-review', argumentHint: '[copy|text|help]' })
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
  const turnRow = texts.find(element => element.text.startsWith('  #1（'))

  // Assert
  expect(tokenRow?.props.wrap).toBe('wrap')
  expect(cacheRow?.props.wrap).toBe('wrap')
  expect(turnRow?.props.wrap).toBe('wrap')
  await ui.unmount()
})

test('Pane のバーは bodyColumns に合わせて縮み、金額が行の先頭に来て、見出し・タイトル・モデル行は切り詰めない', async ($, on) => {
  // Arrange
  answerEngine(on, () => 10, true)
  await $.session.start(SESSION_START)
  await runMainTurn($)
  await $.command.run(COMMAND_RUN)
  const barCells = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ plugin: 'model-review', surface: 'terminal', component: 'Pane', requestId: 'model-review', props: { ...PANE_PROPS, bodyColumns } } as never)
    const texts = await ui.findAll({ type: 'Text' })
    const bar = texts.find(element => element.text.includes('$3.0000') && /[█░]/.test(element.text))
    const wraps = texts.filter(element => element.text.startsWith('▎') || element.text.startsWith('推定 ') || element.text.includes('effort ')).map(element => element.props.wrap)
    await ui.unmount()
    return { bar: bar?.text ?? '', cells: (bar?.text.match(/[█░]/g) ?? []).length, wraps }
  }

  // Act
  const wide = await barCells(100)
  const narrow = await barCells(30)

  // Assert
  expect(wide.cells).toBe(14)
  expect(narrow.cells).toBeLessThan(wide.cells)
  expect(narrow.bar.trimStart().startsWith('$3.0000')).toBe(true)
  expect(narrow.wraps.length).toBeGreaterThan(0)
  expect(narrow.wraps).toContain('wrap')
  expect(narrow.wraps).not.toContain('truncate-end')
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

test('記録処理が例外を投げても、tool.call は通り、debug ログに固定文言だけを残す', async ($, on) => {
  // Arrange: 時計が入力由来の文字列を含む例外を投げる。ログはその中身を出さない固定文言だけになる。
  const logs: string[] = []
  answerEngine(on, () => 0, false, false)
  on('clock.now', () => {
    throw new Error('PRIVATE-PATH')
  })
  on('ui.log', (_$, e) => {
    logs.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  await $.session.start(SESSION_START)

  // Act
  const called = await $.tool.call({ tool: 'Read', tool_use_id: 'use-x', file_path: '/secret/PRIVATE-PATH' } as never)

  // Assert: ツールの結果は変わらず、ログに入力由来の文字列は出ない。
  expect(called).toEqual({ result: { text: 'ok', isError: false } })
  expect(logs).toEqual(['model-review: 記録に失敗したため、この更新を記録しなかった'])
})

test('未完了のターンは、最後の動きから 10 分までペインに出て、過ぎると消える（固定時刻）', async ($, on) => {
  // Arrange
  const clock = answerEngine(on, () => 10, true)
  await $.session.start(SESSION_START)
  await $.command.run(COMMAND_RUN)
  await $.turn.start({ text: '', turnId: 'turn-stale' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'use-stale', file_path: '/x' } as never)
  const mountPane = () =>
    $.ui.mount({ plugin: 'model-review', surface: 'terminal', component: 'Pane', requestId: 'model-review', props: PANE_PROPS } as never)

  // Act / Assert: 10 分ちょうどまでは出る。
  await clock.advance(LIVE_DRAFT_LIFETIME_MS)
  const before = await mountPane()
  expect(await before.find({ type: 'Text', text: /実行中/ })).toBeDefined()
  await before.unmount()

  // Act / Assert: 1ms 過ぎると消える。
  await clock.advance(1)
  const after = await mountPane()
  expect(await after.find({ type: 'Text', text: /実行中/ })).toBeUndefined()
  await after.unmount()
})

test('メインとサブエージェントが同時に進んでも、ターンの記録は混ざらない', async ($, on) => {
  // Arrange
  const haikuUsage = { ...SONNET_USAGE, model: 'claude-haiku-5-5', input_tokens: 10_000, output_tokens: 0 }
  answerEngine(on, () => 0, false)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: e.agentId ? haikuUsage : SONNET_USAGE } as never
  })
  await $.session.start(SESSION_START)
  await $.turn.start({ text: '', turnId: 'main-1' } as never)
  await $.turn.start({ text: '', turnId: 'sub-1', agentId: 'agent-1' } as never)

  // Act: 両方の応答とツール呼び出しを同時に流す。
  const step = async (turnId: string, model: string, agentId?: string) => {
    const stream = $.turn.step({ turnId, index: 0, model, effort: 'low', messageCount: 1, agentId } as never)
    for await (const chunk of stream) void chunk
    await stream.result
  }
  await Promise.all([
    step('main-1', 'claude-sonnet-5-5'),
    step('sub-1', 'claude-haiku-5-5', 'agent-1'),
    $.tool.call({ tool: 'Edit', tool_use_id: 'u-m', file_path: '/x' } as never),
    $.tool.call({ tool: 'Read', tool_use_id: 'u-s', file_path: '/y', agentId: 'agent-1' } as never),
  ])
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub-1', agentId: 'agent-1', reason: 'answer', usage: haikuUsage } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'main-1', reason: 'answer', usage: SONNET_USAGE } as never)
  const ran = await $.command.run(COMMAND_RUN)

  // Assert: メインは Sonnet、サブエージェントは Haiku で、別々に数えられる。
  expect(ran.text).toContain('claude-sonnet-5-5')
  expect(ran.text).toContain('claude-haiku-5-5')
  expect(ran.text).toContain('対象: 2 ターン（サブエージェント 1 件）')
  expect(ran.text).toMatch(/claude-haiku-5-5 {2}effort low {2}ターン 1 /)
  expect(ran.text).toMatch(/claude-sonnet-5-5 {2}effort low {2}ターン 1 /)
  // どちらのツール呼び出しも、並行の更新で失われず、自分のループに数えられる。
  expect(ran.text).toMatch(/#1（[^）]+）.*ツール 1 回/)
  expect(ran.text).toMatch(/#1 の中のサブエージェント.*ツール 1 回/)
})

test('記録（$.state）にはツールの入力（パス・コマンド）が含まれない', async ($, on) => {
  // Arrange
  answerEngine(on, () => 0, false)
  const written: string[] = []
  on('state.set', async (_$, e, next) => {
    written.push(JSON.stringify(e))
    return next(e)
  })
  await $.session.start(SESSION_START)
  await $.turn.start({ text: 'PROMPT-MARKER', turnId: 'turn-priv' } as never)

  // Act
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u-p', command: 'echo COMMAND-MARKER', file_path: '/PATH-MARKER' } as never)
  await $.turn.complete({ answer: 'ANSWER-MARKER', durationMs: 1, isAborted: false, turnId: 'turn-priv', reason: 'answer', usage: SONNET_USAGE } as never)
  const ran = await $.command.run(COMMAND_RUN)
  const stored = written.join('\n')

  // Assert: ツールは回数だけ残り、入力・プロンプト・回答は残らない。
  expect(stored).toContain('"toolCount":1')
  for (const marker of ['COMMAND-MARKER', 'PATH-MARKER', 'PROMPT-MARKER', 'ANSWER-MARKER']) {
    expect(stored).not.toContain(marker)
    expect(ran.text).not.toContain(marker)
  }
})

// status 行・トーストは session.measure で出す。engine の下で ui.status / ui.toast を受けて記録する。
function captureUi(on: On) {
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.status', (_$, e) => (statuses.push(e.text), { value: undefined as never }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined as never }))
  return { statuses, toasts }
}
const measure = (changed: string[], usd: number | undefined, percents: number[] = []) =>
  ({
    context: {},
    rateLimits: percents.map(percentUsed => ({ kind: 'five_hour', percentUsed })),
    cost: usd === undefined ? undefined : { usd },
    changed,
  }) as never

test('measure: コストと使用率を status 行に出し、context だけの変化では描き直さない', async ($, on) => {
  answerEngine(on, () => 0, false)
  const ui = captureUi(on)
  await $.session.start(SESSION_START)

  await $.session.measure(measure(['cost', 'rateLimits'], 1.234, [72]))
  await $.session.measure(measure(['context'], 9, [99]))
  await $.session.measure(measure(['cost'], 1.234, [72]))

  expect(ui.statuses).toEqual(['実コスト $1.23 · 5h 72%'])
})

test('measure: 既定は上限が無効でトーストを出さない', async ($, on) => {
  answerEngine(on, () => 0, false)
  const ui = captureUi(on)
  await $.session.start(SESSION_START)

  await $.session.measure(measure(['cost', 'rateLimits'], 999, [100]))

  expect(ui.toasts).toEqual([])
})

test('measure: 上限を設定すると、超えたときに 1 度だけトーストする', { options: { costLimitUsd: 5, rateLimitPercent: 80 } }, async ($, on) => {
  answerEngine(on, () => 0, false)
  const ui = captureUi(on)
  await $.session.start(SESSION_START)

  await $.session.measure(measure(['cost', 'rateLimits'], 4, [50]))
  await $.session.measure(measure(['cost', 'rateLimits'], 5.5, [85]))
  await $.session.measure(measure(['cost', 'rateLimits'], 6, [90]))

  expect(ui.toasts).toHaveLength(2)
})

test('measure: showStatus を切ると status 行に出さない', { options: { showStatus: false } }, async ($, on) => {
  answerEngine(on, () => 0, false)
  const ui = captureUi(on)
  await $.session.start(SESSION_START)

  await $.session.measure(measure(['cost'], 1, []))

  expect(ui.statuses).toEqual([])
})

test('agent.spawn で覚えた種類は turn.complete の記録に載り、spawn を見ていないときは agent.list で補う。説明・プロンプトは出ない', async ($, on) => {
  // Arrange
  answerEngine(on, () => 10, false)
  on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: e.description === 'x' ? 'sub-1' : 'sub-2' }) as never)
  on('agent.list', () => ({ value: [{ id: 'sub-3', type: 'general-purpose' }] }) as never)
  await $.session.start(SESSION_START)
  await $.agent.spawn({ prompt: 'SECRET-PROMPT', description: 'x', subagentType: 'Explore' } as never)
  await runMainTurn($)
  const complete = (agentId: string, turnId: string) =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, agentId, reason: 'answer', usage: SONNET_USAGE } as never)

  // Act: spawn を見たサブ、spawn を見ていない（list にある）サブ、どちらにもないサブ。
  await complete('sub-1', 's1')
  await complete('sub-3', 's3')
  await complete('sub-9', 's9')
  const ran = await $.command.run(commandWith('text'))

  // Assert
  expect(ran.text).toContain('└ Explore')
  expect(ran.text).toContain('└ general-purpose')
  expect(ran.text).toContain('└ 種類不明')
  expect(ran.text).not.toContain('SECRET-PROMPT')
})

// 切替の直前トースト。classic.PreModelSwitch は観察のみで、結果は書き換えない。
const PRE_SWITCH = {
  hook_event_name: 'PreModelSwitch',
  from_model: 'claude-opus-5-5',
  to_model: 'claude-sonnet-5-5',
  requested_model: 'sonnet',
  source: 'command',
  context_tokens: 120_000,
  prompt_cache_warm: true,
  cache_ttl: '5m',
  estimated_cache_write_usd: 0.3,
  pricing: 'catalog',
} as never

test('切替の直前: キャッシュが温かければトーストし、切替は止めない', async ($, on) => {
  // Arrange
  const ui = captureUi(on)
  on('classic.PreModelSwitch', () => ({}) as never)

  // Act
  const result = await $.classic.PreModelSwitch(PRE_SWITCH)

  // Assert
  expect(ui.toasts).toHaveLength(1)
  expect(ui.toasts[0]).toContain('120,000 tokens')
  expect(result).toEqual({})
})

test('切替の直前: notifyOnSwitch を切るとトーストしない', { options: { notifyOnSwitch: false } }, async ($, on) => {
  // Arrange
  const ui = captureUi(on)
  on('classic.PreModelSwitch', () => ({}) as never)

  // Act
  await $.classic.PreModelSwitch(PRE_SWITCH)

  // Assert
  expect(ui.toasts).toEqual([])
})
