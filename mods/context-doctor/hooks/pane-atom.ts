import { atom } from 'claude-code'

import type { PaneView } from '../types'

export const EMPTY_PANE_VIEW: PaneView = { v: 1, status: 'empty' }

/** ペインが読む値。plugin / key はリテラル（型ファイルの注記: validate が検出する）。 */
export const paneView = atom({ plugin: 'context-doctor', key: 'view' } as const, EMPTY_PANE_VIEW)
