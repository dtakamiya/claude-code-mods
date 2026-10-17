// `/model-review copy` の引数判定と応答文。`$` に触れない純粋関数。
export type CommandMode = 'open' | 'copy' | 'unknown'

const COPY_ARG = 'copy'

/** 引数なしはペイン（またはテキスト）、`copy` はクリップボード。それ以外は案内を返すため unknown。 */
export function parseCommandMode(args: string): CommandMode {
  const word = args.trim().toLowerCase()
  if (word === '') return 'open'
  return word === COPY_ARG ? 'copy' : 'unknown'
}

export const USAGE_TEXT = '使い方: /model-review（ペインを開く） / /model-review copy（テキストレポートをクリップボードへ）'
export const COPIED_TEXT = 'テキストレポートをクリップボードにコピーしました。'
export const copyFailedText = (reason: string): string => `コピーできませんでした: ${reason}`
