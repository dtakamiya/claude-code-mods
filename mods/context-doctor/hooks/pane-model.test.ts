import { test, expect } from 'claude-code/testing'

import { analyze, type Finding, type Snapshot } from './analyze'
import { NARROW_BODY_COLUMNS, WIDE_BODY_COLUMNS, buildPaneRows } from './pane-model'
import { displayWidth } from './pane-text'
import type { PaneView } from '../types'

// 架空データのみ。窓 200,000・使用 150,000・圧縮点 167,000・バッファ 33,000。
const snapshot: Snapshot = {
  percentage: 75,
  totalTokens: 150_000,
  maxTokens: 200_000,
  categories: [
    { name: 'システムプロンプト', tokens: 8_000, kind: 'used' },
    { name: 'システムツール', tokens: 16_500, kind: 'used' },
    { name: 'MCP ツール', tokens: 20_500, kind: 'used' },
    { name: 'メモリファイル', tokens: 21_400, kind: 'used' },
    { name: 'スキル', tokens: 5_700, kind: 'used' },
    { name: 'エージェント', tokens: 3_300, kind: 'used' },
    { name: 'メッセージ', tokens: 74_600, kind: 'used' },
    { name: '空き', tokens: 17_000, kind: 'free' },
    { name: '圧縮バッファ', tokens: 33_000, kind: 'buffer' },
    { name: '遅延ツール', tokens: 12_000, kind: 'deferred' },
  ],
  mcpTools: [{ serverName: 'github', tokens: 12_000, isLoaded: true }, { serverName: 'jira', tokens: 8_500, isLoaded: true }],
  memoryFiles: [{ path: '/x/CLAUDE.md', type: 'Project', tokens: 21_400 }],
  skills: { totalSkills: 40, includedSkills: 40, tokens: 5_700 },
  agents: [{ tokens: 3_300 }],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 167_000,
}
const measuredAtMs = new Date(2026, 0, 1, 14, 5).getTime()
const view: PaneView = { v: 1, status: 'ok', snapshot, measuredAtMs }
const findings = analyze(snapshot)
const texts = (rows: readonly { text: string; label?: string; tail?: string }[]) =>
  rows.map(r => [r.label, r.text, r.tail].filter(Boolean).join(' ')).join('\n')
const kinds = (rows: readonly { kind: string }[]) => rows.map(r => r.kind)
const wide = (extra = {}) => buildPaneRows({ view, findings, bodyColumns: WIDE_BODY_COLUMNS, ...extra })

test('並びは バー → 所見 → 内訳 → 脚注', () => {
  const rows = wide()
  const at = (kind: string, text?: string) => rows.findIndex(r => r.kind === kind && (text === undefined || r.text.startsWith(text)))
  expect(at('bar')).toBeLessThan(at('heading', '所見'))
  expect(at('heading', '所見')).toBeLessThan(at('heading', '内訳'))
  expect(at('heading', '内訳')).toBeLessThan(rows.findIndex(r => r.text.startsWith('測定')))
})

test('広め: 使用率・段階ラベル・圧縮点までが 1 行、凡例にバッファを出す', () => {
  const rows = wide()
  expect(rows[0]).toMatchObject({ kind: 'usage', label: '[注意]', tail: '圧縮点まで 17,000', stage: 'warn' })
  expect(rows[0]?.text).toBe('75% 使用  150,000 / 200,000 トークン（推定）')
  expect(rows.find(r => r.kind === 'legend')?.text).toContain('┃圧縮点 167,000')
  expect(rows.find(r => r.kind === 'legend')?.text).toContain('░バッファ 33,000')
})

test('所見: 回収トークン降順の見出し＋アクション。広めは 1 行に連結', () => {
  const rows = wide().filter(r => r.kind === 'finding')
  expect(rows.map(r => r.text.trim())).toEqual(['メモリ 21,400（11%）', 'MCP 20,500（10%）上位 github 12,000'])
  expect(rows[0]?.tail).toBe('長文を参照ファイルへ切り出す')
  expect(rows.every(r => r.label === '[注意]')).toBe(true)
  expect(new Set(rows.map(r => displayWidth(r.text))).size).toBe(1)
})

test('所見: 通常幅は見出し行とアクション行に分かれる。仮説は出さない', () => {
  const rows = buildPaneRows({ view, findings, bodyColumns: 48 })
  const i = rows.findIndex(r => r.kind === 'finding')
  expect(rows[i]?.tail).toBeUndefined()
  expect(rows[i + 1]).toMatchObject({ kind: 'action', text: '長文を参照ファイルへ切り出す' })
  expect(texts(rows)).not.toContain('常時読み込みが長いほど')
})

test('所見: high が先頭。mid は回収トークン降順。上限 3 件', () => {
  const many: Finding[] = [
    { level: 'mid', observation: 'a', tokens: 100 },
    { level: 'mid', observation: 'b', tokens: 300 },
    { level: 'high', observation: 'c' },
    { level: 'mid', observation: 'd', tokens: 200 },
    { level: 'info', observation: 'e' },
  ]
  const rows = buildPaneRows({ view, findings: many, bodyColumns: 48 }).filter(r => r.kind === 'finding')
  expect(rows.map(r => r.text)).toEqual(['c', 'b', 'd'])
  expect(rows[0]).toMatchObject({ label: '[要対応]', level: 'high' })
})

test('所見が無いとき「所見なし」', () => {
  expect(texts(wide({ findings: [] }))).toContain('所見なし（今すぐ効く対応はありません）')
})

test('内訳: used・free・buffer を降順で全件（deferred は降順に混ぜない）', () => {
  const items = wide().filter(r => r.kind === 'item')
  expect(items.map(r => /^(.+?)\s+[\d,]+\s+\d+%$/.exec(r.text)?.[1])).toEqual([
    'メッセージ', '圧縮バッファ', 'メモリファイル', 'MCP ツール', '空き', 'システムツール', 'システムプロンプト', 'スキル', 'エージェント',
  ])
  expect(items[0]?.text).toContain('74,600')
  expect(items[0]?.text).toContain('37%')
  expect(items[0]).toMatchObject({ itemKind: 'used', barLen: 6 })
  expect(items[1]).toMatchObject({ itemKind: 'buffer', barLen: 3 })
  expect(items[4]).toMatchObject({ itemKind: 'free', barLen: 1 })
})

test('内訳: 名前列は表示幅でそろい、行の幅も全行同じ', () => {
  const widths = new Set(wide().filter(r => r.kind === 'item').map(r => displayWidth(r.text)))
  expect(widths.size).toBe(1)
})

test('内訳: 窓外（deferred）は別行', () => {
  expect(texts(wide())).toContain('窓外（遅延読込） 12,000')
})

test('狭幅: バー幅は bodyColumns - 4、凡例なし、内訳は名前と割合のみ、所見は短縮 2 件まで', () => {
  const rows = buildPaneRows({ view, findings, bodyColumns: NARROW_BODY_COLUMNS - 8 })
  const bar = rows.find(r => r.kind === 'bar')
  expect(bar?.runs?.reduce((n, r) => n + r.count, 0)).toBe(28)
  expect(rows.some(r => r.kind === 'legend')).toBe(false)
  expect(rows[0]).toMatchObject({ kind: 'usage', text: '75%', label: '[注意]' })
  expect(rows.some(r => r.kind === 'note' && r.text === '圧縮点まで 17,000')).toBe(true)
  expect(rows.filter(r => r.kind === 'item').every(r => r.barLen === undefined && !r.text.includes(','))).toBe(true)
  expect(texts(rows)).toContain('メモリ 21,400 (11%)')
  expect(texts(rows)).toContain('長文を切り出す')
  expect(texts(rows)).not.toContain('窓外')
  expect(rows.at(-1)?.text).toBe('14:05 推定値')
})

test('バー幅の上限は 40（NARROW 境界ちょうどは通常）', () => {
  const rows = buildPaneRows({ view, findings, bodyColumns: NARROW_BODY_COLUMNS })
  expect(rows.find(r => r.kind === 'bar')?.runs?.reduce((n, r) => n + r.count, 0)).toBe(40)
  expect(rows.some(r => r.kind === 'legend')).toBe(true)
})

test('参考（info）は placement=dock のときだけ', () => {
  expect(texts(wide())).not.toContain('参考')
  const dock = texts(wide({ placement: 'dock' }))
  expect(dock).toContain('参考')
  expect(dock).toContain('・スキル一覧 5,700 トークン（40/40 件を掲載）')
})

test('高さ: 足りないとき 参考→窓外→脚注→凡例→所見→内訳 の順に省き、バーと所見 1 件目は残す', () => {
  const full = wide({ placement: 'dock' })
  const trimmed = (bodyRows: number) => wide({ placement: 'dock', bodyRows })
  expect(trimmed(full.length)).toEqual(full)
  expect(texts(trimmed(full.length - 1))).not.toContain('参考')
  const noRef = wide({ placement: 'dock', bodyRows: full.length - 1 })
  expect(texts(trimmed(noRef.length - 1))).not.toContain('窓外')
  expect(texts(trimmed(noRef.length - 2))).not.toContain('測定')
  const tiny = trimmed(1)
  expect(tiny.some(r => r.kind === 'bar')).toBe(true)
  expect(tiny.filter(r => r.kind === 'finding')).toHaveLength(1)
  expect(tiny.some(r => r.kind === 'legend')).toBe(false)
})

test('高さ: 内訳は下位を「他 n 件 合計 x%」に畳み、割合の合計を保つ', () => {
  const rows = wide({ bodyRows: 14 })
  expect(rows.length).toBeLessThanOrEqual(14)
  const fold = rows.find(r => r.text.startsWith('他 '))
  expect(fold).toBeDefined()
  const shown = rows.filter(r => r.kind === 'item').map(r => Number(/(\d+)%/.exec(r.text)?.[1]))
  const foldPct = Number(/合計 (\d+)%/.exec(fold?.text ?? '')?.[1])
  // 各割合は四捨五入なので、合計は 100% から 1 ずれることがある。
  expect(Math.abs(shown.reduce((a, b) => a + b, 0) + foldPct - 100)).toBeLessThanOrEqual(1)
})

test('空・版違い・Snapshot なしは案内の 1 行', () => {
  const message = [{ kind: 'message', text: 'まだ内訳がありません（最初の応答後に開き直してください）' }]
  expect(buildPaneRows({ view: { v: 1, status: 'empty' }, findings, bodyColumns: 80 })).toEqual(message)
  expect(buildPaneRows({ view: { ...view, v: 2 } as unknown as PaneView, findings, bodyColumns: 80 })).toEqual(message)
  expect(buildPaneRows({ view: { v: 1, status: 'ok' }, findings, bodyColumns: 80 })).toEqual(message)
})

test('自動圧縮が無効: 余裕・圧縮点を出さず、無効の旨を出す', () => {
  const off: PaneView = { ...view, snapshot: { ...snapshot, isAutoCompactEnabled: false } }
  const rows = buildPaneRows({ view: off, findings: [], bodyColumns: WIDE_BODY_COLUMNS })
  expect(rows[0]?.tail).toBe('自動圧縮は無効（80% で要対応・仮置き）')
  expect(rows.find(r => r.kind === 'legend')?.text).not.toContain('圧縮点')
  expect(rows.find(r => r.kind === 'bar')?.runs?.some(r => r.kind === 'compact' || r.kind === 'margin')).toBe(false)
})

test('超過: 段階 over と超過量', () => {
  const over: PaneView = { ...view, snapshot: { ...snapshot, totalTokens: 175_000, percentage: 88 } }
  const rows = buildPaneRows({ view: over, findings: [], bodyColumns: WIDE_BODY_COLUMNS })
  expect(rows[0]).toMatchObject({ label: '[超過]', tail: '圧縮点を 8,000 超過', stage: 'over' })
})

test('maxTokens=0 でも NaN を出さない', () => {
  const zero: PaneView = { ...view, snapshot: { ...snapshot, maxTokens: 0, totalTokens: 0, percentage: 0 } }
  const out = texts(buildPaneRows({ view: zero, findings: [], bodyColumns: WIDE_BODY_COLUMNS }))
  expect(out).not.toContain('NaN')
  expect(out).not.toContain('Infinity')
})

test('測定時刻が無ければ「測定」を出さない', () => {
  const noTime: PaneView = { v: 1, status: 'ok', snapshot }
  expect(buildPaneRows({ view: noTime, findings, bodyColumns: WIDE_BODY_COLUMNS }).at(-1)?.text).toBe('推定値 ・しきい値は仮置き')
})

test('入力を変更しない', () => {
  const before = JSON.stringify({ view, findings })
  wide({ placement: 'dock', bodyRows: 10 })
  expect(JSON.stringify({ view, findings })).toBe(before)
})
