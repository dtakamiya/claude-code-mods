# session-recap

セッションで呼んだツールごとの回数とエラー件数を一覧にする mod。**読み取り専用**（`$.session.messages()` を読むだけで、書込・実行・通信はしない）。

```
/plugin install session-recap --marketplace dtakamiya/claude-code-mods
/recap
```

- `/recap` が、ツール名・呼び出し回数・エラー件数をテキストで返す。
- 集計するのは `$.session.messages()` が返す範囲（最新の一部）。上限を超えた古い分は数えない。
- ツールの入力・結果の内容は表示しない。

開発: `claude plugin validate mods/session-recap` / `claude plugin test mods/session-recap`。手順は `CLAUDE.md`。
