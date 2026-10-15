# context-doctor しきい値の根拠（mod-006）

- 作成: mods-analyst
- 対象: `mods/context-doctor/hooks/analyze.ts` の `THRESHOLDS`（L23-34）全 6 値
- 出所: 同ファイルの実コード（HEAD `dfe6d3d`）、`docs/design/context-doctor-review.md`（以下「レビュー」）、`docs/design/open-questions.md`（Q-002 回答・実測メモ、Q-003 追記）、型ファイル（`mods/context-doctor/.claude-plugin/types/claude-code/index.d.ts`、存在を確認して grep）
- 結論: **全値とも実測による裏付けなし（仮置き）**。値の妥当性は判定しない。本書は「何に使われているか」と「何を確かめれば根拠になるか」の整理

## 先に: レビュー（v1）と現コード（v2）の違い

レビューは v1 のコードを対象にしており、しきい値の記述の一部は現コードと合わない。混同しないこと。

| 項目 | レビュー時点（v1） | 現コード（v2） |
|---|---|---|
| 80% | `percentage >= 80` で常に high 判定（`HIGH_PERCENT`）。自動圧縮の有無を見ない | **自動圧縮が無効のときだけ**使う `fallbackPercent`（L75）。有効時は使われない |
| 自動圧縮が有効なとき | 同上（80% 固定） | `autoCompactThreshold - totalTokens` の差で判定（L56-73）。差が 0 以下なら超過、窓の 5% 以下なら「近い」 |
| MCP | 窓比 10% のみ。未ロードも合算（C-1） | 読込済みのみ合算し、窓比 10% **または** 絶対量 2 万（L86-91）。未ロードは info 行で別掲 |
| メモリ | 窓比 5% のみ | 窓比 5% **または** 絶対量 2 万（L112） |
| 定数名 | `HIGH_PERCENT` `MCP_SHARE` `MEMORY_SHARE` | `THRESHOLDS` オブジェクトに集約 |

レビューの「C-3 絶対量に下限が無い」「C-2 固定 80% が圧縮点とずれる」は v2 で実装上は対処済み。ただし、対処後の値自体（2 万、5%）も実測に基づかない。

## しきい値一覧

凡例: 観察 = コード・型・文書から直接言える確定事実 / 仮説 = 未検証の推測。根拠の強さは「実測なし = 仮置き」の 1 段階のみ（実測のある値は現時点で無い）。

| 値 | 現在の使われ方（コード行） | 観察（確定事実） | 仮説（未検証） | 検証方法 | 根拠の強さ |
|---|---|---|---|---|---|
| `fallbackPercent` = 80（%） | L75: `!s.isAutoCompactEnabled && s.percentage >= 80` で high（要対応）。自動圧縮が**無効**のときの目安にしか効かない | 有効時は `autoCompactThreshold` 差分で判定され、この値は参照されない（L56-73）。`percentage` は `totalTokens / rawMaxTokens` の整数％（型 `SessionContextBreakdown.percentage`）。テストに「基準が遠ければ 80% 超でも所見なし」の F ケースあり（`analyze.test.ts` L51）。80 の由来はコード・コメントに無い | 圧縮が無い場合、80% なら窓を使い切る前に手動対応する余裕があるはず。90% など別の値のほうが誤警告が少ない可能性もある | 自動圧縮を無効にした実セッションで、応答の遅延や失敗が出始める使用率を数回記録（書込・実行を要するため要相談） | 実測なし = 仮置き |
| `nearCompactShare` = 0.05（窓の 5%） | L66: `remaining <= maxTokens * 0.05` なら high（「基準まで残りわずか」）。`remaining = autoCompactThreshold - totalTokens` | 窓 20 万なら 1 万、100 万なら 5 万トークンが閾値になる（算術）。`totalTokens` にバッファが含まれるかは、組み込み `/context` では「含まない」と読めたが、フック側 `/ctx` の `totalTokens` が同じ定義かは未確認（Q-002 実測メモ、U-1）。L54-55 のコメントも「実余裕とは断定しない」としている | 5% は 1 回の長い出力（大きなファイル読込など）を吸収できる程度か。窓が大きいほど絶対量が過大になる可能性がある | `/ctx` を複数のセッションで実行し、`autoCompactThreshold - totalTokens` と実際に圧縮が走ったタイミングを対応させる。まずフック経由で `totalTokens` の定義（U-1）を確定 | 実測なし = 仮置き |
| `mcpShare` = 0.1（窓の 10%） | L91: 読込済み MCP ツール定義の合計 / `maxTokens` >= 0.1 で mid（注意）。絶対量との OR | 合計は `isLoaded` が true のものだけ（L87）。`maxTokens` は `rawMaxTokens` と同じで、モデル上限より小さい圧縮用窓のこともある（型）。空セッション 1 回の組み込み `/context` では MCP 約 1.3k（Q-002 実測メモ。1 回・1 環境のみ） | 10% を超える MCP 定義は、使っていないサーバーを含むことが多い。現実の分布は不明（U-2） | 複数の利用者・環境で読込済み MCP 合計の分布を匿名化して集計し、上位サーバーが実際に使われているかも併せて見る | 実測なし = 仮置き |
| `mcpAbsolute` = 20,000（トークン） | L91: 読込済み MCP 合計 >= 20000 で mid。窓比との OR（どちらかを満たせば指摘） | 100 万窓では 2%、20 万窓では 10% に相当（算術）。レビュー C-3 は「窓比のみだと大窓で鈍感」としてこの下限を提案したが、2 万という値は提案時に例示されたもので実測由来ではない | 窓の大きさに関わらず、2 万トークンの常時占有は無視できない量か。小窓ではこの絶対量より窓比が先に効くため、実質は大窓向けの下限として働く | `mcpShare` と同じ分布集計。大窓と小窓の利用者で OR のどちらが先に効いたかを記録 | 実測なし = 仮置き |
| `memoryShare` = 0.05（窓の 5%） | L112: メモリファイル合計 / `maxTokens` >= 0.05 で mid。絶対量との OR | 窓 20 万で 1 万トークン（算術）。空セッション 1 回で組み込み `/context` のメモリは約 6.8k（Q-002 実測メモ。1 環境のみ。この値は単独では 20 万窓の 5% = 1 万 を下回るが、大窓ではさらに小さい比率になる） | CLAUDE.md とルールが複数あると 5% を超えやすい。それが「困りごと」に当たるかは未検証 | メモリ構成の分布を type（User/Project/AutoMem）別に集計し、超過したケースで削減余地があったかを確認 | 実測なし = 仮置き |
| `memoryAbsolute` = 20,000（トークン） | L112: メモリ合計 >= 20000 で mid。窓比との OR | 同上。`mcpAbsolute` と同じ値だが、同値にする理由はコード・文書に無い（別々に決めた根拠が無い） | 常時読み込みの 2 万は、窓比と独立の目安になる。MCP と同値でよいかも未確認 | `memoryShare` と同じ分布集計 | 実測なし = 仮置き |

## 要点

1. 80% は v2 では「自動圧縮が無効なときだけ」の目安。レビューの「80% 固定は圧縮点とずれる」指摘は、有効時については v2 で判定式ごと置き換わっている（無効時は依然として固定値）。
2. 「窓比 OR 絶対量」の絶対量 2 万 × 2 は、レビュー C-3 の例示値を踏襲したもので、実測に基づかない。窓比と絶対量のどちらが先に効くかは窓サイズで変わる。
3. Q-002 は B（実測せず仮置きのまま）で回答済み。実測は空セッション 1 回のみで、分布（U-2）とフック側 `totalTokens` の定義（U-1）は未確定。しきい値の妥当性は現時点で言えない。

## 型ファイルで確認した API 名

型ファイルは存在した（`mods/context-doctor/.claude-plugin/types/claude-code/index.d.ts`。git 管理外）。本書で言及する名前を grep で実在確認した。

- `SessionContextBreakdown`（L10866）: `totalTokens` `maxTokens` `rawMaxTokens` `percentage` `autoCompactThreshold?`（「自動圧縮が走るトークン数。無効なら欠落」）`isAutoCompactEnabled` `mcpTools` `memoryFiles`
- `ContextMcpTool.isLoaded`（L2211）

## 相談キューに追記した項目（open-questions.md に Q-004〜006 として追記済み）

- Q-004: フック経由 `/ctx` の `totalTokens` が組み込み `/context` と同じ定義かの実測（U-1 の残り）。実行を伴うため要相談。
- Q-005: 自動圧縮を無効にして `fallbackPercent` の妥当性を確かめる実験。設定変更を伴うため要相談。
- Q-006: `.gitignore` の素の `plugin.json` / `types` の意図確認（prepublish-scan.md 参照）と、コミット履歴の個人メールの扱い（公開判断が出たときに決める）。

## 追記（mod-008・ペイン v2）: 段階表示の仮置き値

`mods/context-doctor/hooks/pane-bar.ts` に、バーの「注意」段階の境界を 3 つ足した。いずれも実測の裏付けなし（仮置き）。「危険」「超過」は既存の `nearCompactShare` / `fallbackPercent` をそのまま使い、所見（high）と食い違わない。

| 値 | 使われ方 | 観察 | 仮説・検証 | 根拠の強さ |
|---|---|---|---|---|
| `WARN_COMPACT_SHARE` = 0.15（窓の 15%） | 自動圧縮が有効なとき、圧縮点までの残りがこの割合以下で「注意」 | 窓 20 万なら残り 3 万以下。由来はコード・文書に無い（設計書 §4.2 の提案値） | 3 万は 1 回の大きな読込を吸収できる目安か。`nearCompactShare` と同じ検証（圧縮が走った時点との対応）で見直す | 実測なし = 仮置き |
| `WARN_FALLBACK_PERCENT` = 60（%） | 自動圧縮が無効なとき、使用率がこの値以上で「注意」 | `fallbackPercent`（80）より手前に段階を足しただけ | `fallbackPercent` と同じ検証 | 実測なし = 仮置き |
| `WIDE_BODY_COLUMNS` = 68（桁）／ミニバー倍率 16・上限 8・名前幅 18 | 幅 68 桁以上で所見を 1 行に連結。内訳の見た目の寸法 | 目視していない。設計書 §7 の「好み・仮説」 | だいすけの目視（T6）で調整 | 実測なし = 仮置き |

## model-review（0.4.0）の仮置き値

いずれも実測の裏付けなし（仮置き）。`mods/model-review/hooks/` の名前付き定数。

| 値 | 場所 | 使われ方 | 根拠の強さ |
|---|---|---|---|
| `MIN_OVERSPEC_SAVINGS_USD` = 0.01 | analyze.ts | Haiku 換算の差額がこれ未満の軽作業は、モデル起因の過剰にしない（effort 起因は差額で絞らない） | 実測なし = 仮置き |
| `UNDERSPEC_ERROR_STREAK` = 2 | analyze.ts | Sonnet / low のメインループでエラー・中断が連続 2 回目から不足 | 実測なし = 仮置き |
| `CACHE_REBUILD_STREAK` = 3 | cache.ts | 書込 > 読込のターンが 3 回連続で注記 | 実測なし = 仮置き |
| `CACHE_TTL_DIFF_RATIO` = 0.2 / `CACHE_TTL_MIN_WRITE_TOKENS` = 50,000 | cache.ts | 実コストが推定を 20% 超上回り、書込 5 万 tokens 以上で TTL 単価差を注記 | 実測なし = 仮置き |
| `UNPRICED_STALE_RATIO` = 0.3 | notes.ts | 単価不明が 3 割以上で単価表の陳腐化を注記 | 実測なし = 仮置き |
| `CACHE_SAFE_EFFORT_MODELS` | switches.ts | effort 変更でキャッシュが維持されるモデル。出所は公式 prompt caching ドキュメント（取得 2026-10-15） | 公式記載 |

未確認: advisor の費用が usage に載るか、fast mode の割増が取れるか（型ファイルに該当フィールドなし）。
