#!/bin/bash
msg="${1:-Update}"
for dir in workspace/workers/*/ workspace/panels/*/; do
  if [ -d "$dir/.git" ]; then
    echo "Committing in $dir"
    git -C "$dir" add -A && git -C "$dir" commit -m "$msg"
  fi
done