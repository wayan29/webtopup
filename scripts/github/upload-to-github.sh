#!/bin/bash

set -e

DEFAULT_REMOTE="https://github.com/wayan29/webtopup.git"

echo "Repository upload helper"
echo "Target default remote: ${DEFAULT_REMOTE}"

if ! command -v git >/dev/null 2>&1; then
    echo "Git belum terpasang."
    exit 1
fi

if [ ! -f "README.md" ] || [ ! -d "client" ] || [ ! -d "server" ]; then
    echo "Jalankan script ini dari root project."
    exit 1
fi

if [ ! -d ".git" ]; then
    git init
fi

git add .

if git diff --cached --quiet; then
    echo "Tidak ada perubahan staged untuk di-commit."
else
    git commit -m "chore(repo): update repository structure and workflow"
fi

if git remote | grep -q origin; then
    echo "Remote origin sudah ada. Biarkan apa adanya."
else
    git remote add origin "${DEFAULT_REMOTE}"
fi

git branch -M main

echo
echo "Repository siap di-push."
echo "Review remote dengan: git remote -v"
echo "Push dengan: git push -u origin main"
