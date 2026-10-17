// 根拠なしの仮置き（docs/design/repeat-call-notice.md §4）。
export const REPEAT_THRESHOLD = 3
export const MAX_SHOWN_GROUPS = 3

export type Repeat = { tool: string; count: number }

// SessionMessage のうち読む部分だけ。result / text / isError は型の上でも読まない。
type MessageLike = {
  role: 'user' | 'assistant'
  toolUses: readonly { tool: string; input: unknown }[]
  toolResults?: readonly unknown[]
}

// キー順に依存しない JSON 文字列。比較専用で、戻り値・通知には出さない。
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map(key => [key, canonicalize(record[key])]),
    )
  }
  return value
}

// 正規化できない入力は null（他と一致しない 1 件として扱う）。例外の中身は読まない。
const canonicalKey = (tool: string, input: unknown): string | null => {
  try {
    return JSON.stringify([tool, canonicalize(input)])
  } catch {
    return null
  }
}

// 末尾から遡り、toolResults を持たない最後の user メッセージの次からをこのターンとする。
const currentTurn = <T extends MessageLike>(messages: readonly T[]): readonly T[] => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user' && !(m.toolResults && m.toolResults.length > 0)) {
      return messages.slice(i + 1)
    }
  }
  return messages
}

export const findRepeats = (
  messages: readonly MessageLike[],
  threshold: number = REPEAT_THRESHOLD,
): Repeat[] => {
  const groups = new Map<string, Repeat>()
  for (const message of currentTurn(messages)) {
    for (const use of message.toolUses ?? []) {
      const key = canonicalKey(use.tool, use.input)
      if (key === null) continue
      const found = groups.get(key)
      groups.set(key, { tool: use.tool, count: (found?.count ?? 0) + 1 })
    }
  }
  // Map は挿入順（初出順）。sort は安定なので同数は初出順のまま。
  return [...groups.values()].filter(g => g.count >= threshold).sort((a, b) => b.count - a.count)
}

export const formatNotice = (repeats: readonly Repeat[]): string => {
  const shown = repeats.slice(0, MAX_SHOWN_GROUPS).map(r => `${r.tool} ×${r.count}`)
  const rest = repeats.length - MAX_SHOWN_GROUPS
  if (rest > 0) shown.push(`ほか ${rest} 組`)
  return `同じ呼び出しの反復: ${shown.join('、')}`
}
