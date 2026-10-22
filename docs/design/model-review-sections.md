# model-review: ペインとテキストを 1 つの節モデルから描く（設計の見直し 段階 2 の計画）

出所: 2026-10-22 の model-review 専門家レビュー（設計・保守性）。段階 1（0.33.0）で依存の向き・重複・不要な再描画・メモリ上限を直した後に残る、構造の変更の計画。**着手前に、画面の目視確認ができる状態（`claude --plugin-dir`）で進める。**

## 問題

- ペイン（`pane-model.ts`）とテキスト（`report.ts`）が、同じ節を別々に組み立てている。節を 1 つ足すたびに 2 か所を直す必要があり、文言・数え方の食い違いが繰り返し出た（0.32.5 で直した実コスト不明の文言 3 通り、負の差の表記など）。
- 描画のたびに、最大 500 ターン分の集計を節ごとに計算し直している（`estimateFacts` が 1 回の描画で 4 回、`findSwitches` が 3 回、`estimateSwitchOptions` が 2 回）。
- 判定（`analyze.ts`）が `Concern.examples` を日本語の文字列で返すため、判定のテストが文言に縛られている。

## 方針

```
ReviewState ──(1 回だけ)──► analyzeReview(review, nowMs, muted) : ReviewAnalysis   ← review の同一性でメモ化
                                   │
                                   ▼
                         buildSections(analysis, ctx) : Section[]                 ← 構造データ（文言を持たない）
                              │                    │
                              ▼                    ▼
                   renderPane(sections)     renderText(sections)                  ← 文言と並べ方だけ
```

- `ReviewAnalysis`: 指摘（直近 / 過去）・結論・推定・実コストの差・切替・ループ別・what-if・内訳・推移・注記を 1 回で計算した値。描画のたびに作り直すのは実行中の行（drafts）だけ。
- `Section`: `{ kind: 'conclusion' | 'money' | 'concerns' | 'loops' | 'groups' | 'topTurns' | 'whatIf' | 'cost' | 'notes', ... }` の判別共用体。金額・件数・ターン参照などは数値のまま持つ。
- ペイン固有の省略（0.32.0 の F1 / F4 / F7 / F8）は `renderPane` 側のフラグにする。
- `Concern.examples` は構造データ（`{ kind: 'overspecGroup', model, effort, turns, sonnetUsd }` など）にし、文面は文言の層の `describeExample()` で作る。

## 進め方（PR を分ける）

1. `analyzeReview` を足し、`pane-model.ts` / `report.ts` が中で 1 回だけ呼ぶようにする（出力は変えない。既存テストは無編集で通る）。描画時間のテスト（500 ターンで目標時間内）を足す。
2. 節を 1 つずつ `Section` に移す（コストの節 → 結論・金額 → 指摘 → 残り）。移した節は、ペインとテキストが同じ値を出すことを 1 つのテストで固定する。
3. `Concern.examples` を構造データにする。判定のテストは構造で、文言は描画ごとに少数の全文テストで固定する。

各 PR で、出力の変化がないこと（または意図した変化だけであること）を既存の全文テストで確かめ、画面の目視確認を依頼する。

## 段階 1（0.33.0）でやったこと

- 記録・分析・文言のどの層からも使う部品を `domain.ts`（葉）に移し、逆向きの依存をなくした（`UNKNOWN_MODEL` を分析・文言が `recorder` から、`ZERO_PARTS` / `addParts` を状態が表示用の `breakdown` から、`countText` を `mute` が `summary` から、`RECENT_CONCERN_MAIN_TURNS` を `labels` が `analyze` から取っていた）。重複していたトークンの加算・`addCost`・`shortModel`・符号付き金額を 1 つにした。
- 累計コストが変わらない測定では状態を書き換えない（再描画を起こさない）。
- 未完了の下書き（`turn.complete` が来なかったもの）と、サブエージェントの種類の対応表に上限を設けた。
- 末尾の免責を句の並びから組み立てる（文字列の置換で句を外していたため、文言を変えると黙って外れなくなっていた）。

## まだ残すもの

- 状態の `schemaVersion` と読み込み時の正規化（古い記録の任意項目の扱いを 1 か所に集める）。
- 層の決まり（上位の層を import しない）をテストで固定する。テストの実行環境でソースを読めるかの確認が要る。
