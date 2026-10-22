// 行モデル → Box / Text。ロジックを持たない（色とグリフの対応だけ）。色はテーマキーで、生の色名は使わない。
import type { Elements } from 'claude-code'

import { type Tone } from './conclusion'
import { type PaneRow, type Tier } from './pane-model'

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
  // dim は飾り（空きのセル・免責）だけ。値や説明は subtle で、暗い背景でも読めるようにする。
  const dim = (text: string) => <Text color="inactive" dimColor>{text}</Text>
  const sub = (text: string) => <Text color="subtle">{text}</Text>

  const renderRow = (row: PaneRow) => {
    switch (row.kind) {
      case 'title':
        return <Text wrap="wrap">{sub(`${row.turns} ターン  ·  サブエージェント ${row.subagents}`)}</Text>
      case 'conclusion':
        return <Text bold wrap="wrap" color={TONE_COLOR[row.tone]}>{row.text}</Text>
      case 'heading':
        return <Text bold wrap="wrap">{`▎${row.text}`}</Text>
      case 'group':
        return (
          <Box flexDirection="column">
            <Text wrap="wrap">
              <Text bold color={TIER_COLOR[row.tier]}>{row.model}</Text>
              <Text>{'  '}</Text>
              <Text color="subtle">{`effort ${row.effort}`}</Text>
              {sub(`  ${row.turns} ターン`)}
            </Text>
            <Text wrap="wrap">
              <Text bold>{`  ${row.costText}`}</Text>
              {row.barWidth === 0 ? null : <Text>{'  '}</Text>}
              <Text color={TIER_COLOR[row.tier]}>{FILLED_GLYPH.repeat(row.filled)}</Text>
              {dim(EMPTY_GLYPH.repeat(row.barWidth - row.filled))}
              {row.percentText === '' ? null : sub(`  ${row.percentText}`)}
            </Text>
            <Text color="subtle" wrap="wrap">{`  ${row.tokenText}`}</Text>
            <Text color="subtle" wrap="wrap">{`  ${row.cacheText}`}</Text>
          </Box>
        )
      case 'turn':
        return (
          <Box flexDirection="column">
            <Text wrap="wrap">
              <Text bold color={TIER_COLOR[row.tier]}>{row.model}</Text>
              <Text bold>{`  ${row.costText}`}</Text>
            </Text>
            <Text color="subtle" wrap="wrap">{`  ${row.label} · ${row.detail}`}</Text>
          </Box>
        )
      case 'kv':
        return (
          <Text wrap="wrap">
            {sub(`${row.label}  `)}
            <Text color={TONE_COLOR[row.tone]}>{row.value}</Text>
          </Text>
        )
      case 'badge':
        return (
          <Text wrap="wrap">
            <Text bold inverse color={TONE_COLOR[row.tone]}>{` ${row.label} `}</Text>
            <Text>{` ${row.text}`}</Text>
          </Text>
        )
      case 'example':
        return <Text color="subtle" wrap="wrap">{`  ・${row.text}`}</Text>
      case 'next':
        return <Text color="suggestion" wrap="wrap">{`  → ${row.text}`}</Text>
      case 'ok':
        return (
          <Text>
            <Text color="success" bold>{'✓ '}</Text>
            <Text>{row.text}</Text>
          </Text>
        )
      case 'note':
        return <Text color="subtle" wrap="wrap">{row.text}</Text>
      case 'message':
        return <Text color="subtle" wrap="wrap">{row.text}</Text>
      default:
        return <Text>{' '}</Text>
    }
  }

  return <Box flexDirection="column">{rows.map(renderRow)}</Box>
}
