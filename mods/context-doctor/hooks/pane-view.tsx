// 行モデル → Box / Text。ロジックは持たない（行の中身は pane-model.ts が決める）。
// 要素表は `$.ui.resolve(e)` の戻りを引数で受ける。
import type { BoxProps, ElementConstructor, TextProps, ThemeKey } from 'claude-code'

import type { Level } from './analyze'
import type { PaneRow } from './pane-model'

export type PaneElements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
}

const BAR_CELLS = 20
const ITEM_BAR_CELLS = 24
const FILLED = '█'
const EMPTY = '░'
const LEVEL_COLOR: Record<Level, ThemeKey> = { high: 'error', mid: 'warning', info: 'subtle' }

const cells = (ratio: number | undefined, width: number) => Math.round((ratio ?? 0) * width)

export function PaneView({ Box, Text }: PaneElements, rows: readonly PaneRow[]) {
  const row = (r: PaneRow) => {
    switch (r.kind) {
      case 'heading':
        return <Text bold>{r.text}</Text>
      case 'usage':
        return <Text bold>{r.text}</Text>
      case 'bar': {
        const filled = cells(r.ratio, BAR_CELLS)
        return (
          <Box flexDirection="column">
            <Text>{`[${FILLED.repeat(filled)}${EMPTY.repeat(BAR_CELLS - filled)}]`}</Text>
            {r.text !== '' && <Text dimColor>{r.text}</Text>}
          </Box>
        )
      }
      case 'item':
        return (
          <Text>
            {r.text}
            {r.ratio === undefined ? '' : ` ${FILLED.repeat(cells(r.ratio, ITEM_BAR_CELLS))}`}
          </Text>
        )
      case 'finding':
        return r.level ? <Text color={LEVEL_COLOR[r.level]}>{r.text}</Text> : <Text>{`  ${r.text}`}</Text>
      case 'note':
        return <Text dimColor>{r.text}</Text>
      case 'message':
        return <Text>{r.text}</Text>
    }
  }
  return <Box flexDirection="column">{rows.map(row)}</Box>
}
