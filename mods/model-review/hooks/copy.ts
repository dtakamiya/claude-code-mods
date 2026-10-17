// `/model-review [copy|text|help]` の引数判定と応答文。`$` に触れない純粋関数。
export type CommandMode = 'open' | 'copy' | 'text' | 'help' | 'unknown'

const NAMED_MODES: ReadonlyMap<string, CommandMode> = new Map([
  ['copy', 'copy'],
  ['text', 'text'],
  ['help', 'help'],
])

/** 前後の空白と大文字小文字は無視する。引数なしはペイン、知らない引数は unknown（ペインは開かない）。 */
export function parseCommandMode(args: string): CommandMode {
  const arg = args.trim().toLowerCase()
  if (arg === '') return 'open'
  return NAMED_MODES.get(arg) ?? 'unknown'
}

/** 型の `argumentHint`（コマンド名の後ろに薄く出る）。 */
export const ARGUMENT_HINT = '[copy|text|help]'

export const HELP_TEXT = [
  '/model-review の使い方',
  '  （引数なし） ペイン「モデル振り返り」を開く（置けない画面ではテキストで返す）',
  '  copy         テキストレポートをクリップボードにコピーする',
  '  text         ペインを開かず、テキストレポートをそのまま返す',
  '  help         この一覧を出す',
].join('\n')

export const UNKNOWN_ARG_TEXT = '不明な引数です。/model-review help を参照してください。'

export const COPIED_TEXT = 'テキストレポートをクリップボードにコピーしました。'
export const copyFailedText = (reason: string): string => `コピーできませんでした: ${reason}`
