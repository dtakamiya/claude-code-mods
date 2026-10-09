# 公開前スキャン記録（mod-006）

- 作成: mods-analyst / 対象: ブランチ `feat/mod-006-prepublish`（基点 `dfe6d3d`）
- 範囲: `git ls-files` の全 12 ファイル（作業ツリー）と、全ブランチの `git log -p --all`（10 コミット）
- 方法: grep -E による正規表現照合のみ（opensource-sanitizer 相当の手動実施。専用ツールは未実行）
- 現状のリポジトリは **private**。公開するかどうかは未判断（`open-questions.md` Q-001）。本書は公開の提案ではなく、混入有無の事実記録

## 結論

**PASS-WITH-WARNINGS**。秘密値の検出は 0 件。要対応（修正が必須）は 0 件。確認を依頼したい項目が 2 件（下表の「許容（要確認）」）。

## パターン別結果

件数は「一致した行数」。tree = 作業ツリー（git 管理下の全ファイル連結）、history = `git log -p --all` 全体。

| # | 観点 | パターン（要旨） | tree | history | 判定 |
|---|---|---|---|---|---|
| 1 | AWS アクセスキー | `AKIA[0-9A-Z]{16}` | 0 | 0 | 問題なし |
| 2 | GitHub トークン | `(ghp\|gho\|ghu\|ghs\|ghr\|github_pat)_…{20,}` | 0 | 0 | 問題なし |
| 3 | API キー（sk- 形式） | `sk-[A-Za-z0-9_-]{20,}` | 0 | 0 | 問題なし |
| 4 | Slack トークン | `xox[abprs]-…` | 0 | 0 | 問題なし |
| 5 | 秘密鍵 | `BEGIN [A-Z ]*PRIVATE KEY` | 0 | 0 | 問題なし |
| 6 | Google API キー | `AIza…{35}` | 0 | 0 | 問題なし |
| 7 | 汎用の秘密値代入 | `(api_key\|secret\|token\|password)\s*[:=]\s*値{16,}` | 0 | 0 | 問題なし |
| 8 | Bearer トークン | `Bearer [A-Za-z0-9._-]{20,}` | 0 | 0 | 問題なし |
| 9 | Slack ID 形式 | `\b[CUW][0-9A-Z]{9,}\b` | 0 | 0 | 問題なし |
| 10 | IPv4 | `(\d{1,3}\.){3}\d{1,3}` | 0 | 0 | 問題なし |
| 11 | .env / 鍵ファイル | `git ls-files` と全履歴のファイル名に `.env*` `*.pem` `*.key` | 0 | 0 | 問題なし。履歴に削除済みファイルも無し |
| 12 | 絶対パス（macOS/Windows） | `/Users/<name>` `C:\Users\` | 0 | 0 | 問題なし |
| 13 | 絶対パス（Linux 形式） | `/home/<name>` | 4 | 8 | 許容。`analyze.test.ts` の架空フィクスチャ `/home/u/...`（`u` は実在ユーザーでない）。履歴 8 は同じ行の追加差分の重複 |
| 14 | `~/.claude` 参照 | `~/\.claude\|\.ryoko` | 1 | 1 | 許容。`CLAUDE.md` の運用規約（書込禁止の注意書き）。個人データではない |
| 15 | メールアドレス | `[\w.+-]+@[\w.-]+\.[a-z]{2,}` | 0 | 20 | 下記「許容（要確認）」A と B |
| 16 | 所有者の GitHub 名 | `dtakamiya` | 3 | 13 | 下記「許容（要確認）」C |

## 許容（要確認）

| ID | 内容 | 場所 | 事実 | 判定 |
|---|---|---|---|---|
| A | コミットの author/committer メールが個人の gmail アドレス | git 履歴のメタデータ（全 10 コミットの Author/Commit 行）。作業ツリーのファイルには無い | tree 0 件・history 20 件の内訳は、Author 行・Commit 行・`Co-Authored-By: ...<noreply@anthropic.com>` のみ（コミット本文・差分内には個人メールは見つからなかった） | 許容（要確認）。公開すると履歴のメールが見える。GitHub の noreply アドレスへ書き換えるには履歴の書き換えが要るため、実施の要否は所有者の判断。ここでは変更していない |
| B | 履歴メールのうち `noreply@anthropic.com` | Co-Authored-By 行 | 公開アドレス（共著表記） | 許容 |
| C | 所有者の GitHub ユーザー名 `dtakamiya` | `README.md`（インストール手順）、`.claude-plugin/marketplace.json`（`owner.name`）、`plugin.json`（`author.name`） | 意図的な公開情報（マーケットプレイスのインストール先指定に必要） | 許容（要確認）。依頼文の方針どおり意図的なものとして記録 |
| D | 実測値の記載 | `docs/design/open-questions.md` Q-002 実測メモ | 空セッション 1 回の `/context` 集計値（カテゴリ別トークン数）が書かれている。実パス・個人情報・秘密値は含まれない | 許容（要確認）。`CLAUDE.md` は「実データを repo に入れない」とする。集計値のみで個人を特定できないが、「実データ」に当たるかは所有者の解釈次第 |

## ファイル・設定の確認

| 確認項目 | 結果 |
|---|---|
| `.claude-plugin/types/` がコミットされていないか | 0 件（`git ls-files \| grep types/` が空）。全履歴のファイル名にも無い |
| `.gitignore` | `.claude-plugin/types/`、`mods/*/.claude-plugin/types/`、`node_modules/`、`data/`、`.env*`、`.DS_Store`、`plugin.json`、`types` を含む |
| 型ファイルの実体 | `mods/context-doctor/.claude-plugin/types/` はローカルに存在するが `git check-ignore` で除外されていることを確認 |

## 注意点（観察）

- `.gitignore` に素の `plugin.json` と `types` がある。現在の `mods/context-doctor/.claude-plugin/plugin.json` は **追跡済み** なので除外は効いていない（追跡済みファイルは ignore の対象外）。新規 mod を追加するとき、`plugin.json` が `git add` で無視される可能性がある。観察のみで原因は未調査。意図を確認してほしい（要相談。修正は未実施）。
- スキャンは正規表現による機械照合のため、難読化された値や未知の形式は検出できない。件数 0 は「検出なし」であり「混入なしの証明」ではない。
- リモートに存在するブランチ（`origin/*`）は `--all` に含まれるが、リモート側にあってローカルに取得していない参照は対象外。
