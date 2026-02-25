#!/bin/bash
shopt -s nullglob
msg="${1:-Update}"

# Provide fallback git identity if not configured
git_commit() {
  local dir="$1" msg="$2"
  if git -C "$dir" config user.email &>/dev/null; then
    git -C "$dir" commit -m "$msg"
  else
    git -C "$dir" -c user.email="natstack@local" -c user.name="natstack" commit -m "$msg"
  fi
}

for dir in workspace/workers/*/ workspace/panels/*/ workspace/contexts/*/ workspace/projects/*/ workspace/packages/*/ workspace/skills/*/ workspace/agents/*/ workspace/about/*/; do
  if [ -d "$dir/.git" ]; then
    echo "Committing in $dir"
    git -C "$dir" add -A && git_commit "$dir" "$msg" || true
  else
    echo "Initializing repo in $dir"
    git -C "$dir" init && git -C "$dir" add -A && git_commit "$dir" "$msg" || true
  fi
done
