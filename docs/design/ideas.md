# 新 mod アイデア（mod-005・隙間探し）

作成: mods-analyst / 2026-10-10。コードは書かない。UI を持つ案は全て **目視未確認**（無人セッションのため）。

## 出所

- repo: `CLAUDE.md` / `README.md` / `docs/design/open-questions.md` / `mods/context-doctor/hooks/register.ts`
- 型ファイル: plugin-authoring スキルが書き出した `claude-code.d.ts`（Claude Code 2.1.295 の build）。以下「型」と略し、確認箇所は宣言名で示す（行番号はセッション固有のため書かない）
- 公式 docs（code.claude.com/docs/en/plugins/mods/*）は今回参照していない。型ファイルのみで確認した範囲に限る

## 隙間の観察（事実）

- 既存 mod は `context-doctor` 1 本のみ。使うのは `session.start`・`command.run`・`$.command.register`・`$.session.usage({ breakdown: 'summary' })` だけ（`register.ts`）。
- 型には次が実在するが、既存 mod は未使用: イベント `session.measure` / `turn.complete` / `session.compact` / `prompt.submit` / `tool.call`、`$` の `ui.status` / `ui.toast` / `session.messages` / `http.fetch`。
- `session.usage()` の戻り値は `context` に加えて `rateLimits`（`kind` / `percentUsed` / `resetsAt?`）と `cost?`（`usd`）を持つ。context-doctor は `context` しか見ていない。

以降の「仮説」は検証前の見立てで、因果の主張ではない。

## 案 1: rate-limit-watch（制限と費用の常時表示）

- **誰の・手間**: サブスク/従量で使う利用者が、使用量の上限に近いかを毎回別画面で確認する手間。仮説: 上限に気付かず作業が途中で止まる場面がある（頻度は未計測）。
- **どう減るか**: ステータス行に `5h 72%` のような 1 行を出し、閾値超過時にトーストで 1 回知らせる。
- **使う API（型で実在確認済み）**: イベント `session.measure`（入力 `rateLimits: SessionRateLimit[]` / `cost?: SessionCost` / `changed: UsageUnit[]`）、`$.ui.status(text | undefined)`、`$.ui.toast(text, options?)`。
- **必要権限**: 読取のみ（表示のみ）。書込・実行・通信なし。
- **受け入れ基準**: (1) `changed` に `rateLimits` が無い測定では再描画しない (2) `rateLimits` が空（サブスク外・初回前）のときは何も出さない (3) 純粋関数 `formatLimits(rateLimits, cost)` に架空データのテスト (4) 同一閾値のトーストは再通知しない (5) validate / test / tsc 通過 (6) 目視確認はだいすけに依頼。
- **重複確認**: context-doctor は `/ctx` で context のみ・手動実行。rateLimits / cost / 常時表示は重複しない。**目視未確認**（status 行・トースト）。

## 案 2: turn-bell（長いターンの完了通知）

- **誰の・手間**: 長い処理中に別作業へ移り、完了に気付かず待たせてしまう手間。仮説: 完了通知があれば確認の往復が減る（未検証）。
- **どう減るか**: ターンが閾値秒以上かかったときだけ、所要時間付きのトーストを出す。
- **使う API**: イベント `turn.complete`（`durationMs` / `isAborted` / `agentId?` / `usage?`）、`$.ui.toast`。
- **必要権限**: 読取のみ。音（`$.audio.play`）は型に実在するが今回は対象外にする（アセット同梱が要るため別案扱い）。
- **受け入れ基準**: (1) `durationMs` が閾値未満なら何も出さない (2) `isAborted` のとき出さない (3) サブエージェント（`agentId` あり）のターンでは出さない (4) 判定は純粋関数で架空値テスト (5) validate / test / tsc 通過。閾値は仮置きと明記。
- **重複確認**: 既存 mod に通知機能なし。**目視未確認**。
- 外部（スマホ等）への通知は通信を伴うため案 5 に分離。

## 案 3: session-recap（`/recap` ツール利用の振り返り）

- **誰の・手間**: 長いセッションで「どのツールを何回、何件失敗したか」を振り返る手段がない手間。
- **どう減るか**: `/recap` がツール別の呼び出し回数とエラー件数（観察）を一覧にする。原因の推測は出さない。
- **使う API**: `$.command.register` + `command.run`（context-doctor と同じ形）、`$.session.messages()`（`SessionMessage.toolUses[]`: `tool` / `input`、`toolResults[]`: `isError`）、`$.session.turns()`。
- **必要権限**: 読取のみ。`input` の内容（コマンド文字列・パス）は出力しない方針とし、`tool` 名の集計だけにする。
- **受け入れ基準**: (1) 架空の `SessionMessage[]` で集計の純粋関数をテスト (2) 件数は「観察」と明記し、失敗の原因を断定する文言を出さない (3) 返却は直近 4096 件までという型の制約を出力に注記 (4) validate / test / tsc 通過。
- **重複確認**: context-doctor は context の内訳で、ツール呼び出しは見ない。重複なし。出力は text のみ（`/ctx` と同じ形式）。表示は**目視未確認**。

## 案 4: repeat-call-notice（同じ呼び出しの反復に気付く）

- **誰の・手間**: モデルが同じツール呼び出しを繰り返していても、画面を追わないと気付けない手間。仮説: 反復は停滞の目印になりうる（共起であり原因ではない。実データ未確認）。
- **どう減るか**: 1 ターンの終わりに、同一 `tool` + 同一 `input` の呼び出しが N 回以上あれば、トーストで事実だけ知らせる（拒否はしない）。
- **使う API**: `turn.complete`、`$.session.messages()`（`toolUses[].tool` / `input`）、`$.ui.toast`。
- **必要権限**: 読取のみ。`tool.call` での `deny` は行動を変えるため使わない。
- **受け入れ基準**: (1) 反復判定は純粋関数で、架空データのテスト（N 回ちょうど・N-1 回・入力が違う場合） (2) 通知文に入力の中身を含めない (3) 閾値 N は仮置きと明記 (4) validate / test / tsc 通過。
- **重複確認**: 既存 mod になし。案 3 と同じ集計の下地を共有できる（DRY は実装時に判断）。**目視未確認**。

## 案 5: remote-bell（外部への完了通知）— 要相談

- **誰の・手間**: 席を離れているとき、完了をスマホ等で知りたい。
- **使う API**: `turn.complete` + `$.http.fetch(url, init?)`（型で実在確認）。
- **必要権限**: **通信（外部へ送信）**。送信先 URL は秘密値に当たりうる。
- **扱い**: ガードレール（通信は相談キュー経由）に従い**着手設計しない**。`open-questions.md` の Q-007 に送った。
- **重複確認**: 案 2 のトーストと目的は近いが、外部送信が本質的な違い。

## 相談キューに送ったもの

- 案 5 → Q-007（通信）。案 1〜4 は読取のみで相談不要。
- 案 2 の音通知（`$.audio.play`）も、アセット同梱の要否が未確定のため Q-007 の追記側で一緒に扱う。

## 次に誰が何をするか（提案）

- リード: 案 1 / 3 を優先候補に（根拠: 型で必要な API が全て確認済みで、既存の `register.ts` / 純粋関数の分け方をそのまま使える。優先度は私見）。
- 実装前に、各案の閾値を実測で決めるか仮置きで進めるかは Q-002 の回答（仮置き）に倣う。
