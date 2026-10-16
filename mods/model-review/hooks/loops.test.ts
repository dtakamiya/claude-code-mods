import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { SUBAGENT_HIT_GAP, describeLoop, subagentHitRateLow, summarizeLoops } from './loops'

// 架空データのみ。
const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 't1',
  agentId: null,
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  tokens: { input: 100, output: 50, cacheRead: 800, cacheWrite: 100 },
  costUsd: 0.5,
  toolCount: 1,
  editCount: 0,
  durationMs: 1_000,
  reason: 'answer',
  ...overrides,
})

test('メインとサブエージェントに分けて、ターン数・トークン・ヒット率・コストを集計する', () => {
  // Arrange: サブエージェントは 2 種（a1 が 2 ターン、a2 が 1 ターン）。
  const records = [
    turn({ turnId: 'm1' }),
    turn({ turnId: 's1', agentId: 'a1', tokens: { input: 500, output: 10, cacheRead: 0, cacheWrite: 500 }, costUsd: 0.2 }),
    turn({ turnId: 's2', agentId: 'a1', tokens: { input: 500, output: 10, cacheRead: 500, cacheWrite: 0 }, costUsd: 0.1 }),
    turn({ turnId: 's3', agentId: 'a2', costUsd: null }),
  ]

  // Act
  const [main, sub] = summarizeLoops(records)

  // Assert
  expect(main).toMatchObject({ kind: 'main', turns: 1, agents: 0, hitRate: 0.8, costUsd: 0.5 })
  expect(sub).toMatchObject({ kind: 'subagent', turns: 3, agents: 2, unpricedTurns: 1 })
  expect(sub?.costUsd.toFixed(6)).toBe('0.300000')
  expect(sub?.tokens).toEqual({ input: 1_100, output: 70, cacheRead: 1_300, cacheWrite: 600 })
})

test('該当のターンがないループは含めず、記録がなければ空', () => {
  expect(summarizeLoops([]).length).toBe(0)
  expect(summarizeLoops([turn()]).map(summary => summary.kind)).toEqual(['main'])
})

test('ヒット率はサブエージェントがメインより 20 ポイント以上低いときだけ低いと見なす', () => {
  // Arrange: メインのヒット率 0.8。
  const main = turn()
  const lowSub = turn({ agentId: 'a1', tokens: { input: 500, output: 1, cacheRead: 100, cacheWrite: 400 } })
  const closeSub = turn({ agentId: 'a1', tokens: { input: 100, output: 1, cacheRead: 700, cacheWrite: 200 } })
  const noTokensSub = turn({ agentId: 'a1', tokens: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } })

  // Assert
  expect(SUBAGENT_HIT_GAP).toBe(0.2)
  expect(subagentHitRateLow(summarizeLoops([main, lowSub]))).toBe(true)
  expect(subagentHitRateLow(summarizeLoops([main, closeSub]))).toBe(false)
  expect(subagentHitRateLow(summarizeLoops([main, noTokensSub]))).toBe(false)
  expect(subagentHitRateLow(summarizeLoops([main]))).toBe(false)
})

test('文面はヒット率・読書トークン・推定コストを含み、サブエージェントには種類数を付ける', () => {
  // Arrange
  const [main, sub] = summarizeLoops([turn(), turn({ turnId: 's', agentId: 'a1' })])

  // Act
  const mainText = main ? describeLoop(main) : ''
  const subText = sub ? describeLoop(sub) : ''

  // Assert
  expect(mainText).toBe('ターン 1 · ヒット 80% · キャッシュ 読 800 / 書 100 · 推定 $0.5000')
  expect(subText).toContain('ターン 1（1 種）')
})
