// ペインとテキスト出力で共用する見出し・用語。順序（ペインに合わせる）は両方の組み立て側で守る。
import type { ConcernKind } from './analyze'

export const HEADING = {
  concerns: '妥当性（参考）',
  loops: 'ループ別（キャッシュ効率）',
  groups: 'モデル × effort（コスト比）',
  topTurns: '高コストターン',
  whatIf: 'いま切り替えたら（目安）',
  cost: 'コスト',
} as const

/** 指摘の種類の短い名前と、1 行の説明。 */
export const CONCERN_TEXT: Readonly<Record<ConcernKind, { readonly label: string; readonly summary: string }>> = {
  overspec: { label: '過剰', summary: '軽作業に重いモデル / effort' },
  underspec: { label: '不足', summary: '重い作業・エラー連続に軽い設定（エラーは API 側の原因もありうる）' },
  delegation: {
    label: '委譲',
    summary: 'サブエージェント未使用（調査系を任せる手もあるが、サブエージェントは 5 分 TTL・親のキャッシュを読まない）',
  },
  subagent: { label: 'サブ', summary: 'サブエージェントがコストの大半（親のキャッシュを読まない・5 分 TTL）' },
  switch: { label: '切替', summary: 'モデル / effort の切替でキャッシュを再構築' },
}

export const NO_CONCERNS_TEXT = '指摘なし'
