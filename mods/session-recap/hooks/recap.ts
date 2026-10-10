// 判定ロジックは $ に触れない純粋関数。tool 名の集計だけを行い、input / 結果本文は読まない。
export type ToolUseLike = { tool: string; isError?: true }
export type MessageLike = { toolUses: readonly ToolUseLike[] }

export type ToolTally = { tool: string; calls: number; errors: number }
export type Recap = { tools: readonly ToolTally[]; totalCalls: number; totalErrors: number; messageCount: number }

/** `$.session.messages()` が返す件数の上限（型の記述）。 */
export const MESSAGE_LIMIT = 4096

export function summarize(messages: readonly MessageLike[]): Recap {
  const byTool = new Map<string, ToolTally>()
  for (const m of messages) {
    for (const use of m.toolUses) {
      const prev = byTool.get(use.tool) ?? { tool: use.tool, calls: 0, errors: 0 }
      byTool.set(use.tool, { ...prev, calls: prev.calls + 1, errors: prev.errors + (use.isError ? 1 : 0) })
    }
  }
  const tools = [...byTool.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
  return {
    tools,
    totalCalls: tools.reduce((n, t) => n + t.calls, 0),
    totalErrors: tools.reduce((n, t) => n + t.errors, 0),
    messageCount: messages.length,
  }
}

export function render(recap: Recap): string {
  const lines: string[] = ['ツール利用の振り返り（観察のみ。原因の推測はしません）']
  if (recap.totalCalls === 0) {
    lines.push('ツール呼び出しはまだありません。')
  } else {
    lines.push(`合計: ${recap.totalCalls} 回 / エラー報告 ${recap.totalErrors} 件`)
    for (const t of recap.tools) lines.push(`  ${t.tool}: ${t.calls} 回（エラー報告 ${t.errors} 件）`)
  }
  lines.push(`注記: 集計対象は直近 ${recap.messageCount} 件のメッセージ（返却は最大 ${MESSAGE_LIMIT} 件まで。それより古い分は含みません）。`)
  lines.push('注記: 「エラー報告」はツールが isError を返した件数で、失敗の原因や重大さは示しません。')
  return lines.join('\n')
}
