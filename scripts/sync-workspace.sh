#!/usr/bin/env bash
# Sync the default workspace source back to the monorepo template directory.
# Copies source dirs (panels, packages, agents, workers, skills, about)
# while excluding .git, node_modules, .cache, and runtime state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_DIR="$REPO_ROOT/workspace"

# Determine workspace source path
if [[ "$(uname)" == "Darwin" ]]; then
  WS_SOURCE="$HOME/Library/Application Support/natstack/workspaces/default/source"
else
  WS_SOURCE="${XDG_CONFIG_HOME:-$HOME/.config}/natstack/workspaces/default/source"
fi

if [[ ! -d "$WS_SOURCE" ]]; then
  echo "Error: Default workspace source not found at: $WS_SOURCE"
  exit 1
fi

SOURCE_DIRS=(panels packages agents workers skills about)

echo "Syncing: $WS_SOURCE → $TEMPLATE_DIR"

for dir in "${SOURCE_DIRS[@]}"; do
  src="$WS_SOURCE/$dir"
  if [[ -d "$src" ]]; then
    rsync -av --delete \
      --exclude='.git' \
      "$src/" "$TEMPLATE_DIR/$dir/"
  fi
done

echo "Done. Review changes with: git diff workspace/"
