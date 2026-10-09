# claude-code-mods

Claude Code の **Mods**（関数フック型プラグイン）を作って配布するリポジトリ。1リポジトリ = 1マーケットプレイス、`mods/<name>/` が1 mod。

## 収録 mod

| mod | 内容 | コマンド |
|---|---|---|
| `context-doctor` | コンテキストの内訳を分析し、課題点と改善点を出す（読み取り専用） | `/ctx` |

## インストール

```
/plugin install context-doctor --marketplace dtakamiya/claude-code-mods
```

`y` でマーケットプレイスを追加 → スコープを選択。terminal セッションのプロンプトで実行する。

## 動作確認済みバージョン

Claude Code 2.1.295（`validate` / `test` 通過。UI の目視確認は未実施）。Mods API は early access のため、バージョンが変わったら再検証する。

## 安全性

Mods は**サンプルボックスなしで利用者の権限のまま動く**。このリポジトリの mod は既定で読み取り専用。`$.process.run`・`$.fs` 書込・外部ネットワークを使う mod は、使う理由を各 mod の README に書く。

## 開発

```
claude plugin validate mods/<name>
claude plugin test mods/<name>
claude --plugin-dir mods/<name>     # 目視確認
```

詳細は `CLAUDE.md`。
