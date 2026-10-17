import { test, expect } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { recordSpawn, resolveAgentType, sanitizeAgentType } from './agenttype'
import { finishTurn, beginTurn } from './recorder'
import { findConcerns, summarizeAgentTypes } from './analyze'
import { loopView } from './summary'
import { buildReportLines } from './report'

// 架空データのみ。
const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 't', agentId: 'a1', model: 'claude-sonnet-5-5', effort: null,
  tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
  costUsd: 1, toolCount: 0, editCount: 0, reason: 'answer', ...overrides,
})

test('spawn → turn.complete の順: 覚えた種類が引ける', () => {
  const types = recordSpawn({}, 'a1', 'Explore')
  expect(resolveAgentType(types, 'a1')).toBe('Explore')
})

test('reload 後に途中から拾う順: 表が空でも agent.list の type で補う。なければ null', () => {
  const listed = [{ id: 'a2', type: 'general-purpose' }]
  expect(resolveAgentType({}, 'a2', listed)).toBe('general-purpose')
  expect(resolveAgentType({}, 'a9', listed)).toBeNull()
  expect(resolveAgentType({}, undefined, listed)).toBeNull()
})

test('不正な種類・id は表を変えない', () => {
  expect(recordSpawn({}, 'a1', 42)).toEqual({})
  expect(recordSpawn({}, undefined, 'Explore')).toEqual({})
  expect(sanitizeAgentType('x\ny')).toBeNull()
  expect(sanitizeAgentType('a'.repeat(65))).toBeNull()
})

test('finishTurn は種類の名前だけを記録に載せる。メインには載せない', () => {
  const drafts = beginTurn({}, { turnId: 't', agentId: 'a1' })
  const sub = finishTurn(drafts, { turnId: 't', agentId: 'a1', durationMs: 1, reason: 'answer', agentType: 'Explore' })
  const main = finishTurn({}, { turnId: 'm', durationMs: 1, reason: 'answer', agentType: 'Explore' })
  expect(sub.record.agentType).toBe('Explore')
  expect('agentType' in main.record).toBe(false)
  expect(Object.keys(sub.record).some(key => key === 'prompt' || key === 'description')).toBe(false)
})

test('種類別に集計し、種類のないターンは「種類不明」にまとめる（コストの大きい順）', () => {
  const rows = summarizeAgentTypes([
    turn({ agentType: 'Explore', costUsd: 1 }),
    turn({ agentType: 'general-purpose', costUsd: 5 }),
    turn({ agentType: 'general-purpose', costUsd: 1, model: 'claude-opus-5-5' }),
    turn({ costUsd: 2 }),
    turn({ agentId: null, costUsd: 9 }),
  ])
  expect(rows.map(row => row.type)).toEqual(['general-purpose', '種類不明', 'Explore'])
  expect(rows[0]).toMatchObject({ turns: 2, models: ['claude-sonnet-5-5', 'claude-opus-5-5'] })
})

test('ループ別の節とコピー出力に種類名は出るが、説明・プロンプトは出ない', () => {
  const records = [turn({ agentId: null, turnId: 'm' }), turn({ agentType: 'Explore' }), turn({ agentType: 'my-agent', costUsd: 3 })]
  const view = loopView(records)
  expect(view?.rows.map(row => row.label)).toEqual(['メイン', 'サブエージェント', '└ my-agent', '└ Explore'])
  const text = buildReportLines({ turns: records, sessionCostUsd: { baseline: null, current: null } }, 0, new Set()).join('\n')
  expect(text).toContain('└ Explore')
})

test('「サブ」の指摘に、コストが最も大きい種類を名前で添える。種類不明は名前にしない', () => {
  const main = turn({ agentId: null, turnId: 'm', costUsd: 1 })
  const subs = [1, 2, 3].map(i => turn({ turnId: `s${i}`, agentType: 'general-purpose', costUsd: 5 }))
  const named = findConcerns([main, ...subs]).find(c => c.kind === 'subagent')
  expect(named?.examples.join('\n')).toContain('general-purpose 3 ターン')
  const unknown = findConcerns([main, ...subs.map(s => ({ ...s, agentType: undefined } as TurnRecord))]).find(c => c.kind === 'subagent')
  expect(unknown?.examples.join('\n')).not.toContain('最も大きい種類')
})

test('種類が 1 つでも名前が分かれば行を出し、種類不明だけなら出さない', () => {
  const main = turn({ agentId: null, turnId: 'm' })
  expect(loopView([main, turn({ agentType: 'Explore' })])?.rows.map(row => row.label)).toEqual(['メイン', 'サブエージェント', '└ Explore'])
  expect(loopView([main, turn({})])?.rows.map(row => row.label)).toEqual(['メイン', 'サブエージェント'])
})
