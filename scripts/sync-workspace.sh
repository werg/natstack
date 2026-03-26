#!/usr/bin/env bash
# Sync a dev workspace's source back to the monorepo template directory.
# Copies source dirs (panels, packages, agents, workers, skills, about, templates)
# while excluding .git, node_modules, .cache, and runtime state.
#
# Usage:
#   ./scripts/sync-workspace.sh              # auto-picks if only one workspace exists
#   ./scripts/sync-workspace.sh <name>        # sync a specific workspace
#   ./scripts/sync-workspace.sh --list        # list available workspaces
#   ./scripts/sync-workspace.sh --dry-run     # preview without writing
#   ./scripts/sync-workspace.sh --dry-run dev # preview a specific workspace

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_DIR="$REPO_ROOT/workspace"

# Determine workspaces root
if [[ "$(uname)" == "Darwin" ]]; then
  WS_ROOT="$HOME/Library/Application Support/natstack/workspaces"
else
  WS_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/natstack/workspaces"
fi

SOURCE_DIRS=(panels packages agents workers skills about templates)

DRY_RUN=false
WS_NAME=""

# Parse args
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --list)
      if [[ ! -d "$WS_ROOT" ]]; then
        echo "No workspaces directory found at: $WS_ROOT"
        exit 1
      fi
      echo "Available workspaces:"
      for d in "$WS_ROOT"/*/; do
        name="$(basename "$d")"
        if [[ -d "$d/source" ]]; then
          echo "  $name"
        fi
      done
      exit 0
      ;;
    -*) echo "Unknown option: $arg"; exit 1 ;;
    *) WS_NAME="$arg" ;;
  esac
done

if [[ ! -d "$WS_ROOT" ]]; then
  echo "Error: No workspaces directory found at: $WS_ROOT"
  exit 1
fi

# Auto-pick workspace if none specified
if [[ -z "$WS_NAME" ]]; then
  workspaces=()
  for d in "$WS_ROOT"/*/; do
    [[ -d "$d/source" ]] && workspaces+=("$(basename "$d")")
  done

  if [[ ${#workspaces[@]} -eq 0 ]]; then
    echo "Error: No workspaces found in $WS_ROOT"
    exit 1
  elif [[ ${#workspaces[@]} -eq 1 ]]; then
    WS_NAME="${workspaces[0]}"
    echo "Auto-selected workspace: $WS_NAME"
  else
    echo "Multiple workspaces found. Pick one:"
    for ws in "${workspaces[@]}"; do
      echo "  $ws"
    done
    echo ""
    echo "Usage: $0 [--dry-run] <workspace-name>"
    exit 1
  fi
fi

WS_SOURCE="$WS_ROOT/$WS_NAME/source"

if [[ ! -d "$WS_SOURCE" ]]; then
  echo "Error: Workspace source not found at: $WS_SOURCE"
  exit 1
fi

RSYNC_FLAGS=(-av --delete --exclude='.git' --exclude='node_modules' --exclude='.cache')
if $DRY_RUN; then
  RSYNC_FLAGS+=(--dry-run)
  echo "DRY RUN — no files will be written"
  echo ""
fi

echo "Syncing: $WS_SOURCE -> $TEMPLATE_DIR"
echo ""

for dir in "${SOURCE_DIRS[@]}"; do
  src="$WS_SOURCE/$dir"
  if [[ -d "$src" ]]; then
    echo "--- $dir/ ---"
    rsync "${RSYNC_FLAGS[@]}" "$src/" "$TEMPLATE_DIR/$dir/"
    echo ""
  fi
done

if $DRY_RUN; then
  echo "Dry run complete. Run without --dry-run to apply."
else
  echo "Done. Review changes with: git diff workspace/"
fi
