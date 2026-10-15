// 行の配列を Box / Text に並べるだけ。ロジックは持たない（文面は report.ts が作る）。
import type { Elements } from 'claude-code'

type Ui = Pick<Elements['terminal'], 'Box' | 'Text'>

export function PaneBody({ ui, lines }: { ui: Ui; lines: readonly string[] }) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      {lines.map(line => (
        <Text>{line === '' ? ' ' : line}</Text>
      ))}
    </Box>
  )
}
