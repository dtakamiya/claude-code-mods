import { test, expect } from 'claude-code/testing'
import { formatSwitchNotice, readNotifyOnSwitch, type PreSwitch } from './switchnotice'

// 架空データのみ。
const BASE: PreSwitch = {
  fromModel: 'claude-opus-5-5',
  toModel: 'claude-sonnet-5-5',
  contextTokens: 120_000,
  isCacheWarm: true,
  estimatedCacheWriteUsd: 0.3,
  pricing: 'catalog',
}

test('温かいキャッシュの切替は、書き直す tokens と見積りを出す', () => {
  const text = formatSwitchNotice(BASE)
  expect(text).toContain('claude-opus-5-5 → claude-sonnet-5-5')
  expect(text).toContain('120,000 tokens')
  expect(text).toContain('約 $0.30')
  expect(text).not.toContain('仮定')
})

test('キャッシュが冷えているときは出さない', () => {
  expect(formatSwitchNotice({ ...BASE, isCacheWarm: false })).toBeUndefined()
})

test('単価が既定の仮定のときは「単価は仮定」と添える', () => {
  expect(formatSwitchNotice({ ...BASE, pricing: 'default' })).toContain('単価は仮定')
})

test('同じモデルへの切替・使えない見積りは出さない', () => {
  expect(formatSwitchNotice({ ...BASE, toModel: BASE.fromModel })).toBeUndefined()
  expect(formatSwitchNotice({ ...BASE, estimatedCacheWriteUsd: Number.NaN })).toBeUndefined()
  expect(formatSwitchNotice({ ...BASE, contextTokens: -1 })).toBeUndefined()
})

test('設定 notifyOnSwitch は false のときだけ切れる', () => {
  expect(readNotifyOnSwitch({})).toBe(true)
  expect(readNotifyOnSwitch({ notifyOnSwitch: true })).toBe(true)
  expect(readNotifyOnSwitch({ notifyOnSwitch: false })).toBe(false)
})
