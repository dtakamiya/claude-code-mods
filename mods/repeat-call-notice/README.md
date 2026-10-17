# repeat-call-notice

1 ターンで同じツールを同じ入力で N 回以上呼んでいたら、ターン終了時にトーストで知らせる mod。**読み取り専用**で、呼び出しの拒否・書き換えはしない。

```
/plugin install repeat-call-notice --marketplace dtakamiya/claude-code-mods
```

- コマンドはなく、ターン完了（`turn.complete`）のたびに自動で判定する。
- 通知例: `同じ呼び出しの反復: Read ×5、Read ×4、Bash ×3、ほか 2 組`。ツール名と回数だけで、入力の内容は載せない。
- 同一とみなすのは、tool 名が同じで入力がキー順を除いて同じ呼び出し。結果は読まない。
- 閾値 N は 3。**根拠のない仮置き**（Q-008）で、反復が停滞の原因だとは言わない。
- サブエージェントのターンでは何もしない。判定に失敗したときは固定文言を debug ログに残すだけ。
- トーストは目視未確認。

設計は `docs/design/repeat-call-notice.md`。開発: `claude plugin validate` / `claude plugin test`。手順は `CLAUDE.md`。
