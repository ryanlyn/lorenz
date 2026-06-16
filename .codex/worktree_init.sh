#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

prepare_typescript() {
  if [ ! -f "$repo_root/package.json" ]; then
    echo "TypeScript workspace not found: $repo_root" >&2
    exit 1
  fi

  echo "Preparing TypeScript workspace in $repo_root"
  (
    cd "$repo_root"
    mise trust
    mise install
    mise exec -- pnpm install --frozen-lockfile
    mise exec -- pnpm build
  )
}

prepare_typescript
