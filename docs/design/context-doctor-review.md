# context-doctor 課題点レビュー（mod-002）

- 対象: `mods/context-doctor/hooks/analyze.ts` / `register.ts` / `analyze.test.ts`（試作1号）
- 出所: repo のコード、セッションに書き出された型定義（`.claude-plugin/types/claude-code/index.d.ts` の `SessionContextBreakdown` 周辺。パスはセッション固有なので以後は型名で参照）
- 方法: 架空の匿名化 Snapshot 11 個で `analyze` / `render` を Node で実際に実行（コードは変更していない）。実セッションでの `/ctx` 実行は未実施（目視未確認）

## 結論

**試作1号は「動くが、判断材料としては薄く、誤検知の芽が 1 つある」。** 型との整合は取れているが、型が提供している情報の大半（skills / agents / slashCommands / 自動圧縮しきい値 / MCP の isLoaded）を使っていない。mod-001（改善実装）では次の順で直すのがよい。

1. MCP 集計から未ロード（`isLoaded: false`）のツールを除く（誤検知）
2. 80% 判定を `autoCompactThreshold` / `isAutoCompactEnabled` 基準に寄せる（的外れな文言の回避）
3. 絶対量の下限を足し、MCP のサーバー別内訳を出す（行動に移せる提案にする）
4. skills / agents / slashCommands を観点に追加

しきい値（80% / 10% / 5%）の根拠はコードにもコメントにもなく、実測による裏付けも無い（詳細は後述）。

## 型との整合確認

| analyze.ts の Snapshot | 型定義 | 判定 |
|---|---|---|
| `percentage` / `totalTokens` / `maxTokens` | `SessionContextBreakdown` に同名で実在 | 一致 |
| `categories: Row[]`（name/tokens/kind） | `ContextCategory`（他に color, isDeferred もある） | 部分集合で互換 |
| `mcpTools: {tokens}[]` | `ContextMcpTool`（name, serverName, tokens, isLoaded） | 互換だが `isLoaded` / `serverName` を捨てている |
| `memoryFiles: {path,tokens}[]` | `ContextMemoryFile`（path, type, tokens） | 互換だが `type`（Project/User/AutoMem 等）を捨てている |
| 未使用 | `skills`, `agents`, `slashCommands`, `autoCompactThreshold`, `isAutoCompactEnabled`, `rawMaxTokens`, `autocompactSource`, `apiUsage` | 型に実在。使える情報 |

## 課題点リスト

凡例: 観察 = 実行結果・コード・型から直接言えること / 仮説 = 未検証の推測。

### C-1 [高] 未ロードの MCP ツールまで合計して誤検知しうる

- 観察: `register.ts` は `b.mcpTools` を丸ごと渡し、`analyze` は `isLoaded` を見ずに全 `tokens` を合算する（analyze.ts L29）。型では `isLoaded` は「ツールスキーマがオンデマンド読込のとき、まだ検索されていないものは false」とある。サンプル C（60 ツール × 500 トークンが全て未ロード、使用率 10%）でも「MCP 定義 30000 トークン（窓の 15%）→ 無効化せよ」が出た。
- 仮説: オンデマンド読込が有効なセッションでは、窓を占めていない分まで警告し、無効化を促して利便性を下げる。未ロード分の tokens が窓の外として扱われるかは型からは断定できない（`deferred` カテゴリは「窓の外」と明記されているが、`mcpTools` 個別の `tokens` が窓内かは未確認）。
- 根拠: analyze.ts L29-30、型 `ContextMcpTool.isLoaded`、`ContextCategoryKind`（deferred は窓の外）。
- mod-001 提案: `isLoaded` が true のものだけ合算。未ロード分は別行の参考情報（info）に回す。

### C-2 [高] 「自動圧縮が近い」の判定が実際の圧縮点とずれうる

- 観察: 判定は `percentage >= 80`（固定）。型には実際の圧縮点 `autoCompactThreshold`（無効時は欠落）と `isAutoCompactEnabled` があるが未使用。`percentage` は `totalTokens / rawMaxTokens` で、`rawMaxTokens` はモデル上限か「より小さい圧縮用ウィンドウ」（`autocompactSource` で由来が分かる）。サンプル F（使用 152000/200000=76%、空き 3000、バッファ 45000）は所見なしだったが、バッファを含めると実質余裕がほぼ無い構成。サンプル E は自動圧縮が無効でも同じ文言を出す。
- 仮説: ① `totalTokens` にバッファ行が含まれるかは型の記述（"Tokens in use"）だけでは確定できない。含まれるなら 80% は実質より早く、含まれないなら遅く鳴る。② 自動圧縮が無効のセッションで「自動圧縮が近い」は事実と合わない。
- 根拠: analyze.ts L13, L22-27、型 `SessionContextBreakdown.percentage` / `autoCompactThreshold` / `isAutoCompactEnabled` / `ContextCategoryKind`。
- mod-001 提案: `totalTokens` と `autoCompactThreshold` の差（あと何トークンか）で判定し、文言は有効/無効で出し分ける。バッファを含むかは実測で確認してから判定式を決める（不明点 U-1）。

### C-3 [中] 絶対量に下限が無く、窓の大きさで鈍感になる

- 観察: MCP 10%・メモリ 5% は窓比。サンプル H（窓 100 万、MCP 20000・メモリ 20000 トークン）は共に 2% で所見なし。窓 20 万なら同じ絶対量は 10% で MCP が指摘される。境界サンプル K（メモリ 10000/20 万 = 5.0%）はちょうど指摘された（`>=`）。
- 仮説: 大きい窓のユーザーにとって、常時読み込み 2 万トークンは無視できないが検出されない。逆に小窓では少量でも検出される。どちらが「困りごと」に近いかは実利用で未検証。
- 根拠: analyze.ts L14-15, L30, L38。
- mod-001 提案: 窓比 OR 絶対量（例: 2 万トークン超）のどちらかで指摘。値は不明点 U-2 の実測後に決める。

### C-4 [中] 提案が行動に移しにくい（どれを・どこから）

- 観察: MCP は「使っていない MCP サーバーを無効化する」と一般論のみ。`ContextMcpTool.serverName` があるのにサーバー別の合計を出さない。メモリは最大 1 ファイルの絶対パスを出すが、`type`（Project/User/AutoMem）を出さず、どの層を直すべきか分からない。サンプル B（60 ツール）では重いサーバーが特定できない。
- 仮説: サーバー名とトークン数の上位 3 件が出れば、そのまま `/mcp` で無効化の判断ができるはず（未検証）。
- 根拠: analyze.ts L29-36, L37-44、型 `ContextMcpTool` / `ContextMemoryFile`。
- mod-001 提案: MCP はサーバー別上位 3 件、メモリは type 付き上位 3 件を出す。

### C-5 [中] 型にある観点を使っていない（skills / agents / slashCommands）

- 観察: `skills`（totalSkills / includedSkills / tokens / 個別）、`agents`（agentType, source, tokens）、`slashCommands`（totalCommands / includedCommands / tokens）が型に実在するのに、`Snapshot` に無く分析されない。特に `includedSkills < totalSkills` はリストが予算で切られたことを示す。ミッション記載の観点（スキル/エージェント一覧）と食い違う。
- 仮説: スキル一覧の切り捨ては、モデルが使えるスキルを見落とす原因になりうる（因果は未検証。観察できるのは件数差のみ）。
- 根拠: 型 `ContextSkills` / `ContextAgent` / `ContextSlashCommands`、analyze.ts L3-10。
- mod-001 提案: スキル（切り捨て有無）→ エージェント → コマンドの順で info 行を追加。

### C-6 [中] `categories` を分析に使っておらず、Messages の肥大が見えない

- 観察: `categories` は Snapshot に入るが `analyze` / `render` のどこでも参照されない。Messages 行（会話本体）が支配的でも、80% 未満なら何も言わない。サンプル A〜D は内訳が全く表示されない（`render` はヘッダ 1 行と所見のみ）。
- 仮説: 利用者が最も知りたい「何が窓を食っているか」の概観（カテゴリ別の上位）が無く、診断コマンドとしては情報が少ない。
- 根拠: analyze.ts L7, L49-53。
- mod-001 提案: 所見の有無に関わらず `kind: 'used'` の上位 3 カテゴリと、free / buffer を 1 行ずつ出す。

### C-7 [中] 80% 超の提案が一律で、`/clear` は副作用が大きい

- 観察: 文言は「/compact か /clear」。`/clear` は会話を捨てる操作で、`/compact` と同列に提示されている。100% 超（サンプル I: 112%）でも同じ文言と同じ high。
- 仮説: 圧縮点を過ぎた後は取れる行動が変わる（すでに圧縮が走る、または走らない設定）が、現状は区別されない。
- 根拠: analyze.ts L22-27。
- mod-001 提案: `/compact` を第一候補に、`/clear` は「作業の区切りで」と条件付きにする。超過時は別文言。

### C-8 [低] 表示が読みにくい・一貫しない

- 観察: レベルが `[high]` `[mid]` `[info]` の英字（`info` は現状どの経路でも出ない）。トークン数が桁区切り無し（166000）。メモリのパスが絶対パスで長く、ユーザー名を含みうる（スクリーンショットや共有時に出る）。所見の並びは固定で重大度ソートはされない。
- 仮説: 日本語表示（「要対応/注意/参考」）と桁区切りで読みやすくなる（未検証）。
- 根拠: analyze.ts L11, L33, L42, L50-52。
- mod-001 提案: ラベルの日本語化、桁区切り、パスはホーム相対またはファイル名 + type に短縮。

### C-9 [低] テストが薄い

- 観察: `analyze.test.ts` は 3 件（所見なし / high / MCP）。メモリ所見、境界値（ちょうど 80 / 10% / 5%）、`maxTokens = 0`、`render` はテストされていない。サンプル J（maxTokens=0）は `share` のガードで所見なしになる動作を今回の実行で確認したが、テストには無い。
- 根拠: analyze.test.ts 全体、analyze.ts L18。
- mod-001 提案: 本レビューのサンプル（A〜K）をそのままテストケース化する。

### C-10 [低] 内訳が推定値である旨が出ない

- 観察: `register.ts` は `breakdown: 'summary'` を使う。型では `summary` は直近応答の usage とローカル推定、`full` は token-count API で数える。また `breakdown.totalTokens` は `context.tokens` と一致しない場合がある（型の注記）。出力に「推定」の表記は無い。
- 仮説: 数値を絶対値として読まれると、`/context` との差を不具合と誤解されうる。
- 根拠: register.ts L15、型 `ContextBreakdownDetail` / `SessionContextUsage.breakdown` の注記。
- mod-001 提案: ヘッダに「推定値」と明記。`full` は通信を伴う可能性があるため不明点 Q-003 で扱う。

## しきい値の根拠と妥当性評価（mod-006 用）

| 値 | 現在の使い方 | 根拠の有無 | 評価（観察） | mod-006 で確かめること |
|---|---|---|---|---|
| 80%（`HIGH_PERCENT`） | `percentage >= 80` で high | コードに根拠なし | 実際の圧縮点（`autoCompactThreshold`）と無関係な固定値。圧縮点が分母の何%かは設定・モデルで変わる | 実セッションで `autoCompactThreshold / rawMaxTokens` を記録し、80% が圧縮点の手前に来るか |
| 10%（`MCP_SHARE`） | MCP 合計 / `maxTokens` | なし | 未ロード分を含む（C-1）。窓の大小で意味が変わる（C-3） | `isLoaded` のみで合算した実測分布、窓 20 万/100 万での典型値 |
| 5%（`MEMORY_SHARE`） | メモリ合計 / `maxTokens` | なし | 窓 20 万で 1 万トークン。CLAUDE.md＋rules が複数あると超えやすい。誤検知か妥当かは未検証 | 実際のメモリ構成での分布、どの type（User/Project/AutoMem）が占めるか |

- 分母: `maxTokens`（= `rawMaxTokens`）は圧縮用ウィンドウでモデル上限より小さいことがある。MCP/メモリ比の分母としては「実際に使える窓」なので妥当と見てよいが、バッファ（圧縮の予約領域）を引いた実効窓で割る案との差は未評価。
- `percentage` がバッファを含むか: 型からは確定できない（U-1）。サンプル F の「76% で空き 3000」は、バッファを含めて実質余裕が無い状況の例。
- `free` / `buffer` 行: `analyze` は一切参照しない（C-6）。`kind` で判別でき、`name` に依存しない設計は型の推奨どおり。

## 不明点

- U-1: `totalTokens` / `percentage` に `buffer` 行が含まれるか。型は「使用中」としか書かない。実セッションの `/ctx` 出力（categories の合計と totalTokens の比較）で確認できる。
- U-2: 実際の利用者のメモリ・MCP 構成の分布。今回は架空サンプルのみで、しきい値の良し悪しは判定できない。
- U-3: オンデマンド読込（deferred）時に、`mcpTools` の未ロード分の tokens が `totalTokens` に入るか。
- U-4: 実環境での目視確認（`claude --plugin-dir` で `/ctx` の見え方）。無人セッションでは不可。
- 付記: 今回の再現は `analyze` / `render` の純粋関数のみ。`register.ts` が `$.session.usage` から Snapshot を組み立てる経路は型の確認のみで、実行していない。
