import type { PaneView } from '../types'

/** ペインの初期値。atom 本体は validate の静的走査の都合で register.tsx に置く。 */
export const EMPTY_PANE_VIEW: PaneView = { v: 1, status: 'empty' }
