// 純粋関数: 内訳 → 所見。`$` に触れない（テストしやすさと読み取り専用の保証のため）。
// 所見は「観察」（数値で直接言えること）と「仮説」（推測）を分けて持つ。因果は断定しない。
export type Row = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }
export type McpTool = { serverName: string; tokens: number; isLoaded: boolean }
export type MemoryFile = { path: string; type: string; tokens: number }
export type Snapshot = {
  percentage: number
  totalTokens: number
  maxTokens: number
  categories: readonly Row[]
  mcpTools: readonly McpTool[]
  memoryFiles: readonly MemoryFile[]
  skills?: { totalSkills: number; includedSkills: number; tokens: number }
  agents: readonly { tokens: number }[]
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number }
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
}
export type Level = 'high' | 'mid' | 'info'
export type Finding = {
  level: Level
  observation: string
  hypothesis?: string
  suggestion?: string
  /** ペイン用の 1 行見出し（観察できる数値のみ）。 */
  headline?: string
  shortHeadline?: string
  /** ペイン用の 1 行アクション。 */
  action?: string
  shortAction?: string
  /** 回収できる見込みのトークン（並べ替え用）。 */
  tokens?: number
}

// しきい値はすべて仮置き（実測による裏付け待ち: docs/design/open-questions.md Q-002）。
export const THRESHOLDS = {
  /** 自動圧縮が無効なときの使用率の目安（%） */
  fallbackPercent: 80,
  /** 圧縮点までの残りが窓のこの割合以下なら「近い」 */
  nearCompactShare: 0.05,
  /** MCP（読込済み）: 窓比 OR 絶対量 */
  mcpShare: 0.1,
  mcpAbsolute: 20_000,
  /** メモリ: 窓比 OR 絶対量 */
  memoryShare: 0.05,
  memoryAbsolute: 20_000,
} as const

const TOP_N = 3
const COMPACT_ACTION = '/compact で要約（区切りなら /clear）'
const COMPACT_ACTION_SHORT = '/compact で要約'
const LEVEL_ORDER: Record<Level, number> = { high: 0, mid: 1, info: 2 }
const LEVEL_LABEL: Record<Level, string> = { high: '要対応', mid: '注意', info: '参考' }

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
const share = (n: number, total: number) => (total > 0 ? n / total : 0)
export const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const pct = (n: number, total: number) => `${Math.round(share(n, total) * 100)}%`
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function topBy<T>(items: readonly T[], key: (t: T) => string, tokens: (t: T) => number): [string, number][] {
  const acc = new Map<string, number>()
  for (const it of items) acc.set(key(it), (acc.get(key(it)) ?? 0) + tokens(it))
  return [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N)
}
const listTop = (xs: readonly [string, number][]) => xs.map(([k, v]) => `${k} ${fmt(v)}`).join('、')

function compactionFinding(s: Snapshot): Finding | undefined {
  // 注意: totalTokens に buffer 行が含まれるかは未確認（U-1）。そのため
  // 「totalTokens と autoCompactThreshold の差」を観察として示すに留め、実余裕とは断定しない。
  if (s.isAutoCompactEnabled && s.autoCompactThreshold !== undefined) {
    const remaining = s.autoCompactThreshold - s.totalTokens
    if (remaining <= 0) {
      return {
        level: 'high',
        observation: `使用量が自動圧縮の基準 ${fmt(s.autoCompactThreshold)} トークンを ${fmt(-remaining)} 超えている`,
        hypothesis: '基準を超えた状態のため、近く自動圧縮が走るか、すでに走りきれていない可能性がある',
        suggestion: '/compact で先に要約するのが第一候補。会話を捨てて良い区切りなら /clear も可（履歴は失われる）',
        headline: `圧縮点を ${fmt(-remaining)} 超過`,
        shortHeadline: `圧縮点を ${fmt(-remaining)} 超過`,
        action: COMPACT_ACTION,
        shortAction: COMPACT_ACTION_SHORT,
      }
    }
    if (s.maxTokens > 0 && remaining <= s.maxTokens * THRESHOLDS.nearCompactShare) {
      return {
        level: 'high',
        observation: `自動圧縮の基準まで残り ${fmt(remaining)} トークン（窓の ${pct(remaining, s.maxTokens)}）`,
        suggestion: '/compact を第一候補に。作業の区切りなら /clear も可（履歴は失われる）。長い出力を返すコマンドは避ける',
        headline: `圧縮点まで残り ${fmt(remaining)}（窓の ${pct(remaining, s.maxTokens)}）`,
        shortHeadline: `圧縮点まで ${fmt(remaining)}`,
        action: COMPACT_ACTION,
        shortAction: COMPACT_ACTION_SHORT,
      }
    }
    return undefined
  }
  if (!s.isAutoCompactEnabled && s.percentage >= THRESHOLDS.fallbackPercent) {
    return {
      level: 'high',
      observation: `窓の ${s.percentage}% を使用中。自動圧縮は無効`,
      hypothesis: '自動では圧縮されないため、窓を使い切る前に手動対応が必要になる可能性がある',
      suggestion: '/compact を第一候補に。作業の区切りなら /clear も可（履歴は失われる）',
      headline: `窓の ${s.percentage}% を使用・自動圧縮は無効`,
      shortHeadline: `${s.percentage}% 使用・自動圧縮なし`,
      action: COMPACT_ACTION,
      shortAction: COMPACT_ACTION_SHORT,
    }
  }
  return undefined
}

function mcpFindings(s: Snapshot): Finding[] {
  const loaded = s.mcpTools.filter(t => t.isLoaded)
  const unloaded = s.mcpTools.filter(t => !t.isLoaded)
  const out: Finding[] = []
  const total = sum(loaded.map(t => t.tokens))
  const top = topBy(loaded, t => t.serverName, t => t.tokens)[0]
  const topMcp = top ? `${top[0]} ${fmt(top[1])}` : ''
  if (total > 0 && (share(total, s.maxTokens) >= THRESHOLDS.mcpShare || total >= THRESHOLDS.mcpAbsolute)) {
    out.push({
      level: 'mid',
      observation: `読込済み MCP ツール定義が ${fmt(total)} トークン（窓の ${pct(total, s.maxTokens)}）。上位サーバー: ${listTop(topBy(loaded, t => t.serverName, t => t.tokens))}`,
      hypothesis: '使っていないサーバーが含まれていれば、無効化で窓を空けられる可能性がある',
      suggestion: '/mcp で上位サーバーの要否を確認し、不要なものを無効化する',
      headline: `MCP ${fmt(total)}（${pct(total, s.maxTokens)}）上位 ${topMcp}`,
      shortHeadline: `MCP ${fmt(total)} (${pct(total, s.maxTokens)})`,
      action: '/mcp で上位サーバーの要否を確認',
      shortAction: '/mcp で要否確認',
      tokens: total,
    })
  }
  const unloadedTotal = sum(unloaded.map(t => t.tokens))
  if (unloaded.length > 0) {
    out.push({
      level: 'info',
      observation: `未ロードの MCP ツール ${unloaded.length} 件（${fmt(unloadedTotal)} トークン）は集計から除外`,
      hypothesis: '呼ばれた時点でオンデマンド読込される想定。窓への影響は呼び出し後に変わる可能性がある',
    })
  }
  return out
}

function memoryFinding(s: Snapshot): Finding | undefined {
  const total = sum(s.memoryFiles.map(f => f.tokens))
  if (!(share(total, s.maxTokens) >= THRESHOLDS.memoryShare || total >= THRESHOLDS.memoryAbsolute) || total <= 0) return undefined
  const top = [...s.memoryFiles].sort((a, b) => b.tokens - a.tokens).slice(0, TOP_N)
  const list = top.map(f => `${baseName(f.path)}（${f.type}）${fmt(f.tokens)}`).join('、')
  return {
    level: 'mid',
    observation: `メモリファイルが ${fmt(total)} トークン（窓の ${pct(total, s.maxTokens)}）。上位: ${list}`,
    hypothesis: '常時読み込みが長いほど、毎ターン窓を占有している可能性がある',
    suggestion: '長文は参照ファイルへ切り出し、常時読み込みを短くする',
    headline: `メモリ ${fmt(total)}（${pct(total, s.maxTokens)}）`,
    shortHeadline: `メモリ ${fmt(total)} (${pct(total, s.maxTokens)})`,
    action: '長文を参照ファイルへ切り出す',
    shortAction: '長文を切り出す',
    tokens: total,
  }
}

function listingFindings(s: Snapshot): Finding[] {
  const out: Finding[] = []
  if (s.skills) {
    const cut = s.skills.includedSkills < s.skills.totalSkills
    out.push({
      level: 'info',
      observation: `スキル一覧 ${fmt(s.skills.tokens)} トークン（${s.skills.includedSkills}/${s.skills.totalSkills} 件を掲載${cut ? '・予算で切り捨てあり' : ''}）`,
      hypothesis: cut ? '掲載外のスキルはモデルから見えにくい可能性がある（因果は未検証）' : undefined,
      suggestion: cut ? '使わないスキルやプラグインを減らすと掲載枠に余裕ができる' : undefined,
    })
  }
  if (s.agents.length > 0) {
    out.push({ level: 'info', observation: `エージェント説明 ${s.agents.length} 件（${fmt(sum(s.agents.map(a => a.tokens)))} トークン）` })
  }
  if (s.slashCommands) {
    const c = s.slashCommands
    out.push({ level: 'info', observation: `スラッシュコマンド一覧 ${fmt(c.tokens)} トークン（${c.includedCommands}/${c.totalCommands} 件を掲載）` })
  }
  return out
}

export function analyze(s: Snapshot): Finding[] {
  const found = [compactionFinding(s), ...mcpFindings(s), memoryFinding(s), ...listingFindings(s)]
  const out = found.filter((f): f is Finding => f !== undefined)
  // Array.prototype.sort は安定。重大度順、同順位は元の並び。
  return [...out].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}

function breakdownLine(s: Snapshot): string {
  const used = [...s.categories].filter(c => c.kind === 'used').sort((a, b) => b.tokens - a.tokens).slice(0, TOP_N)
  const kindSum = (k: Row['kind']) => sum(s.categories.filter(c => c.kind === k).map(c => c.tokens))
  const usedText = used.length ? used.map(c => `${c.name} ${fmt(c.tokens)}`).join('、') : '-'
  return `内訳（使用上位）: ${usedText} ／ 空き ${fmt(kindSum('free'))} ／ 圧縮バッファ ${fmt(kindSum('buffer'))}`
}

function renderFinding(f: Finding): string {
  return [
    `- [${LEVEL_LABEL[f.level]}] 観察: ${f.observation}`,
    ...(f.hypothesis ? [`  仮説: ${f.hypothesis}`] : []),
    ...(f.suggestion ? [`  → ${f.suggestion}`] : []),
  ].join('\n')
}

export function render(s: Snapshot, findings: readonly Finding[]): string {
  const head = `コンテキスト ${s.percentage}%（${fmt(s.totalTokens)}/${fmt(s.maxTokens)} トークン・推定値）`
  const body = findings.length === 0 ? ['所見なし。'] : findings.map(renderFinding)
  return [head, breakdownLine(s), ...body, '※ 数値は推定値。しきい値は仮置きで、実測で見直す予定'].join('\n')
}
