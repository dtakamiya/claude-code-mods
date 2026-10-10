// 行モデル → Box / Text。ロジックを持たない（色とグリフの対応だけ）。色はテーマキーで、生の色名は使わない。
import type { Elements } from 'claude-code'

import type { Level } from './analyze'
import type { BarKind, Stage } from './pane-bar'
import { ACTION_INDENT, ACTION_PREFIX, FINDING_GAP, type PaneRow } from './pane-row'

type Ui = Pick<Elements['terminal'], 'Box' | 'Text'>

const STAGE_COLOR: Record<Stage, 'success' | 'warning' | 'error'> = { ok: 'success', warn: 'warning', danger: 'error', over: 'error' }
const LEVEL_COLOR: Record<Level, 'error' | 'warning' | undefined> = { high: 'error', mid: 'warning', info: undefined }
const BAR_GLYPH: Record<BarKind, string> = { used: '█', margin: '▒', compact: '┃', buffer: '░', free: '░' }
const ITEM_GLYPH = { used: '█', free: '▒', buffer: '░' } as const
const ITEM_COLOR = { used: undefined, free: 'subtle', buffer: 'inactive' } as const

export function PaneBody({ ui, rows }: { ui: Ui; rows: readonly PaneRow[] }) {
  const { Box, Text } = ui
  const dim = (text: string) => <Text color="inactive" dimColor>{text}</Text>
  const stageLabel = (row: PaneRow) =>
    row.label && row.stage ? (
      <Text color={STAGE_COLOR[row.stage]} bold inverse>{row.label}</Text>
    ) : undefined

  const renderBar = (row: PaneRow) => (
    <Box flexDirection="row">
      <Text>{' ['}</Text>
      {(row.runs ?? []).map(run => {
        const glyph = BAR_GLYPH[run.kind].repeat(run.count)
        if (run.kind === 'used') return <Text color={row.stage ? STAGE_COLOR[row.stage] : undefined}>{glyph}</Text>
        if (run.kind === 'margin') return <Text color="subtle">{glyph}</Text>
        if (run.kind === 'compact') return <Text bold color={row.stage === 'over' ? 'error' : undefined}>{glyph}</Text>
        return dim(glyph)
      })}
      <Text>{']'}</Text>
    </Box>
  )

  const renderRow = (row: PaneRow) => {
    switch (row.kind) {
      case 'bar':
        return renderBar(row)
      case 'usage':
      case 'stage':
        return (
          <Box flexDirection="row">
            {row.text ? <Text bold>{row.text}</Text> : undefined}
            {stageLabel(row) ? <Text>{row.text ? '  ' : ''}</Text> : undefined}
            {stageLabel(row)}
            {row.tail ? <Text>{` ${row.tail}`}</Text> : undefined}
          </Box>
        )
      case 'finding':
        return (
          <Box flexDirection="row">
            <Text bold color={LEVEL_COLOR[row.level ?? 'info']}>{row.label}</Text>
            <Text>{` ${row.text}`}</Text>
            {row.tail ? <Text color="suggestion">{`${FINDING_GAP}${ACTION_PREFIX}${row.tail}`}</Text> : undefined}
          </Box>
        )
      case 'action':
        return <Text color="suggestion">{`${ACTION_INDENT}${ACTION_PREFIX}${row.text}`}</Text>
      case 'item': {
        const kind = row.itemKind ?? 'used'
        return (
          <Box flexDirection="row">
            <Text wrap="truncate-end" color={kind === 'used' ? undefined : ITEM_COLOR[kind]} dimColor={kind === 'buffer'}>{row.text}</Text>
            {row.barLen ? <Text color={ITEM_COLOR[kind]} dimColor={kind === 'buffer'}>{` ${ITEM_GLYPH[kind].repeat(row.barLen)}`}</Text> : undefined}
          </Box>
        )
      }
      case 'heading':
        return <Text bold>{row.text}</Text>
      case 'blank':
        return <Text>{' '}</Text>
      case 'message':
        return <Text dimColor>{row.text}</Text>
      default:
        return dim(row.text)
    }
  }

  return <Box flexDirection="column">{rows.map(renderRow)}</Box>
}
