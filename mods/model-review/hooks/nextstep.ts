// 指摘ごとの「次の一手」の候補（1 行）。$ に触れない純粋関数。ペインとテキストレポートで共用する。
// 断定せず「候補」「目安」で書く。コマンド名は公式 docs で確認したもの（`/model [model]`・`/effort [level]`、
// サブエージェント定義の frontmatter `model`、組み込みの Explore）だけを書く。
// `/model`・`/effort` はメインのセッションに効く。サブエージェント由来の指摘には定義側の設定を示す。
import type { TurnRecord } from '../types'
import { RANK_SONNET, RANK_UNRANKED, modelRank, type Concern, type OverspecFacts, type UnderspecFacts } from './analyze'
import { formatUsd } from './format'
import { SONNET_REFERENCE_MODEL } from './pricing'
import { UNKNOWN_MODEL } from './recorder'
import { keepsCacheOnEffortChange } from './switches'
import { breakEvenTurns, estimateSwitchOptions } from './whatif'

export const NEXT_STEP_PREFIX = '候補: '
/** 回収に要するターン数がこれを超えると「切替の元は取りにくい」と添える（仮置き）。 */
export const MAX_RECOVERABLE_TURNS = 10

const PIECE_SEPARATOR = ' / '

/**
 * 再構築コストと回収の見込み。再構築は「いま切り替えたら」と同じ見積り（直近のメインのターン基準）、
 * 節約は軽作業の平均で、回収ターン数は whatif.ts と同じ計算。見積もれなければその旨を返す。
 */
function recoveryText(records: readonly TurnRecord[], savingPerTurnUsd: number): string {
  const sonnet = estimateSwitchOptions(records).find(option => option.model === SONNET_REFERENCE_MODEL)
  if (sonnet === undefined) return '、再構築の目安は出せません'
  if (sonnet.rebuildUsd <= 0) return '、再構築はほぼなし'
  const turns = breakEvenTurns(sonnet.rebuildUsd, savingPerTurnUsd)
  const rebuild = `、再構築 +${formatUsd(sonnet.rebuildUsd)}`
  if (turns === null) return rebuild
  const hard = turns > MAX_RECOVERABLE_TURNS ? `。${MAX_RECOVERABLE_TURNS} ターンを超えるので切替の元は取りにくい` : ''
  return `${rebuild}・約 ${turns} ターンで回収の目安${hard}`
}

/** 直近のメインのターンのモデル（モデル不明は飛ばす）。見積りの基準と違い、compact 直後や単価不明のターンも含める。 */
const latestMainModel = (records: readonly TurnRecord[]): string | null =>
  [...records].reverse().find(record => record.agentId === null && record.model !== UNKNOWN_MODEL)?.model ?? null

const isSonnetOrLighter = (model: string): boolean => modelRank(model) !== RANK_UNRANKED && modelRank(model) <= RANK_SONNET

function mainModelPiece(facts: OverspecFacts, records: readonly TurnRecord[]): string | null {
  if (facts.mainModelTurns === 0) return null
  const latest = latestMainModel(records)
  if (latest !== null && isSonnetOrLighter(latest)) {
    return '直近のメインはすでに Sonnet 以下なので、見直し済みなら対応不要'
  }
  const perTurn = facts.mainModelSavingsUsd === null ? null : facts.mainModelSavingsUsd / facts.mainModelTurns
  const detail =
    perTurn === null ? '' : `（軽作業の平均で 1 ターンあたり約 -${formatUsd(perTurn)}${recoveryText(records, perTurn)}。戻すときにも再構築）`
  return `軽作業が続くあいだは /model sonnet で Sonnet へ${detail}`
}

function mainEffortPiece(facts: OverspecFacts): string | null {
  if (facts.mainEffortModels.length === 0) return null
  const cache = facts.mainEffortModels.every(keepsCacheOnEffortChange)
    ? 'いずれのモデルも effort を変えてもキャッシュは維持される'
    : 'モデルによっては effort の変更でキャッシュを再構築することがある'
  return `/effort high などで effort を high 以下へ（${cache}）`
}

function overspecStep(facts: OverspecFacts, records: readonly TurnRecord[]): string {
  const pieces = [
    mainModelPiece(facts, records),
    facts.subagentModel ? 'サブエージェントは定義の model を sonnet / haiku に' : null,
    mainEffortPiece(facts),
    facts.subagentEffort ? 'サブエージェントの effort は定義側の設定による' : null,
  ].flatMap(piece => piece ?? [])
  return pieces.join(PIECE_SEPARATOR)
}

function underspecStep(facts: UnderspecFacts): string {
  const pieces = [
    facts.haikuLowMain ? 'Haiku / low の重い作業は effort を上げるか、/model sonnet などで Sonnet 以上へ' : null,
    facts.haikuLowSubagent ? 'サブエージェントの Haiku / low の重い作業は、定義の model を sonnet に' : null,
    facts.sonnetLow ? 'Sonnet / low のエラー連続は /effort medium 以上へ' : null,
  ].flatMap(piece => piece ?? [])
  return pieces.join(PIECE_SEPARATOR)
}

const FIXED_STEP: Readonly<Record<'delegation' | 'subagent' | 'switch', string>> = {
  delegation: '調べもの（Read / Grep 中心）は Explore などのサブエージェントへ（メインには結果だけが戻る）',
  subagent: 'サブエージェントの定義で model を haiku / sonnet に（Explore も同じ名前の定義で上書きできる）、短い調べものはメインで',
  switch: '切替はまとめるのが目安（往復のたびにキャッシュを再構築）',
}

function stepBody(concern: Concern, records: readonly TurnRecord[]): string {
  switch (concern.kind) {
    case 'overspec':
      return concern.overspec === undefined ? '' : overspecStep(concern.overspec, records)
    case 'underspec':
      return concern.underspec === undefined ? '' : underspecStep(concern.underspec)
    default:
      return FIXED_STEP[concern.kind]
  }
}

/** 指摘に添える次の一手。材料がなく何も言えないときは null。 */
export function nextStepText(concern: Concern, records: readonly TurnRecord[]): string | null {
  const body = stepBody(concern, records)
  return body === '' ? null : `${NEXT_STEP_PREFIX}${body}`
}
