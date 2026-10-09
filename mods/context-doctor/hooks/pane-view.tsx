// 行モデル → Box / Text。ロジックを持たない（棒の文字列化だけ）。
import type { Elements } from 'claude-code'

import type { PaneRow } from './pane-model'

type Ui = Pick<Elements['terminal'], 'Box' | 'Text'>

const BAR_FILLED = '█'
const BAR_EMPTY = '░'
const LEVEL_COLOR = { high: 'red', mid: 'yellow', info: undefined } as const

const bar = (ratio: number, width: number) => {
  const filled = Math.round(ratio * width)
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(width - filled)
}

export function PaneBody({ ui, rows, bodyColumns }: { ui: Ui; rows: readonly PaneRow[]; bodyColumns: number }) {
  const { Box, Text } = ui
  const barWidth = Math.max(1, Math.min(bodyColumns - 2, 20))
  return (
    <Box flexDirection="column">
      {rows.map(row => {
        if (row.kind === 'bar') {
          return <Text>{`${bar(row.ratio ?? 0, barWidth)}  ${row.text}`.trimEnd()}</Text>
        }
        if (row.kind === 'item' && row.ratio !== undefined) {
          return <Text>{`${row.text} ${bar(row.ratio, Math.max(1, Math.round(row.ratio * barWidth)))}`}</Text>
        }
        return (
          <Text
            bold={row.kind === 'heading' || row.kind === 'usage'}
            dimColor={row.kind === 'note' || row.kind === 'message'}
            color={row.level ? LEVEL_COLOR[row.level] : undefined}
          >
            {row.text}
          </Text>
        )
      })}
    </Box>
  )
}
