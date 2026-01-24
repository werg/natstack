#!/bin/bash
msg="${1:-Update}"
for dir in workspace/workers/*/ workspace/panels/*/ workspace/contexts/*/ workspace/packages/*/; do
  if [ -d "$dir/.git" ]; then
    echo "Committing in $dir"
    git -C "$dir" add -A && git -C "$dir" commit -m "$msg"
  else
    echo "Initializing repo in $dir"
    git -C "$dir" init && git -C "$dir" add -A && git -C "$dir" commit -m "$msg"
  fi
done