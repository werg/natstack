#!/usr/bin/env bash
# Remove ephemeral dev workspaces (dev-*) from the NatStack workspaces directory.
# Usage: ./scripts/cleanup-dev-workspaces.sh [--dry-run]

set -euo pipefail

WORKSPACES_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/natstack/workspaces"

if [ ! -d "$WORKSPACES_DIR" ]; then
  echo "No workspaces directory found at $WORKSPACES_DIR"
  exit 0
fi

dry_run=false
if [ "${1:-}" = "--dry-run" ]; then
  dry_run=true
fi

count=0
for dir in "$WORKSPACES_DIR"/dev-*; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  if $dry_run; then
    echo "[dry-run] Would delete: $name"
  else
    rm -rf "$dir"
    echo "Deleted: $name"
  fi
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "No dev workspaces to clean up."
else
  if $dry_run; then
    echo "Would delete $count dev workspace(s). Run without --dry-run to delete."
  else
    echo "Cleaned up $count dev workspace(s)."
  fi
fi
