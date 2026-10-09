// 純粋関数: 内訳 → 所見。`$` に触れない（テストしやすさと読み取り専用の保証のため）。
export type Row = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }
export type Snapshot = {
  percentage: number
  totalTokens: number
  maxTokens: number
  categories: Row[]
  mcpTools: { tokens: number }[]
  memoryFiles: { path: string; tokens: number }[]
}
export type Finding = { level: 'high' | 'mid' | 'info'; issue: string; suggestion: string }

const HIGH_PERCENT = 80
const MCP_SHARE = 0.1
const MEMORY_SHARE = 0.05

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
const share = (n: number, total: number) => (total > 0 ? n / total : 0)

export function analyze(s: Snapshot): Finding[] {
  const out: Finding[] = []
  if (s.percentage >= HIGH_PERCENT) {
    out.push({
      level: 'high',
      issue: `ウィンドウの ${s.percentage}% を使用中（自動圧縮が近い）`,
      suggestion: '区切りの良い所で /compact か /clear。長い出力を返すコマンドは避ける',
    })
  }
  const mcp = sum(s.mcpTools.map(t => t.tokens))
  if (share(mcp, s.maxTokens) >= MCP_SHARE) {
    out.push({
      level: 'mid',
      issue: `MCP ツール定義が ${mcp} トークン（窓の ${Math.round(share(mcp, s.maxTokens) * 100)}%）`,
      suggestion: '使っていない MCP サーバーを無効化する',
    })
  }
  const mem = sum(s.memoryFiles.map(f => f.tokens))
  if (share(mem, s.maxTokens) >= MEMORY_SHARE) {
    const top = [...s.memoryFiles].sort((a, b) => b.tokens - a.tokens)[0]
    out.push({
      level: 'mid',
      issue: `メモリファイルが ${mem} トークン（最大: ${top?.path ?? '-'}）`,
      suggestion: '長文は参照ファイルへ切り出し、常時読み込みを短くする',
    })
  }
  return out
}

export function render(s: Snapshot, findings: readonly Finding[]): string {
  const head = `コンテキスト ${s.percentage}%（${s.totalTokens}/${s.maxTokens} トークン）`
  if (findings.length === 0) return `${head}\n所見なし。`
  return [head, ...findings.map(f => `- [${f.level}] ${f.issue}\n  → ${f.suggestion}`)].join('\n')
}
