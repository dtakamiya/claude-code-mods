import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { effortToRecord } from './effort'
import {
  LIGHT_MAX_OUTPUT_TOKENS,
  LIGHT_MAX_TOOL_CALLS,
  estimateTotal,
  findConcerns,
  groupByModelEffort,
  modelRank,
  topCostTurns,
  MIN_OVERSPEC_SAVINGS_USD,
  MIN_OVERSPEC_TURNS,
  MIN_UNDERSPEC_TURNS,
  MAIN_DELEGATION_MIN_TOOL_CALLS,
  UNDERSPEC_ERROR_STREAK,
  RANK_HAIKU,
  estimateRange,
  RANK_OPUS,
  RANK_SONNET,
  DELEGATION_WINDOW_TURNS,
  LONG_TURN_MS,
  MIN_TOOLS_FOR_DURATION_HEAVY,
  DELEGATION_MAX_EDIT_SHARE,
  OVERSPEC_MIN_LIGHT_SHARE,
} from './analyze'

// 架空データのみ。既定値は「重い」側に寄らない軽い 1 ターン。
const repeat = (count: number, make: (index: number) => TurnRecord): TurnRecord[] =>
  Array.from({ length: count }, (_, index) => make(index))

const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 'turn-x',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.01,
  toolCount: 0,
  editCount: 0,
  durationMs: 1_000,
  reason: 'answer',
  ...overrides,
})

test('モデル × effort ごとにターン数・トークン・コストを足し合わせる', () => {
  // Arrange
  const records = [
    turn({ turnId: 'a', costUsd: 0.5, tokens: { input: 10, output: 1, cacheRead: 2, cacheWrite: 3 } }),
    turn({ turnId: 'b', costUsd: 0.25, tokens: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 } }),
    turn({ turnId: 'c', model: 'claude-haiku-5-5', effort: 'low', costUsd: 0.1 }),
  ]

  // Act
  const groups = groupByModelEffort(records)

  // Assert
  expect(groups).toHaveLength(2)
  expect(groups[0]).toMatchObject({
    model: 'claude-sonnet-5-5',
    effort: 'high',
    turns: 2,
    unpricedTurns: 0,
    tokens: { input: 30, output: 3, cacheRead: 2, cacheWrite: 3 },
  })
  expect(groups[0]?.costUsd?.toFixed(9)).toBe('0.750000000')
})

test('単価不明のターンがあるグループはコストを null にし、件数だけ数える', () => {
  // Arrange
  const records = [turn({ costUsd: 0.5 }), turn({ costUsd: null })]

  // Act
  const [group] = groupByModelEffort(records)

  // Assert
  expect(group).toMatchObject({ turns: 2, unpricedTurns: 1, costUsd: null })
})

test('推定合計は単価不明のターンを除き、その件数を別に返す', () => {
  // Arrange
  const records = [turn({ costUsd: 0.5 }), turn({ costUsd: null }), turn({ costUsd: 0.25 })]

  // Act
  const total = estimateTotal(records)

  // Assert
  expect(total).toEqual({ costUsd: 0.75, unpricedTurns: 1 })
})

test('モデル名から階層を判定し、未知のモデルは階層なしにする', () => {
  // Act / Assert
  expect(modelRank('claude-haiku-5-5')).toBe(RANK_HAIKU)
  expect(modelRank('us.anthropic.claude-sonnet-4-6')).toBe(RANK_SONNET)
  expect(modelRank('claude-fable-5-1')).toBe(RANK_OPUS)
  expect(modelRank('claude-unlisted-9')).toBe(-1)
})

test('Opus の軽作業が 3 件以上あれば過剰の可能性として指摘し、同じ設定は 1 行にまとめる', () => {
  // Arrange
  const records = repeat(MIN_OVERSPEC_TURNS, index => turn({ turnId: `light-${index}`, model: 'claude-opus-5-5', effort: 'medium', toolCount: 2, costUsd: 0.5, sonnetCostUsd: 0.25 }))

  // Act
  const concern = findConcerns(records).find(candidate => candidate.kind === 'overspec')

  // Assert
  expect(concern).toMatchObject({ kind: 'overspec', count: 3 })
  expect(concern?.examples).toHaveLength(1)
  expect(concern?.examples[0]).toContain('claude-opus-5-5 / effort medium: 軽作業 3 件')
})

test('過剰は 1〜2 件では指摘しない（1 ターンの軽さは切替の根拠にならない）', () => {
  // Arrange
  const records = repeat(MIN_OVERSPEC_TURNS - 1, () => turn({ model: 'claude-opus-5-5', effort: 'xhigh' }))

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'overspec')).toBeUndefined()
})

test('Sonnet / Haiku の軽作業は、effort が高くなければモデル起因の過剰にしない', () => {
  // Arrange
  const records = [
    ...repeat(5, () => turn({ model: 'claude-sonnet-5-5', effort: 'medium', costUsd: 0.5, haikuCostUsd: 0.02 })),
    ...repeat(5, () => turn({ model: 'claude-haiku-5-5', effort: 'medium' })),
  ]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'overspec')).toBeUndefined()
})

test('中断・拒否のターンは出力が少なくても軽作業とは見なさない', () => {
  // Arrange
  const records = [
    turn({ model: 'claude-opus-5-5', effort: 'medium', reason: 'aborted' }),
    turn({ model: 'claude-opus-5-5', effort: 'medium', reason: 'refusal' }),
    turn({ model: 'claude-opus-5-5', effort: 'medium', reason: 'aborted' }),
  ]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'overspec')).toBeUndefined()
})

test('軽作業でも effort が xhigh なら、モデルが Haiku でも過剰の可能性として指摘する', () => {
  // Arrange
  const records = repeat(MIN_OVERSPEC_TURNS, () => turn({ model: 'claude-haiku-5-5', effort: 'xhigh', toolCount: 0 }))

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.map(concern => concern.kind)).toEqual(['overspec'])
})

test('編集を伴うか出力が大きいターンは軽作業とみなさず、過剰として指摘しない', () => {
  // Arrange
  const records = [
    turn({ model: 'claude-opus-5-5', toolCount: 1, editCount: 1 }),
    turn({ model: 'claude-opus-5-5', toolCount: 0, tokens: { input: 1, output: LIGHT_MAX_OUTPUT_TOKENS + 1, cacheRead: 0, cacheWrite: 0 } }),
    turn({ model: 'claude-opus-5-5', toolCount: LIGHT_MAX_TOOL_CALLS + 1 }),
  ]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'overspec')).toBeUndefined()
})

test('Haiku を低 effort で使い、ツールが多いターンを不足の可能性として指摘する', () => {
  // Arrange: 不足は 2 件以上で指摘する（MIN_UNDERSPEC_TURNS）。例は新しい順。
  const records = [
    turn({ turnId: 'heavy-1', model: 'claude-haiku-5-5', effort: 'low', toolCount: 12 }),
    turn({ turnId: 'heavy-2', model: 'claude-haiku-5-5', effort: 'low', toolCount: 12 }),
  ]

  // Act
  const underspec = findConcerns(records).find(concern => concern.kind === 'underspec')

  // Assert
  expect(underspec).toMatchObject({ count: 2 })
  expect(underspec?.examples[1]).toContain('heavy-1')
})

test('不足は 1 件だけなら指摘しない（偶発の 1 ターンを根拠にしない）', () => {
  // Arrange
  const records = repeat(MIN_UNDERSPEC_TURNS - 1, index => turn({ turnId: `heavy-${index}`, model: 'claude-haiku-5-5', effort: 'low', toolCount: 12 }))

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'underspec')).toBeUndefined()
})

test('Haiku を低 effort で使ったエラー終了だけでは、不足として指摘しない（API 側の原因もありうる）', () => {
  // Arrange
  const records = [turn({ model: 'claude-haiku-5-5', effort: 'low', reason: 'error' })]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'underspec')).toBeUndefined()
})

test('メインループが非 Haiku でツールを 30 回以上呼び、サブエージェントを使っていなければ委譲を確認する', () => {
  // Arrange: メインのツール合計が閾値ちょうど。
  const records = [
    turn({ turnId: 'm1', toolCount: MAIN_DELEGATION_MIN_TOOL_CALLS - 4, editCount: 2 }),
    turn({ turnId: 'm2', toolCount: 4 }),
  ]

  // Act
  const delegation = findConcerns(records).find(concern => concern.kind === 'delegation')

  // Assert
  expect(delegation).toMatchObject({ count: 1 })
  expect(delegation?.examples[0]).toContain('30 回')
})

test('閾値未満のツール回数では、委譲の指摘はしない', () => {
  // Arrange
  const records = [turn({ toolCount: MAIN_DELEGATION_MIN_TOOL_CALLS - 1 })]

  // Act / Assert
  expect(findConcerns(records).find(concern => concern.kind === 'delegation')).toBeUndefined()
})

test('委譲は直近 DELEGATION_WINDOW_TURNS ターンの窓だけで見て、窓の外の古いサブエージェントでは指摘を消さない', () => {
  // Arrange: サブエージェントは窓の外（先頭）。窓内のメインのツール合計は閾値以上。
  const records = [
    turn({ turnId: 'old-sub', agentId: 'agent-1', model: 'claude-sonnet-5-5', effort: 'medium' }),
    ...repeat(DELEGATION_WINDOW_TURNS, index => turn({ turnId: `m${index}`, toolCount: 2 })),
  ]

  // Act
  const delegation = findConcerns(records).find(concern => concern.kind === 'delegation')

  // Assert
  expect(delegation).toMatchObject({ count: 1 })
})

test('委譲の判定に使うツール回数は窓の中のターンだけを足す', () => {
  // Arrange: 窓の外のメインは 50 回だが、窓の中は 20 回で閾値未満。
  const records = [
    ...repeat(5, index => turn({ turnId: `old${index}`, toolCount: 10 })),
    ...repeat(DELEGATION_WINDOW_TURNS, index => turn({ turnId: `w${index}`, toolCount: 1 })),
  ]

  // Act / Assert
  expect(findConcerns(records).find(concern => concern.kind === 'delegation')).toBeUndefined()
})

test('窓の中にサブエージェントのターンがあれば、窓の中のメインのツールが多くても委譲の指摘はしない', () => {
  // Arrange: 窓の一番新しい位置にサブエージェントを置く。
  const records = [
    ...repeat(DELEGATION_WINDOW_TURNS - 1, index => turn({ turnId: `m${index}`, toolCount: 2 })),
    turn({ turnId: 's1', agentId: 'agent-1', model: 'claude-sonnet-5-5', effort: 'medium', toolCount: 3 }),
  ]

  // Act / Assert
  expect(findConcerns(records).find(concern => concern.kind === 'delegation')).toBeUndefined()
})

test('サブエージェントを使っていれば、メインのツールが多くても委譲の指摘はしない', () => {
  // Arrange
  const records = [
    turn({ turnId: 'm1', toolCount: 40 }),
    turn({ turnId: 's1', agentId: 'agent-1', model: 'claude-sonnet-5-5', effort: 'medium', toolCount: 3 }),
  ]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'delegation')).toBeUndefined()
})

test('サブエージェントが推定コストの半分以上を占めれば、割合とヒット率つきで指摘する', () => {
  // Arrange: メイン 1 ターン $1、サブエージェント 3 ターン $3（ヒット 0%）。
  const records = [
    turn({ turnId: 'm', costUsd: 1 }),
    ...repeat(3, index => turn({ turnId: `s${index}`, agentId: 'a', costUsd: 1, tokens: { input: 1_000, output: 10, cacheRead: 0, cacheWrite: 5_000 } })),
  ]

  // Act
  const concern = findConcerns(records).find(candidate => candidate.kind === 'subagent')

  // Assert
  expect(concern).toMatchObject({ count: 3, amountUsd: 3 })
  expect(concern?.examples[0]).toContain('75%')
  expect(concern?.examples[0]).toContain('キャッシュヒット 0%')
})

test('サブエージェント指摘の母数は単価ありのターン数にし、比率の計算と同じ基準に揃える', () => {
  // Arrange: 単価不明のメインターンを 1 件含む。比率は 3 / 4 = 75%。
  const records = [
    turn({ turnId: 'm', costUsd: 1 }),
    ...repeat(3, index => turn({ turnId: `s${index}`, agentId: 'a', costUsd: 1 })),
    turn({ turnId: 'unpriced', costUsd: null }),
  ]

  // Act
  const concern = findConcerns(records).find(candidate => candidate.kind === 'subagent')

  // Assert
  expect(concern).toMatchObject({ count: 3, outOf: 4 })
  expect(concern?.examples[0]).toContain('75%')
})

test('サブエージェントが少数、またはコストの半分未満なら、サブエージェントの指摘はしない', () => {
  // Arrange
  const few = [turn({ costUsd: 1 }), turn({ agentId: 'a', costUsd: 5 }), turn({ agentId: 'a', costUsd: 5 })]
  const small = [turn({ costUsd: 10 }), ...repeat(3, () => turn({ agentId: 'a', costUsd: 1 }))]

  // Act / Assert
  expect(findConcerns(few).find(concern => concern.kind === 'subagent')).toBeUndefined()
  expect(findConcerns(small).find(concern => concern.kind === 'subagent')).toBeUndefined()
})

test('記録がないときは集計も指摘も空になる', () => {
  // Act / Assert
  expect(groupByModelEffort([])).toEqual([])
  expect(findConcerns([])).toEqual([])
  expect(estimateTotal([])).toEqual({ costUsd: 0, unpricedTurns: 0 })
})

test('Sonnet 換算の差額が小さい Opus の軽作業は、モデル起因の過剰として指摘しない', () => {
  // Arrange: 差額 0.0005 は下限未満。
  const records = repeat(MIN_OVERSPEC_TURNS, () =>
    turn({ model: 'claude-opus-5-5', effort: 'medium', toolCount: 1, costUsd: 0.02, sonnetCostUsd: 0.0195, haikuCostUsd: 0.01 }),
  )

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'overspec')).toBeUndefined()
})

test('過剰の例は差額の大きいグループ順に並び、合計は Sonnet 換算、例の文面には Haiku の上限も入る', () => {
  // Arrange
  const big = (index: number) => turn({ turnId: `big${index}`, model: 'claude-opus-5-5', effort: 'medium', costUsd: 0.5, sonnetCostUsd: 0.25, haikuCostUsd: 0.02 })
  const small = (index: number) => turn({ turnId: `s${index}`, model: 'claude-opus-5-5', effort: 'high', costUsd: 0.1, sonnetCostUsd: 0.05, haikuCostUsd: 0.01 })
  const records = [...repeat(3, small), ...repeat(2, big)]

  // Act
  const overspec = findConcerns(records).find(concern => concern.kind === 'overspec')

  // Assert: big: Sonnet 0.5 / Haiku 0.96、small: Sonnet 0.15 / Haiku 0.27。
  expect(overspec?.examples[0]).toContain('effort medium: 軽作業 2 件')
  expect(overspec?.examples[0]).toContain('Sonnet なら約 $0.5000 減')
  expect(overspec?.examples[0]).toContain('Haiku なら最大約 $0.9600 減（上限）')
  expect(overspec?.examples[1]).toContain('effort high: 軽作業 3 件')
  expect(overspec?.amountUsd?.toFixed(4)).toBe('0.6500')
})

test('Haiku の高 effort は差額が 0 でも、effort 起因の過剰として残る（金額は付けない）', () => {
  // Arrange
  const records = repeat(MIN_OVERSPEC_TURNS, () => turn({ model: 'claude-haiku-5-5', effort: 'max', toolCount: 0, costUsd: 0.01, haikuCostUsd: 0.01 }))

  // Act
  const overspec = findConcerns(records).find(concern => concern.kind === 'overspec')

  // Assert
  expect(overspec).toMatchObject({ count: 3, amountUsd: null })
})

test('差額が下限未満の Sonnet でも、effort が xhigh なら過剰として残る', () => {
  // Arrange
  const records = repeat(MIN_OVERSPEC_TURNS, () => turn({ model: 'claude-sonnet-5-5', effort: 'xhigh', toolCount: 0, costUsd: 0.001, haikuCostUsd: 0.0009 }))

  // Act
  const overspec = findConcerns(records).find(concern => concern.kind === 'overspec')

  // Assert
  expect(overspec?.count).toBe(3)
  expect(MIN_OVERSPEC_SAVINGS_USD).toBeGreaterThan(0.001 - 0.0009)
})

test('Sonnet 換算がない古い記録は、差額が分からないので Opus でもモデル起因の過剰として指摘しない', () => {
  // Arrange: sonnetCostUsd を持たない。
  const records = repeat(MIN_OVERSPEC_TURNS, () => turn({ model: 'claude-opus-5-5', effort: 'medium', toolCount: 0 }))

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'overspec')).toBeUndefined()
})

test('Sonnet の low effort でエラーが連続したエピソードを、エピソードごとに 1 件として指摘する', () => {
  // Arrange: 連続 2 回目から数える。間に成功が入ると連続は切れる。
  const failed = (turnId: string, reason: TurnRecord['reason']) =>
    turn({ turnId, model: 'claude-sonnet-5-5', effort: 'low', toolCount: 0, reason })
  const records = [
    failed('e1', 'error'),
    failed('e2', 'error'),
    failed('ok', 'answer'),
    failed('e3', 'error'),
    failed('e4', 'error'),
  ]

  // Act
  const underspec = findConcerns(records).find(concern => concern.kind === 'underspec')

  // Assert: エピソードは 2 つ。各エピソードは最後のターンで代表する（新しい順）。
  expect(UNDERSPEC_ERROR_STREAK).toBe(2)
  expect(underspec?.count).toBe(2)
  expect(underspec?.examples[0]).toContain('e4')
  expect(underspec?.examples[1]).toContain('e2')
})

test('Sonnet の low effort で 5 回連続してエラーになっても、1 エピソードとして 1 件に数える', () => {
  // Arrange: 連続の 2 回目以降を全部数えると 4 件になる。直後の重い Haiku と合わせて 2 件。
  const failed = (turnId: string) => turn({ turnId, model: 'claude-sonnet-5-5', effort: 'low', toolCount: 0, reason: 'error' })
  const records = [
    failed('x1'),
    failed('x2'),
    failed('x3'),
    failed('x4'),
    failed('x5'),
    turn({ turnId: 'heavy', model: 'claude-haiku-5-5', effort: 'low', toolCount: 12 }),
  ]

  // Act
  const underspec = findConcerns(records).find(concern => concern.kind === 'underspec')

  // Assert
  expect(underspec?.count).toBe(2)
})

test('Sonnet の low effort でも、エラーが 1 回だけなら不足として指摘しない', () => {
  // Arrange
  const records = [turn({ model: 'claude-sonnet-5-5', effort: 'low', toolCount: 0, reason: 'error' })]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'underspec')).toBeUndefined()
})

test('高コストターンはコストの降順で上位だけを返し、単価不明のターンは除く', () => {
  // Arrange
  const records = [
    turn({ turnId: 'a', costUsd: 0.1 }),
    turn({ turnId: 'b', costUsd: null }),
    turn({ turnId: 'c', costUsd: 2 }),
    turn({ turnId: 'd', costUsd: 1 }),
    turn({ turnId: 'e', costUsd: 0.5 }),
  ]

  // Act
  const top = topCostTurns(records, 3)

  // Assert
  expect(top.map(record => record.turnId)).toEqual(['c', 'd', 'e'])
  expect(records[0]?.turnId).toBe('a')
})

test('メインループのモデル切替は、再構築コストの推定つきで切替の指摘になる', () => {
  // Arrange
  const records = [
    turn({ turnId: 't1', model: 'claude-sonnet-5-5', toolCount: 5 }),
    turn({ turnId: 't2', model: 'claude-opus-5-5', toolCount: 5, firstStepCacheWrite: 100_000 }),
  ]

  // Act
  const concern = findConcerns(records).find(candidate => candidate.kind === 'switch')

  // Assert
  expect(concern?.count).toBe(1)
  expect(concern?.amountUsd?.toFixed(4)).toBe('0.4800')
})

test('Opus の軽作業の例には Sonnet 換算と Haiku の上限を出し、Sonnet の高 effort には差額を出さない', () => {
  // Arrange
  const opus = repeat(3, () => turn({ model: 'claude-opus-5-5', effort: 'medium', costUsd: 0.5, haikuCostUsd: 0.02, sonnetCostUsd: 0.25 }))
  const sonnet = repeat(3, () => turn({ model: 'claude-sonnet-5-5', effort: 'xhigh', costUsd: 0.5, haikuCostUsd: 0.02, sonnetCostUsd: 0.5 }))

  // Act
  const lines = [opus, sonnet].map(records => findConcerns(records).find(c => c.kind === 'overspec')?.examples[0])

  // Assert
  expect(lines[0]).toContain('Sonnet なら約 $0.7500 減 · Haiku なら最大約 $1.4400 減（上限）')
  expect(lines[1]).not.toContain('Sonnet なら')
  expect(lines[1]).not.toContain('Haiku なら')
})

test('推定の幅は、上限のある記録は上限で、古い記録・単価不明は下限のまま・除外で足す', () => {
  // Arrange
  const records = [
    turn({ turnId: 'a', costUsd: 1, costUpperUsd: 1.6 }),
    turn({ turnId: 'b', costUsd: 2 }),
    turn({ turnId: 'c', costUsd: null, costUpperUsd: null }),
  ]

  // Act
  const range = estimateRange(records)

  // Assert
  expect(range).toEqual({ lowUsd: 3, highUsd: 3.6 })
})

test('ユーザーの中断（aborted）は、Haiku / Sonnet の low effort でも不足として指摘しない', () => {
  // Arrange
  const aborted = (turnId: string, model: string) => turn({ turnId, model, effort: 'low', toolCount: 0, reason: 'aborted' })
  const records = [aborted('a1', 'claude-sonnet-5-5'), aborted('a2', 'claude-sonnet-5-5'), aborted('a3', 'claude-haiku-5-5')]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'underspec')).toBeUndefined()
})

test('不足の境界: ツール 10 回と 120 秒ちょうどで指摘し、9 回・119.999 秒では指摘しない', () => {
  // Arrange
  const haiku = (turnId: string, overrides: Partial<TurnRecord>) =>
    turn({ turnId, model: 'claude-haiku-5-5', effort: 'low', ...overrides })
  const hit = [
    haiku('tools-10', { toolCount: 10 }),
    haiku('time-120', { toolCount: MIN_TOOLS_FOR_DURATION_HEAVY, durationMs: 120_000 }),
  ]
  const miss = [
    haiku('tools-9', { toolCount: 9 }),
    haiku('time-under', { toolCount: MIN_TOOLS_FOR_DURATION_HEAVY, durationMs: 119_999 }),
  ]

  // Act
  const hitCount = findConcerns(hit).find(concern => concern.kind === 'underspec')?.count
  const missConcern = findConcerns(miss).find(concern => concern.kind === 'underspec')

  // Assert
  expect(hitCount).toBe(2)
  expect(missConcern).toBeUndefined()
})

test('ツールが少なく時間だけ長いターンは、Haiku の低 effort でも不足として重い作業にしない（承認待ちの誤検出）', () => {
  // Arrange: 時間は閾値ちょうどだが、ツールは MIN_TOOLS_FOR_DURATION_HEAVY 未満。
  const idle = (turnId: string) =>
    turn({ turnId, model: 'claude-haiku-5-5', effort: 'low', toolCount: MIN_TOOLS_FOR_DURATION_HEAVY - 1, durationMs: LONG_TURN_MS })
  const records = [idle('idle-1'), idle('idle-2')]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(concerns.find(concern => concern.kind === 'underspec')).toBeUndefined()
})

test('ツールが MIN_TOOLS_FOR_DURATION_HEAVY 回以上で、時間が閾値以上なら重い作業として不足に数える', () => {
  // Arrange
  const busy = (turnId: string) =>
    turn({ turnId, model: 'claude-haiku-5-5', effort: 'low', toolCount: MIN_TOOLS_FOR_DURATION_HEAVY, durationMs: LONG_TURN_MS })
  const records = [busy('busy-1'), busy('busy-2')]

  // Act
  const underspec = findConcerns(records).find(concern => concern.kind === 'underspec')

  // Assert
  expect(underspec?.count).toBe(2)
})

test('過剰・不足・サブの件数には全ターン数を母数として付け、切替・委譲には付けない', () => {
  // Arrange: 過剰 3 件 + 通常 7 件。
  const records = [
    ...repeat(3, index => turn({ turnId: `o${index}`, model: 'claude-opus-5-5', effort: 'medium', costUsd: 0.5, sonnetCostUsd: 0.25 })),
    ...repeat(7, index => turn({ turnId: `n${index}`, toolCount: 5 })),
  ]

  // Act
  const overspec = findConcerns(records).find(concern => concern.kind === 'overspec')

  // Assert
  expect(overspec).toMatchObject({ count: 3, outOf: 10 })
  const withSwitch = findConcerns([turn({ turnId: 'a' }), turn({ turnId: 'b', model: 'claude-opus-5-5', toolCount: 5 })])
  expect(withSwitch.find(concern => concern.kind === 'switch')?.outOf).toBeUndefined()
})

test('過剰の例には、そのグループの直近のターン番号を出す', () => {
  // Arrange
  const records = repeat(4, index => turn({ turnId: `t${index}`, model: 'claude-opus-5-5', effort: 'medium', costUsd: 0.5, sonnetCostUsd: 0.25 }))

  // Act
  const overspec = findConcerns(records).find(concern => concern.kind === 'overspec')

  // Assert
  expect(overspec?.examples[0]).toContain('直近 ターン t3')
})

test('不足の例は新しいターンから順に並べ、直近の 3 件が残る', () => {
  // Arrange
  const records = repeat(5, index => turn({ turnId: `h${index}`, model: 'claude-haiku-5-5', effort: 'low', toolCount: 12 }))

  // Act
  const underspec = findConcerns(records).find(concern => concern.kind === 'underspec')

  // Assert
  expect(underspec?.count).toBe(5)
  expect(underspec?.examples.map(line => line.match(/ターン (h\d)/)?.[1])).toEqual(['h4', 'h3', 'h2'])
})

test('重い作業が大半のグループに短い応答が混ざっていても、過剰として指摘しない', () => {
  // Arrange: Opus / medium の 10 ターン中、軽作業は 3 件（30%）だけ。
  const records = [
    ...repeat(MIN_OVERSPEC_TURNS, index => turn({ turnId: `short${index}`, model: 'claude-opus-5-5', effort: 'medium', costUsd: 0.5, sonnetCostUsd: 0.25 })),
    ...repeat(7, index => turn({ turnId: `work${index}`, model: 'claude-opus-5-5', effort: 'medium', toolCount: 20, editCount: 5 })),
  ]

  // Act
  const concerns = findConcerns(records)

  // Assert
  expect(3 / 10).toBeLessThan(OVERSPEC_MIN_LIGHT_SHARE)
  expect(concerns.find(concern => concern.kind === 'overspec')).toBeUndefined()
})

test('軽作業がグループの半数以上なら、過剰として指摘する（境界）', () => {
  // Arrange: 3 件 / 6 ターン = 50%。
  const records = [
    ...repeat(MIN_OVERSPEC_TURNS, index => turn({ turnId: `short${index}`, model: 'claude-opus-5-5', effort: 'medium', costUsd: 0.5, sonnetCostUsd: 0.25 })),
    ...repeat(3, index => turn({ turnId: `work${index}`, model: 'claude-opus-5-5', effort: 'medium', toolCount: 20 })),
  ]

  // Act / Assert
  expect(findConcerns(records).find(concern => concern.kind === 'overspec')).toMatchObject({ count: 3 })
})

test('編集が多い実装中心の窓では、ツールが多くても委譲の指摘はしない', () => {
  // Arrange: ツール 30 回のうち編集 10 回（33%）。
  const records = [turn({ toolCount: MAIN_DELEGATION_MIN_TOOL_CALLS, editCount: 10 })]

  // Act / Assert
  expect(10 / MAIN_DELEGATION_MIN_TOOL_CALLS).toBeGreaterThan(DELEGATION_MAX_EDIT_SHARE)
  expect(findConcerns(records).find(concern => concern.kind === 'delegation')).toBeUndefined()
})

test('編集の割合が上限ちょうどなら、委譲を確認する（境界）', () => {
  // Arrange: ツール 30 回のうち編集 6 回（20%）。
  const records = [turn({ toolCount: MAIN_DELEGATION_MIN_TOOL_CALLS, editCount: 6 })]

  // Act / Assert
  expect(findConcerns(records).find(concern => concern.kind === 'delegation')).toMatchObject({ count: 1 })
})

test('数値の effort は過剰の判定に入らず、文字列の effort とは別のグループに分かれる', () => {
  // Arrange
  const numeric = repeat(MIN_OVERSPEC_TURNS, () => turn({ model: 'claude-opus-5-5', effort: effortToRecord(32000), toolCount: 0 }))
  const text = [turn({ model: 'claude-opus-5-5', effort: '32000', toolCount: 0 })]

  // Act
  const concerns = findConcerns(numeric)
  const groups = groupByModelEffort([...numeric, ...text])

  // Assert
  expect(concerns.find(concern => concern.kind === 'overspec')?.overspec?.mainEffortModels ?? []).toEqual([])
  expect(groups).toHaveLength(2)
  expect(groups.map(group => group.effort)).toContain(effortToRecord(32000))
  expect(groups.map(group => group.effort)).toContain('32000')
})
