# claude-code-mods — 開発規約

## 構成
- `.claude-plugin/marketplace.json` — 全 mod の一覧（`source: ./mods/<name>`）
- `mods/<name>/.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts(x)`, `hooks/*.test.ts`
- 判定ロジックは `$` に触れない純粋関数（`analyze.ts` など）に分け、`register.ts` は薄く保つ
- `docs/design/` 設計・アイデア、`docs/adr/` 重い判断の記録

## API の調べ方（重要）
- 型ファイルのパスは**セッション固有**。ハードコードしない。自分のセッションで `plugin-authoring` スキルを読み込むと型が書き出される
- 使う API 名は必ず型ファイルで grep して実在とシグネチャを確認してから書く（推測で書かない）

## 完了の条件（無人セッションでも満たせるもの）
1. `claude plugin validate mods/<name>` が通る
2. `claude plugin test mods/<name>` が通る（新機能にはテストを付ける）
3. 型検査（tsc。tsconfig は mod フォルダの外に置く）
4. UI を持つ mod は `claude --plugin-dir` での目視確認が必要。無人セッションではできないので、報告に「目視未確認」と明記し、だいすけに確認を依頼する

## ガードレール
- 既定は読み取り専用。`$.process.run`・`$.fs` 書込・モデル以外のネットワークは、相談キュー（`docs/design/open-questions.md`）で判断してから
- 実データ・個人情報・秘密値を repo に入れない。サンプルは架空データ
- `~/.claude/dev-mods/` には書かない（ホットリロード確認が走る）。開発は repo 内で
- `.claude-plugin/types/` はコミットしない（エンジンが毎回生成）
- Claude Code のバージョンが変わったら validate/test を再実行し、README の「動作確認済みバージョン」を更新
- feat/ ブランチ → push → PR まで行う。main 直 push 禁止
