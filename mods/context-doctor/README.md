# context-doctor

コンテキストの内訳（システム・ツール・MCP・メモリ・メッセージ）を分析し、課題と改善案を示す mod。**読み取り専用**（`breakdown: 'summary'` の推定値のみ。通信しない）。

```
/plugin install context-doctor --marketplace dtakamiya/claude-code-mods
/ctx          # テキストで所見を返す
/ctx pane     # ペインを開く（ペインを置けない画面ではテキスト）
```

- 圧縮点までの残り、MCP・メモリの占有を所見にする。ペインは `session.measure` で自動更新する。
- 数値は**推定値**。しきい値（80% / 窓比 5%・10% / 絶対量 2 万 など）は全て実測の裏付けがない仮置きで、`docs/design/threshold-rationale.md` に根拠の強さを書いている。
- 実測が未確定の点: フック経由の `totalTokens` が組み込み `/context` と同じ定義か（Q-004）。
- 「正確に数え直す」（`full`・通信を伴う）は実装していない（Q-003）。
- ペインの見た目は目視未確認。

設計は `docs/design/context-doctor-pane*.md`。開発: `claude plugin validate` / `claude plugin test`。手順は `CLAUDE.md`。
