# model-review

セッションで使ったモデル・effort・トークン・推定コストを集計し、モデル選択の妥当性（過剰・不足・委譲・サブエージェント・切替）を観察として表示する mod。**読み取り専用**で、書込・コマンド実行・モデル以外の通信は行わない。

## 使い方

```
/plugin install model-review --marketplace dtakamiya/claude-code-mods
/model-review
```

- `/model-review` でペイン「モデル振り返り」を開く。ペインを置けない画面では同じ内容をテキストで返す（先頭は結論の 1 行）。
- `/model-review copy` でテキストレポートをクリップボードにコピーする（入力・プロンプトは含まない）。
- `/model-review text` でペインを置ける画面でもペインを開かず、テキストレポートをそのまま返す（トランスクリプトに残したいとき）。
- `/model-review help` で使える引数の一覧を返す。引数は前後の空白・大文字小文字を無視し、知らない引数（打ち間違いを含む）ではペインを開かずに help を案内する。
- 記録されるのは、この mod の読み込み後に完了したターンだけ。過去のセッションは遡れない。
- 指摘は「参考の観察」で、モデル選択の誤りを断定しない。

## 表示する内容

- モデル × effort ごとのターン数、トークン、キャッシュのヒット率、推定コスト。
- 指摘: 過剰（軽作業に重いモデル/effort）、不足（重い作業・エラー連続に軽いモデル/low）、委譲（メインが多くのツールを使うのにサブエージェント未使用）、サブエージェントの比重、切替。
- 指摘ごとの「次の一手」の候補（0.18.0）: 例「候補: 軽作業が続くあいだは /model sonnet で Sonnet へ（軽作業の平均で 1 ターンあたり約 -$0.0200、再構築 +$0.2400・約 12 ターンで回収の目安。10 ターンを超えるので切替の元は取りにくい。戻すときにも再構築）」。候補は目安で、切替を勧める断定ではない。
- 切替の注記（直近のモデル・effort の切替と、キャッシュへの影響の見積り）。
- 高コストのターン上位、Haiku・Sonnet 換算の差額、単価不明のモデル名。

しきい値の一覧と根拠の強さは `docs/design/threshold-rationale.md`。いずれも実測の裏付けがない仮置き。

## status 行とトースト（0.16.0）

コストか使用率が動いたときだけ、status 行に「実コスト $1.23 · 5h 72%」の形で 1 行出す（`/model-review` を開かなくても見える）。使用率が取れない環境（サブスク外・初回前）ではコストだけを出す。設定（`/config` または `pluginConfigs`）:

- `showStatus`（既定: オン）— status 行の表示。
- `costLimitUsd`（既定: 0 = 無効）— 実コストがこの額に達したらトーストで 1 度知らせる。
- `rateLimitPercent`（既定: 0 = 無効）— 5h / 7d などの使用率がこの値に達したらトーストで 1 度知らせる。枠がリセットされて下回った後に再び達したときは、もう一度知らせる。

上限は利用者が決める値で、Mod は仮置きの推奨値を持たない。設定の変更は reload（`/reload-plugins`）後に反映される。reload するとトーストの通知済みの記録が消えるため、超過中なら reload 後にもう一度出る。status 行・トーストは目視未確認。

## 推定の限界

- コストは `TurnUsage` のトークン数に単価表を掛けた**推定**。請求額ではない。
- **advisor の費用と fast mode の割増は含まれない**（`TurnUsage` に載らないため。Q-009）。推定は過小になりうる。ペインの advisor 表示は回数のみ。
- キャッシュ書込は TTL の内訳がなく、5 分単価を基本に 1 時間単価を上限とする幅で示す。
- 単価表にないモデルは「単価不明」として名前を画面に出し、合計から除く。単価表の取得日から 60 日を過ぎると改定の確認を促す注記が出る。
- 長いセッションでは、直近 500 ターンより前（古い分）を集計値に畳み込む。件数・コスト・モデル別は全体を含み、指摘・切替・ループ別・高コスト順は直近 500 ターンが対象。
- 実コスト（`$.session.usage` の累計）が取れない環境では推定のみを表示する。

## 単価表の更新手順

1. 公式の価格表（https://platform.claude.com/docs/en/about-claude/pricing）を取得する。
2. `hooks/pricing.ts` の `RATE_TABLE` と `PRICE_TABLE_FETCHED_AT` を更新する。
3. 新世代が出たら `HAIKU_REFERENCE_MODEL` / `SONNET_REFERENCE_MODEL` / `OPUS_REFERENCE_MODEL` を差し替える（`pricing.test.ts` が、参照モデルと `CACHE_SAFE_EFFORT_MODELS` が表に引けることを確認する）。
4. `.claude-plugin/plugin.json` の version を上げ、`CHANGELOG.md` に書く。

`pricing.test.ts` の「単価表の取得日が古くなりすぎていない」は、取得から 120 日で意図して落ちる。落ちたら上の手順で更新する。

## 開発

`claude plugin validate mods/model-review` / `claude plugin test mods/model-review` / `scripts/typecheck.sh model-review <claude-code.d.ts>`。手順は `CLAUDE.md`。ペインの見た目は目視未確認。
