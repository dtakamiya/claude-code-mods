# claude-code-mods

Claude Code の **Mods**（関数フック型プラグイン）を作って配布するリポジトリ。1リポジトリ = 1マーケットプレイス、`mods/<name>/` が1 mod。

## 収録 mod

| mod | 内容 | コマンド |
|---|---|---|
| `context-doctor` | コンテキストの内訳を分析し、課題点と改善点を出す（読み取り専用） | `/ctx` |
| `session-recap` | ツール別の呼び出し回数とエラー報告件数を一覧にする（読み取り専用・tool 名の集計のみ、input は出力しない） | `/recap` |
| `repeat-call-notice` | 1 ターンで同じツールを同じ入力で N 回以上呼んだら、ターン終了時にトーストで知らせる（読み取り専用・tool 名と回数のみ、input は出力しない。N=3 は仮置き） | トースト |
| `model-review` | 現在のセッションのモデル・effort・トークン・推定コストを表示し、モデル選択の妥当性を参考として示す。公式 `/usage` にないモデル×effort 別コスト、Haiku 換算の差額、モデル/effort 切替のキャッシュ再構築コスト、キャッシュヒット率、実行中ターンのリアルタイム表示を持つ（読み取り専用・ヒューリスティック。Mod 読み込み後のターンだけが対象） | `/model-review` |

## 公開範囲（private リポジトリ）

このリポジトリは現在 **private** です。リポジトリへのアクセス権（GitHub 上で閲覧できる権限）がある人だけが取得できます。公開するかどうかは未判断で、判断の経緯は [`docs/design/open-questions.md`](docs/design/open-questions.md) の Q-001 を参照してください。

## インストール

以下の手順は、リポジトリへのアクセス権があり、GitHub 認証済みの利用者向けです。

```
/plugin install context-doctor --marketplace dtakamiya/claude-code-mods
```

`y` でマーケットプレイスを追加 → スコープを選択。terminal セッションのプロンプトで実行する。

## 動作確認済みバージョン

Claude Code 2.1.302（2026-10-17 確認。model-review・context-doctor・repeat-call-notice・session-recap の全 4 mod で `validate` / `test` / tsc 通過。UI の目視確認は未実施）。型検査の手順は `CLAUDE.md`。Mods API は early access のため、バージョンが変わったら再検証する。

## 安全性

Mods は**サンプルボックスなしで利用者の権限のまま動く**。このリポジトリの mod は既定で読み取り専用。`$.process.run`・`$.fs` 書込・外部ネットワークを使う mod は、使う理由を各 mod の README に書く。

## 開発

```
claude plugin validate mods/<name>
claude plugin test mods/<name>
claude --plugin-dir mods/<name>     # 目視確認
```

詳細は `CLAUDE.md`。
