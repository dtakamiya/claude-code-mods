// 行モデル → Box / Text。ロジックを持たない（色とグリフの対応だけ）。色はテーマキーで、生の色名は使わない。
import type { Elements } from 'claude-code'

import { BAR_WIDTH, type PaneRow, type Tier, type Tone } from './pane-model'

type Ui = Pick<Elements['terminal'], 'Box' | 'Text'>

const FILLED_GLYPH = '█'
const EMPTY_GLYPH = '░'
const TONE_COLOR: Record<Tone, 'success' | 'warning' | 'error' | 'suggestion' | undefined> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
  suggestion: 'suggestion',
  plain: undefined,
}
// モデル階層の色: 軽いほど success、重いほど warning。未知は色なし。
const TIER_COLOR: Record<Tier, 'success' | 'suggestion' | 'warning' | undefined> = {
  haiku: 'success',
  sonnet: 'suggestion',
  opus: 'warning',
  other: undefined,
}

export function PaneBody({ ui, rows }: { ui: Ui; rows: readonly PaneRow[] }) {
  const { Box, Text } = ui
  const dim = (text: string) => <Text color="inactive" dimColor>{text}</Text>

  const renderRow = (row: PaneRow) => {
    switch (row.kind) {
      case 'title':
        return (
          <Text>
            <Text bold>{`${row.turns} ターン`}</Text>
            {dim(`  ·  サブエージェント ${row.subagents}  ·  推定 `)}
            <Text bold>{row.costText}</Text>
          </Text>
        )
      case 'heading':
        return <Text bold>{`▎${row.text}`}</Text>
      case 'group':
        return (
          <Box flexDirection="column">
            <Text>
              <Text bold color={TIER_COLOR[row.tier]}>{row.model}</Text>
              <Text>{'  '}</Text>
              <Text color="subtle">{`effort ${row.effort}`}</Text>
              {dim(`  ${row.turns} ターン`)}
            </Text>
            <Text>
              <Text>{'  '}</Text>
              <Text color={TIER_COLOR[row.tier]}>{FILLED_GLYPH.repeat(row.filled)}</Text>
              {dim(EMPTY_GLYPH.repeat(BAR_WIDTH - row.filled))}
              <Text bold>{`  ${row.costText}`}</Text>
              {row.percentText === '' ? null : dim(`  ${row.percentText}`)}
            </Text>
            <Text color="inactive" dimColor wrap="truncate-end">{`  ${row.tokenText}`}</Text>
          </Box>
        )
      case 'turn':
        return (
          <Text wrap="truncate-end">
            <Text bold color={TIER_COLOR[row.tier]}>{row.model}</Text>
            <Text bold>{`  ${row.costText}`}</Text>
            {dim(`  ${row.label} · ${row.detail}`)}
          </Text>
        )
      case 'kv':
        return (
          <Text>
            {dim(`${row.label}  `)}
            <Text color={TONE_COLOR[row.tone]}>{row.value}</Text>
          </Text>
        )
      case 'badge':
        return (
          <Text>
            <Text bold inverse color={TONE_COLOR[row.tone]}>{` ${row.label} `}</Text>
            <Text>{` ${row.text}`}</Text>
          </Text>
        )
      case 'example':
        return <Text color="inactive" dimColor wrap="truncate-end">{`  ・${row.text}`}</Text>
      case 'ok':
        return (
          <Text>
            <Text color="success" bold>{'✓ '}</Text>
            <Text>{row.text}</Text>
          </Text>
        )
      case 'note':
        return <Text color="inactive" dimColor>{row.text}</Text>
      case 'message':
        return <Text dimColor>{row.text}</Text>
      default:
        return <Text>{' '}</Text>
    }
  }

  return <Box flexDirection="column">{rows.map(renderRow)}</Box>
}
