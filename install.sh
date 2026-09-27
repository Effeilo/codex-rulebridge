#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf 'Usage: bash install.sh [--local <checkout>] [--prefix <directory>] [--profile <file> | --no-profile]\n'
  exit 0
fi

# Works from a checkout or piped into Bash. No npm or sudo required.
for dependency in node git; do
  command -v "$dependency" >/dev/null 2>&1 || { printf 'Required: %s\n' "$dependency" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22+ is required"); process.exit(1); }'

if [[ ${1:-} == --local ]]; then
  [[ $# -ge 2 ]] || { printf 'Usage: install.sh --local <checkout> [installer options]\n' >&2; exit 1; }
  rulebridge_source=$2
  shift 2
  node "$rulebridge_source/scripts/install.mjs" --source "$rulebridge_source" "$@"
else
  rulebridge_temp=$(mktemp -d)
  trap 'node -e '\''require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })'\'' "$rulebridge_temp"' EXIT
  git clone --quiet --depth 1 --branch "${RULEBRIDGE_REF:-main}" https://github.com/Effeilo/codex-rulebridge.git "$rulebridge_temp/repo"
  node "$rulebridge_temp/repo/scripts/install.mjs" --source "$rulebridge_temp/repo" "$@"
fi
