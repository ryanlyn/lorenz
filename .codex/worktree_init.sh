#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

prepare_typescript() {
  local ts_dir="$repo_root/ts"

  if [ ! -d "$ts_dir" ]; then
    echo "TypeScript workspace not found: $ts_dir" >&2
    exit 1
  fi

  echo "Preparing TypeScript workspace in $ts_dir"
  (
    cd "$ts_dir"
    mise trust
    mise install
    mise exec -- pnpm install --frozen-lockfile
    mise exec -- pnpm build
  )
}

prepare_typescript
