# session-recap

セッションで呼んだツールごとの回数とエラー件数を一覧にする mod です。読み取り専用で、`$.session.messages()` が返すメッセージを読むだけです。ファイルへの書き込み、コマンドの実行、外部への通信はしません。

## インストールと使い方

```
/plugin install session-recap --marketplace dtakamiya/claude-code-mods
/tool-recap
```

`/tool-recap` を入力すると、ツール名・呼び出し回数・エラー件数をテキストで返します。組み込みの `/recap` は Claude Code が使うため、この mod は `/tool-recap` という名前にしています。旧名の `/recap` は登録しません。

## 出力例

以下は架空のデータで作った出力例です。

```
ツール利用の振り返り（観察のみ。原因の推測はしません）
合計: 5 回 / エラー報告 1 件
  Read: 3 回（エラー報告 0 件）
  Bash: 2 回（エラー報告 1 件）
注記: 集計対象は直近 3 件のメッセージ（返却は最大 4096 件まで。それより古い分は含みません）。
注記: 「エラー報告」はツールが isError を返した件数で、失敗の原因や重大さは示しません。
```

## 権限（読み取りのみ）

- `$.session.messages()` で直近の一部のメッセージを読むだけです。
- ツールの入力（input）と結果本文は表示しません。tool 名と件数だけを集計します。
- 集計できるのは `$.session.messages()` が返す範囲（最新の一部）です。上限を超えた古い分は数えません。
- 集計に失敗したときは固定の失敗文言を返します。例外の中身は出しません。

## 開発

`claude plugin validate mods/session-recap` と `claude plugin test mods/session-recap` を実行します。手順はリポジトリの `CLAUDE.md` にあります。
