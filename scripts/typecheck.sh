#!/usr/bin/env bash
# 使い方: scripts/typecheck.sh <mod 名> <claude-code.d.ts のパス>
# 型ファイルは plugin-authoring スキルを読み込むと書き出される（パスはセッション固有）。
# それを mod の .claude-plugin/types/ に敷き、tsc で型検査する。敷いたものは gitignore 済み。
set -euo pipefail
mod="${1:?mod 名を指定}"
dts="${2:?claude-code.d.ts のパスを指定}"
dir="mods/$mod"
[ -d "$dir" ] || { echo "no such mod: $mod" >&2; exit 2; }
types="$dir/.claude-plugin/types"
mkdir -p "$types/claude-code"
cp "$dts" "$types/claude-code/index.d.ts"
cat > "$types/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["./", "../../hooks", "../../types"]
}
JSON
[ -f "$dir/tsconfig.json" ] || echo '{ "extends": "./.claude-plugin/types/tsconfig.json" }' > "$dir/tsconfig.json"
tsc -p "$dir"
echo "tsc OK: $mod"
