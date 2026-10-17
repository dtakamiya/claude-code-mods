import { test, expect } from 'claude-code/testing'

import { effortText, effortToRecord, isNumericEffort, numericEffortNote } from './effort'
import type { TurnRecord } from '../types'

const turnWith = (effort: string | null): TurnRecord => ({ effort }) as TurnRecord

test('数値の effort は n: 付きで残し、文字列は変えず、未指定は null', () => {
  expect(effortToRecord(32000)).toBe('n:32000')
  expect(effortToRecord('high')).toBe('high')
  expect(effortToRecord(undefined)).toBeNull()
})

test('数値の effort は文字列の "32000" とも別物として判定する', () => {
  expect(isNumericEffort('n:32000')).toBe(true)
  expect(isNumericEffort('32000')).toBe(false)
  expect(isNumericEffort('high')).toBe(false)
  expect(isNumericEffort(null)).toBe(false)
})

test('表示は「数値 32000」と書き、なければ - を返す', () => {
  expect(effortText('n:32000')).toBe('数値 32000')
  expect(effortText('xhigh')).toBe('xhigh')
  expect(effortText(null)).toBe('-')
})

test('数値の effort のターンがあるときだけ、判定に入れていない旨の注記を返す', () => {
  expect(numericEffortNote([turnWith('high'), turnWith(null)])).toBeNull()
  const note = numericEffortNote([turnWith('n:1'), turnWith('n:2'), turnWith('high')])
  expect(note).toContain('2 件')
  expect(note).toContain('読み替えません')
})
