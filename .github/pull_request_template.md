## 概要

## 確認（該当するものにチェック）
- [ ] `claude plugin validate mods/<name>` が通る
- [ ] `claude plugin test mods/<name>` が通る（新機能にはテストを付けた）
- [ ] 型検査（`scripts/typecheck.sh <name> <claude-code.d.ts>`）が通る。CI では型を生成できないため手元で実施
- [ ] mod を変更した場合、`plugin.json` の `version` を上げた（機能追加=minor / 修正=patch）
- [ ] UI を変えた場合の目視確認: 実施済み / 目視未確認（未確認なら明記）
- [ ] サンプルや例は架空データのみ
