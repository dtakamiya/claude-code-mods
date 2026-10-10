import { test, expect } from 'claude-code/testing'

import { formatBell, shouldNotify, THRESHOLD_MS } from './analyze'

// 架空値のみ。閾値は既定 30000ms（仮置き）。
const turn = (durationMs: number, extra: { isAborted?: boolean; agentId?: string } = {}) => ({
  durationMs,
  isAborted: false,
  ...extra,
})

test('既定の閾値は 30000ms', () => {
  expect(THRESHOLD_MS).toBe(30000)
})

test('閾値ちょうど（30000）は通知する', () => {
  expect(shouldNotify(turn(30000))).toBe(true)
})

test('閾値未満（29999）は通知しない', () => {
  expect(shouldNotify(turn(29999))).toBe(false)
})

test('中断されたターンは通知しない', () => {
  expect(shouldNotify(turn(90000, { isAborted: true }))).toBe(false)
})

test('サブエージェントのターンは通知しない', () => {
  expect(shouldNotify(turn(90000, { agentId: 'agent-1' }))).toBe(false)
})

test('agentId が空文字でも通知しない', () => {
  expect(shouldNotify(turn(90000, { agentId: '' }))).toBe(false)
})

test('0・負・NaN・Infinity は通知しない', () => {
  expect(shouldNotify(turn(0))).toBe(false)
  expect(shouldNotify(turn(-1))).toBe(false)
  expect(shouldNotify(turn(NaN))).toBe(false)
  expect(shouldNotify(turn(Infinity))).toBe(false)
})

test('閾値を引数で変えられる', () => {
  expect(shouldNotify(turn(5000), 5000)).toBe(true)
  expect(shouldNotify(turn(4999), 5000)).toBe(false)
})

test('30499ms は 30 秒、30500ms は 31 秒と表示する', () => {
  expect(formatBell(30499)).toBe('ターン完了（30秒）')
  expect(formatBell(30500)).toBe('ターン完了（31秒）')
})

test('90000ms は 1分30秒と表示する', () => {
  expect(formatBell(90000)).toBe('ターン完了（1分30秒）')
})

test('59 秒台の繰り上がりは 1分0秒になる', () => {
  expect(formatBell(59500)).toBe('ターン完了（1分0秒）')
})
