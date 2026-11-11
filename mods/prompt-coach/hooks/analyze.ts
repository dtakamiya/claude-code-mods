// 送信文の弱点を 1 行で指す判定（純粋関数）。$ には触れない。
// 状態は受け取って新しいオブジェクトを返す（元は変えない）。しきい値は仮置きで、実測で調整する。

export type RuleId = 'vague-target' | 'no-scope' | 'multi-task' | 'no-done-criterion'

// 人が送った通数などを保持する。register のクロージャ内にだけ置き、ファイルには保存しない。
export type CoachState = {
  readonly isStopped: boolean
  readonly humanCount: number
  readonly lastShownAt: number | null
  readonly shownCounts: Readonly<Partial<Record<RuleId, number>>>
}

// prompt.submit の入力のうち判定に要る部分だけ。本文は判定にのみ使い、外へ出さない。
export type PromptSignal = {
  readonly text: string
  readonly originKind: string
  readonly isMeta: boolean
  readonly isCommand: boolean
}

export type Judgement = {
  readonly state: CoachState
  readonly notice: string | null
}

export const RULE_SESSION_CAP = 2
export const GLOBAL_WINDOW = 10
export const NO_SCOPE_MAX_CHARS = 40
export const DONE_CRITERION_MAX_CHARS = 30
export const MULTI_TASK_MIN_SEGMENTS = 4
export const PASTE_MIN_LINES = 5
export const PASTE_MIN_CHARS = 300
export const NOTICE_PREFIX = '💡 '

export const INITIAL_STATE: CoachState = Object.freeze({
  isStopped: false,
  humanCount: 0,
  lastShownAt: null,
  shownCounts: Object.freeze({}),
})

const DEMONSTRATIVE = /これ|それ|あれ|この|その/u
// 拡張子（`.ts` など）またはパス（`src/a` など）
const FILE_LIKE = /\.[A-Za-z]{1,6}\b|[\w.-]+\/[\w./-]+/u
// 英字で始まる 2 文字以上の語（識別子らしきもの）
const IDENTIFIER_LIKE = /[A-Za-z_][A-Za-z0-9_]+/u
const ERROR_LIKE = /エラー|error|exception|例外|失敗|fail|ENOENT|TypeError/iu
const BROAD_VERB = /リファクタ|整理|改善|最適化|いい感じ|きれいに|綺麗に|ブラッシュアップ|よしなに/u
const IMPLEMENT_VERB = /実装|追加|作って|作成|対応/u
const DONE_CRITERION = /テスト|通る|通って|通す|ように|期待|確認|完了|動く|パス|ビルド|test|pass/iu
const APPROVAL_WORDS: ReadonlySet<string> = new Set([
  'はい', 'うん', 'ok', 'okay', 'yes', 'y', 'お願い', 'お願いします', '続けて', '続けてください', '続けて下さい',
  '進めて', '進めてください', '進めて下さい', 'どうぞ', 'いいよ', '了解', 'よろしく', 'よろしくお願いします',
  'go', 'continue',
])
const TRAILING_PUNCTUATION = /[。．.!！?？]+$/u
// 読点・カンマ・改行・セミコロンで区切る。行頭の箇条記号だけを落とす（文中の「・」では割らない）。
const SEGMENT_SEPARATOR = /[、，,;；\n]/u
const BULLET_PREFIX = /^\s*[-*・•]\s*/u

export const RULE_MESSAGES: Readonly<Record<RuleId, string>> = {
  'vague-target': '「これ」だけでは対象が伝わりにくい。ファイル名かエラー文を添えると手戻りが減りやすい',
  'no-scope': '範囲と守る制約を添えると、広い書き換えが減りやすい',
  'multi-task': '依頼が複数並んでいる。1 通 1 ゴールに分けると取りこぼしが減りやすい',
  'no-done-criterion': '完了の判定（テスト通過など）を添えると、止め時が伝わりやすい',
}

const charCount = (text: string): number => [...text].length

// 具体的な対象（パス・拡張子・識別子・コード・エラー文）が文にあるか。
const hasConcreteTarget = (text: string): boolean =>
  FILE_LIKE.test(text) || IDENTIFIER_LIKE.test(text) || text.includes('`') || ERROR_LIKE.test(text)

const segmentsOf = (text: string): string[] =>
  text
    .split(SEGMENT_SEPARATOR)
    .map(segment => segment.replace(BULLET_PREFIX, '').trim())
    .filter(segment => segment.length > 0)

type Rule = {
  readonly id: RuleId
  readonly matches: (text: string, isFirst: boolean) => boolean
}

// 優先順位順。1 通に出すのは先頭から見て最初に当たり、上限に達していないルール 1 つ。
const RULES: readonly Rule[] = [
  {
    id: 'vague-target',
    matches: (text, isFirst) => isFirst && DEMONSTRATIVE.test(text) && !hasConcreteTarget(text),
  },
  {
    id: 'no-scope',
    matches: text =>
      BROAD_VERB.test(text) && charCount(text) < NO_SCOPE_MAX_CHARS && !hasConcreteTarget(text),
  },
  {
    id: 'multi-task',
    matches: text => !text.includes('`') && segmentsOf(text).length >= MULTI_TASK_MIN_SEGMENTS,
  },
  {
    id: 'no-done-criterion',
    matches: text =>
      IMPLEMENT_VERB.test(text) && charCount(text) < DONE_CRITERION_MAX_CHARS && !DONE_CRITERION.test(text),
  },
]

const isPersonTyped = (signal: PromptSignal): boolean =>
  signal.originKind === 'composer' &&
  !signal.isMeta &&
  !signal.isCommand &&
  !signal.text.trimStart().startsWith('/')

// 短い承認・継続（「はい」「OK」「続けて」「はい、お願いします」など）だけの送信か。
export const isApprovalOnly = (text: string): boolean => {
  const tokens = text
    .split(/[、，,\s]+/u)
    .map(token => token.toLowerCase().replace(TRAILING_PUNCTUATION, ''))
    .filter(token => token.length > 0)
  return tokens.length > 0 && tokens.every(token => APPROVAL_WORDS.has(token))
}

// コードフェンス、または長い複数行の貼り付け（ログ・差分など）か。
export const isPasted = (text: string): boolean =>
  text.includes('```') || (text.split('\n').length >= PASTE_MIN_LINES && charCount(text) > PASTE_MIN_CHARS)

const isGlobalWindowOpen = (state: CoachState): boolean =>
  state.lastShownAt === null || state.humanCount - state.lastShownAt >= GLOBAL_WINDOW

const isRuleCapped = (state: CoachState, id: RuleId): boolean =>
  (state.shownCounts[id] ?? 0) >= RULE_SESSION_CAP

const withShown = (state: CoachState, id: RuleId): CoachState => ({
  ...state,
  lastShownAt: state.humanCount,
  shownCounts: { ...state.shownCounts, [id]: (state.shownCounts[id] ?? 0) + 1 },
})

// 人が送った通数を 1 つ進めた新しい状態を返す（判定対象になった通のみ数える）。
const countHuman = (state: CoachState): CoachState => ({ ...state, humanCount: state.humanCount + 1 })

export const judgeSubmission = (state: CoachState, signal: PromptSignal): Judgement => {
  if (!isPersonTyped(signal)) return { state, notice: null }
  const counted = countHuman(state)
  if (state.isStopped || isApprovalOnly(signal.text) || isPasted(signal.text)) {
    return { state: counted, notice: null }
  }
  if (!isGlobalWindowOpen(counted)) return { state: counted, notice: null }
  const isFirst = counted.humanCount === 1
  const rule = RULES.find(
    candidate => !isRuleCapped(counted, candidate.id) && candidate.matches(signal.text, isFirst),
  )
  if (!rule) return { state: counted, notice: null }
  return { state: withShown(counted, rule.id), notice: `${NOTICE_PREFIX}${RULE_MESSAGES[rule.id]}` }
}

export const setStopped = (state: CoachState, isStopped: boolean): CoachState => ({ ...state, isStopped })

export const COACH_USAGE_TEXT = '使い方: /coach on（再開）または /coach off（停止）'
export const COACH_OFF_TEXT = 'prompt-coach を停止した（このセッション内。/coach on で再開）'
export const COACH_ON_TEXT = 'prompt-coach を再開した'

// `/coach` の引数を解釈し、新しい状態と表示文言を返す。引数が不明なら状態は変えない。
export const handleCoachCommand = (state: CoachState, args: string): { state: CoachState; text: string } => {
  const action = args.trim().toLowerCase()
  if (action === 'off') return { state: setStopped(state, true), text: COACH_OFF_TEXT }
  if (action === 'on') return { state: setStopped(state, false), text: COACH_ON_TEXT }
  return { state, text: COACH_USAGE_TEXT }
}
