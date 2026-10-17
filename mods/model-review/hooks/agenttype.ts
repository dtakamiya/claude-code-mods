// サブエージェントの種類（agent.spawn の subagentType）を agentId に対応づける純粋な reducer。$ に触れない。
// 記録するのは種類の名前だけ。description・prompt は受け取らない。
export const UNKNOWN_AGENT_TYPE = '種類不明'
const MAX_TYPE_LENGTH = 64

export type AgentTypes = Readonly<Record<string, string>>

export type ListedAgent = { readonly id: string; readonly type: string }

/** 種類の名前として使えるのは、制御文字を含まない 1〜64 文字の文字列だけ。それ以外は null（推測しない）。 */
export function sanitizeAgentType(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  // eslint-disable-next-line no-control-regex
  return text.length === 0 || text.length > MAX_TYPE_LENGTH || /[\u0000-\u001f\u007f]/.test(text) ? null : text
}

/** spawn の結果を対応表に足す。agentId か種類が使えなければ表を変えない。 */
export function recordSpawn(types: AgentTypes, agentId: unknown, subagentType: unknown): AgentTypes {
  const type = sanitizeAgentType(subagentType)
  if (typeof agentId !== 'string' || agentId === '' || type === null) return types
  return { ...types, [agentId]: type }
}

/**
 * agentId の種類を引く。spawn で覚えた表を先に見て、なければ $.agent.list() の結果で補う
 * （reload で表が消えた後に途中から拾う場合）。どちらにもなければ null。
 */
export function resolveAgentType(types: AgentTypes, agentId: string | undefined, listed: readonly ListedAgent[] = []): string | null {
  if (agentId === undefined) return null
  const known = types[agentId]
  if (known !== undefined) return known
  const found = listed.find(agent => agent.id === agentId)
  return found === undefined ? null : sanitizeAgentType(found.type)
}
