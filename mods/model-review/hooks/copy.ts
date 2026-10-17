// `/model-review copy` の引数判定と応答文。`$` に触れない純粋関数。
export type CommandMode = 'open' | 'copy'

const COPY_ARG = 'copy'

/** `copy` だけがクリップボード。それ以外（引数なしを含む）は従来どおりペイン（またはテキスト）。 */
export function parseCommandMode(args: string): CommandMode {
  return args.trim().toLowerCase() === COPY_ARG ? 'copy' : 'open'
}

export const COPIED_TEXT = 'テキストレポートをクリップボードにコピーしました。'
export const copyFailedText = (reason: string): string => `コピーできませんでした: ${reason}`
