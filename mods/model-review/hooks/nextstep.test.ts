import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { findConcerns, type Concern, type ConcernKind } from './analyze'
import { MAX_RECOVERABLE_TURNS, NEXT_STEP_PREFIX, nextStepText } from './nextstep'

// 架空データのみ。既定値は Opus 5.5 / medium の軽作業 1 ターン（Sonnet なら 1 ターンあたり $0.02 安い）。
const repeat = (count: number, make: (index: number) => TurnRecord): TurnRecord[] =>
  Array.from({ length: count }, (_, index) => make(index))

const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 'turn-x',
  agentId: null,
  model: 'claude-opus-5-5',
  effort: 'medium',
  tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 1_000 },
  costUsd: 0.05,
  sonnetCostUsd: 0.03,
  haikuCostUsd: 0.01,
  toolCount: 0,
  editCount: 0,
  durationMs: 1_000,
  reason: 'answer',
  firstStepCacheWrite: 1_000,
  firstStepPromptTokens: 2_000,
  ...overrides,
})

const concernOf = (records: readonly TurnRecord[], kind: ConcernKind): Concern => {
  const concern = findConcerns(records).find(item => item.kind === kind)
  if (concern === undefined) throw new Error(`${kind} の指摘が出ていない`)
  return concern
}

const ASSERTIVE_WORDS = ['すべき', 'してください', '必ず', '必要があります']

test('モデル起因の過剰（メイン）は Sonnet への切替を、1 ターンの差額・再構築・回収ターン数つきで候補にする', () => {
  // Arrange: 書込 1,000 tokens なら Sonnet への再構築は 1 ターンの節約（$0.02）で回収できる。
  const records = repeat(3, index => turn({ turnId: `t${index}` }))

  // Act
  const text = nextStepText(concernOf(records, 'overspec'), records)

  // Assert
  expect(text).toBe(`${NEXT_STEP_PREFIX}軽作業が続くあいだは /model sonnet で Sonnet へ（1 ターンあたり約 -$0.0200、再構築 +$0.0024・約 1 ターンで回収の目安）`)
})

test('回収に MAX_RECOVERABLE_TURNS を超えるターンがかかるときは「切替の元は取りにくい」と添える', () => {
  // Arrange: 書込 100,000 tokens。Sonnet への再構築 $0.24 を $0.02/ターンで回収するには 12 ターン。
  const records = repeat(3, index =>
    turn({ turnId: `t${index}`, firstStepCacheWrite: 100_000, firstStepPromptTokens: 100_000 }),
  )

  // Act
  const text = nextStepText(concernOf(records, 'overspec'), records)

  // Assert
  expect(text).toContain('再構築 +$0.2400・約 12 ターンで回収の目安')
  expect(text).toContain(`${MAX_RECOVERABLE_TURNS} ターンを超えるので切替の元は取りにくい`)
})

test('再構築コストを見積もれる記録がないときは、回収の見込みを出せないと書く', () => {
  // Arrange: firstStepCacheWrite のない旧記録だけ。
  const records = repeat(3, index => turn({ turnId: `t${index}`, firstStepCacheWrite: undefined }))

  // Act
  const text = nextStepText(concernOf(records, 'overspec'), records)

  // Assert
  expect(text).toContain('再構築の目安は出せません')
  expect(text).not.toContain('回収の目安')
})

test('直近のメインがすでに Sonnet なら、切替ではなく対応不要かもしれないと書く', () => {
  // Arrange: Opus の軽作業 3 件の後で Sonnet に切り替えた。
  const records = [
    ...repeat(3, index => turn({ turnId: `t${index}` })),
    turn({ turnId: 'after', model: 'claude-sonnet-5-5', sonnetCostUsd: 0.03, costUsd: 0.03, toolCount: 10 }),
  ]

  // Act
  const text = nextStepText(concernOf(records, 'overspec'), records)

  // Assert
  expect(text).toBe(`${NEXT_STEP_PREFIX}直近のメインはすでに Sonnet 以下（見直し済みなら対応不要）`)
})

test('サブエージェントのモデル起因の過剰は、サブエージェント定義の model を候補にする', () => {
  const records = repeat(3, index => turn({ turnId: `s${index}`, agentId: 'agent-1' }))

  const text = nextStepText(concernOf(records, 'overspec'), records)

  expect(text).toBe(`${NEXT_STEP_PREFIX}サブエージェントは定義の model を sonnet / haiku に`)
})

test('effort 起因の過剰は effort を下げる候補にし、キャッシュが維持されるモデルならそう書く', () => {
  // Arrange: Sonnet 5.5 / xhigh の軽作業（モデル起因にはならない）。
  const records = repeat(3, index =>
    turn({ turnId: `t${index}`, model: 'claude-sonnet-5-5', effort: 'xhigh', costUsd: 0.03 }),
  )

  const text = nextStepText(concernOf(records, 'overspec'), records)

  expect(text).toBe(`${NEXT_STEP_PREFIX}/effort high などで effort を high 以下へ（このモデルは effort を変えてもキャッシュは維持される）`)
})

test('キャッシュ維持の一覧にないモデルの effort 起因では、再構築の可能性を書く', () => {
  // Arrange: Bedrock 表記の Sonnet は維持の一覧外。
  const records = repeat(3, index =>
    turn({ turnId: `t${index}`, model: 'us.anthropic.claude-sonnet-5-5', effort: 'max', costUsd: 0.03 }),
  )

  const text = nextStepText(concernOf(records, 'overspec'), records)

  expect(text).toContain('モデルによっては effort の変更でキャッシュを再構築する')
})

test('モデル起因と effort 起因が両方あるときは、両方の候補を「 / 」でつなぐ', () => {
  const records = repeat(3, index => turn({ turnId: `t${index}`, effort: 'max' }))

  const text = nextStepText(concernOf(records, 'overspec'), records) ?? ''

  expect(text.startsWith(`${NEXT_STEP_PREFIX}軽作業が続くあいだは /model sonnet`)).toBe(true)
  expect(text).toContain(' / /effort high などで effort を high 以下へ')
})

test('不足は該当した条件に応じて、effort を上げる・Sonnet 以上へを候補にする', () => {
  // Arrange: Haiku / low の重いターン 2 件と、Sonnet / low のエラー連続 1 エピソード。
  const haiku = repeat(2, index =>
    turn({ turnId: `h${index}`, model: 'claude-haiku-5-5', effort: 'low', toolCount: 12, costUsd: 0.01 }),
  )
  const sonnetErrors = repeat(2, index =>
    turn({ turnId: `e${index}`, model: 'claude-sonnet-5-5', effort: 'low', reason: 'error', toolCount: 5 }),
  )

  // Act
  const haikuOnly = nextStepText(concernOf(haiku, 'underspec'), haiku)
  const both = nextStepText(concernOf([...haiku, ...sonnetErrors], 'underspec'), [...haiku, ...sonnetErrors])

  // Assert
  expect(haikuOnly).toBe(`${NEXT_STEP_PREFIX}Haiku / low の重い作業は effort を上げるか /model sonnet 以上へ`)
  expect(both).toContain(' / Sonnet / low のエラー連続は /effort medium 以上へ')
})

test('委譲・サブ・切替はそれぞれ決まった候補を返す', () => {
  const delegation: Concern = { kind: 'delegation', count: 1, examples: [], amountUsd: null }
  const subagent: Concern = { kind: 'subagent', count: 3, examples: [], amountUsd: 1 }
  const switching: Concern = { kind: 'switch', count: 2, examples: [], amountUsd: 0.5 }

  expect(nextStepText(delegation, [])).toContain('Explore などのサブエージェントへ')
  expect(nextStepText(subagent, [])).toContain('サブエージェントの定義で model を haiku / sonnet に')
  expect(nextStepText(switching, [])).toBe(`${NEXT_STEP_PREFIX}切替はまとめて行う（往復のたびにキャッシュを再構築）`)
})

test('材料（facts）のない過剰・不足は、何も言えないので null を返す', () => {
  expect(nextStepText({ kind: 'overspec', count: 3, examples: [], amountUsd: null }, [])).toBeNull()
  expect(nextStepText({ kind: 'underspec', count: 2, examples: [], amountUsd: null }, [])).toBeNull()
})

test('どの候補も「候補: 」で始まり、断定・指示の言い回しを含まない', () => {
  // Arrange: 種類ごとに候補が出る記録を集める。
  const overspecRecords = repeat(3, index => turn({ turnId: `t${index}`, effort: 'max', firstStepCacheWrite: 100_000 }))
  const texts = [
    nextStepText(concernOf(overspecRecords, 'overspec'), overspecRecords),
    ...(['delegation', 'subagent', 'switch'] as const).map(kind =>
      nextStepText({ kind, count: 1, examples: [], amountUsd: null }, []),
    ),
    nextStepText({ kind: 'underspec', count: 2, examples: [], amountUsd: null, underspec: { haikuLow: true, sonnetLow: true } }, []),
  ]

  // Assert
  for (const text of texts) {
    expect(text?.startsWith(NEXT_STEP_PREFIX)).toBe(true)
    for (const word of ASSERTIVE_WORDS) expect(text).not.toContain(word)
  }
})
