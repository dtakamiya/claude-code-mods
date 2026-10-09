# context-doctor ペイン表示設計（mod-004）

**状態: T1・T2 は PR#9 マージ済み。T3（配線の最小版）は PR で実装済み・目視未確認。T4 以降は未着手。** 本書は設計書（読み取り専用）。出所は repo のコードと、Claude Code 2.1.295 同梱の plugin-authoring 型定義（`claude-code.d.ts`）、`reference.md`、`examples/pane.tsx`・`pane-state.d.ts`。型の行番号は 2.1.295 同梱版のもので、バージョンが変わるとずれる。サンプル数値はすべて架空。

## 結論

- `/ctx` の分析結果を `$.ui.open` + `ui.render`（`Pane`）の常駐ペインに出す設計は、型の上で成立する。必要な API はすべて型ファイルに宣言があった（下の確認表）。
- 更新は **`session.measure` フック（コンテキスト変化の push）で `breakdown: 'summary'` を取り、`$.state` の atom に載せる**方式を推奨する。`ui.render` は atom を読むだけにして、書込と `$.session.usage` 呼出を描画の外に置く。
- 既定の挙動は変えない。第1段階は **`/ctx pane`（引数付き）でのみペインを開く**。引数なしの `/ctx` は現行どおりテキスト。ペインを既定にするかは mods-lead の判断（後述）。
- フォールバックは 2 種類に分ける。(A) `isPlaced: false` → 現行テキストをそのまま返す。(B) 配置はされたが幅が狭い → コンパクト表示。
- 純粋関数 `analyze.ts` は無変更で再利用。画面モデル（幅に応じた行組み立て）を `$` 非依存の新ファイルに切り出し、`register.tsx` は配線だけにする。
- 読み取り専用は保たれる。`$.process.run`・`$.fs` 書込・ネットワークは使わない。新しい相談事項は無く、Q-003 に追記のみ（新 ID なし）。

## 目的

- 誰の: 長いセッションで窓の残りを気にして Claude Code を使う人（だいすけ想定）。
- どんな手間: 今は `/ctx` を打つたびに全文が transcript に流れ、窓が埋まったか確かめるために何度も叩く。出力は transcript に積まれ、`command.run` の `text` は **モデルも読む**ため（`reference.md` の CommandOutput 節）、確認のたびにトークンも使う（仮説: 量は未計測）。
- どう減るか: ペインを開いておけば、ターンごとに自動で更新された内訳が横に出る。叩く回数と transcript の汚れが減る。placed 時は `/ctx` の返答を 1 行にでき、モデルに渡る量も減る（仮説）。

## 現行 `/ctx` との差分

| 項目 | 現行 `/ctx`（観察: register.tsx / analyze.ts） | ペイン案 |
|---|---|---|
| 出力先 | `command.run` の `text`（transcript 1 行、モデルも読む） | ペイン（transcript の外）。`/ctx` の返答は placed 時 1 行 |
| 更新 | 叩いた時だけ | ターンごとに自動（`session.measure`）+ 開いた時 |
| 分析 | `analyze` → `render`（文字列） | 同じ `analyze`。表示だけ幅に合わせて組み直す |
| 幅への対応 | なし（80 桁想定の 1 本の文字列） | `bodyColumns` で通常／コンパクトを切替 |
| 権限 | 読取のみ | 読取のみ（変更なし） |

## ペインの画面構成（架空データ）

通常（`bodyColumns >= NARROW_BODY_COLUMNS`、仮置き 40）:

```
コンテキスト 62%   124,000 / 200,000 トークン（推定）
[████████████░░░░░░░░]  圧縮点 160,000 まで 36,000

内訳（使用上位）
  メッセージ  58,000  ███████
  メモリ      21,000  ███
  MCP         15,000  ██
空き 76,000 ／ 圧縮バッファ 33,000

所見
 [注意] 観察: 読込済み MCP ツール定義が 15,000 トークン（窓の 8%）…
        仮説: 使っていないサーバーが含まれていれば…
        → /mcp で上位サーバーの要否を確認
 [参考] 観察: スキル一覧 5,700 トークン（40/40 件を掲載）

測定 14:05（推定値）  ※しきい値は仮置き
```

コンパクト（`bodyColumns < 40`、棒グラフなし・1 項目 1〜2 行）:

```
ctx 62% 124,000/200,000
圧縮点まで 36,000
上位: メッセージ 58,000
      メモリ 21,000
[注意] MCP 15,000（8%）
測定 14:05 推定値
```

- 要素は `Box`・`Text` のみ（`$.ui.resolve(e)` が返す表の項目）。ボタンは第1段階では置かない。
- 観察／仮説／提案の 3 段は `render` の既存書式を踏襲する（「共起を原因と書かない」ルール）。
- 画面外にあふれる分はエンジンのスクロール（`Pane` の `scroll`）に任せる。上位 N 件で切るのは `analyze` 側の `TOP_N` のままにする。
- 日時は表示用の時刻のみ。実データ・パスは出さない（`memoryFiles` はファイル名＋type に短縮する現行方針を維持）。

## データの流れ

### 更新契機の候補

| 候補 | 内容 | 評価 |
|---|---|---|
| a. `session.measure` | 各メインスレッドのターン後と、レート制限が 1 ポイント動いた時に発火。`e.changed` に `'context'` が入る時だけ取得。型の注記に「breakdown が要るなら `$.session.usage({ breakdown })` をフック内で呼べ」とある | **推奨**。push 型で無駄な取得がない |
| b. `turn.complete` | ターン終了時 | 重複（a で足りる）。ターン外の変化（`/compact`）は拾えるか不明 |
| c. `$.clock.every` による定期取得 | 一定間隔で取得 | 不要。窓が動かない間も回る |
| d. 手動更新ボタン（`ui.press`） | ペイン内のボタンから | 任意。第1段階は見送り |
| e. `ui.render` 内で `$.session.usage` | 描画のたびに取得 | **不採用**。描画フックが `$.session.usage` を呼べるかは、読んだ範囲では未確認。書込は描画中に拒否される（`$.state.set` の注記）ので、読むだけの描画に統一する |

### フロー（推奨）

1. `command.run`（`ctx`、引数 `pane`）: `$.session.usage({ breakdown: 'summary' })` を 1 回取り、atom に書く → `$.ui.open({ id: 'context-doctor', title: 'Context' })`。結果の `isPlaced` で分岐（次節）。人の入力に応じた open は「asked」で、どの幅でも配置される（`UiOpenResult` の注記）。
2. `session.measure`: `e.changed` に `'context'` がなければ何もしない。`$.ui.panes()` に自分のペインが無い、または `isPlaced` が false なら何もしない（`isPlaced: false` のペインも一覧には残るため、`isPlaced === true` まで見る）。条件を満たせば `breakdown: 'summary'` を取り、atom に `update` で書く。
3. `ui.render`（`{ component: 'Pane', requestId: 'context-doctor' }`）: `read($, atom)` で読む（この読みが描画インスタンスを購読し、書込で自動再描画される。`$.ui.invalidate` は不要）。`e.props.bodyColumns` で表示を選び、純粋関数で行を組む。
4. 取得は常に `summary`（推定・通信なし）。Q-003 の A を維持。正確な再計数（`full`）は通信を伴いうるため着手しない（Q-003 に追記）。

未確認（仮説扱い。builder が実機で確認）:

- `session.measure` が `/compact` や `/clear` の後にも `context` の変化として発火するか。`/clear` は `session.end`（`reason: 'clear'`）を出し `session.start` は出さない（`reference.md`）。`$.state` が `/clear` 後に残るかも不明。→ 対策として「測定時刻」を必ず表示し、古い値が見分けられるようにする。
- `breakdown: 'summary'` を毎ターン取るコストの実測値（型には「ローカル推定で送信なし」とだけある）。
- `mcpTools` など配列が大きい Snapshot を atom に載せる際のサイズ上限。大きい場合は書込前にサーバー別合計へ畳む案を検討する。

## `$.state` 契約案

```ts
// mods/context-doctor/types/index.d.ts（plugin.json の "types" で指定）。自己完結で import しない。
export type PaneViewSnapshot = { /* analyze.ts の Snapshot と同形の再宣言 */ }
export type PaneView = { v: 1; status: 'empty' | 'ok'; snapshot?: PaneViewSnapshot; measuredAtMs?: number }

declare module 'claude-code' {
  interface PluginState {
    'context-doctor': { view: PaneView }
  }
}
```

- 契約は `hooks/` でなく `types/index.d.ts` に置き、`plugin.json` の `types` で指定する。契約ファイルは `analyze.ts` を import せず、`PaneViewSnapshot` を `analyze.ts` の `Snapshot` と同形で再宣言する。形を変えるときは両方を直し、`PaneView.v` を上げる。
- atom 本体（`atom({ plugin: 'context-doctor', key: 'view' } as const, EMPTY_PANE_VIEW)`）は `register.tsx` に置く。`claude plugin validate` の静的走査は、`update` / `read` の参照を同じファイル内のリテラル参照か atom の const としてしか読めないため（別ファイルから import した atom は検証エラーになった）。更新は `update($, paneView, () => view)` の関数形で書く。

- `plugin` はリテラル `'context-doctor'`（`plugin.json` の `name` と一致）、`key` はリテラル `'view'`。`as const` の参照を atom 生成にのみ使う（型ファイルの注記: リテラルでないと `claude plugin validate` で検出される）。
- atom の初期値は `{ v: 1, status: 'empty' }`。`status: 'empty'` なら描画は「まだ内訳がありません（最初の応答後に開き直してください）」を出す（現行 `register.ts` の文言を再利用）。
- **幅に依存しないデータだけ**を載せる（Snapshot と時刻）。`analyze` と行組みは描画時に走らせる。幅が変わっても再取得は不要。
- JSON 安全性（未確認）: `$.state.set` は「JSON データ・`undefined` 不可」とある（3416 付近の注記）。現行の Snapshot 組立は `skills` `slashCommands` `autoCompactThreshold` を `undefined` のまま持ちうるため、書込前に `undefined` のキーを落とす（T2 のテストで担保）。`readonly` 配列を含む `Snapshot` がそのまま `PluginState` の値型として通るかは tsc を通すまで未確認（仮説）。
- `v` は形の版。ホットリロードでは state が残るため、コードの形が変わると古い値に当たる。描画側は `v !== 1` を `empty` と同じに扱う。より厳密にするなら atom の `{ shape }` オプションと `Shaped<T>` があるが、第1段階は `v` で足りる。
- 永続化（`$.store`）は使わない。セッション内で足り、`$.store` は書込扱いにして論点が増えるため（必要になれば Q を立てる）。

## 幅が狭い・配置されない場合

型からの観察（実行はしていない）:

- `/ctx` の中からの open は「asked」→ 端末の幅に関係なく配置される。fullscreen 時は 110 桁以上でドック、それ未満や通常画面では prompt の上にインライン。
- `isPlaced: false` になるのは、(1) 人の入力を介さない open（`session.start` や timer）で 144 桁（過去に人が開いた id は 110 桁）未満、(2) ペインを置かない面（古い desktop 等）に繋がっている場合のみ。

設計:

| ケース | 条件 | 挙動 |
|---|---|---|
| A. 配置されない | `$.ui.open` が `{ isPlaced: false, reason }` | 現行の `render(snap, analyze(snap))` のテキストを `command.run` の返答にそのまま返す。ペインは開いたまま未描画で待機する（`$.ui.close` はしない）。後から配置できる面が繋がれば atom の値で描かれ、「測定時刻」で古さが分かる。待機中は `session.measure` で取得しない |
| B. 配置されたが狭い | `bodyColumns < NARROW_BODY_COLUMNS`（仮置き 40） | コンパクト表示（上図）。棒グラフを出さず折り返しを前提にしない |
| C. 配置された | `isPlaced: true` | `/ctx` の返答は 1 行（「ペインを開きました（62%）」程度）。全文は出さない |

- **`session.start` で自動 open はしない**。unasked の open は幅で `isPlaced: false` になる唯一の経路で、かつ人が頼んでいないペインを出すことになるため。
- 閾値 `NARROW_BODY_COLUMNS` は名前付き定数にして仮置きと明記。目視で調整する。

## 純粋関数の再利用方針と構成

CLAUDE.md の「判定ロジックは純粋関数、register は薄く」に従う。

| ファイル | 役割 | `$` への依存 |
|---|---|---|
| `analyze.ts`（既存・**無変更**） | `Snapshot` → `Finding[]`、既存の文字列 `render`（フォールバック A で再利用） | なし |
| `pane-model.ts`（既存） | 入力 `{ view, findings, bodyColumns, measuredAtMs? }` → 行モデル `PaneRow[]`。export は `buildPaneRows`。通常／コンパクトの切替、棒の比率、時刻整形を持つ | なし |
| `types/index.d.ts`（既存） | `PaneView` / `PaneViewSnapshot` と `PluginState` の宣言（`plugin.json` の `types`） | 型のみ |
| `pane-atom.ts`（既存） | `EMPTY_PANE_VIEW`（初期値）。atom 本体は上記の理由で `register.tsx` | なし |
| `pane-snapshot.ts`（既存） | `buildSnapshot`（内訳 → Snapshot）、`dropUndefined`、`buildPaneView`（atom に書く値） | なし |
| `pane-view.tsx`（T3 で最小版） | 行モデル → `Box` / `Text`（`$.ui.resolve(e)` の戻りを引数で受ける）。ロジックを持たない | 要素表のみ |
| `register.tsx`（`register.ts` から改名） | `session.start`（コマンド登録）、`command.run`、`session.measure`、`ui.render` の配線のみ。Snapshot 組立は既存コードを関数に括り出して共有 | あり |
| `hooks.json` | `"modules": ["./register.tsx"]` に変更 | - |

- Snapshot の組立は `register.tsx` 内でなく `pane-snapshot.ts` の `buildSnapshot`。`command.run` と `session.measure` の両方がそれを呼ぶ（DRY）。
- 画面モデルの純粋関数はテストしやすさ優先。JSX は `pane-view.tsx` だけに閉じる。

## API 名 → 型ファイル内の宣言（確認表）

2.1.295 同梱の `claude-code.d.ts` を grep した結果。行番号は宣言行。例の出所は `examples/pane.tsx` と `pane-state.d.ts`。

| 使う API / 型 | 宣言（行） | 確認した内容 |
|---|---|---|
| `Register` | `export type Register`（9301） | `(on, options) => unknown` |
| `$.ui.open` | `open: (pane: PaneOpenArgs) => Promise<UiOpenResult>`（2500） | 注記に asked/unasked の幅規則（2484 付近）。`PaneOpenArgs`（7390）に `id` `title` `focus` `rows` `columns` |
| `UiOpenResult` | `export type UiOpenResult`（14134） | `{ isPlaced: true }` または `{ isPlaced: false; reason }`。`ui.open` フックで `{ value: { isPlaced: false, reason } }` を返す例あり（テストで再現可） |
| `$.ui.panes` / `UiPane` | `panes: () => …`（2527）／`UiPane`（14167、`isPlaced` は 14192） | 自分のペイン一覧と `isPlaced` |
| `$.ui.close` | `close:`（2514） | 第1段階では使わない（人が閉じる） |
| `$.ui.invalidate` | `invalidate:`（2360） | 使わない（`$.state` 購読で自動再描画） |
| `ui.render` イベント | `'ui.render': RenderInput`（3981）、`RenderInputOf`（9715） | `requestId`（9734）、`viewport?`（9743）、`props`（9747） |
| `Pane` の props | `Pane: {`（10312） | `bodyColumns`（10330）、`placement: 'dock' \| 'inline'`（10338）、`isFocused`、`scroll` |
| `RenderViewport` | `export type RenderViewport`（10390） | `columns` `rows` `isFullscreen?`（10415） |
| `$.ui.resolve` / 要素表 | `resolve:`（2397）／`Elements`（3802）、`Box`/`Text`/`Button`（3804/3805/3806） | `BoxProps`（901）、`TextProps`（12563、`dimColor` `bold` `color`） |
| `command.run` イベント | `'command.run': CommandRunInput`（4239）、`CommandRunInput`（1792） | `presentation`（1818）= `CommandPresentation`（1761）。`CommandRunResult`（1837）は `{ text, context? }` |
| `$.command.register` | `register:`（3091） | 既存コードと同じ。`argumentHint` の説明は 3086 付近 |
| `session.start` | `'session.start': SessionStartInput`（4334） | コマンド登録に既存利用 |
| `session.measure` | `'session.measure': SessionMeasureInput`（4415）、`SessionMeasureInput`（11095） | ターン後にコンテキスト変化で発火。`changed: UsageUnit[]`（11120）。注記に「breakdown は `$.session.usage` で」 |
| `UsageUnit` | `export type UsageUnit`（14594） | `'context' \| 'rateLimits' \| 'cost'` |
| `$.session.usage` | `usage: (args?) => Promise<SessionUsage>`（2846） | `SessionUsage`（11704）、`SessionUsageArgs`（11737）で `breakdown` を指定 |
| `ContextBreakdownDetail` | `'summary' \| 'full'`（2117） | `summary` は送信なしのローカル推定 |
| `SessionContextBreakdown` | `export type SessionContextBreakdown`（10866） | `totalTokens`（10875）、`autoCompactThreshold?`（10928）、`isAutoCompactEnabled`（10932）。`ContextCategoryKind`（2156） |
| `$.state.get` / `set` | `get:`（3400）／`set:`（3416） | `get` を描画中に呼ぶと購読、`set` は描画中禁止。`plugin`/`key` はリテラル必須 |
| `PluginState` | `export interface PluginState`（7786） | 宣言マージで契約を足す |
| `StateFamily` / `StateRef` | 12009／12054 | 使わない（単一値）。参照の型 |
| `atom` / `read` / `update` | `export const atom`（14701）／`read`（14726）／`update`（14735） | 型: `AtomFunction`（708）、`ReadFunction`（9284）、`UpdateFunction`（14585）。`AtomOptions`（720）、`Shaped<T>`（11833） |
| `session.compact` | `'session.compact'`（4383） | 使わない。`/compact` 後の更新が `measure` で足りるかの確認対象 |

型ファイルに宣言が見つからなかったものはない。ただし「描画フック内から `$.session.usage` を呼んでよいか」「`session.measure` が `/compact`・`/clear` で発火するか」は型・docs から読み取れなかったため、設計上は避ける／実機確認に回す。

## 受け入れ基準

1. `/ctx pane` でペインが開き、現在の窓使用率・内訳上位 3・所見が出る。引数なし `/ctx` の出力は現行と同一（回帰なし）。
2. 1 ターン進めるとペインの数値が自動で更新され、「測定時刻」が進む。
3. `isPlaced: false`（`ui.open` フックで再現）では現行テキストが返り、ペインに依存しない。
4. 狭い幅（`bodyColumns < NARROW_BODY_COLUMNS`）でコンパクト表示になり、横にはみ出さない。
5. 初回応答前は「まだ内訳がありません」が出て、例外にならない。
6. `$.process.run`・`$.fs` 書込・ネットワークを使っていない（grep で確認）。
7. `claude plugin validate mods/context-doctor`、`claude plugin test mods/context-doctor`、tsc が通る。
8. **目視確認**（`claude --plugin-dir` で fullscreen と通常画面の両方）。無人セッションでは実施できないため、実施するまで「目視未確認」と報告に書き、だいすけに依頼する。

## テスト方針

- 純粋関数（`pane-model.ts`）: 既存 `analyze.test.ts` の架空サンプルを流用し、通常／コンパクトの切替、境界値（`bodyColumns` ちょうど閾値）、`status: 'empty'`、`v` 不一致、`maxTokens = 0` を AAA で。
- フォールバック A: `claude-code/testing` のテストで `ui.open` フックを plugin の下に置き `{ value: { isPlaced: false, reason } }` を返させ、`command.run` の `text` が現行 `render` と一致することを確認する（型ファイル 14155 付近の例）。
- UI: `mount`（`{ plugin, surface, component: 'Pane', props }`）を `['terminal', 'desktop'] as const` でループ（`reference.md` のテスト節）。描画の見た目ではなく、行・文言が出ることを検証する。
- `session.measure` の経路: テストキットで当該イベントを発火できるかは builder が自セッションの型で確認する（本書では未確認）。できない場合は、Snapshot 組立と atom 更新の関数を単体で検証する。
- カバレッジは 80% を目標（純粋関数側で稼ぐ）。

## builder への実装タスク分割

| # | タスク | 依存 | 完了条件 |
|---|---|---|---|
| T1 | **済（PR#9）** `pane-model.ts` + テスト（RED → GREEN）。`NARROW_BODY_COLUMNS` を名前付き定数に | なし | 通常／コンパクト／empty の各テスト通過 |
| T2 | **済（PR#9）** `types/index.d.ts` と atom 初期値、Snapshot 組立の共通関数化（既存の挙動不変）。書込前に `undefined` キーを除く処理とそのテストを含む | なし（T1 と並行可） | 既存 `analyze.test.ts` が全通過、tsc 通過 |
| T3 | **実装済（本 PR・目視未確認。`session.measure` 経路はテストキットで発火できず未テスト）** `register.ts` → `register.tsx` に改名、`hooks.json` を更新。`command.register` に `argumentHint: 'pane'` を付け（`/ctx pane` を一覧で発見できるように）、`command.run` の `pane` 引数、`session.measure` 更新、`ui.render` 配線 | T1・T2 | フォールバック A のテスト通過 |
| T4 | `pane-view.tsx` + `mount` テスト（terminal/desktop） | T1 | 両面でテスト通過 |
| T5 | `claude plugin validate/test`、tsc、README の「動作確認済みバージョン」更新、feat ブランチ → push → PR（main 直 push 禁止） | T3・T4 | 全通過。PR 説明に「目視未確認」と明記 |
| T6 | だいすけによる目視確認（fullscreen／通常画面）。結果で `NARROW_BODY_COLUMNS` を調整 | T5 | 目視 OK の記録 |

並列実行できるのは T1 と T2。T3 より前に T1・T2 を終える。

## 決めること（mods-lead 向け・open-questions には載せない）

- ペインを `/ctx` の既定にするか、`/ctx pane` の opt-in のままにするか。
  - 選択肢: A) opt-in（第1段階）B) 目視後に既定化。
  - おすすめ: A（回帰が起きない。目視確認後に B を判断）。
  - 期限: T6（目視確認）後。

## open-questions への追記

- 新 ID は作らない。Q-003 に「追記（mod-004）」を 1 行足した（`full` でのペイン内再計数は通信を伴いうるため着手しない）。
- 通信・書込・実行・public 化に触れる案は本書に含めていない。
