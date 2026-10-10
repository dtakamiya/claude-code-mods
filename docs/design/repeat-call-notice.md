# repeat-call-notice 要件書（mod-010）

- 出所: `docs/design/ideas.md` 案 4。コードは書かない（本書は builder 向けの要件）
- 状態: 要件のみ。**UI（トースト）を持つため目視未確認**。閾値 N は**根拠なしの仮置き**
- 型の確認: Claude Code 2.1.296 の型ファイルを grep で確認（§9）。型ファイルのパスはセッション固有なので書かない

## 1. 目的と非目的

- 目的: 1 ターンの終わりに、同じツールを同じ入力で N 回以上呼んでいたら、トーストで事実だけ知らせる。
- 非目的: 拒否・書き換え（`tool.call` の `deny` は使わない）、原因の推定（反復は停滞の「共起」であり原因ではない。実データ未確認）、通知文への入力内容の掲載、書込・実行・通信。

## 2. 反復の定義

- 同一視の条件: `tool` 文字列が完全一致、かつ `input` の正規化表現が一致。`result` / `text` / `isError` は**読まない**（内容が入りうるため。失敗後の再試行も反復として数える。これは仮置き）。
- 正規化（`canonicalKey`）: `input` を、オブジェクトのキーを再帰的に辞書順に並べ、配列は順序を保って JSON 化した文字列にする。キー順だけが違う入力は同一。
- 正規化できない入力（循環参照・BigInt など）: 例外を外に出さず、その呼び出しを**他と一致しない 1 件**として数える。`catch` では `err.message` を使わない（プロパティ名が入りうる）。
- 比較は内部のみ: 正規化キーは関数内の `Map` のキーにだけ使い、戻り値・ログ・トースト・テストのスナップショットに出さない。
- ハッシュ化しない（v0 の決定）: `crypto.subtle.digest` は非同期で、判定の純粋関数が非同期になる。同期の正規化キーをメモリ内にだけ持てば「比較は内部のみ」を満たす。巨大入力でのメモリが問題になったら、その時にハッシュ化を再検討する。
- 戻り値の型は `{ tool: string; count: number }[]` のみ。入力が型の上で外に出られないようにする。

## 3. 1 ターンの範囲

`SessionMessage` に turnId は無い。次の規則で境界を決める（`analyze.ts` の純粋関数として実装・テストする）。

- (a) 境界: `$.session.messages()` の末尾から遡り、`role === 'user'` かつ `toolResults` が無い（または空）の最後のメッセージを「このターンの開始」とする。その**次**のメッセージ以降の `toolUses` を集計する。
- (b) `toolResults` を持つ user メッセージは境界にしない（ツール結果の返却であり、新しいプロンプトではない）。
- (c) `turn.complete` の `e.agentId !== undefined`（サブエージェントのターン）では何もせず `next(e)` を返す。引数なしの `messages()` は主会話を読むため、サブエージェントの終了時に主会話を誤って集計する。
- (d) `e.reason`: v0 は `answer` / `aborted` / `refusal` / `error` のすべてで通知する（事実の通知であり、中断・失敗でも反復は起きうる）。仮置き。
- 開始 user メッセージが見つからない（空・assistant のみ）場合は全メッセージを対象にする。
- `messages()` は最新 4096 件まで。超過時は数え落としが起きうるが許容する（過少申告のみ。誤検知にはならない）。

## 4. 閾値 N

- `REPEAT_THRESHOLD = 3`（`analyze.ts` に名前付き定数、関数引数でも上書き可にしてテストで使う）。
- **根拠なし・仮置き**。実セッションの分布を見ていない。Q-002 回答（B: 実測せず仮置き）の運用に倣い、観察表示に留める。実測が必要になったら open-questions Q-008 を再提起する。
- `userConfig` は作らない（YAGNI）。

## 5. 通知文

- 形式: `同じ呼び出しの反復: Bash ×4、Read ×3`（tool 名と回数のみ）。入力の中身・tool_use_id・結果は含めない。
- 並び: 回数の多い順、同数は初出順。表示は最大 3 組、超過は `ほか k 組`。
- 同じ tool で入力が違う 2 組（例: Read が 3 回の組が 2 つ）は**別の組として並べる**（`Read ×3、Read ×3`）。入力で区別して見せることはしない。
- `$.ui.toast(text)`（既定 4000 ms）。該当が無ければ何も出さない。判定の失敗時もトーストは出さず、固定文言のログのみ。
- フックは常に `next(e)` の結果を**そのまま**返す（応答テキストは変えない）。

## 6. 構成（CLAUDE.md の規約どおり）

- `mods/repeat-call-notice/.claude-plugin/plugin.json`（version `0.1.0`）、`hooks/hooks.json`、`hooks/register.ts`、`hooks/analyze.ts`、`hooks/analyze.test.ts`
- `analyze.ts`: `$` に触れない純粋関数 `findRepeats(messages, threshold)` と `formatNotice(repeats)`。`register.ts` は薄く、`on('turn.complete', …)` で `messages()` → `findRepeats` → `toast`。
- `.claude-plugin/marketplace.json` に追記。README の「動作確認済みバージョン」を更新。`.claude-plugin/types/` はコミットしない。
- tsconfig は CLAUDE.md では mod フォルダの外。mod-009（session-recap）は `mods/session-recap/tsconfig.json` を置いているので、どちらに合わせるか builder が確認する。

## 7. テストケース（全て架空データ。N=3）

入力例は `{ path: 'a.txt' }` のような架空値。以下は `findRepeats` の期待値。

| # | ケース | 期待 |
|---|---|---|
| 1 | 同一 tool・同一 input が 3 回（N ちょうど） | `[{ tool, count: 3 }]` |
| 2 | 同上が 2 回（N-1） | `[]` |
| 3 | 4 回・5 回 | 実際の回数（4・5）で報告 |
| 4 | 同一 tool で input が 1 キーだけ違う 3 回 | `[]`（組にならない） |
| 5 | 同一 input で tool が違う 3 回 | `[]` |
| 6 | メッセージ空 / toolUses 無しの assistant のみ | `[]` |
| 7 | 複数組が同時（Bash×4 と Read×3、別組の Read×3 を含む） | 回数降順・同数は初出順で全組 |
| 8 | キー順だけ違う同一 input、入れ子オブジェクト | 同一組として数える |
| 9 | 最後のプロンプトより前の反復 | 数えない（§3-a） |
| 10 | 呼び出しの間に `toolResults` を持つ user メッセージが挟まる | ターンは分割されない（§3-b） |
| 11 | 循環参照の input | 例外を投げない。その呼び出しは他と一致しない |
| 12 | 漏えい確認: input に架空の目印文字列を入れる | 目印が `findRepeats` の戻り値にも `formatNotice` の文字列にも**含まれない**。input 由来の値をスナップショットしない |
| 13 | `formatNotice`: 4 組以上 | 3 組 + `ほか k 組`。同 tool 2 組は別々に並ぶ |

`register.ts` 側は `claude-code/testing`（型に実在）で、`turn.complete` で toast が 1 回出る / `agentId` 付きでは出ない / `messages()` 失敗で例外にならない、を可能な範囲で追加する。

## 8. 検証手順（builder 用）

1. `claude plugin validate mods/repeat-call-notice`
2. `claude plugin test mods/repeat-call-notice`
3. tsc（上記の tsconfig の置き場に従う）
4. `git check-ignore -v mods/repeat-call-notice/.claude-plugin/plugin.json` が何も出さない（`.gitignore` は `mods/*/.claude-plugin/types/` のみで、mod-009 と同じ）
5. `plugin.json` の version `0.1.0`、marketplace 追記、README 更新
6. feat/ ブランチ → push → PR（main 直 push 禁止）

## 9. 目視未確認（報告に明記する）

- トーストが実際にターン終了時に出る・読める・4 秒で足りるか
- 反復が無い普通のターンで出ない
- `turn.complete` の時点で `messages()` が最終ステップの `toolUses` を含むか
- 継続ターン（`TurnStartInput.text` が `""`）や、ターン途中の圧縮で境界の規則が崩れないか（前ターンの呼び出しを再通知しないか）
- サブエージェントのターンで出ない

## 10. 使った API の型上の根拠（2.1.296 の型ファイルを grep で確認）

| 使うもの | 型の宣言と要点 |
|---|---|
| `turn.complete` | イベント表に `'turn.complete': TurnCompleteInput` / 結果 `TurnCompleteResult`（`{ text; usage? }`）。`TurnCompleteFields` に `agentId?`（主ループでは無し）、`isAborted`、`durationMs`。`reason` は `'answer' \| 'aborted' \| 'refusal' \| 'error'` |
| フックの形 | `messages()` の doc の例 `on("turn.complete", async ($, e, next) => { … return next(e) })` |
| `$.session.messages()` | `SessionMessagesCall` の引数なし形は `Promise<SessionMessage[]>`。doc: 主会話、最新 4096 件、`{ role, text, toolUses }` |
| `SessionMessage` | `role`、`text`、`toolUses: ToolUseSummary[]`、`toolResults?: ToolResultSummary[]`（user のみ） |
| `ToolUseSummary` | `tool: string`（`tool.call` の `e.tool` と同じ）、`input: Record<string, unknown>`。`result?` `text?` `isError?` は読まない |
| `$.ui.toast` | `toast: (text: string, options?: ToastOptions) => void`。先頭 2000 文字まで描画。`ToastOptions = { timeoutMs? }`（既定 4000） |
| 正規化 | 特別な API は使わない（`JSON.stringify` のみ）。`crypto.subtle.digest` は型にあるが非同期のため不採用 |
| テスト | `declare module 'claude-code/testing'` が型に実在 |

## 11. 相談キュー

読取のみで完結するため着手の相談は不要。実データが要る項目だけ `open-questions.md` の Q-008 に載せた（N の根拠づけ）。
