import { atom, read, update } from 'claude-code'
import type { Register, SessionUsage } from 'claude-code'

import { PaneBody } from './pane'
import { EMPTY_REVIEW, appendTurn, withBaseline, withCostSample } from './state'
import { beginTurn, finishTurn, liveDrafts, recordStep, recordTool, type Drafts } from './recorder'
import { buildPaneRows } from './pane-model'
import { buildReportLines } from './report'
import { evaluateAlerts, formatStatus, needsRedraw, readLimits, readShowStatus } from './glance'

const PANE_ID = 'model-review'
const PANE_TITLE = 'モデル振り返り'
const ADVISOR_TOOL_NAME = 'advisor'
const PANE_OPENED_TEXT = 'モデル振り返りペインを開きました。'
// 例外の中身は入力由来の文字列を含みうるので出さず、固定文言だけをログに残す。
const COST_READ_FAILED_TEXT = 'model-review: 累計コストの取得に失敗したため、実コストを記録しなかった'
const GLANCE_FAILED_TEXT = 'model-review: status 行の更新に失敗したため、この更新を省いた'
const RECORD_FAILED_TEXT = 'model-review: 記録に失敗したため、この更新を記録しなかった'

// validate の静的走査が読めるよう、参照はこのファイルに置く（リテラルの plugin / key）。
const reviewAtom = atom({ plugin: 'model-review', key: 'review' } as const, EMPTY_REVIEW)

/** 累計コストを取る。取れなかった（例外・未定義）ときは null。 */
async function readCostUsd(loadUsage: () => Promise<SessionUsage>, log: (text: string) => void): Promise<number | null> {
  try {
    return (await loadUsage()).cost?.usd ?? null
  } catch {
    log(COST_READ_FAILED_TEXT)
    return null
  }
}

/**
 * 記録処理を実行する。失敗しても固定文言を debug に残すだけで、呼び出し側の処理（ツールの実行など）は止めない。
 * `next(e)` は包まない（包むと、失敗の後にもう一度 next を呼んで二重実行しうる）。
 */
async function recordSafely(work: () => void | Promise<void>, log: (text: string) => void): Promise<void> {
  try {
    await work()
  } catch {
    try {
      log(RECORD_FAILED_TEXT)
    } catch {
      // ログも失敗したときは何もしない。記録の失敗でホストの処理を止めない。
    }
  }
}

const logDebug =
  ($: { readonly ui: { log: (text: string, options: { to: 'debug' }) => unknown } }) =>
  (text: string): void => {
    void $.ui.log(text, { to: 'debug' })
  }

export const register: Register = (on, options) => {
  const limits = readLimits(options)
  const showStatus = readShowStatus(options)
  // 知らせ済みの上限と、直近に出した status 文。reload で消えるので、reload 後は超過中の上限をもう一度知らせうる。
  let notified: ReadonlySet<string> = new Set()
  let lastStatus: string | undefined
  // 進行中のターンの下書き（ループごと）。値は差し替えるだけで、中身は書き換えない。
  let drafts: Drafts = {}
  // /compact（自動を含む）が通った後、まだ完了していないメインのターンに印を付けるための旗。
  let compactPending = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'model-review',
      description: 'セッションのモデル・effort・トークン・推定コストと、モデル選択の妥当性を表示する（読み取り専用）',
    })
    const costUsd = await readCostUsd(
      () => $.session.usage(),
      text => $.ui.log(text, { to: 'debug' }),
    )
    await update($, reviewAtom, state => withBaseline(state, costUsd))
    lastStatus = undefined
    return next(e)
  })

  on('command.run', { command: 'model-review' }, async $ => {
    const costUsd = await readCostUsd(
      () => $.session.usage(),
      text => $.ui.log(text, { to: 'debug' }),
    )
    if (costUsd !== null) await update($, reviewAtom, state => withCostSample(state, costUsd))
    const lines = buildReportLines(await read($, reviewAtom), await $.clock.now())
    const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    return { text: opened.isPlaced ? PANE_OPENED_TEXT : lines.join('\n') }
  })

  on('session.measure', async ($, e, next) => {
    const costUsd = e.cost?.usd
    // 表示は記録（await）より先に。記録の失敗や遅れで status 行が止まったり、古い値で上書きされたりしないように。
    if (needsRedraw(e.changed)) {
      try {
        const glance = { costUsd, rateLimits: e.rateLimits }
        if (showStatus) {
          const text = formatStatus(glance)
          if (text !== lastStatus) {
            lastStatus = text
            void $.ui.status(text)
          }
        }
        const result = evaluateAlerts(glance, limits, notified)
        notified = result.notified
        for (const alert of result.alerts) void $.ui.toast(alert)
      } catch {
        void $.ui.log(GLANCE_FAILED_TEXT, { to: 'debug' })
      }
    }
    if (costUsd !== undefined) await update($, reviewAtom, state => withCostSample(state, costUsd))
    return next(e)
  })

  // 実行中のターンの途中経過は $.state に載らないので、変わるたびにペインを描き直させる（毎秒 10 回まで）。
  on('turn.start', async ($, e, next) => {
    await recordSafely(async () => {
      const nowMs = await $.clock.now()
      drafts = beginTurn(drafts, e, nowMs)
      $.ui.invalidate('ui.render')
    }, logDebug($))
    return next(e)
  })

  // モデルと effort は turn.start ではなく、応答ごとの turn.step にしか載らない。
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    await recordSafely(async () => {
      // 時刻は先に取る。await をまたいで drafts を読むと、並行するループの更新を上書きして失う。
      const nowMs = await $.clock.now()
      drafts = recordStep(
        drafts,
        {
          turnId: e.turnId,
          agentId: e.agentId,
          model: e.model,
          effort: e.effort,
          usage: result.usage,
          advisorCalls: (result.serverToolUses ?? []).filter(use => use.name === ADVISOR_TOOL_NAME).length,
        },
        nowMs,
      )
      $.ui.invalidate('ui.render')
    }, logDebug($))
    return result
  })

  // 入力（e の tool 以外）は記録しない。記録が失敗してもツールは通す。
  on('tool.call', async ($, e, next) => {
    await recordSafely(async () => {
      const nowMs = await $.clock.now()
      drafts = recordTool(drafts, { agentId: e.agentId, tool: e.tool }, nowMs)
      $.ui.invalidate('ui.render')
    }, logDebug($))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await recordSafely(async () => {
      const finished = finishTurn(drafts, {
        turnId: e.turnId,
        agentId: e.agentId,
        usage: e.usage,
        durationMs: e.durationMs,
        reason: e.reason,
        afterCompact: e.agentId === undefined && compactPending,
      })
      if (e.agentId === undefined) compactPending = false
      drafts = finished.drafts
      await update($, reviewAtom, state => appendTurn(state, finished.record))
      $.ui.invalidate('ui.render')
    }, logDebug($))
    return next(e)
  })

  // compact が実際に通ったら（skip でなければ）、次に完了するメインのターンを再構築の対象外にする。
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) compactPending = true
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const nowMs = await $.clock.now()
    const rows = buildPaneRows(await read($, reviewAtom), liveDrafts(drafts, nowMs), nowMs)
    return <PaneBody ui={$.ui.resolve(e)} rows={rows} />
  })
}
