import { test, expect } from 'claude-code/testing'

import { analyze, render, fmt, type Snapshot } from './analyze'

// 架空データのみ。
const base: Snapshot = {
  percentage: 10,
  totalTokens: 20_000,
  maxTokens: 200_000,
  categories: [],
  mcpTools: [],
  memoryFiles: [],
  agents: [],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 160_000,
}
const issues = (s: Snapshot) => analyze(s).map(f => f.observation).join('\n')

test('A: 余裕があり内訳も小さいとき所見なし', () => {
  expect(analyze(base)).toEqual([])
})

test('B: MCP が多いとき上位3サーバーを示す', () => {
  const tools = ['s1', 's2', 's3', 's4'].flatMap((serverName, i) =>
    Array.from({ length: 10 }, () => ({ serverName, tokens: 700 - i * 100, isLoaded: true })))
  const f = analyze({ ...base, mcpTools: tools })[0]
  expect(f?.level).toBe('mid')
  expect(f?.observation).toContain('s1 7,000')
  expect(f?.observation).not.toContain('s4')
})

test('C: 未ロード MCP は mid にならず info の別行になる', () => {
  const tools = Array.from({ length: 60 }, () => ({ serverName: 'big', tokens: 500, isLoaded: false }))
  const res = analyze({ ...base, mcpTools: tools })
  expect(res.map(f => f.level)).toEqual(['info'])
  expect(res[0]?.observation).toContain('未ロード')
})

test('D: 自動圧縮の基準を超過したとき超過文言で high', () => {
  const f = analyze({ ...base, totalTokens: 170_000, percentage: 85 })[0]
  expect(f?.level).toBe('high')
  expect(f?.observation).toContain('超えている')
  expect(f?.suggestion).toContain('/compact')
})

test('E: 自動圧縮が無効のとき文言を出し分ける', () => {
  const f = analyze({ ...base, percentage: 85, isAutoCompactEnabled: false, autoCompactThreshold: undefined })[0]
  expect(f?.observation).toContain('自動圧縮は無効')
})

test('F: 基準が遠ければ使用率が高めでも所見なし（固定80%に依存しない）', () => {
  expect(analyze({ ...base, totalTokens: 152_000, percentage: 76, autoCompactThreshold: 190_000 })).toEqual([])
})

test('F2: 基準まで残りわずかなら high で残量を示す', () => {
  const f = analyze({ ...base, totalTokens: 155_000, percentage: 78 })[0]
  expect(f?.level).toBe('high')
  expect(f?.observation).toContain('残り 5,000')
})

test('G: メモリは type 付き・ファイル名のみで上位3件', () => {
  const memoryFiles = [
    { path: '/home/u/a/CLAUDE.md', type: 'Project', tokens: 8000 },
    { path: '/home/u/.claude/rules/x.md', type: 'User', tokens: 4000 },
    { path: '/home/u/m/y.md', type: 'AutoMem', tokens: 2000 },
    { path: '/home/u/m/z.md', type: 'AutoMem', tokens: 100 },
  ]
  const text = issues({ ...base, memoryFiles })
  expect(text).toContain('CLAUDE.md（Project）8,000')
  expect(text).not.toContain('/home')
  expect(text).not.toContain('z.md')
})

test('H: 大きい窓でも絶対量が大きければ指摘する', () => {
  const s = { ...base, maxTokens: 1_000_000, totalTokens: 50_000, autoCompactThreshold: 900_000 }
  expect(issues({ ...s, mcpTools: [{ serverName: 'a', tokens: 20_000, isLoaded: true }] })).toContain('MCP')
  expect(issues({ ...s, memoryFiles: [{ path: '/x/M.md', type: 'User', tokens: 20_000 }] })).toContain('メモリ')
})

test('I: 112% 超過でも high 1件で超過文言', () => {
  const res = analyze({ ...base, totalTokens: 224_000, percentage: 112 })
  expect(res.filter(f => f.level === 'high')).toHaveLength(1)
  expect(res[0]?.observation).toContain('超えている')
})

test('J: maxTokens=0 でも例外なく所見なし', () => {
  expect(analyze({ ...base, maxTokens: 0, totalTokens: 0, percentage: 0 })).toEqual([])
})

test('K: 境界 メモリがちょうど窓の5%で指摘、直前は指摘しない', () => {
  const mk = (tokens: number) => ({ ...base, memoryFiles: [{ path: '/x/M.md', type: 'User', tokens }] })
  expect(analyze(mk(10_000))).toHaveLength(1)
  expect(analyze(mk(9_999))).toHaveLength(0)
})

test('skills 切り捨てあり/なしを info 行で示す', () => {
  const cut = analyze({ ...base, skills: { totalSkills: 50, includedSkills: 30, tokens: 4000 } })[0]
  expect(cut?.observation).toContain('30/50')
  expect(cut?.observation).toContain('切り捨て')
  const ok = analyze({ ...base, skills: { totalSkills: 5, includedSkills: 5, tokens: 400 } })[0]
  expect(ok?.observation).not.toContain('切り捨て')
})

test('agents と slashCommands の info 行', () => {
  const res = analyze({
    ...base,
    agents: [{ tokens: 100 }, { tokens: 200 }],
    slashCommands: { totalCommands: 20, includedCommands: 20, tokens: 900 },
  })
  expect(res.map(f => f.level)).toEqual(['info', 'info'])
  expect(res[0]?.observation).toContain('2 件（300')
})

test('重大度順に並ぶ（high → mid → info）', () => {
  const res = analyze({
    ...base,
    totalTokens: 170_000,
    agents: [{ tokens: 1 }],
    mcpTools: [{ serverName: 'a', tokens: 30_000, isLoaded: true }],
  })
  expect(res.map(f => f.level)).toEqual(['high', 'mid', 'info'])
})

test('render: 推定値・桁区切り・日本語ラベル・観察/仮説・free/buffer', () => {
  const s: Snapshot = {
    ...base,
    totalTokens: 170_000,
    percentage: 85,
    categories: [
      { name: 'Messages', tokens: 100_000, kind: 'used' },
      { name: 'System prompt', tokens: 8000, kind: 'used' },
      { name: 'Free space', tokens: 15_000, kind: 'free' },
      { name: 'Autocompact buffer', tokens: 40_000, kind: 'buffer' },
    ],
  }
  const text = render(s, analyze(s))
  expect(text).toContain('推定値')
  expect(text).toContain('170,000/200,000')
  expect(text).toContain('[要対応]')
  expect(text).toContain('観察:')
  expect(text).toContain('仮説:')
  expect(text).toContain('Messages 100,000')
  expect(text).toContain('空き 15,000')
  expect(text).toContain('圧縮バッファ 40,000')
  expect(text).toContain('仮置き')
})

test('render: 所見なしでも内訳を表示', () => {
  expect(render(base, [])).toContain('所見なし')
})

test('fmt: 桁区切り', () => {
  expect(fmt(1234567)).toBe('1,234,567')
  expect(fmt(12)).toBe('12')
})

test('ペイン用の headline / action / tokens: メモリ・MCP・圧縮点', () => {
  const mem = analyze({ ...base, memoryFiles: [{ path: '/x/M.md', type: 'User', tokens: 21_400 }] })[0]
  expect(mem?.headline).toBe('メモリ 21,400（11%）')
  expect(mem?.shortHeadline).toBe('メモリ 21,400 (11%)')
  expect(mem?.action).toBe('長文を参照ファイルへ切り出す')
  expect(mem?.tokens).toBe(21_400)

  const mcp = analyze({ ...base, mcpTools: [{ serverName: 'github', tokens: 12_000, isLoaded: true }, { serverName: 'b', tokens: 8_500, isLoaded: true }] })[0]
  expect(mcp?.headline).toBe('MCP 20,500（10%）上位 github 12,000')
  expect(mcp?.shortAction).toBe('/mcp で要否確認')
  expect(mcp?.tokens).toBe(20_500)

  const over = analyze({ ...base, totalTokens: 170_000, percentage: 85 })[0]
  expect(over?.headline).toBe('圧縮点を 10,000 超過')
  expect(over?.action).toContain('/compact')
  expect(over?.tokens).toBeUndefined()
})
