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

/** ペイン先頭の結論行の文言（「結論: 」の後ろ）。 */
export const CONCLUSION_NO_RECORDS_TEXT = 'まだ記録がありません'
export const CONCLUSION_NONE_TEXT = '目立った指摘なし'

/** ペインに出ている行の用語だけ、末尾の用語行でまとめて説明する。各 40 字以内。 */
export const TERM_TEXT = {
  hitRate: 'ヒット率: プロンプトのうちキャッシュから読んだ割合（高いほど安い）',
  afterLoad: '読み込み後: この Mod を読み込んでからの実コスト',
  sonnetEquivalent: 'Sonnet 換算: Sonnet 5.5 にしていた場合に減る額の目安',
  diff: '差（実コスト − 推定）: + は推定より実額が大きい',
} as const
export type TermKey = keyof typeof TERM_TEXT
