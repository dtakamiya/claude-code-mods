// 上限を超えた古いターンを集計値に畳み込む。$ に触れない純粋関数。
// turns を無制限に持つと、毎ターンの書き直しと描画ごとの全件再計算が増え続ける。
import { ZERO_PARTS, addParts } from './breakdown'
import type { ArchivedGroup, ArchivedTurns, ReviewState, TurnRecord } from '../types'

/** turns に残す件数の上限（仮置き）。これを超えた分は古い順に集計へ畳む。 */
export const MAX_TURNS = 500

export const EMPTY_ARCHIVE: ArchivedTurns = {
  turns: 0,
  subagents: 0,
  advisorCalls: 0,
  groups: [],
  pricedUsd: 0,
  unpricedTurns: 0,
  highUsd: 0,
  costParts: ZERO_PARTS,
  partsMissingTurns: 0,
  sinceBaseline: { lowUsd: 0, highUsd: 0, cacheWrite: 0 },
}

const groupKey = (model: string, effort: string | null): string => `${model}\u0000${effort ?? ''}`

const addCost = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b)

/**
 * 1 ターンを集計に入れる単位に分ける。モデルが混ざったターン（byModel あり）はモデルごとに分け、
 * それぞれのモデルの行にそのターンを 1 件ずつ数える（行の合計はターン数より増えうる）。
 * 内訳のない記録・古い記録は従来どおり、最後のモデル 1 つにまとめる。
 */
export function sharesOf(record: TurnRecord): readonly {
  readonly model: string
  readonly tokens: TurnRecord['tokens']
  readonly costUsd: number | null
}[] {
  return record.byModel !== undefined && record.byModel.length > 1
    ? record.byModel
    : [{ model: record.model, tokens: record.tokens, costUsd: record.costUsd }]
}

function foldIntoGroups(groups: readonly ArchivedGroup[], record: TurnRecord): readonly ArchivedGroup[] {
  return sharesOf(record).reduce(
    (acc, share) => foldShare(acc, record.effort, share),
    groups,
  )
}

function foldShare(
  groups: readonly ArchivedGroup[],
  effort: string | null,
  record: { readonly model: string; readonly tokens: TurnRecord['tokens']; readonly costUsd: number | null },
): readonly ArchivedGroup[] {
  const key = groupKey(record.model, effort)
  const found = groups.find(group => groupKey(group.model, group.effort) === key)
  const base: ArchivedGroup = found ?? {
    model: record.model,
    effort,
    turns: 0,
    unpricedTurns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
  }
  const next: ArchivedGroup = {
    ...base,
    turns: base.turns + 1,
    unpricedTurns: base.unpricedTurns + (record.costUsd === null ? 1 : 0),
    tokens: {
      input: base.tokens.input + record.tokens.input,
      output: base.tokens.output + record.tokens.output,
      cacheRead: base.tokens.cacheRead + record.tokens.cacheRead,
      cacheWrite: base.tokens.cacheWrite + record.tokens.cacheWrite,
    },
    costUsd: addCost(base.costUsd, record.costUsd),
  }
  return found === undefined ? [...groups, next] : groups.map(group => (group === found ? next : group))
}

/** 1 ターンを集計に足す。afterBaseline が true なら、実コストに入るターンとして別に積む。 */
export function foldTurn(archive: ArchivedTurns, record: TurnRecord, afterBaseline: boolean): ArchivedTurns {
  // 内訳を持たない古い集計は、初めて畳むときに、すでに畳んでいた単価ありのターンを「内訳なし」として数え残す。
  const legacyMissing = archive.costParts === undefined ? archive.turns - archive.unpricedTurns : 0
  const baseParts = archive.costParts ?? ZERO_PARTS
  const low = record.costUsd ?? 0
  const high = record.costUsd === null ? 0 : (record.costUpperUsd ?? record.costUsd)
  return {
    turns: archive.turns + 1,
    subagents: archive.subagents + (record.agentId === null ? 0 : 1),
    advisorCalls: archive.advisorCalls + (record.advisorCalls ?? 0),
    groups: foldIntoGroups(archive.groups, record),
    pricedUsd: archive.pricedUsd + low,
    unpricedTurns: archive.unpricedTurns + (record.costUsd === null ? 1 : 0),
    highUsd: archive.highUsd + high,
    costParts: record.costParts == null ? baseParts : addParts(baseParts, record.costParts),
    partsMissingTurns: (archive.partsMissingTurns ?? 0) + legacyMissing + (record.costUsd !== null && record.costParts == null ? 1 : 0),
    sinceBaseline: afterBaseline
      ? {
          lowUsd: archive.sinceBaseline.lowUsd + low,
          highUsd: archive.sinceBaseline.highUsd + high,
          cacheWrite: archive.sinceBaseline.cacheWrite + record.tokens.cacheWrite,
        }
      : archive.sinceBaseline,
  }
}

/**
 * turns が上限を超えていれば、古い順に畳む。基準点のターン数も、外した分だけ前へずらす。
 * 基準点がまだ無い（実コストを取れていない）あいだに畳んだターンは、後で取る基準点より前なので、基準点より後には積まない。
 */
export function trimTurns(state: ReviewState): ReviewState {
  const excess = state.turns.length - MAX_TURNS
  if (excess <= 0) return state
  const hasBaseline = state.sessionCostUsd.baseline !== null
  const baselineTurns = state.sessionCostUsd.baselineTurns ?? 0
  const archived = state.turns
    .slice(0, excess)
    .reduce((acc, record, index) => foldTurn(acc, record, hasBaseline && index >= baselineTurns), state.archived ?? EMPTY_ARCHIVE)
  return {
    ...state,
    turns: state.turns.slice(excess),
    archived,
    sessionCostUsd: { ...state.sessionCostUsd, baselineTurns: Math.max(0, baselineTurns - excess) },
  }
}

/** 畳んだ集計と直近のグループを、モデル × effort ごとに足し合わせる。並びは ターン数の多い順（groupByModelEffort と同じ）。 */
export function mergeGroups<G extends ArchivedGroup>(archived: ArchivedTurns | undefined, recent: readonly G[]): readonly ArchivedGroup[] {
  const merged = [...(archived?.groups ?? []), ...recent].reduce<readonly ArchivedGroup[]>((acc, group) => {
    const key = groupKey(group.model, group.effort)
    const found = acc.find(item => groupKey(item.model, item.effort) === key)
    if (found === undefined) return [...acc, group]
    const sum: ArchivedGroup = {
      ...found,
      turns: found.turns + group.turns,
      unpricedTurns: found.unpricedTurns + group.unpricedTurns,
      tokens: {
        input: found.tokens.input + group.tokens.input,
        output: found.tokens.output + group.tokens.output,
        cacheRead: found.tokens.cacheRead + group.tokens.cacheRead,
        cacheWrite: found.tokens.cacheWrite + group.tokens.cacheWrite,
      },
      costUsd: addCost(found.costUsd, group.costUsd),
    }
    return acc.map(item => (item === found ? sum : item))
  }, [])
  return [...merged].sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model))
}

/** 畳んだぶんの注記。畳んでいなければ null。 */
export const archiveNote = (archived: ArchivedTurns | undefined): string | null =>
  archived === undefined || archived.turns === 0
    ? null
    : `古い ${archived.turns} ターンは集計値だけを保持しています（件数・コスト・モデル別はそれを含み、指摘・切替・ループ別・高コスト順は直近 ${MAX_TURNS} ターンが対象です）`
